import fs from 'node:fs';
import { EOL } from 'node:os';
import path from 'node:path';
import { APP_DATA_DIR, APP_DIR, DATA_DIR } from '@/common/constants';
import { LoggerService } from '@/core/logger/logger.service';
import { Injectable } from '@nestjs/common';
import type { z } from 'zod';

@Injectable()
export class FilesystemService {
  constructor(private readonly logger: LoggerService) {}

  private getSafeFilePath(filePath: string): string {
    // Define allowed directories as absolute paths
    const allowedDirs = [
      path.resolve(APP_DIR),
      path.resolve(APP_DATA_DIR),
      path.resolve(DATA_DIR),
      path.resolve('/host/proc/'),
      path.resolve('/tmp/'),
    ];

    // Resolve and normalize the file path to an absolute path
    const resolvedPath = path.resolve(filePath);

    for (const dir of allowedDirs) {
      if (path.relative(dir, resolvedPath).startsWith('..')) {
        continue; // If relative path starts with '..', it's outside the allowed dir
      }

      return resolvedPath;
    }

    this.logger.error(`File path "${filePath}" is not allowed. Resolved: "${resolvedPath}"`);
    throw new Error('File path is not allowed');
  }

  async readJsonFile<T extends object>(filePath: string, schema?: z.ZodType<T>): Promise<T | null> {
    try {
      const file = Bun.file(this.getSafeFilePath(filePath));
      const parsedContent = await file.json();

      if (schema) {
        const validatedContent = schema.safeParse(parsedContent);
        if (!validatedContent.success) {
          this.logger.debug(`File ${filePath} validation error:`, validatedContent.error);
          return null;
        }
        return validatedContent.data;
      }

      return parsedContent;
    } catch (error) {
      this.logger.debug(`Error reading file ${filePath}:`, error);
      return null;
    }
  }

  async readTextFile(filePath: string): Promise<string | null> {
    try {
      const file = Bun.file(this.getSafeFilePath(filePath));
      return await file.text();
    } catch (error) {
      this.logger.debug(`Error reading file ${filePath}:`, error);
      return null;
    }
  }

  async readBinaryFile(filePath: string): Promise<Buffer | null> {
    try {
      const file = Bun.file(this.getSafeFilePath(filePath));
      const arrayBuffer = await file.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (error) {
      this.logger.debug(`Error reading file ${filePath}:`, error);
      return null;
    }
  }

  async writeJsonFile<T>(filePath: string, data: T): Promise<boolean> {
    try {
      await Bun.write(this.getSafeFilePath(filePath), `${JSON.stringify(data, null, 2)}${EOL}`);
      return true;
    } catch (error) {
      this.logger.error(`Error writing file ${filePath}:`, error);
      return false;
    }
  }

  async writeTextFile(filePath: string, content: string): Promise<boolean> {
    try {
      const dirPath = this.getSafeFilePath(filePath.split('/').slice(0, -1).join('/'));
      await fs.promises.mkdir(dirPath, { recursive: true });
      await Bun.write(this.getSafeFilePath(filePath), `${content}${EOL}`);
      return true;
    } catch (error) {
      this.logger.error(`Error writing file ${filePath}:`, error);
      return false;
    }
  }

  async writeBinaryFile(filePath: string, data: Buffer): Promise<boolean> {
    try {
      const dirPath = this.getSafeFilePath(filePath.split('/').slice(0, -1).join('/'));
      await fs.promises.mkdir(dirPath, { recursive: true });
      await Bun.write(this.getSafeFilePath(filePath), data);
      return true;
    } catch (error) {
      this.logger.error(`Error writing binary file ${filePath}:`, error);
      return false;
    }
  }

  async pathExists(filePath: string): Promise<boolean> {
    return fs.promises
      .access(this.getSafeFilePath(filePath))
      .then(() => true)
      .catch(() => false);
  }

  async copyFile(src: string, dest: string): Promise<boolean> {
    try {
      const srcFile = Bun.file(this.getSafeFilePath(src));
      await Bun.write(this.getSafeFilePath(dest), srcFile);
      return true;
    } catch (error) {
      this.logger.error(`Error copying file from ${src} to ${dest}:`, error);
      return false;
    }
  }

  async createDirectory(dirPath: string): Promise<boolean> {
    try {
      await fs.promises.mkdir(this.getSafeFilePath(dirPath), { recursive: true });
      return true;
    } catch (error) {
      this.logger.error(`Error creating directory ${dirPath}:`, error);
      return false;
    }
  }

  async createDirectories(dirPaths: string[]): Promise<boolean> {
    for (const dirPath of dirPaths) {
      if (!(await this.createDirectory(this.getSafeFilePath(dirPath)))) {
        return false;
      }
    }
    return true;
  }

  async copyDirectory(src: string, dest: string, options: fs.CopyOptions = {}): Promise<boolean> {
    try {
      await fs.promises.cp(this.getSafeFilePath(src), this.getSafeFilePath(dest), { recursive: true, ...options });
      return true;
    } catch (error) {
      this.logger.error(`Error copying directory from ${src} to ${dest}:`, error);
      return false;
    }
  }

  async removeDirectory(dirPath: string): Promise<boolean> {
    try {
      await fs.promises.rm(this.getSafeFilePath(dirPath), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return true;
    } catch (error) {
      this.logger.error(`Error removing directory ${dirPath}:`, error);
      return false;
    }
  }

  async removeFile(filePath: string): Promise<boolean> {
    try {
      const file = Bun.file(this.getSafeFilePath(filePath));
      await file.delete();
      return true;
    } catch (error) {
      this.logger.error(`Error removing file ${filePath}:`, error);
      return false;
    }
  }

  async listFiles(dirPath: string): Promise<string[]> {
    try {
      return await fs.promises.readdir(this.getSafeFilePath(dirPath));
    } catch (error) {
      this.logger.error(`Error listing files in ${dirPath}:`, error);
      return [];
    }
  }

  async isDirectory(dirPath: string): Promise<boolean> {
    return (await fs.promises.lstat(this.getSafeFilePath(dirPath))).isDirectory();
  }

  async createTempDirectory(prefix: string): Promise<string | null> {
    return fs.promises.mkdtemp(prefix);
  }

  async getStats(filePath: string) {
    return await fs.promises.stat(this.getSafeFilePath(filePath));
  }

  async getFileEtag(filePath: string): Promise<string | null> {
    try {
      const stats = await this.getStats(filePath);
      return `"${stats.size.toString(16)}-${stats.mtime.getTime().toString(16)}"`;
    } catch {
      return null;
    }
  }
}
