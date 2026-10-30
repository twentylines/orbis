import { BadRequestException, ConflictException } from '@nestjs/common';
import { themeSettingsByteLimit, themeSettingsDocumentSchema, type ThemeSettingsDocument } from '@runtipi/common/schemas/theme-settings';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const review = () => new ConflictException('Saved theme settings need a storage review.');
export const emptyThemeSettings = (): ThemeSettingsDocument => ({
  formatVersion: 1,
  revision: 0,
  legacyMigration: 'pending',
  settings: { formatVersion: 1, entries: [] },
});

export class ThemeSettingsStore {
  constructor(private readonly dataDir: string) {}

  private async directory(create: boolean) {
    let folder = path.resolve(this.dataDir);
    for (const [index, name] of ['state', 'theme-settings'].entries()) {
      folder = path.join(folder, name);
      if (create)
        await fs.mkdir(folder, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
        });
      const details = await fs.lstat(folder);
      if (
        !details.isDirectory() ||
        details.isSymbolicLink() ||
        details.uid !== process.getuid?.() ||
        (index === 0 ? details.mode & 0o002 : details.mode & 0o077)
      )
        throw review();
    }
    return folder;
  }

  private account(userId: number) {
    if (!Number.isSafeInteger(userId) || userId < 1) throw new BadRequestException('Invalid account.');
    return `${userId}.json`;
  }

  async read(userId: number): Promise<ThemeSettingsDocument> {
    const name = this.account(userId);
    try {
      const folder = await this.directory(false);
      const handle = await fs.open(path.join(folder, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const details = await handle.stat();
        if (
          !details.isFile() ||
          details.nlink !== 1 ||
          details.uid !== process.getuid?.() ||
          details.mode & 0o077 ||
          details.size > themeSettingsByteLimit
        )
          throw review();
        const bytes = Buffer.alloc(details.size + 1);
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        const after = await handle.stat();
        if (offset !== details.size || after.size !== details.size || after.mtimeMs !== details.mtimeMs) throw review();
        const parsed: unknown = JSON.parse(bytes.subarray(0, offset).toString('utf8'));
        if (!themeSettingsDocumentSchema.allows(parsed)) throw review();
        return parsed;
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyThemeSettings();
      if (error instanceof ConflictException) throw error;
      throw review();
    }
  }

  async write(userId: number, document: ThemeSettingsDocument) {
    const name = this.account(userId);
    if (!themeSettingsDocumentSchema.allows(document)) throw review();
    const bytes = `${JSON.stringify(document)}\n`;
    if (Buffer.byteLength(bytes) > themeSettingsByteLimit) throw new BadRequestException('Theme settings are too large.');
    const folder = await this.directory(true);
    const before = await fs.lstat(folder);
    const temporary = path.join(folder, `.settings-${randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.directory(false);
      const current = await fs.lstat(folder);
      if (current.dev !== before.dev || current.ino !== before.ino) throw review();
      await fs.rename(temporary, path.join(folder, name));
      const parent = await fs.open(folder, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
}
