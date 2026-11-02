import { BadRequestException, ConflictException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import {
  accountSecuritySchema,
  accountSecurityUpdateSchema,
  defaultAccountSecurity,
  type AccountSecurity,
} from '@runtipi/common/schemas/account-security';
import { ConfigurationService } from '@/core/config/configuration.service';
import { type } from 'arktype';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

@Injectable()
export class AccountSecurityService {
  private readonly writes = new Map<number, Promise<unknown>>();
  constructor(private readonly config: ConfigurationService) {}
  private file(ownerId: number) {
    if (!Number.isSafeInteger(ownerId) || ownerId <= 0) throw new BadRequestException('Choose a valid account.');
    return path.join(this.config.get('directories').dataDir, 'state', 'account-security', `${ownerId}.json`);
  }
  async read(ownerId: number): Promise<AccountSecurity> {
    try {
      const handle = await fs.open(this.file(ownerId), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 || stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid()))
          throw new Error('Unsafe policy file');
        const value = accountSecuritySchema(JSON.parse(await handle.readFile('utf8')));
        if (value instanceof type.errors) throw new Error('Unsupported policy');
        return { ...value, requireRestoreAuthentication: value.requireRestoreAuthentication ?? false };
      } finally {
        await handle.close();
      }
    } catch (reason) {
      if ((reason as NodeJS.ErrnoException).code === 'ENOENT') return defaultAccountSecurity();
      throw new ServiceUnavailableException('Account security could not be verified. Check this account’s security settings before continuing.');
    }
  }
  async update(ownerId: number, body: unknown, authorizeRelaxation: () => Promise<unknown>) {
    const next = accountSecurityUpdateSchema(body);
    if (next instanceof type.errors) throw new BadRequestException('Review the account capture security setting.');
    const work = (this.writes.get(ownerId) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        const current = await this.read(ownerId);
        if (current.revision !== next.expectedRevision) throw new ConflictException('This account security setting changed. Refresh before saving.');
        const restore = next.requireRestoreAuthentication ?? current.requireRestoreAuthentication ?? false;
        if ((current.requireCaptureAuthentication && !next.requireCaptureAuthentication) || (current.requireRestoreAuthentication && !restore))
          await authorizeRelaxation();
        if (current.requireCaptureAuthentication === next.requireCaptureAuthentication && current.requireRestoreAuthentication === restore)
          return current;
        const value = {
          version: 1 as const,
          revision: current.revision + 1,
          requireCaptureAuthentication: next.requireCaptureAuthentication,
          requireRestoreAuthentication: restore,
        };
        const file = this.file(ownerId);
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        const temporary = `${file}.${randomUUID()}.tmp`;
        try {
          const handle = await fs.open(temporary, 'wx', 0o600);
          try {
            await handle.writeFile(`${JSON.stringify(value)}\n`);
            await handle.sync();
          } finally {
            await handle.close();
          }
          await fs.rename(temporary, file);
          const parent = await fs.open(path.dirname(file), 'r');
          try {
            await parent.sync();
          } finally {
            await parent.close();
          }
        } finally {
          await fs.rm(temporary, { force: true });
        }
        return value;
      });
    this.writes.set(ownerId, work);
    void work
      .finally(() => {
        if (this.writes.get(ownerId) === work) this.writes.delete(ownerId);
      })
      .catch(() => undefined);
    return work;
  }
}
