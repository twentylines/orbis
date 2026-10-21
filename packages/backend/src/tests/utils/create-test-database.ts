import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client } from 'pg';
import * as schema from '../../core/database/drizzle/schema';

export type TestDatabase = Awaited<ReturnType<typeof createTestDatabase>>;

const port = Number(process.env.ORBIS_TEST_DB_PORT ?? 5433);

const getClient = () => {
  return new Client({
    user: 'postgres',
    host: 'localhost',
    database: 'postgres',
    password: 'postgres',
    port,
  });
};

export const createTestDatabase = async (testsuite: string) => {
  const client = getClient();
  await client.connect();

  await client.query(`DROP DATABASE IF EXISTS ${testsuite}`);
  await client.query(`CREATE DATABASE ${testsuite}`);

  await client.end();

  const connectionString = `postgresql://postgres:postgres@localhost:${port}/${testsuite}?connect_timeout=300`;
  const drizzleClient = drizzle(connectionString, { schema });

  const __dirname = path.dirname(fileURLToPath(import.meta.url));

  await migrate(drizzleClient, { migrationsFolder: path.join(__dirname, '..', '..', 'core', 'database', 'drizzle') }).catch((e) => {
    console.error('Failed to run migrations', e);
  });

  return drizzleClient;
};

export const dropTestDatabase = async (testsuite: string) => {
  const client = getClient();
  await client.connect();

  await client.query(`DROP DATABASE IF EXISTS ${testsuite}`);

  await client.end();
};

export const cleanTestData = async (db: TestDatabase) => {
  await db.delete(schema.link);
  await db.delete(schema.app);
  await db.delete(schema.user);
  await db.delete(schema.appStore);
};
