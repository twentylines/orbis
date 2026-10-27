import { createCipheriv, createHash, pbkdf2Sync, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { backupDatabaseTables, type BackupDatabaseTable } from './backup-database-records';
import { readNormalizedBackupDatabase } from './backup-normalized-database';
import type { BackupDatabaseReview } from './backup-database.service';

type Row = Record<string, unknown>;
type Entry = { table: BackupDatabaseTable; row: Row };

let directory: string;
let file: string;
const jwtSecret = randomBytes(32).toString('hex');

beforeEach(async () => {
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-normalized-database-')));
  await fs.chmod(directory, 0o700);
  file = path.join(directory, 'database.jsonl');
});

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

function passwordHash() {
  const salt = Buffer.alloc(16, 1).toString('base64').replace(/=+$/, '');
  const digest = Buffer.alloc(32, 2).toString('base64').replace(/=+$/, '');
  return `$argon2id$v=19$m=8192,t=1,p=1$${salt}$${digest}`;
}

function databaseRows(): Entry[] {
  return [
    {
      table: 'user',
      row: {
        id: 1,
        username: 'fixture@example.invalid',
        password: passwordHash(),
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
        name: 'Fixture store',
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
        id: 1,
        status: 'stopped',
        config: { port: 8080, environment: { FIXTURE_MESSAGE: 'fixture content' }, nested: [true, null, 1.5] },
        created_at: 1_700_000_000,
        updated_at: 1_700_000_001,
        version: 3,
        ignored_version: 4,
        exposed: false,
        domain: null,
        is_visible_on_guest_dashboard: true,
        open_port: true,
        port: 8080,
        exposed_local: true,
        app_store_slug: 'catalogue',
        app_name: 'fixture-app',
        enable_auth: true,
        subnet: '10.50.1.0/24',
        local_subdomain: 'fixture',
        pending_restart: true,
        user_config_enabled: true,
        max_backups: 7,
        template_urn: 'template:fixture',
        last_template_sync_at: 1_700_000_002,
        template_version: 2,
      },
    },
    {
      table: 'link',
      row: {
        id: 1,
        title: 'Fixture link',
        url: 'https://example.invalid/',
        icon_url: null,
        created_at: 1_700_000_000,
        updated_at: 1_700_000_001,
        user_id: 1,
        description: null,
        is_visible_on_guest_dashboard: false,
      },
    },
  ];
}

function entryAt(entries: Entry[], index: number): Entry {
  const entry = entries[index];
  if (!entry) throw new Error('Missing fixture row');
  return entry;
}

function encode(entries: Entry[]) {
  return Buffer.from(`${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
}

function review(bytes: Buffer, entries: Entry[]): BackupDatabaseReview {
  const counts = Object.fromEntries(
    backupDatabaseTables.map((table) => [table, entries.filter((entry) => entry.table === table).length]),
  ) as BackupDatabaseReview['counts'];
  return { counts, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

async function save(bytes: Buffer, mode = 0o600) {
  await fs.writeFile(file, bytes, { flag: 'w', mode });
  await fs.chmod(file, mode);
}

function source(expected: BackupDatabaseReview, passkeys?: unknown) {
  return { file, expected, jwtSecret, passkeys };
}

it('reads every table in declared order from a private directory and 0600 file, binding rows to exact bytes and digest', async () => {
  const entries = databaseRows();
  const bytes = encode(entries);
  await save(bytes);

  const directoryStat = await fs.stat(directory);
  const fileStat = await fs.stat(file);
  expect(directoryStat.mode & 0o777).toBe(0o700);
  expect(fileStat.mode & 0o777).toBe(0o600);
  expect(fileStat.uid).toBe(process.getuid?.() ?? fileStat.uid);

  const accepted: Entry[] = [];
  await expect(
    readNormalizedBackupDatabase(source(review(bytes, entries)), new AbortController().signal, async (table, row) => {
      accepted.push({ table, row });
    }),
  ).resolves.toEqual({ counts: { user: 1, app_store: 1, app: 1, link: 1 }, bytes: bytes.length });
  expect(accepted).toEqual(entries);
  expect(accepted.map(({ table }) => table)).toEqual(backupDatabaseTables);
});

it.each([
  ['changed digest', (expected: BackupDatabaseReview) => ({ ...expected, sha256: '0'.repeat(64) })],
  ['changed byte count', (expected: BackupDatabaseReview) => ({ ...expected, bytes: expected.bytes + 1 })],
  ['wrong table count', (expected: BackupDatabaseReview) => ({ ...expected, counts: { ...expected.counts, app: 0 } })],
] as const)('rejects an expected review with %s', async (_name, change) => {
  const entries = databaseRows();
  const bytes = encode(entries);
  await save(bytes);
  await expect(readNormalizedBackupDatabase(source(change(review(bytes, entries))), new AbortController().signal)).rejects.toThrow();
});

it.each([
  ['extra wrapper key', (entry: Entry) => ({ ...entry, extra: true })],
  ['array wrapper', (entry: Entry) => [entry.table, entry.row] as unknown as Entry],
  ['unknown table', (entry: Entry) => ({ ...entry, table: 'unknown' as BackupDatabaseTable })],
] as const)('rejects a row wrapper with %s', async (_name, change) => {
  const entries = databaseRows();
  entries[0] = change(entryAt(entries, 0));
  const bytes = encode(entries);
  await save(bytes);
  await expect(readNormalizedBackupDatabase(source(review(bytes, entries)), new AbortController().signal)).rejects.toThrow();
});

it.each([
  [
    'missing physical column',
    (entry: Entry) => ({ ...entry, row: Object.fromEntries(Object.entries(entry.row).filter(([key]) => key !== 'template_version')) }),
  ],
  ['extra physical column', (entry: Entry) => ({ ...entry, row: { ...entry.row, unrecognized_column: true } })],
] as const)('rejects a table row with %s', async (_name, change) => {
  const entries = databaseRows();
  entries[2] = change(entryAt(entries, 2));
  const bytes = encode(entries);
  await save(bytes);
  await expect(readNormalizedBackupDatabase(source(review(bytes, entries)), new AbortController().signal)).rejects.toThrow();
});

it('rejects an out-of-order table even when the review digest and counts match', async () => {
  const entries = databaseRows();
  const outOfOrder = [entryAt(entries, 1), entryAt(entries, 0), entryAt(entries, 2), entryAt(entries, 3)];
  const bytes = encode(outOfOrder);
  await save(bytes);
  await expect(readNormalizedBackupDatabase(source(review(bytes, outOfOrder)), new AbortController().signal)).rejects.toThrow();
});

it.each([
  ['truncated final line', (bytes: Buffer) => bytes.subarray(0, bytes.length - 4)],
  ['trailing bytes without a line', (bytes: Buffer) => Buffer.concat([bytes, Buffer.from(' ')])],
  ['empty trailing line', (bytes: Buffer) => Buffer.concat([bytes, Buffer.from('\n')])],
  ['invalid UTF-8', (bytes: Buffer) => Buffer.concat([bytes.subarray(0, bytes.length - 1), Buffer.from([0xff, 0x0a])])],
] as const)('rejects %s when its own byte count and digest are supplied', async (_name, alter) => {
  const entries = databaseRows();
  const bytes = alter(encode(entries));
  await save(bytes);
  await expect(readNormalizedBackupDatabase(source(review(bytes, entries)), new AbortController().signal)).rejects.toThrow();
});

it('rejects permissive files, symlinks and a file whose size differs from the review', async () => {
  const entries = databaseRows();
  const bytes = encode(entries);
  await save(bytes, 0o644);
  await expect(readNormalizedBackupDatabase(source(review(bytes, entries)), new AbortController().signal)).rejects.toThrow();

  await fs.rm(file);
  await fs.writeFile(path.join(directory, 'target.jsonl'), bytes, { mode: 0o600 });
  await fs.symlink(path.join(directory, 'target.jsonl'), file);
  await expect(readNormalizedBackupDatabase(source(review(bytes, entries)), new AbortController().signal)).rejects.toThrow();

  await fs.rm(file);
  await save(bytes);
  await fs.appendFile(file, ' ');
  await expect(readNormalizedBackupDatabase(source(review(bytes, entries)), new AbortController().signal)).rejects.toThrow();
});

it('honours cancellation before reading and while awaiting the row callback', async () => {
  const entries = databaseRows();
  const bytes = encode(entries);
  await save(bytes);
  await expect(readNormalizedBackupDatabase(source(review(bytes, entries)), AbortSignal.abort())).rejects.toThrow();

  const controller = new AbortController();
  await expect(
    readNormalizedBackupDatabase(source(review(bytes, entries)), controller.signal, async () => {
      controller.abort();
      await Promise.resolve();
    }),
  ).rejects.toThrow();
});

it('propagates callback failures and detects a source file changed during callback processing', async () => {
  const entries = databaseRows();
  const bytes = encode(entries);
  await save(bytes);
  const callbackFailure = new Error('fixture callback failed');
  await expect(
    readNormalizedBackupDatabase(source(review(bytes, entries)), new AbortController().signal, async () => {
      throw callbackFailure;
    }),
  ).rejects.toBe(callbackFailure);

  await save(bytes);
  let changed = false;
  await expect(
    readNormalizedBackupDatabase(source(review(bytes, entries)), new AbortController().signal, async () => {
      if (!changed) {
        changed = true;
        const modified = Buffer.from(bytes);
        modified[0] = modified[0] === 0x7b ? 0x5b : 0x7b;
        await fs.writeFile(file, modified);
      }
    }),
  ).rejects.toThrow();
});

function encryptedTotp() {
  const salt = randomBytes(16).toString('hex');
  const key = pbkdf2Sync(jwtSecret, salt, 100_000, 32, 'sha256');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update('JBSWY3DPEHPK3PXP'), cipher.final()]);
  key.fill(0);
  return { salt, secret: [iv.toString('hex'), ciphertext.toString('hex'), cipher.getAuthTag().toString('hex')].join(':') };
}

it('reuses database record validation for encrypted TOTP and passkey state', async () => {
  const entries = databaseRows();
  const totp = encryptedTotp();
  const user = entryAt(entries, 0);
  entries[0] = { ...user, row: { ...user.row, totp_enabled: true, totp_secret: totp.secret, salt: totp.salt } };
  const binding = createHash('sha256').update(`${totp.secret}/${totp.salt}`).digest('hex');
  const passkeys = {
    version: 1,
    users: {
      '1': {
        handle: 'Zml4dHVyZS11c2Vy',
        credentials: [
          {
            id: 'Zml4dHVyZS1jcmVkZW50aWFs',
            publicKey: 'Zml4dHVyZS1wdWJsaWMta2V5',
            counter: 0,
            name: 'Fixture credential',
            rpID: 'example.invalid',
            createdAt: 1_700_000_000,
            lastUsedAt: null,
            transports: ['internal'],
          },
        ],
        totpAfterPasskey: binding,
      },
    },
  };
  const bytes = encode(entries);
  await save(bytes);
  await expect(readNormalizedBackupDatabase(source(review(bytes, entries), passkeys), new AbortController().signal)).resolves.toEqual({
    counts: { user: 1, app_store: 1, app: 1, link: 1 },
    bytes: bytes.length,
  });

  await expect(
    readNormalizedBackupDatabase(source(review(bytes, entries), { ...passkeys, unexpected: true }), new AbortController().signal),
  ).rejects.toThrow();
  const invalidTotp = entries.map((entry) => (entry.table === 'user' ? { ...entry, row: { ...entry.row, totp_secret: 'invalid' } } : entry));
  const invalidBytes = encode(invalidTotp);
  await save(invalidBytes);
  await expect(readNormalizedBackupDatabase(source(review(invalidBytes, invalidTotp), passkeys), new AbortController().signal)).rejects.toThrow();
});
