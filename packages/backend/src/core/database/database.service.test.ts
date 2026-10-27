import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import type { ConfigurationService } from '../config/configuration.service';
import type { LoggerService } from '../logger/logger.service';
import { DatabaseService } from './database.service';

describe('DatabaseService PostgreSQL connection options', () => {
  let service: DatabaseService | undefined;

  afterEach(async () => {
    if (service) await (service.db as unknown as { $client: Pool }).$client.end();
    service = undefined;
  });

  it('preserves punctuation credentials, IPv6 host, database, port and timeout in a real pg Pool without connecting', () => {
    const database = {
      username: 'qa.user+orbis@example.invalid',
      password: 'synthetic @:/?#[]% & =+!$ value',
      database: 'orbis qa/db?one',
      host: '2001:db8::7',
      port: 55432,
    };
    const configuration = {
      get: vi.fn((key: string) => (key === 'database' ? database : {})),
    } as unknown as ConfigurationService;
    service = new DatabaseService(configuration, {} as LoggerService);

    const pool = (service.db as unknown as { $client: Pool }).$client;
    expect(pool.options).toMatchObject({
      user: database.username,
      password: database.password,
      database: database.database,
      host: database.host,
      port: database.port,
      connectionTimeoutMillis: 300_000,
    });
    expect(pool.totalCount).toBe(0);
    expect(pool.idleCount).toBe(0);
    expect(pool.waitingCount).toBe(0);
    expect(configuration.get).toHaveBeenCalledWith('database');
  });
});
