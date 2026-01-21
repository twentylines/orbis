import { spawnAsync } from '@/common/helpers/exec-helpers';
import { LoggerService } from '@/core/logger/logger.service';
import { Injectable } from '@nestjs/common';

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
}
