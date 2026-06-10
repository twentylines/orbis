import { spawnAsync } from '@/common/helpers/exec-helpers';
import { LoggerService } from '@/core/logger/logger.service';
import { Injectable } from '@nestjs/common';

export type ArchiveEntry = { path: string; type: string };

@Injectable()
export class ArchiveService {
  constructor(private readonly logger: LoggerService) {}

  createTarGz = async (sourceDir: string, destinationFile: string) => {
    const args = ['-czpf', destinationFile, '-C', sourceDir, '.'];
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

  listTarGz = async (sourceFile: string): Promise<ArchiveEntry[]> => {
    const fileType = await spawnAsync('file', ['--brief', '--mime-type', sourceFile]);
    const mimeType = fileType.stdout.trim();

    const args = mimeType === 'application/x-tar' ? ['-tvf', sourceFile] : ['-tzvf', sourceFile];

    this.logger.debug(`Listing archive with args: tar ${args.join(' ')}`);
    const { stdout, stderr } = await spawnAsync('tar', args);

    if (stderr.trim()) {
      throw new Error('Invalid backup archive');
    }

    return stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => ({ path: this.getTarListPath(line), type: line[0] ?? '' }));
  };

  private getTarListPath(line: string) {
    return line.split(/\s+/).slice(8).join(' ');
  }
}
