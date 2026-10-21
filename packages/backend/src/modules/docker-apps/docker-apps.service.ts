import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type Dockerode from 'dockerode';
import type { DockerAppRemoval, DockerApps } from '@runtipi/common/schemas';
import { castAppUrn } from '@/common/helpers/app-helpers';
import { installationHeld } from '@/common/installation-mode';
import { ConfigurationService } from '@/core/config/configuration.service';
import { AppsRepository } from '../apps/apps.repository';
import { DOCKERODE } from '../docker/docker.module';
import { TasksService } from '../tasks/tasks.service';
import { dockerAppGroup, dockerAppHash, dockerAppSummary, dockerContainerDefinition, dockerId, protectedDockerContainer } from './docker-apps.model';

type Group = { id: string; containers: Dockerode.ContainerInspectInfo[] };
type Inventory = { groups: Group[]; daemon: string; protectedContainers: number };

@Injectable()
export class DockerAppsService {
  private cache?: { until: number; value: DockerApps };
  private pending?: { epoch: number; promise: Promise<DockerApps> };
  private epoch = 0;
  private removing = new Set<string>();

  constructor(
    @Inject(DOCKERODE) private readonly docker: Dockerode,
    private readonly apps: AppsRepository,
    private readonly configuration: ConfigurationService,
    private readonly tasks: TasksService,
  ) {}

  async read(): Promise<DockerApps> {
    if (this.cache && this.cache.until > Date.now()) return this.cache.value;
    if (this.pending?.epoch === this.epoch) return this.pending.promise;
    const epoch = this.epoch;
    const promise = this.inventory()
      .then((inventory) => {
        const value = {
          apps: inventory.groups.map((group) => dockerAppSummary(group.id, group.containers)).sort((a, b) => a.name.localeCompare(b.name)),
          protectedContainers: inventory.protectedContainers,
          sampledAt: new Date().toISOString(),
        };
        if (epoch === this.epoch) this.cache = { until: Date.now() + 10000, value };
        return value;
      })
      .finally(() => {
        if (this.pending?.promise === promise) this.pending = undefined;
      });
    this.pending = { epoch, promise };
    return promise;
  }

  private async inventory(): Promise<Inventory> {
    if (installationHeld()) throw new ServiceUnavailableException('Installation is in progress.');
    try {
      const signal = AbortSignal.timeout(10000);
      // The installed Dockerode supports abortSignal here; its info overload omits the options argument.
      const readInfo = this.docker.info.bind(this.docker) as (options: { abortSignal: AbortSignal }) => Promise<{ ID?: string }>;
      const [info, all, registered] = await Promise.all([
        readInfo({ abortSignal: signal }),
        this.docker.listContainers({ all: true, abortSignal: signal }),
        this.apps.getApps(),
      ]);
      if (!info.ID || all.length > 4096 || all.some((item) => !dockerId.test(item.Id)) || new Set(all.map((item) => item.Id)).size !== all.length) {
        throw new Error('Invalid Docker inventory');
      }
      const registeredUrns = new Set(registered.map((app) => `${app.appName}:${app.appStoreSlug}`));
      const registeredProjects = new Set(registered.map((app) => `${app.appName}_${app.appStoreSlug}`));
      const blockedGroups = new Set(
        all
          .filter(
            (item) =>
              protectedDockerContainer(item) ||
              registeredUrns.has(item.Labels?.['runtipi.appurn'] ?? '') ||
              registeredProjects.has(item.Labels?.['com.docker.compose.project'] ?? ''),
          )
          .map((item) => JSON.stringify(dockerAppGroup(item))),
      );
      const candidates = all.filter((item) => !blockedGroups.has(JSON.stringify(dockerAppGroup(item))));
      const inspected: Dockerode.ContainerInspectInfo[] = [];
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(4, candidates.length) }, async () => {
          while (next < candidates.length) {
            const candidate = candidates[next++];
            if (!candidate) break;
            const value = await this.docker.getContainer(candidate.Id).inspect({ abortSignal: signal });
            if (
              value.Id !== candidate.Id ||
              value.Image !== candidate.ImageID ||
              JSON.stringify(value.Config.Labels ?? {}) !== JSON.stringify(candidate.Labels ?? {})
            ) {
              throw new Error('Docker app changed during inspection');
            }
            inspected.push(value);
          }
        }),
      );
      const current = await this.docker.listContainers({ all: true, abortSignal: signal });
      const membership = (rows: Dockerode.ContainerInfo[]) =>
        rows.map((item) => [item.Id, item.ImageID, item.Labels]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
      if (JSON.stringify(membership(all)) !== JSON.stringify(membership(current))) throw new Error('Docker app membership changed');
      const groups = new Map<string, Dockerode.ContainerInspectInfo[]>();
      const byId = new Map(all.map((item) => [item.Id, item]));
      for (const item of inspected) {
        const original = byId.get(item.Id);
        if (!original) throw new Error('Docker app disappeared');
        const id = dockerAppHash([info.ID, dockerAppGroup(original)]);
        const group = groups.get(id) ?? [];
        group.push(item);
        groups.set(id, group);
      }
      return {
        daemon: info.ID,
        protectedContainers: all.length - candidates.length,
        groups: [...groups].map(([id, containers]) => ({ id, containers: containers.sort((a, b) => a.Id.localeCompare(b.Id)) })),
      };
    } catch {
      throw new ServiceUnavailableException('Docker apps could not be inspected. Refresh before making changes.');
    }
  }

  private review(inventory: Inventory, group: Group): DockerAppRemoval {
    const storage = group.containers.flatMap((container) =>
      container.Mounts.flatMap<DockerAppRemoval['storage'][number]>((mount) => {
        if (mount.Type === 'bind') return [{ type: 'bind' as const, name: mount.Source, destination: mount.Destination }];
        if (mount.Type === 'volume') return [{ type: 'volume' as const, name: mount.Name ?? mount.Source, destination: mount.Destination }];
        return [];
      }),
    );
    return {
      app: dockerAppSummary(group.id, group.containers),
      reviewId: dockerAppHash([inventory.daemon, group.id, group.containers.map((item) => [dockerContainerDefinition(item), item.State.Status])]),
      storage: [...new Map(storage.map((item) => [JSON.stringify(item), item])).values()].sort(
        (a, b) => a.destination.localeCompare(b.destination) || a.name.localeCompare(b.name),
      ),
      retainsData: true,
    };
  }

  private selected(inventory: Inventory, id: string) {
    if (!dockerId.test(id)) throw new NotFoundException('Docker app was not found.');
    const group = inventory.groups.find((item) => item.id === id);
    if (!group) throw new NotFoundException('Docker app changed or is now managed by Orbis. Refresh the app list.');
    return group;
  }

  async removalReview(id: string): Promise<DockerAppRemoval> {
    const inventory = await this.inventory();
    return this.review(inventory, this.selected(inventory, id));
  }

  async uninstall(id: string, reviewId: string, name: string) {
    if (!dockerId.test(id)) throw new NotFoundException('Docker app was not found.');
    if (this.removing.has(id)) throw new ConflictException('This app is already being uninstalled.');
    this.removing.add(id);
    this.epoch++;
    this.cache = undefined;
    const removed = new Set<string>();
    const requestId = randomUUID();
    const event = { requestId, appUrn: castAppUrn(`docker-${id.slice(0, 12)}:external`), command: 'uninstall' as const, displayName: name };
    let journal: string | undefined;
    let record: Record<string, unknown> | undefined;
    let started = false;
    try {
      const inventory = await this.inventory();
      const group = this.selected(inventory, id);
      const review = this.review(inventory, group);
      if (review.reviewId !== reviewId || review.app.name !== name) throw new ConflictException('Docker app changed. Review the uninstall again.');
      if (!review.app.removable) throw new ConflictException(review.app.unavailableReason ?? 'This app cannot be uninstalled yet.');
      const directory = path.join(this.configuration.get('directories').dataDir, 'state', 'orbis-docker-apps');
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      journal = path.join(directory, `${requestId}.json`);
      record = {
        requestId,
        appId: id,
        name,
        reviewId,
        containerIds: group.containers.map((item) => item.Id),
        definitions: group.containers.map((item) => ({ id: item.Id, hash: dockerContainerDefinition(item) })),
        storage: review.storage,
        removedIds: [],
        phase: 'prepared',
      };
      await this.writeRecord(journal, record);
      await this.tasks.enqueue(event);
      await this.tasks.start(event);
      started = true;
      for (const original of group.containers) {
        const current = await this.inventory();
        const remaining = this.selected(current, id);
        const expected = group.containers.filter((item) => !removed.has(item.Id));
        if (
          current.daemon !== inventory.daemon ||
          JSON.stringify(remaining.containers.map(dockerContainerDefinition)) !== JSON.stringify(expected.map(dockerContainerDefinition))
        ) {
          throw new ConflictException('Docker app changed during uninstall. Remaining containers were retained.');
        }
        const container = this.docker.getContainer(original.Id);
        record.phase = 'stopping';
        record.currentContainerId = original.Id;
        await this.writeRecord(journal, record);
        const state = await container.inspect();
        if (state.State.Paused) await container.unpause();
        if (state.State.Running || state.State.Restarting) await container.stop({ t: 30 });
        const stopped = await container.inspect();
        if (stopped.State.Running || stopped.State.Restarting || dockerContainerDefinition(stopped) !== dockerContainerDefinition(original)) {
          throw new ConflictException('Docker app changed or could not be stopped. It was not removed.');
        }
        record.phase = 'removing';
        await this.writeRecord(journal, record);
        await container.remove({ v: false, force: false });
        removed.add(original.Id);
        record.removedIds = [...removed];
        await this.writeRecord(journal, record);
      }
      record.phase = 'completed';
      await this.writeRecord(journal, record);
      await this.tasks.finish(event, true);
      return { success: true, requestId, removedContainers: removed.size, retainedData: true };
    } catch (error) {
      if (journal && record) await this.writeRecord(journal, { ...record, phase: 'failed', removedIds: [...removed] }).catch(() => undefined);
      if (started) await this.tasks.finish(event, false);
      if (error instanceof ConflictException || error instanceof NotFoundException || error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException(
        'Uninstall did not finish. Refresh the app list to review the remaining containers. Persistent data was retained.',
      );
    } finally {
      this.removing.delete(id);
      this.epoch++;
      this.cache = undefined;
    }
  }

  private async writeRecord(file: string, value: Record<string, unknown>) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
    const directory = await fs.open(path.dirname(file), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}
