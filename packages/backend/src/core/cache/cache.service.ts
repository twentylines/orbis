import { DatabaseSync } from 'node:sqlite';
import { Injectable } from '@nestjs/common';
import { restoreStartupRole } from '@/modules/system-backups/backup-restore-startup';

export const ONE_DAY_IN_SECONDS = 60 * 60 * 24;

@Injectable()
export class CacheService {
  private db: DatabaseSync;

  constructor() {
    this.db = new DatabaseSync(restoreStartupRole() === 'verify' ? ':memory:' : '/cache/cache.sqlite');

    const tableCheck = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").get();

    if (!tableCheck) {
      this.db.exec('CREATE TABLE keyv (key TEXT PRIMARY KEY, value TEXT)');
    }
  }

  public set(key: string, value: string, expiration = ONE_DAY_IN_SECONDS) {
    const stmt = this.db.prepare('INSERT OR REPLACE INTO keyv (key, value) VALUES (?, ?)');
    stmt.run(key, JSON.stringify({ value, expiration: Math.max(Date.now() + expiration * 1000, expiration) }));
  }

  public get(key: string) {
    const query = this.db.prepare('SELECT * FROM keyv WHERE key = ?');
    const row = query.get(key) as { value: string } | undefined;

    if (!row) {
      return undefined;
    }

    const { value, expiration = 0 } = JSON.parse(row.value) as { value: string; expiration: number };
    if (expiration < Date.now()) {
      this.del(key);
      return undefined;
    }

    return value;
  }

  public del(key: string) {
    const stmt = this.db.prepare('DELETE FROM keyv WHERE key = ?');
    stmt.run(key);
  }

  public async getByPrefix(prefix: string) {
    try {
      const query = this.db.prepare('SELECT * FROM keyv WHERE key LIKE ?');
      const rows = query.all(`${prefix}%`) as { key: string; value: string }[];

      return rows.map((row) => {
        const record: unknown = JSON.parse(row.value);
        if (!record || typeof record !== 'object' || !('value' in record) || typeof record.value !== 'string') {
          throw new Error('Invalid cached session record');
        }
        return { key: row.key, val: record.value };
      });
    } catch {
      throw new Error('Could not read cached session records');
    }
  }

  public clear() {
    const stmt = this.db.prepare('DELETE FROM keyv');
    stmt.run();
  }
}
