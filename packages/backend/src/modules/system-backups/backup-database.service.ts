import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type Dockerode from 'dockerode';
import { ConfigurationService } from '@/core/config/configuration.service';
import { DOCKERODE } from '../docker/docker.module';
import { BackupRequirementError, privateBackupDirectory } from './backup-files';
import { backupDockerExec, BackupDatabaseLines } from './backup-docker-exec';
import { backupDatabaseColumns, backupDatabaseLimits, BackupDatabaseRecords, backupDatabaseTables } from './backup-database-records';
import { restoreStartupRole } from './backup-restore-startup';

const label = 'io.orbis.backup-database-review';
const failure = () => new BackupRequirementError('The backup database could not be reviewed safely. No server data has been changed.');
const missing = (error: unknown) => (error as { statusCode?: number }).statusCode === 404;
const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`;
type Ownership = { version: 1; name: string; nonce: string; image: string };
export type BackupDatabaseReview = { counts: Record<(typeof backupDatabaseTables)[number], number>; bytes: number; sha256: string };

export function backupDatabaseSandbox(image: string, name: string, nonce: string, volumes: string[]): Dockerode.ContainerCreateOptions {
  if (
    !/^sha256:[a-f0-9]{64}$/.test(image) ||
    volumes.length > 8 ||
    volumes.some((value) => (value !== '/var/lib/postgresql' && !value.startsWith('/var/lib/postgresql/')) || path.posix.normalize(value) !== value)
  )
    throw failure();
  const tmpfs: Record<string, string> = {
    '/sandbox': 'rw,noexec,nosuid,nodev,size=512m,mode=1777',
    '/tmp': 'rw,noexec,nosuid,nodev,size=16m,mode=1777',
  };
  for (const volume of volumes) tmpfs[volume] = 'rw,noexec,nosuid,nodev,size=1m,mode=1777';
  return {
    name,
    Image: image,
    User: 'postgres',
    NetworkDisabled: true,
    WorkingDir: '/tmp',
    Env: ['PGDATA=/sandbox/cluster', 'PGHOST=/sandbox', 'PGUSER=orbis_review', 'PGDATABASE=orbis_review', 'LC_ALL=C'],
    Entrypoint: ['sh', '-ec'],
    Cmd: [
      'umask 077; test "$(id -u)" -gt 0; initdb --no-locale --encoding=UTF8 --username=orbis_review --auth=trust >/dev/null; exec postgres -k /sandbox -c listen_addresses= -c max_connections=8 -c shared_buffers=16MB -c work_mem=4MB -c maintenance_work_mem=16MB -c max_parallel_workers=0 -c log_statement=none -c log_min_error_statement=panic',
    ],
    Labels: { [label]: nonce },
    Healthcheck: { Test: ['NONE'] },
    HostConfig: {
      NetworkMode: 'none',
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      Privileged: false,
      Binds: [],
      Tmpfs: tmpfs,
      LogConfig: { Type: 'none', Config: {} },
      Memory: 768 * 1024 * 1024,
      MemorySwap: 768 * 1024 * 1024,
      NanoCpus: 1_000_000_000,
      PidsLimit: 128,
      ShmSize: 32 * 1024 * 1024,
      IpcMode: 'private',
      Ulimits: [
        { Name: 'nofile', Soft: 1024, Hard: 1024 },
        { Name: 'core', Soft: 0, Hard: 0 },
      ],
      RestartPolicy: { Name: 'no' },
    },
  };
}

@Injectable()
export class BackupDatabaseService implements OnModuleInit, OnModuleDestroy {
  private initialization?: Promise<void>;
  private running?: Promise<BackupDatabaseReview>;
  private cancellation?: AbortController;

  constructor(
    private readonly config: ConfigurationService,
    @Inject(DOCKERODE) private readonly docker: Dockerode,
  ) {}

  private root() {
    return path.join(this.config.get('directories').dataDir, 'backups', 'database-review');
  }
  private journal() {
    return path.join(this.root(), 'sandbox.json');
  }
  onModuleInit() {
    if (restoreStartupRole() === 'verify') return;
    return this.initialize();
  }
  async onModuleDestroy() {
    this.cancellation?.abort();
    await this.running?.catch(() => undefined);
  }
  private initialize() {
    this.initialization ??= this.cleanup();
    return this.initialization;
  }
  private async cleanup() {
    await privateBackupDirectory(this.root());
    let source: string;
    try {
      const file = await fs.open(this.journal(), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 1024 || stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid())) throw failure();
        source = await file.readFile('utf8');
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw failure();
    }
    let owner: Ownership;
    try {
      owner = JSON.parse(source);
    } catch {
      throw failure();
    }
    if (
      !owner ||
      typeof owner !== 'object' ||
      owner.version !== 1 ||
      !/^orbis-database-review-[a-f0-9-]{36}$/.test(owner.name) ||
      !/^[a-f0-9-]{36}$/.test(owner.nonce) ||
      !/^sha256:[a-f0-9]{64}$/.test(owner.image) ||
      Object.keys(owner).length !== 4
    )
      throw failure();
    const container = this.docker.getContainer(owner.name);
    let info: Dockerode.ContainerInspectInfo | undefined;
    try {
      info = await container.inspect({ abortSignal: AbortSignal.timeout(10_000) });
    } catch (error) {
      if (!missing(error)) throw failure();
    }
    if (info) {
      if (info.Name !== `/${owner.name}` || info.Config.Labels?.[label] !== owner.nonce || info.Image !== owner.image) throw failure();
      await container.remove({ force: true, v: true, abortSignal: AbortSignal.timeout(15_000) });
    }
    await fs.rm(this.journal());
    const directory = await fs.open(this.root(), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  private async save(owner: Ownership) {
    const temporary = path.join(this.root(), `.${randomUUID()}.tmp`);
    try {
      const file = await fs.open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(JSON.stringify(owner));
        await file.sync();
      } finally {
        await file.close();
      }
      await fs.link(temporary, this.journal());
      const directory = await fs.open(this.root(), 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  private async image(signal: AbortSignal) {
    const self = await this.docker.getContainer(os.hostname()).inspect({ abortSignal: signal });
    const networks = new Set(Object.keys(self.NetworkSettings.Networks));
    const database = this.config.get('database');
    const found: Dockerode.ContainerInspectInfo[] = [];
    for (const candidate of await this.docker.listContainers({ all: true, abortSignal: signal })) {
      signal.throwIfAborted();
      if (!Object.keys(candidate.NetworkSettings.Networks).some((network) => networks.has(network))) continue;
      const info = await this.docker.getContainer(candidate.Id).inspect({ abortSignal: signal });
      if (
        !Object.entries(info.NetworkSettings.Networks).some(
          ([network, endpoint]) =>
            networks.has(network) && [info.Name.replace(/^\//, ''), ...(endpoint.Aliases ?? []), endpoint.IPAddress].includes(database.host),
        )
      )
        continue;
      if (!info.State.Running || info.State.Paused || info.State.Restarting || !/(?:^|\/)postgres(?:[:@]|$)/.test(info.Config.Image)) throw failure();
      found.push(info);
    }
    if (found.length !== 1 || !found[0]) throw failure();
    const imageOptions: Dockerode.ImageInspectOptions & { abortSignal: AbortSignal } = { abortSignal: signal };
    const info = await this.docker.getImage(found[0].Image).inspect(imageOptions);
    return { image: info.Id, volumes: Object.keys(info.Config.Volumes ?? {}) };
  }

  async review(content: string, destination: string, signal: AbortSignal, progress: (bytes: number) => void): Promise<BackupDatabaseReview> {
    await this.initialize();
    if (this.running) throw failure();
    this.cancellation = new AbortController();
    const combined = AbortSignal.any([signal, this.cancellation.signal, AbortSignal.timeout(5 * 60_000)]);
    this.running = this.inspect(content, destination, combined, progress);
    try {
      return await this.running;
    } finally {
      this.running = undefined;
      this.cancellation = undefined;
    }
  }

  private async inspect(content: string, destination: string, signal: AbortSignal, progress: (bytes: number) => void) {
    const installed = await this.image(signal);
    const owner: Ownership = { version: 1, name: `orbis-database-review-${randomUUID()}`, nonce: randomUUID(), image: installed.image };
    await this.save(owner);
    let complete = false;
    let createdDestination = false;
    try {
      const options = backupDatabaseSandbox(installed.image, owner.name, owner.nonce, installed.volumes);
      const container = await this.docker.createContainer({ ...options, abortSignal: signal });
      const info = await container.inspect({ abortSignal: signal });
      const host = info.HostConfig;
      if (
        info.Image !== installed.image ||
        info.Config.User !== 'postgres' ||
        !(info.Config as typeof info.Config & { NetworkDisabled?: boolean }).NetworkDisabled ||
        host.NetworkMode !== 'none' ||
        !host.ReadonlyRootfs ||
        host.Privileged ||
        host.Memory !== options.HostConfig?.Memory ||
        host.MemorySwap !== host.Memory ||
        host.NanoCpus !== 1_000_000_000 ||
        host.PidsLimit !== 128 ||
        host.LogConfig?.Type !== 'none' ||
        host.CapAdd?.length ||
        !host.CapDrop?.includes('ALL') ||
        !host.SecurityOpt?.includes('no-new-privileges:true') ||
        host.Binds?.length ||
        host.Devices?.length ||
        host.DeviceRequests?.length ||
        host.VolumesFrom?.length ||
        (host.PortBindings && Object.keys(host.PortBindings).length) ||
        (info.Mounts ?? []).some((mount) => mount.Type !== 'tmpfs') ||
        Object.keys(options.HostConfig?.Tmpfs ?? {}).some((volume) => !host.Tmpfs?.[volume]) ||
        Object.keys(host.Tmpfs ?? {}).some((volume) => host.Tmpfs?.[volume] !== options.HostConfig?.Tmpfs?.[volume])
      )
        throw failure();
      await container.start({ abortSignal: signal });
      const run = (
        command: string[],
        maxOutputBytes = 16 * 1024,
        stdout: (chunk: Buffer) => Promise<void> = async () => undefined,
        source?: string,
      ) => backupDockerExec({ container, command, signal, maxOutputBytes, stdout, source });
      let ready = false;
      const deadline = Date.now() + 30_000;
      while (!ready && Date.now() < deadline) {
        try {
          await run(['pg_isready', '--quiet', '--dbname=postgres']);
          ready = true;
        } catch {
          signal.throwIfAborted();
          if (!(await container.inspect({ abortSignal: signal })).State.Running) throw failure();
          await delay(100, undefined, { signal });
        }
      }
      if (!ready) throw failure();
      await run(['createdb', '--no-password', 'orbis_review']);
      await run(
        [
          'pg_restore',
          '--exit-on-error',
          '--single-transaction',
          '--no-owner',
          '--no-acl',
          '--no-tablespaces',
          '--no-password',
          '--dbname=orbis_review',
        ],
        16 * 1024,
        async () => undefined,
        path.join(content, 'database.dump'),
      );
      const recovery = (await this.readJson(path.join(content, 'recovery.json'), 1024 * 1024)) as { jwtSecret?: unknown };
      if (!recovery || typeof recovery.jwtSecret !== 'string') throw failure();
      const validator = new BackupDatabaseRecords(recovery.jwtSecret);
      let passkeys: unknown;
      try {
        passkeys = await this.readJson(path.join(content, 'data/state/auth/passkeys.json'), 512 * 1024);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await fs.mkdir(destination, { mode: 0o700 });
      createdDestination = true;
      await privateBackupDirectory(destination);
      const output = await fs.open(path.join(destination, 'records.ndjson'), 'wx', 0o600);
      const digest = createHash('sha256');
      let bytes = 0;
      try {
        for (const table of backupDatabaseTables) {
          const lines = new BackupDatabaseLines(backupDatabaseLimits, async (value) => {
            signal.throwIfAborted();
            const row = validator.accept(table, value);
            const serialized = Buffer.from(`${JSON.stringify({ table, row })}\n`);
            bytes += serialized.length;
            if (bytes > backupDatabaseLimits.totalBytes) throw failure();
            let offset = 0;
            while (offset < serialized.length) {
              const result = await output.write(serialized, offset, serialized.length - offset);
              if (!result.bytesWritten) throw failure();
              offset += result.bytesWritten;
            }
            digest.update(serialized);
            progress(bytes);
          });
          const sql = `SELECT pg_catalog.row_to_json(record) FROM (SELECT ${backupDatabaseColumns(table).map(identifier).join(',')} FROM public.${identifier(table)} ORDER BY ${identifier(table === 'app_store' ? 'slug' : 'id')}) AS record`;
          await run(['psql', '-XqAt', '--no-password', '--set=ON_ERROR_STOP=1', '--command', sql], backupDatabaseLimits.totalBytes, (chunk) =>
            lines.write(chunk),
          );
          lines.finish();
        }
        const counts = await validator.finish(passkeys, signal);
        await output.sync();
        const result = { counts, bytes, sha256: digest.digest('hex') };
        const manifest = await fs.open(path.join(destination, 'records.json'), 'wx', 0o600);
        try {
          await manifest.writeFile(JSON.stringify({ version: 1, ...result }));
          await manifest.sync();
        } finally {
          await manifest.close();
        }
        const directory = await fs.open(destination, 'r');
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
        complete = true;
        return result;
      } finally {
        await output.close();
      }
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted();
      if (error instanceof BackupRequirementError) throw error;
      throw failure();
    } finally {
      try {
        if (!complete && createdDestination) await fs.rm(destination, { recursive: true, force: true });
      } finally {
        await this.cleanup();
      }
    }
  }

  private async readJson(file: string, maximum: number): Promise<unknown> {
    const input = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await input.stat();
      if (!stat.isFile() || stat.size > maximum || stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid())) throw failure();
      return JSON.parse(await input.readFile('utf8'));
    } finally {
      await input.close();
    }
  }
}
