import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CacheService } from './cache.service';

describe('Cached session enumeration', () => {
  let database: DatabaseSync;
  let cache: CacheService;
  let closed: boolean;

  beforeEach(() => {
    database = new DatabaseSync(':memory:');
    database.exec('CREATE TABLE keyv (key TEXT PRIMARY KEY, value TEXT)');
    cache = Object.create(CacheService.prototype) as CacheService;
    Object.defineProperty(cache, 'db', { value: database });
    closed = false;
  });

  afterEach(() => {
    if (!closed) database.close();
  });

  it('returns the actual matching session indexes and preserves unrelated entries', async () => {
    cache.set('session:41:one', 'session:one');
    cache.set('session:42:other', 'session:other');
    await expect(cache.getByPrefix('session:41:')).resolves.toEqual([{ key: 'session:41:one', val: 'session:one' }]);
    expect(cache.get('session:42:other')).toBe('session:other');
  });

  it('returns an empty list only when the database successfully has no matches', async () => {
    await expect(cache.getByPrefix('session:41:')).resolves.toEqual([]);
  });

  it('does not report a closed SQLite connection as zero remaining sessions', async () => {
    cache.set('session:41:one', 'session:one');
    database.close();
    closed = true;
    await expect(cache.getByPrefix('session:41:')).rejects.toThrow('Could not read cached session records');
  });

  it.each(['not-json', 'null', '{}', '{"value":41}'])('does not hide an unreadable matching session index (%s)', async (value) => {
    database.prepare('INSERT INTO keyv (key, value) VALUES (?, ?)').run('session:41:one', value);
    await expect(cache.getByPrefix('session:41:')).rejects.toThrow('Could not read cached session records');
  });
});
