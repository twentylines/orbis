import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { privateBackupDirectory } from './backup-files';

export type BackupRetentionSettings = { version: 1; revision: number; retentionHours: number };
export function parseBackupRetentionUpdate(value: unknown): { revision: number; retentionHours: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('Choose a valid backup retention period.');
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => !['revision', 'retentionHours'].includes(key)) ||
    !Number.isSafeInteger(record.revision) ||
    Number(record.revision) < 0 ||
    !Number.isSafeInteger(record.retentionHours) ||
    Number(record.retentionHours) < 24 ||
    Number(record.retentionHours) > 8760
  )
    throw new BadRequestException('Choose a backup retention period from 24 hours to one year.');
  return { revision: record.revision as number, retentionHours: record.retentionHours as number };
}
export function backupExpiresAt(createdAt: number, retentionHours: number, previous?: number) {
  return Math.max(previous ?? 0, createdAt + retentionHours * 60 * 60_000);
}
export class BackupRetentionPolicy {
  private ready?: Promise<BackupRetentionSettings>;
  private writing: Promise<unknown> = Promise.resolve();
  constructor(private readonly directory: string) {}
  read() {
    this.ready ??= this.load();
    return this.ready.then((value) => ({ ...value }));
  }
  private async load(): Promise<BackupRetentionSettings> {
    await privateBackupDirectory(this.directory);
    const file = path.join(this.directory, 'retention.json');
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 4096 || stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid()))
        throw new Error('Unsafe backup retention settings.');
      const value = JSON.parse(await handle.readFile('utf8'));
      if (value.version !== 1 || Object.keys(value).some((key) => !['version', 'revision', 'retentionHours'].includes(key)))
        throw new Error('Invalid backup retention settings.');
      return { version: 1, ...parseBackupRetentionUpdate({ revision: value.revision, retentionHours: value.retentionHours }) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, revision: 0, retentionHours: 24 };
      throw error;
    } finally {
      await handle?.close();
    }
  }
  update(input: unknown): Promise<BackupRetentionSettings> {
    const value = parseBackupRetentionUpdate(input);
    const task = this.writing.then(async () => {
      const current = await this.read();
      if (value.revision !== current.revision) throw new ConflictException('Backup settings changed. Refresh settings before saving again.');
      const next: BackupRetentionSettings = { version: 1, revision: current.revision + 1, retentionHours: value.retentionHours };
      const temporary = path.join(this.directory, `.${randomUUID()}.tmp`);
      try {
        const handle = await fs.open(temporary, 'wx', 0o600);
        try {
          await handle.writeFile(JSON.stringify(next));
          await handle.sync();
        } finally {
          await handle.close();
        }
        await fs.rename(temporary, path.join(this.directory, 'retention.json'));
        const parent = await fs.open(this.directory, 'r');
        try {
          await parent.sync();
        } finally {
          await parent.close();
        }
        this.ready = Promise.resolve(next);
        return { ...next };
      } finally {
        await fs.rm(temporary, { force: true });
      }
    });
    this.writing = task.catch(() => undefined);
    return task;
  }
}
