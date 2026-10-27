import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { Duplex } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { Injectable, Inject } from '@nestjs/common';
import type Dockerode from 'dockerode';
import { ConfigurationService } from '@/core/config/configuration.service';
import { DOCKERODE } from '../docker/docker.module';
import { BackupRequirementError } from './backup-files';

export type BackupContainer = { id: string; project: string; running: boolean };
export type BackupRuntimePlan = { databaseId: string; containers: BackupContainer[]; images: { project: string; image: string }[] };
const below = (root: string, value: string) => value === root || value.startsWith(`${root}/`);

@Injectable()
export class BackupRuntimeService {
  constructor(
    private readonly config: ConfigurationService,
    @Inject(DOCKERODE) private readonly docker: Dockerode,
  ) {}

  async plan(projects: string[]): Promise<BackupRuntimePlan> {
    const self = await this.docker.getContainer(os.hostname()).inspect();
    const database = this.config.get('database');
    const networks = new Set(Object.keys(self.NetworkSettings.Networks));
    const candidates = await this.docker.listContainers({ all: true });
    const databases: string[] = [];
    const containers: BackupContainer[] = [];
    const images: BackupRuntimePlan['images'] = [];
    const { dataDir, appDataDir } = this.config.get('directories');
    const readable = [appDataDir, ...['state', 'apps', 'media', 'repos', 'user-config', 'traefik'].map((part) => path.join(dataDir, part))].flatMap(
      (root) =>
        (self.Mounts ?? [])
          .filter((mount) => mount.Type === 'bind' && below(mount.Destination, root))
          .map((mount) => path.posix.join(mount.Source, path.posix.relative(mount.Destination, root))),
    );
    for (const info of candidates) {
      const project = info.Labels['com.docker.compose.project'];
      const expectedApp = typeof project === 'string' && projects.includes(project);
      // Resolve the configured database inside this controller's Docker networks; never guess a remote server.
      const inspect = await this.docker.getContainer(info.Id).inspect();
      const matchesDatabase = Object.entries(inspect.NetworkSettings.Networks).some(
        ([network, endpoint]) =>
          networks.has(network) && [inspect.Name.replace(/^\//, ''), ...(endpoint.Aliases ?? []), endpoint.IPAddress].includes(database.host),
      );
      if (matchesDatabase) {
        if (!inspect.State.Running || inspect.State.Paused || inspect.State.Restarting || !/(?:^|\/)postgres(?:[:@]|$)/.test(inspect.Config.Image))
          throw new BackupRequirementError('Full backup requires the configured PostgreSQL container to be running.');
        databases.push(inspect.Id);
      }
      if (
        inspect.Id !== self.Id &&
        !expectedApp &&
        !matchesDatabase &&
        (inspect.State.Running || inspect.State.Restarting) &&
        (inspect.Mounts ?? []).some(
          (mount) => mount.RW && mount.Type === 'bind' && readable.some((root) => below(root, mount.Source) || below(mount.Source, root)),
        )
      )
        throw new BackupRequirementError('Another container is writing Orbis data. Stop it before creating a full backup.');
      if (!expectedApp) continue;
      if (inspect.State.Paused || inspect.State.Restarting)
        throw new BackupRequirementError('Wait for apps to finish starting or resume paused apps before a full backup.');
      for (const mount of inspect.Mounts ?? []) {
        if (!mount.RW && ['/etc/localtime', '/etc/timezone', '/var/run/docker.sock'].includes(mount.Destination)) continue;
        if (mount.Type !== 'bind' || !readable.some((root) => below(root, mount.Source)))
          throw new BackupRequirementError(
            'An app uses a Docker volume or external storage outside Orbis data. Review its storage before creating a full backup.',
          );
      }
      containers.push({ id: inspect.Id, project, running: inspect.State.Running });
      images.push({ project, image: inspect.Config.Image });
    }
    if (databases.length !== 1) throw new BackupRequirementError('The configured PostgreSQL container could not be identified safely.');
    return { databaseId: databases[0] as string, containers, images };
  }

  async stop(container: BackupContainer) {
    const handle = this.docker.getContainer(container.id);
    const current = await handle.inspect();
    if (current.Config.Labels?.['com.docker.compose.project'] !== container.project)
      throw new BackupRequirementError('App container ownership changed.');
    if (current.State.Running) await handle.stop({ t: 30 });
    const stopped = await handle.inspect();
    if (stopped.State.Running || stopped.State.Restarting || stopped.State.Paused)
      throw new BackupRequirementError('An app could not be stopped for a consistent backup.');
  }

  async resume(containers: BackupContainer[]) {
    let failed = false;
    for (const container of containers.filter((item) => item.running)) {
      try {
        const handle = this.docker.getContainer(container.id);
        const state = await handle.inspect();
        if (state.Config.Labels?.['com.docker.compose.project'] !== container.project || state.State.Paused)
          throw new BackupRequirementError('App ownership or state changed.');
        if (!state.State.Running) await handle.start();
        if (!(await handle.inspect()).State.Running) throw new BackupRequirementError('App did not resume.');
      } catch {
        failed = true;
      }
    }
    if (failed) throw new BackupRequirementError('Some apps could not be restarted. Review Apps before retrying the backup.');
  }

  async dumpDatabase(containerId: string, destination: string, signal: AbortSignal, onBytes: (bytes: number) => void) {
    signal.throwIfAborted();
    const database = this.config.get('database');
    const operation = await this.docker.getContainer(containerId).exec({
      Cmd: [
        'pg_dump',
        '--format=custom',
        '--no-owner',
        '--no-acl',
        '--no-password',
        `--username=${database.username}`,
        `--dbname=${database.database}`,
      ],
      Env: [`PGPASSWORD=${database.password}`],
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    });
    const output = await fs.open(destination, 'wx', 0o600);
    let stream: Duplex | undefined;
    let bytes = 0;
    let stderr = false;
    const abort = () => stream?.destroy?.(new Error('Backup cancelled.'));
    try {
      stream = await operation.start({ hijack: true, stdin: false });
      signal.addEventListener('abort', abort, { once: true });
      signal.throwIfAborted();
      let header = Buffer.alloc(0);
      let remaining = 0;
      let channel = 0;
      for await (const raw of stream as NodeJS.ReadableStream & AsyncIterable<Buffer>) {
        signal.throwIfAborted();
        const chunk = Buffer.from(raw);
        let offset = 0;
        while (offset < chunk.length) {
          if (!remaining) {
            const take = Math.min(8 - header.length, chunk.length - offset);
            header = Buffer.concat([header, chunk.subarray(offset, offset + take)]);
            offset += take;
            if (header.length < 8) continue;
            channel = header[0] ?? 0;
            if (![1, 2].includes(channel) || header[1] || header[2] || header[3]) throw new BackupRequirementError('Invalid database backup stream.');
            remaining = header.readUInt32BE(4);
            header = Buffer.alloc(0);
            if (!remaining) continue;
          }
          const take = Math.min(remaining, chunk.length - offset);
          if (channel === 1) {
            let written = 0;
            while (written < take) {
              const part = await output.write(chunk, offset + written, take - written);
              if (!part.bytesWritten) throw new BackupRequirementError('Database backup storage could not be written.');
              written += part.bytesWritten;
            }
            bytes += take;
            onBytes(bytes);
          } else stderr = true;
          offset += take;
          remaining -= take;
        }
      }
      let result = await operation.inspect();
      const deadline = Date.now() + 3000;
      while (result.Running && Date.now() < deadline) {
        await delay(25, undefined, { signal });
        result = await operation.inspect();
      }
      if (header.length || remaining || stderr || result.Running || result.ExitCode !== 0 || bytes < 5)
        throw new BackupRequirementError('The database snapshot did not complete.');
      const magic = Buffer.alloc(5);
      const input = await fs.open(destination, 'r');
      try {
        await input.read(magic, 0, 5, 0);
      } finally {
        await input.close();
      }
      if (magic.toString() !== 'PGDMP') throw new BackupRequirementError('The database snapshot is not a PostgreSQL archive.');
      await output.sync();
      return bytes;
    } finally {
      signal.removeEventListener('abort', abort);
      stream?.destroy?.();
      await output.close();
    }
  }
}
