import { spawnAsync } from '@/common/helpers/exec-helpers';
import { LoggerService } from '@/core/logger/logger.service';
import { Injectable } from '@nestjs/common';
import { readTarMetadata } from './tar-metadata';

export type { ArchiveEntry } from './tar-metadata';
import type { ArchiveEntry } from './tar-metadata';

@Injectable()
export class ArchiveService {
  constructor(private readonly logger: LoggerService) {}

  createTarGz = async (sourceDir: string, destinationFile: string) => {
    const args = ['--format=pax', '-czpf', destinationFile, '-C', sourceDir, '.'];
    this.logger.debug(`Creating archive with args: tar ${args.join(' ')}`);
    return spawnAsync('tar', args);
  };

  extractTarGz = async (sourceFile: string, destinationDir: string) => {
    const fileType = await spawnAsync('file', ['--brief', '--mime-type', sourceFile]);
    const mimeType = fileType.stdout.trim();

    let args = ['-xzpf', sourceFile, '-C', destinationDir];

    if (mimeType === 'application/x-tar') {
      args = ['-xpf', sourceFile, '-C', destinationDir];
    }

    this.logger.debug(`Extracting archive with args: tar ${args.join(' ')}`);
    return await spawnAsync('tar', args);
  };

  listTarGz = async (sourceFile: string, signal?: AbortSignal): Promise<ArchiveEntry[]> => {
    signal?.throwIfAborted();
    const options = signal ? { signal } : undefined;
    const fileType = options
      ? await spawnAsync('file', ['--brief', '--mime-type', sourceFile], options)
      : await spawnAsync('file', ['--brief', '--mime-type', sourceFile]);
    const mimeType = fileType.stdout.trim();
    if (fileType.stderr.trim()) throw new Error('Invalid backup archive');

    if (!['application/x-tar', 'application/gzip', 'application/x-gzip'].includes(mimeType)) throw new Error('Invalid backup archive');
    return readTarMetadata(sourceFile, mimeType !== 'application/x-tar', signal);
  };

  readTarConfig = async (sourceFile: string, entry: string, signal?: AbortSignal): Promise<string> => {
    signal?.throwIfAborted();
    const fileType = await spawnAsync('file', ['--brief', '--mime-type', sourceFile], signal ? { signal } : undefined);
    if (fileType.stderr.trim()) throw new Error('Invalid backup archive');
    const flags = fileType.stdout.trim() === 'application/x-tar' ? '-xOf' : '-xzOf';
    return new Promise((resolve, reject) => {
      const child = spawn('tar', [flags, sourceFile, '--', entry], { signal, stdio: ['ignore', 'pipe', 'pipe'] });
      const chunks: Buffer[] = [];
      let bytes = 0;
      let failure: Error | undefined;
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) {
          failure = new Error('Backup app configuration exceeds 1 MiB');
          child.kill();
        } else if (!failure) chunks.push(chunk);
      });
      child.stderr.on('data', () => {
        failure ??= new Error('Invalid backup app configuration');
      });
      child.on('error', (error) => {
        failure = error;
      });
      child.on('close', (code) => {
        if (failure || code !== 0) reject(failure ?? new Error('Invalid backup app configuration'));
        else resolve(Buffer.concat(chunks).toString('utf8'));
      });
    });
  };
}
import { spawn } from 'node:child_process';
