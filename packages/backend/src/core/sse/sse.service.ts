import { DockerService } from '@/modules/docker/docker.service';
import { colorizeLogs } from '@/modules/docker/helpers/colorize-logs';
import { Injectable, type MessageEvent, type OnModuleDestroy } from '@nestjs/common';
import type { SSE, Topic } from '@runtipi/common/schemas';
import type { AppUrn } from '@runtipi/common/types';
import { EMPTY, Observable, ReplaySubject, Subject, interval } from 'rxjs';
import { LoggerService } from '../logger/logger.service';

@Injectable()
export class SSEService implements OnModuleDestroy {
  constructor(
    private readonly logger: LoggerService,
    private readonly dockerService: DockerService,
  ) {
    // Kill all topics with no subscribers
    this.cleanupTimer = interval(1000 * 60).subscribe(() => {
      this.topics.forEach((topic, key) => {
        if (!topic.observed) {
          this.logger.debug(`Killing topic ${key}`);
          topic.complete();
          this.topics.delete(key);
        }
      });
    });
  }

  private topics: Map<Topic, Subject<MessageEvent>> = new Map();
  private readonly cleanupTimer;
  private readonly logStreams = new Set<() => void>();
  private closing = false;
  private readonly stopped = new ReplaySubject<void>(1);

  shutdownEvents() {
    return this.stopped.asObservable();
  }

  onModuleDestroy() {
    if (this.closing) return;
    this.closing = true;
    this.stopped.next();
    this.stopped.complete();
    this.cleanupTimer.unsubscribe();
    for (const stop of this.logStreams) stop();
    for (const topic of this.topics.values()) topic.complete();
    this.topics.clear();
  }

  /**
   * Emits an event to the specified topic.
   */
  emit<T extends Topic>(topic: T, data: Extract<SSE, { topic: T }>['data'], appUrn?: AppUrn) {
    if (this.closing) return;
    let formattedTopic = topic;

    if (appUrn) {
      // We want to use this topic for a specific app
      formattedTopic = `${topic}:${appUrn}` as T;
    }

    let currentTopic = this.topics.get(formattedTopic);
    if (!currentTopic) {
      currentTopic = new Subject<MessageEvent>();
      this.topics.set(formattedTopic, currentTopic);
    }

    const event = new MessageEvent('message', { data: JSON.stringify(data) });

    currentTopic.next(event);
  }

  /**
   * Gets an observable for the specified topic.
   * If the topic does not exist, it creates it.
   */
  getTopicObservable(topic: Topic, appUrn?: AppUrn): Observable<MessageEvent> {
    if (this.closing) return EMPTY;
    let formattedTopic = topic;

    if (appUrn) {
      // We want to use this topic for a specific app
      formattedTopic = `${topic}:${appUrn}` as Topic;
    }

    let currentTopic = this.topics.get(formattedTopic);
    if (!currentTopic) {
      currentTopic = new Subject<MessageEvent>();
      this.topics.set(formattedTopic, currentTopic);
    }

    return currentTopic.asObservable();
  }

  /**
   * Creates an observable for logs stream.
   * It listens to the logs stream and emits the logs to the specified topic.
   */
  async getLogStreamObservable(topic: Topic, maxLines: number, appUrn?: AppUrn): Promise<Observable<MessageEvent>> {
    if (this.closing || (topic !== 'app-logs' && topic !== 'runtipi-logs')) return EMPTY;

    return new Observable((subscriber) => {
      if (this.closing) {
        subscriber.complete();
        return;
      }
      let active = true;
      let formatting = 0;
      let inputEnded = false;
      let killReader: (() => void) | undefined;
      const releaseReader = () => {
        const kill = killReader;
        killReader = undefined;
        if (!kill) return;
        try {
          kill();
        } catch (error) {
          this.logger.error('Unable to stop a log reader:', error);
        }
      };
      const stop = () => {
        if (!active) return;
        active = false;
        this.logStreams.delete(stop);
        releaseReader();
        subscriber.complete();
      };
      this.logStreams.add(stop);

      // Acquire only for a live subscription. A late result still belongs to
      // this subscription and must be released after revocation or shutdown.
      void (async () => {
        const { on, kill } = await this.dockerService.getLogsStream(maxLines, appUrn);
        killReader = kill;
        if (!active || this.closing) {
          releaseReader();
          return;
        }
        const finish = () => {
          inputEnded = true;
          if (formatting === 0) subscriber.complete();
        };
        on('end', finish);
        on('close', finish);
        on('error', (error) => subscriber.error(error));
        on('data', async (data) => {
          if (!active || this.closing || inputEnded) return;
          formatting++;
          try {
            const lines = await colorizeLogs(
              data
                .toString()
                .split(/(?:\r\n|\r|\n)/g)
                .filter(Boolean),
            );
            if (!active || this.closing) return;
            const payload = appUrn ? { appUrn, lines, event: 'newLogs' as const } : { lines, event: 'newLogs' as const };
            subscriber.next(new MessageEvent('message', { data: JSON.stringify(payload) }));
          } catch (error) {
            if (active && !this.closing) this.logger.error('Error colorizing logs:', error);
          } finally {
            formatting--;
            if (active && inputEnded && formatting === 0) subscriber.complete();
          }
        });
      })().catch((error) => {
        if (active && !this.closing) subscriber.error(error);
      });
      return stop;
    });
  }
}
