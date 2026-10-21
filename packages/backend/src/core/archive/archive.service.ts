import { spawnAsync } from '@/common/helpers/exec-helpers';
import { LoggerService } from '@/core/logger/logger.service';
import { Injectable } from '@nestjs/common';

export type ArchiveEntry = { path: string; type: string };

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

    const verboseArgs = mimeType === 'application/x-tar' ? ['-tvf', sourceFile] : ['-tzvf', sourceFile];
    const pathArgs = mimeType === 'application/x-tar' ? ['-tf', sourceFile] : ['-tzf', sourceFile];

    this.logger.debug(`Listing archive with args: tar ${verboseArgs.join(' ')}`);
    const [verboseList, pathList] = await Promise.all([
      options ? spawnAsync('tar', verboseArgs, options) : spawnAsync('tar', verboseArgs),
      options ? spawnAsync('tar', pathArgs, options) : spawnAsync('tar', pathArgs),
    ]);
    signal?.throwIfAborted();

    if (verboseList.stderr.trim() || pathList.stderr.trim()) {
      throw new Error('Invalid backup archive');
    }

    const verboseLines = verboseList.stdout.split('\n').filter(Boolean);
    const paths = pathList.stdout.split('\n').filter(Boolean);

    if (verboseLines.length !== paths.length) {
      throw new Error('Invalid backup archive');
    }

    return paths.map((entryPath, index) => ({ path: entryPath, type: verboseLines[index]?.[0] ?? '' }));
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
