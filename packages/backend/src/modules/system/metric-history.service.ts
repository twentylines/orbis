import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Injectable, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { metricHistoryRanges, type MetricHistory, type MetricHistoryRange } from '@runtipi/common/schemas';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { SystemService } from './system.service';
import { decodeBucket, encodeBucket, historyPoint, mergeBuckets, metricSample, type MetricBucket } from './metric-history.model';

const retentionMs = 7 * 86400000;
const minuteLimit = 10081;
const fileLimit = 8 * 1024 * 1024;

@Injectable()
export class MetricHistoryService implements OnModuleInit, OnModuleDestroy {
  private minutes = new Map<number, MetricBucket>();
  private recent: MetricBucket[] = [];
  private restoredPartial?: MetricBucket;
  private timer?: ReturnType<typeof setInterval>;
  private loading?: Promise<void>;
  private pending?: Promise<void>;
  private writes: Promise<void> = Promise.resolve();
  private currentMinute: number | null = null;
  private lastSampleAt: number | null = null;
  private persistedThrough: number | null = null;
  private storage: MetricHistory['storage'] = 'persistent';
  private collectorAvailable = false;
  private unreadable = false;
  private closed = false;
  private writesSinceCompact = 0;
  private needsCompact = false;

  constructor(
    private readonly system: SystemService,
    private readonly config: ConfigurationService,
    private readonly logger: LoggerService,
  ) {}

  async onModuleInit() {
    await this.load();
    this.timer = setInterval(() => void this.collect(), 10000);
    this.timer.unref();
    void this.collect();
  }

  async onModuleDestroy() {
    this.closed = true;
    clearInterval(this.timer);
    if (this.currentMinute !== null) {
      const bucket = this.minutes.get(this.currentMinute);
      if (bucket && bucket.lastAt > (this.persistedThrough ?? -1)) this.persist(bucket);
    }
    await this.writes;
  }

  private file() {
    return path.join(this.config.get('directories').dataDir, 'state', 'orbis-metrics', 'minutes-v1.jsonl');
  }

  private load() {
    this.loading ??= this.readStored();
    return this.loading;
  }

  private async readStored() {
    try {
      const file = this.file();
      if ((await fs.stat(file)).size > fileLimit) throw new Error('Metric history exceeds its storage bound');
      const lines = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean);
      if (lines.length > 40000) throw new Error('Metric history exceeds its record bound');
      for (const line of lines) {
        const bucket = decodeBucket(JSON.parse(line), Date.now());
        this.minutes.set(bucket.bucketAt, bucket);
        this.persistedThrough = Math.max(this.persistedThrough ?? 0, bucket.lastAt);
      }
      this.lastSampleAt = this.persistedThrough;
      this.prune();
      this.needsCompact = lines.length !== this.minutes.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      this.unreadable = true;
      this.storage = 'unavailable';
      this.lastSampleAt = this.persistedThrough;
      this.prune();
      this.logger.warn('Metric history storage could not be loaded. Existing data is preserved; collection continues in memory.');
    }
  }

  private prune() {
    const cutoff = Date.now() - retentionMs;
    if (this.restoredPartial && this.restoredPartial.lastAt < cutoff) this.restoredPartial = undefined;
    for (const [key, bucket] of this.minutes) if (bucket.lastAt < cutoff) this.minutes.delete(key);
    if (this.minutes.size > minuteLimit) {
      for (const key of [...this.minutes.keys()].sort((left, right) => left - right).slice(0, this.minutes.size - minuteLimit))
        this.minutes.delete(key);
    }
    this.recent = this.recent.filter((bucket) => bucket.lastAt >= Date.now() - 3600000).slice(-360);
  }

  private persist(bucket: MetricBucket) {
    if (this.unreadable) return;
    const line = `${encodeBucket(bucket)}\n`;
    this.writes = this.writes.then(async () => {
      const file = this.file();
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        if (this.needsCompact || this.writesSinceCompact >= 60) {
          const retained = [...this.minutes.values()].sort((left, right) => left.bucketAt - right.bucketAt);
          await fs.writeFile(temporary, retained.map((item) => `${encodeBucket(item)}\n`).join(''), { mode: 0o600 });
          await fs.rename(temporary, file);
          this.persistedThrough = Math.max(this.persistedThrough ?? 0, ...retained.map((item) => item.lastAt));
          this.writesSinceCompact = 0;
          this.needsCompact = false;
        } else {
          await fs.appendFile(file, line, { mode: 0o600 });
          this.persistedThrough = Math.max(this.persistedThrough ?? 0, bucket.lastAt);
          this.writesSinceCompact++;
        }
        this.storage = 'persistent';
      } catch {
        if (this.storage !== 'unavailable') this.logger.warn('Metric history could not be saved. Recent readings remain in memory.');
        this.storage = 'unavailable';
        this.needsCompact = true;
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => undefined);
      }
    });
  }

  collect(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.pending ??= this.sample().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async sample() {
    await this.load();
    try {
      const sample = metricSample(await this.system.getTelemetry());
      if (this.closed) return;
      if (!sample || sample.lastAt > Date.now() + 1000 || sample.lastAt < Date.now() - 60000) throw new Error('Telemetry sample is not current');
      this.collectorAvailable = true;
      if (this.lastSampleAt !== null && sample.lastAt <= this.lastSampleAt) return;
      if (this.currentMinute !== null && this.currentMinute !== sample.bucketAt) {
        const previous = this.minutes.get(this.currentMinute);
        if (previous) this.persist(previous);
      }
      const existing = this.minutes.get(sample.bucketAt);
      if (!this.recent.length && existing && existing.lastAt < sample.firstAt) this.restoredPartial = existing;
      this.minutes.set(sample.bucketAt, existing ? mergeBuckets(existing, sample) : sample);
      this.currentMinute = sample.bucketAt;
      this.lastSampleAt = sample.lastAt;
      this.recent.push(sample);
      this.prune();
    } catch {
      if (this.collectorAvailable) this.logger.warn('Metric history collection is interrupted. Missing samples will remain gaps.');
      this.collectorAvailable = false;
    }
  }

  async read(range: MetricHistoryRange): Promise<MetricHistory> {
    await this.load();
    this.prune();
    const now = Date.now();
    const { seconds, resolutionSeconds } = metricHistoryRanges[range];
    const from = now - seconds * 1000;
    const retained = [...this.minutes.values()].filter((bucket) => bucket.lastAt >= from && bucket.firstAt <= now);
    const grouped = new Map<number, MetricBucket>();
    if (range === '5m') {
      const recent = this.recent.filter((bucket) => bucket.lastAt >= from && bucket.firstAt <= now);
      const firstRecentMinute = recent[0]?.bucketAt ?? Number.POSITIVE_INFINITY;
      for (const bucket of retained) if (bucket.bucketAt < firstRecentMinute) grouped.set(bucket.bucketAt, bucket);
      if (this.restoredPartial?.bucketAt === firstRecentMinute && this.restoredPartial.lastAt >= from) {
        grouped.set(this.restoredPartial.firstAt, this.restoredPartial);
      }
      for (const bucket of recent) grouped.set(bucket.firstAt, bucket);
    } else {
      for (const bucket of retained.sort((left, right) => left.bucketAt - right.bucketAt)) {
        const key = Math.floor(bucket.bucketAt / (resolutionSeconds * 1000)) * resolutionSeconds * 1000;
        const previous = grouped.get(key);
        grouped.set(key, previous ? mergeBuckets(previous, bucket) : bucket);
      }
    }
    const points = [...grouped.values()]
      .sort((left, right) => left.firstAt - right.firstAt)
      .slice(-720)
      .map((bucket) => historyPoint(bucket, range === '5m' && this.recent.includes(bucket) ? 10 : Math.max(60, resolutionSeconds)));
    return {
      range,
      from: new Date(from).toISOString(),
      to: new Date(now).toISOString(),
      resolutionSeconds,
      sampledEverySeconds: 10,
      retentionDays: 7,
      storage: this.storage,
      collectorAvailable: this.collectorAvailable && this.lastSampleAt !== null && now - this.lastSampleAt >= 0 && now - this.lastSampleAt < 30000,
      lastSampleAt: this.lastSampleAt === null ? null : new Date(this.lastSampleAt).toISOString(),
      persistedThrough: this.persistedThrough === null ? null : new Date(this.persistedThrough).toISOString(),
      points,
    };
  }
}
