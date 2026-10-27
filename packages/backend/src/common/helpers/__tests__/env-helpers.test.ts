import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DATA_DIR } from '@/common/constants';
import { generateSystemEnvFile } from '../env-helpers';

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('node:fs', async () => {
  const { fsMock } = await import('@/tests/__mocks__/fs');
  return fsMock;
});
vi.mock('@/core/logger/logger.service', async (load) => {
  const actual = await load<typeof import('@/core/logger/logger.service')>();
  return {
    ...actual,
    LoggerService: class {
      info = logger.info;
      warn = logger.warn;
      error = logger.error;
      debug = logger.debug;
    },
  };
});
vi.mock('dotenv', async (load) => {
  const actual = await load<typeof import('dotenv')>();
  return { ...actual, default: { ...actual, config: vi.fn(() => ({ parsed: {} })) } };
});

const keys = ['POSTGRES_HOST', 'POSTGRES_DBNAME', 'POSTGRES_USERNAME', 'POSTGRES_PORT'] as const;
const defaults = { POSTGRES_HOST: 'runtipi-db', POSTGRES_DBNAME: 'tipi', POSTGRES_USERNAME: 'tipi', POSTGRES_PORT: '5432' };
const envFile = path.join(DATA_DIR, '.env');
const settingsFile = path.join(DATA_DIR, 'state', 'settings.json');
const seedFile = path.join(DATA_DIR, 'state', 'seed');
let originalProcessEnv: NodeJS.ProcessEnv;
beforeEach(() => {
  originalProcessEnv = { ...process.env };
  vi.clearAllMocks();
  for (const key of keys) vi.stubEnv(key, '');
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const key of Object.keys(process.env)) {
    if (!(key in originalProcessEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalProcessEnv);
  vi.restoreAllMocks();
});

async function fixture(values: Record<string, string> = {}, settings: Record<string, unknown> = {}) {
  const entries = { ROOT_FOLDER_HOST: '/disposable/orbis', POSTGRES_PASSWORD: 'disposable-private-password', ...values };
  await fs.promises.writeFile(
    envFile,
    Object.entries(entries)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n'),
  );
  await fs.promises.writeFile(path.join(DATA_DIR, 'state', 'settings.json'), JSON.stringify(settings));
}
async function written() {
  return dotenv.parse(await fs.promises.readFile(envFile, 'utf8'));
}
async function snapshotConfigurationFiles() {
  const paths = [envFile, settingsFile, seedFile];
  return Promise.all(
    paths.map(async (file) => {
      try {
        const [contents, stat] = await Promise.all([fs.promises.readFile(file), fs.promises.stat(file)]);
        return [file, contents, { mode: stat.mode, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino }] as const;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [file, null, null] as const;
        throw error;
      }
    }),
  );
}
function watchFilesystemMutations() {
  return [
    vi.spyOn(fs.promises, 'mkdir'),
    vi.spyOn(fs.promises, 'writeFile'),
    vi.spyOn(fs.promises, 'rename'),
    vi.spyOn(fs.promises, 'rm'),
    vi.spyOn(fs.promises, 'unlink'),
    vi.spyOn(fs, 'mkdirSync'),
    vi.spyOn(fs, 'writeFileSync'),
    vi.spyOn(fs, 'renameSync'),
    vi.spyOn(fs, 'rmSync'),
    vi.spyOn(fs, 'unlinkSync'),
  ];
}
function connectionEquals(actual: Map<string, string> | Record<string, string>, expected: Record<string, string>) {
  return keys.every((key) => (actual instanceof Map ? actual.get(key) : actual[key]) === expected[key]);
}

it('retains the existing defaults when neither file nor process supplies a connection', async () => {
  await fixture();
  const result = await generateSystemEnvFile();
  expect(connectionEquals(result, defaults)).toBe(true);
  expect(connectionEquals(await written(), defaults)).toBe(true);
  expect(dotenv.config).toHaveBeenCalledWith({ path: envFile, override: true, quiet: true });
});

it('preserves a prepared restore connection and reserved URI punctuation without constructing a URL', async () => {
  const custom = {
    POSTGRES_HOST: '/run/postgresql',
    POSTGRES_DBNAME: 'restored:=db@host/%25',
    POSTGRES_USERNAME: 'operator:=role@host/%25',
    POSTGRES_PORT: '6543',
  };
  await fixture(custom);
  const result = await generateSystemEnvFile();
  expect(connectionEquals(result, custom)).toBe(true);
  expect(connectionEquals(await written(), custom)).toBe(true);
});

it('preserves correctly quoted existing file values containing spaces, hash signs and quotes', async () => {
  const encoded = {
    POSTGRES_HOST: 'custom-db.internal',
    POSTGRES_DBNAME: '"restored # database"',
    POSTGRES_USERNAME: '\'operator "role" # account\'',
    POSTGRES_PORT: '5544',
  };
  const semantic = { ...encoded, POSTGRES_DBNAME: 'restored # database', POSTGRES_USERNAME: 'operator "role" # account' };
  await fixture(encoded);
  const result = await generateSystemEnvFile();
  expect(connectionEquals(result, encoded)).toBe(true);
  expect(connectionEquals(await written(), semantic)).toBe(true);
  await generateSystemEnvFile();
  expect(connectionEquals(await written(), semantic)).toBe(true);
});

it('gives each nonempty file value precedence over a conflicting process value', async () => {
  const custom = { POSTGRES_HOST: 'file-host', POSTGRES_DBNAME: 'file-restored-db', POSTGRES_USERNAME: 'file-role', POSTGRES_PORT: '6544' };
  for (const key of keys) vi.stubEnv(key, `process-${key}`);
  await fixture(custom);
  const result = await generateSystemEnvFile();
  expect(connectionEquals(result, custom)).toBe(true);
  expect(connectionEquals(await written(), custom)).toBe(true);
});

it('uses process values independently for empty and missing file entries', async () => {
  const fallback = {
    POSTGRES_HOST: 'process-db.internal',
    POSTGRES_DBNAME: 'process:=db@host/%25',
    POSTGRES_USERNAME: 'process:=role@host/%25',
    POSTGRES_PORT: '7654',
  };
  for (const key of keys) vi.stubEnv(key, fallback[key]);
  await fixture({ POSTGRES_HOST: '', POSTGRES_USERNAME: '' });
  const result = await generateSystemEnvFile();
  expect(connectionEquals(result, fallback)).toBe(true);
  expect(connectionEquals(await written(), fallback)).toBe(true);
});

it('falls back independently per connection field instead of replacing the whole connection', async () => {
  vi.stubEnv('POSTGRES_HOST', 'process-db.internal');
  vi.stubEnv('POSTGRES_PORT', '7655');
  await fixture({ POSTGRES_DBNAME: 'prepared-restored-db', POSTGRES_USERNAME: '' });
  const expected = {
    POSTGRES_HOST: 'process-db.internal',
    POSTGRES_DBNAME: 'prepared-restored-db',
    POSTGRES_USERNAME: 'tipi',
    POSTGRES_PORT: '7655',
  };
  expect(connectionEquals(await generateSystemEnvFile(), expected)).toBe(true);
  expect(connectionEquals(await written(), expected)).toBe(true);
});

it('uses defaults for empty file and process values', async () => {
  await fixture(Object.fromEntries(keys.map((key) => [key, ''])));
  expect(connectionEquals(await generateSystemEnvFile(), defaults)).toBe(true);
  expect(connectionEquals(await written(), defaults)).toBe(true);
});

it('treats an encoded empty file value as empty before using the process fallback', async () => {
  vi.stubEnv('POSTGRES_DBNAME', 'prepared-restored-db');
  await fixture({ POSTGRES_DBNAME: '""' });
  const expected = { ...defaults, POSTGRES_DBNAME: 'prepared-restored-db' };
  expect(connectionEquals(await generateSystemEnvFile(), expected)).toBe(true);
  expect(connectionEquals(await written(), expected)).toBe(true);
});

it.each([
  ['hash', 'restored#database'],
  ['single quote and hash', "restored'role#database"],
  ['double quote and hash', 'restored"role#database'],
  ['backslash sequences', String.raw`restored\name\n#database`],
  ['surrounding spaces', '  restored database  '],
])('encodes process fallbacks without changing their meaning: %s', async (_description, value) => {
  vi.stubEnv('POSTGRES_DBNAME', value);
  await fixture();
  const generated = await generateSystemEnvFile();
  const expected = { ...defaults, POSTGRES_DBNAME: value };
  expect(connectionEquals(await written(), expected)).toBe(true);
  const first = await fs.promises.readFile(envFile, 'utf8');
  expect(typeof generated.get('POSTGRES_DBNAME') === 'string').toBe(true);
  vi.stubEnv('POSTGRES_DBNAME', 'different-process-value');
  const restarted = await generateSystemEnvFile();
  expect(restarted.get('POSTGRES_DBNAME') === generated.get('POSTGRES_DBNAME')).toBe(true);
  expect(connectionEquals(await written(), expected)).toBe(true);
  expect((await fs.promises.readFile(envFile, 'utf8')) === first).toBe(true);
});

it.each(keys)('rejects unrepresentable process values without writing or logging material: %s', async (field) => {
  const value = 'restore\'"`#unrepresentable';
  vi.stubEnv(field, value);
  await fixture();
  const original = await fs.promises.readFile(envFile, 'utf8');
  let caught: unknown;
  try {
    await generateSystemEnvFile();
  } catch (error) {
    caught = error;
  }
  expect(caught instanceof Error && caught.message === `Invalid ${field} configuration.`).toBe(true);
  expect((await fs.promises.readFile(envFile, 'utf8')) === original).toBe(true);
  const logged = JSON.stringify(Object.values(logger).flatMap((method) => method.mock.calls));
  expect(logged.includes(value)).toBe(false);
});

it.each([
  ['line feed', '\n'],
  ['carriage return', '\r'],
])('rejects process control characters without partial file writes: %s', async (_description, control) => {
  const value = `disposable${control}database`;
  vi.stubEnv('POSTGRES_DBNAME', value);
  await fixture();
  const original = await fs.promises.readFile(envFile, 'utf8');
  let caught: unknown;
  try {
    await generateSystemEnvFile();
  } catch (error) {
    caught = error;
  }
  expect(caught instanceof Error && caught.message === 'Invalid POSTGRES_DBNAME configuration.').toBe(true);
  expect((await fs.promises.readFile(envFile, 'utf8')) === original).toBe(true);
});

it.each([
  ['multiline quoted value', '"disposable\ndatabase"'],
  ['encoded line feed', '"disposable\\ndatabase"'],
  ['carriage return', 'disposable\rdatabase'],
  ['NUL', 'disposable\0database'],
])('rejects unsupported existing file encodings without replacing them: %s', async (_description, value) => {
  await fixture({ POSTGRES_DBNAME: value });
  const original = await fs.promises.readFile(envFile, 'utf8');
  let caught: unknown;
  try {
    await generateSystemEnvFile();
  } catch (error) {
    caught = error;
  }
  expect(caught instanceof Error && caught.message === 'Invalid POSTGRES_DBNAME configuration.').toBe(true);
  expect((await fs.promises.readFile(envFile, 'utf8')) === original).toBe(true);
});

it('keeps the prepared connection through repeated starts and later process changes', async () => {
  const initial = {
    POSTGRES_HOST: 'prepared-db.internal',
    POSTGRES_DBNAME: 'prepared-restored-db',
    POSTGRES_USERNAME: 'prepared-role',
    POSTGRES_PORT: '6432',
  };
  for (const key of keys) vi.stubEnv(key, initial[key]);
  await fixture();
  await generateSystemEnvFile();
  const first = await fs.promises.readFile(envFile, 'utf8');
  for (const key of keys) vi.stubEnv(key, `changed-${key}`);
  expect(connectionEquals(await generateSystemEnvFile(), initial)).toBe(true);
  expect(connectionEquals(await written(), initial)).toBe(true);
  expect((await fs.promises.readFile(envFile, 'utf8')) === first).toBe(true);
});

it('leaves passwords and settings precedence unchanged and never logs connection material', async () => {
  const custom = {
    POSTGRES_HOST: 'private-fixture-host',
    POSTGRES_DBNAME: 'private-fixture-db',
    POSTGRES_USERNAME: 'private-fixture-role',
    POSTGRES_PORT: '6543',
  };
  const password = 'disposable-private-password';
  vi.stubEnv('POSTGRES_PASSWORD', 'different-disposable-process-password');
  await fixture({ ...custom, POSTGRES_PASSWORD: password, DOMAIN: 'old.invalid', DNS_IP: '1.1.1.1' }, { domain: 'settings.invalid' });
  const result = await generateSystemEnvFile();
  const parsed = await written();
  expect(result.get('POSTGRES_PASSWORD') === password && parsed.POSTGRES_PASSWORD === password).toBe(true);
  expect(result.get('DOMAIN')).toBe('settings.invalid');
  expect(result.get('DNS_IP')).toBe('1.1.1.1');
  const logged = JSON.stringify(Object.values(logger).flatMap((method) => method.mock.calls));
  expect([...Object.values(custom), password].some((value) => logged.includes(value))).toBe(false);
  expect(logger.info).toHaveBeenCalledWith('Generating system env file');
});

it('computes read-only defaults without creating or modifying configuration files', async () => {
  const originalEnv = 'ROOT_FOLDER_HOST=/disposable/orbis\nPOSTGRES_PASSWORD=disposable-private-password\nCUSTOM_VALUE=kept';
  await fixture({ ROOT_FOLDER_HOST: '/disposable/orbis', POSTGRES_PASSWORD: 'disposable-private-password' });
  await fs.promises.writeFile(envFile, originalEnv);
  await fs.promises.writeFile(seedFile, 'restored-seed');
  const before = await snapshotConfigurationFiles();
  const mutations = watchFilesystemMutations();

  const result = await generateSystemEnvFile({ readOnly: true });

  expect(connectionEquals(result, defaults)).toBe(true);
  expect(keys.every((key) => process.env[key] === defaults[key])).toBe(true);
  expect(await snapshotConfigurationFiles()).toEqual(before);
  expect(mutations.every((mutation) => mutation.mock.calls.length === 0)).toBe(true);
});

it('makes the normalized restored database connection available in process env without rewriting quoted values', async () => {
  const fileValues = {
    POSTGRES_HOST: '"restored-db.internal"',
    POSTGRES_DBNAME: '"restored # database"',
    POSTGRES_USERNAME: '\'operator "role" # account\'',
    POSTGRES_PORT: '"6544"',
  };
  const normalized = {
    POSTGRES_HOST: 'restored-db.internal',
    POSTGRES_DBNAME: 'restored # database',
    POSTGRES_USERNAME: 'operator "role" # account',
    POSTGRES_PORT: '6544',
  };
  await fixture(fileValues);
  await fs.promises.writeFile(seedFile, 'restored-seed');
  const before = await snapshotConfigurationFiles();
  const mutations = watchFilesystemMutations();

  await generateSystemEnvFile({ readOnly: true });

  expect(keys.every((key) => process.env[key] === normalized[key])).toBe(true);
  expect(await snapshotConfigurationFiles()).toEqual(before);
  expect(mutations.every((mutation) => mutation.mock.calls.length === 0)).toBe(true);
});

it.each([
  ['environment file', envFile],
  ['settings file', settingsFile],
  ['seed file', seedFile],
])('refuses read-only generation when the %s is missing without recreating it', async (_description, missingFile) => {
  await fixture();
  await fs.promises.writeFile(seedFile, 'restored-seed');
  await fs.promises.rm(missingFile, { force: true });
  const before = await snapshotConfigurationFiles();
  const mutations = watchFilesystemMutations();

  await expect(generateSystemEnvFile({ readOnly: true })).rejects.toMatchObject({ code: 'ENOENT' });

  expect(await snapshotConfigurationFiles()).toEqual(before);
  expect(mutations.every((mutation) => mutation.mock.calls.length === 0)).toBe(true);
});
