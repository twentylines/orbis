import fs from 'node:fs/promises';
import path from 'node:path';
import { BackupRequirementError } from './backup-files';
import { fullBackupLimits } from './backup-limits';

export class BackupExtractionBudget {
  private directories = new Set<string>(['.']);
  private nodes = 0;
  private pathBytes = 0;
  private remainingBytes = 0;
  private remainingInodes = 0;
  private blockSize = 4096;
  private operations = 128;
  private sinceCheck = 0;

  constructor(private readonly directory: string) {}

  private async refresh() {
    const stat = await fs.statfs(this.directory);
    const blockSize = Number(stat.bsize);
    if (!Number.isSafeInteger(blockSize) || blockSize <= 0 || blockSize > 16 * 1024 * 1024)
      throw new BackupRequirementError('Filesystem capacity could not be checked for this backup.');
    this.blockSize = blockSize;
    this.remainingBytes = Math.max(0, Math.floor(Number(stat.bavail) * blockSize - fullBackupLimits.reserveBytes));
    this.remainingInodes = Math.max(0, Number(stat.ffree) - fullBackupLimits.reserveInodes);
    if (!Number.isFinite(this.remainingBytes) || !Number.isFinite(this.remainingInodes))
      throw new BackupRequirementError('Filesystem capacity could not be checked for this backup.');
    this.operations = 0;
  }

  async reserve(name: string, type: string, size: number) {
    if (name === '.') return;
    const directories: string[] = [];
    let parent = type === 'd' ? name : path.posix.dirname(name);
    while (parent !== '.') {
      if (!this.directories.has(parent)) directories.push(parent);
      parent = path.posix.dirname(parent);
    }
    const count = directories.length + (type === '-' ? 1 : 0);
    const pathBytes = directories.reduce((total, value) => total + Buffer.byteLength(value), 0) + (type === '-' ? Buffer.byteLength(name) : 0);
    if (this.nodes + count > fullBackupLimits.entries + 10 || this.pathBytes + pathBytes > fullBackupLimits.pathBytes + 4096)
      throw new BackupRequirementError('This backup exceeds the supported inventory size. No server data has been changed.');
    if (this.operations >= 128) await this.refresh();
    const required = () =>
      directories.length * this.blockSize * 2 + (type === '-' ? Math.ceil(size / this.blockSize) * this.blockSize + this.blockSize : 0);
    if (required() > this.remainingBytes || count > this.remainingInodes) await this.refresh();
    if (required() > this.remainingBytes || count > this.remainingInodes)
      throw new BackupRequirementError('There is not enough free storage or file entries to inspect this backup.');
    this.remainingBytes -= required();
    this.remainingInodes -= count;
    this.operations += count;
    this.nodes += count;
    this.pathBytes += pathBytes;
    for (const directory of directories) this.directories.add(directory);
  }

  async written(bytes: number) {
    this.sinceCheck += bytes;
    if (this.sinceCheck < 16 * 1024 * 1024) return;
    this.sinceCheck = 0;
    const stat = await fs.statfs(this.directory);
    if (Number(stat.bavail) * Number(stat.bsize) < fullBackupLimits.reserveBytes + 16 * 1024 * 1024)
      throw new BackupRequirementError('Backup inspection is stopping because free storage is low. No server data has been changed.');
  }
}
