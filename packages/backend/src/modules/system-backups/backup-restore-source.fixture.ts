import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { backupDatabaseTables } from './backup-database-records';
import { createBackupSourceSeal } from './backup-restore-source';
import type { BackupDatabaseReview } from './backup-database.service';
import type { FullBackupManifest } from './backup-import';

export type ReviewedBackupRow = { table: (typeof backupDatabaseTables)[number]; row: Record<string, unknown> };
export type ReviewedBackupFixture = {
  directory: string;
  content: string;
  normalized: string;
  seal: ReturnType<typeof createBackupSourceSeal>;
  manifest: FullBackupManifest;
};
export type ReviewedBackupFixtureOptions = { dbStatus?: string; manifestRunning?: boolean };

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const jwtSecret = 'fixture-jwt-secret';
const appProject = 'fixture-app_catalogue';
export const reviewedBackupAppConfig = {
  id: 'fixture-app',
  urn: 'fixture-app:catalogue',
  available: true,
  name: 'Fixture App',
  short_desc: 'A fixture app',
  author: 'Fixture',
  source: 'https://example.invalid/fixture',
  tipi_version: 1,
  created_at: 0,
  updated_at: 0,
};

export function reviewedBackupRows(status: string): ReviewedBackupRow[] {
  return [
    {
      table: 'user',
      row: {
        id: 1,
        username: 'fixture@example.invalid',
        password: '$argon2id$v=19$m=8192,t=1,p=1$AQEBAQEBAQEBAQEBAQEBAQ$AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI',
        created_at: 1_700_000_000,
        updated_at: 1_700_000_001,
        operator: true,
        totp_secret: null,
        totp_enabled: false,
        salt: null,
        locale: 'en',
        has_seen_welcome: true,
      },
    },
    {
      table: 'app_store',
      row: {
        slug: 'catalogue',
        hash: 'fixture-store-hash',
        name: 'Catalogue',
        enabled: true,
        url: 'https://example.invalid/catalogue.git',
        branch: 'main',
        created_at: 1_700_000_000,
        updated_at: 1_700_000_001,
      },
    },
    {
      table: 'app',
      row: {
        id: 9,
        status,
        config: { fixture: true },
        created_at: 1_700_000_000,
        updated_at: 1_700_000_001,
        version: 1,
        ignored_version: null,
        exposed: false,
        domain: null,
        is_visible_on_guest_dashboard: false,
        open_port: true,
        port: null,
        exposed_local: false,
        app_store_slug: 'catalogue',
        app_name: 'fixture-app',
        enable_auth: false,
        subnet: null,
        local_subdomain: null,
        pending_restart: false,
        user_config_enabled: true,
        max_backups: null,
        template_urn: null,
        last_template_sync_at: null,
        template_version: null,
      },
    },
  ];
}

export async function fileMetadata(content: string, name: string) {
  const file = path.join(content, name);
  const bytes = await fs.readFile(file);
  const stat = await fs.stat(file);
  return { name, bytes: bytes.length, sha256: sha256(bytes), mode: stat.mode & 0o777, uid: stat.uid, gid: stat.gid, mtime: stat.mtimeMs };
}

export async function directoryMetadata(content: string, name: string) {
  const stat = await fs.stat(path.join(content, name));
  return { name, mode: stat.mode & 0o777, uid: stat.uid, gid: stat.gid, mtime: stat.mtimeMs };
}

export async function makeReviewedBackupFixture(parentDirectory: string, options: ReviewedBackupFixtureOptions = {}): Promise<ReviewedBackupFixture> {
  const directory = path.join(parentDirectory, `source-${Math.random().toString(16).slice(2)}`);
  const content = path.join(directory, 'content');
  const data = path.join(content, 'data');
  const database = path.join(directory, 'database');
  const appDirectory = path.join(data, 'apps', 'catalogue', 'fixture-app');
  await fs.mkdir(path.join(data, 'state'), { recursive: true, mode: 0o700 });
  await fs.mkdir(appDirectory, { recursive: true, mode: 0o700 });
  await fs.mkdir(database, { mode: 0o700 });
  await fs.chmod(directory, 0o700);
  await fs.chmod(content, 0o700);
  await fs.chmod(database, 0o700);
  await fs.writeFile(path.join(data, 'state', 'seed'), 'fixture-state', { mode: 0o600 });
  await fs.writeFile(path.join(appDirectory, 'config.json'), JSON.stringify(reviewedBackupAppConfig), { mode: 0o600 });
  await fs.writeFile(path.join(appDirectory, 'docker-compose.yml'), 'services: {}\n', { mode: 0o600 });
  await fs.writeFile(path.join(content, 'recovery.json'), JSON.stringify({ jwtSecret, userSettings: { timeZone: 'UTC' } }), { mode: 0o600 });
  const dump = Buffer.from('PGDMP-disposable-fixture-dump');
  await fs.writeFile(path.join(content, 'database.dump'), dump, { mode: 0o600 });

  const databaseRows = reviewedBackupRows(options.dbStatus ?? 'stopped');
  const records = Buffer.from(`${databaseRows.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  const counts = Object.fromEntries(
    backupDatabaseTables.map((table) => [table, databaseRows.filter((entry) => entry.table === table).length]),
  ) as BackupDatabaseReview['counts'];
  const normalized: BackupDatabaseReview = { counts, bytes: records.length, sha256: sha256(records) };
  await fs.writeFile(path.join(database, 'records.ndjson'), records, { mode: 0o600 });
  await fs.writeFile(path.join(database, 'records.json'), JSON.stringify({ version: 1, ...normalized }), { mode: 0o600 });

  const files = await Promise.all([
    fileMetadata(content, 'data/state/seed'),
    fileMetadata(content, 'data/apps/catalogue/fixture-app/config.json'),
    fileMetadata(content, 'data/apps/catalogue/fixture-app/docker-compose.yml'),
  ]);
  const directories = await Promise.all(
    ['data/state', 'data/apps', 'data/apps/catalogue', 'data/apps/catalogue/fixture-app'].map((name) => directoryMetadata(content, name)),
  );
  const manifest: FullBackupManifest = {
    format: 'orbis-full-backup',
    version: 1,
    createdAt: Date.now(),
    orbisVersion: 'v1.0.0',
    runtipiVersion: '4.10.1',
    architecture: 'arm64',
    files,
    directories,
    containers: [{ id: 'a'.repeat(64), project: appProject, running: options.manifestRunning ?? true }],
    images: [{ project: appProject, image: 'fixture-image:latest' }],
    exclusions: ['logs', 'cache', 'previous-backups', 'container-images', 'restore-recovery-files'],
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  await fs.writeFile(path.join(content, 'manifest.json'), manifestBytes, { mode: 0o600 });
  const recovery = await fs.readFile(path.join(content, 'recovery.json'));
  const integrity = {
    manifest: { bytes: manifestBytes.length, sha256: sha256(manifestBytes) },
    recovery: { bytes: recovery.length, sha256: sha256(recovery) },
    database: { bytes: dump.length, sha256: sha256(dump) },
  };
  return { directory, content, normalized: path.join(database, 'records.json'), seal: createBackupSourceSeal(integrity, normalized), manifest };
}
