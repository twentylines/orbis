import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import dotenv from 'dotenv';
import { rebaseBackupConfiguration } from './backup-restore-configuration';
import { generateSystemEnvFile } from '@/common/helpers/env-helpers';
import { DATA_DIR } from '@/common/constants';

const testState = vi.hoisted(() => ({ directory: '' }));
vi.mock('@/common/constants', async (load) => ({
  ...(await load<typeof import('@/common/constants')>()),
  get DATA_DIR() {
    return testState.directory;
  },
}));

const target = {
  POSTGRES_HOST: 'target-db',
  POSTGRES_DBNAME: 'target-database',
  POSTGRES_USERNAME: 'target-user',
  POSTGRES_PASSWORD: 'declared target fixture # with spaces',
  POSTGRES_PORT: '5544',
  RABBITMQ_HOST: 'target-queue',
  RABBITMQ_USERNAME: 'target-queue-user',
  RABBITMQ_PASSWORD: 'declared queue fixture',
  ROOT_FOLDER_HOST: '/srv/target',
  RUNTIPI_APP_DATA_PATH: '/srv/target-data',
  ARCHITECTURE: 'arm64',
  TIPI_VERSION: '4.10.1',
  JWT_SECRET: 'declared-target-fixture',
  APPS_REPO_URL: 'https://example.invalid/target.git',
  APPS_REPO_ID: 'target-repository-hash',
  TZ: 'Asia/Singapore',
  INTERNAL_IP: '192.0.2.10',
  DOMAIN: 'target.example.invalid',
  LOCAL_DOMAIN: 'target.lan',
  RUNTIPI_FORWARD_AUTH_URL: 'http://target:3000/api/auth/traefik',
  DNS_IP: '192.0.2.53',
  NGINX_PORT: '8080',
  NGINX_PORT_SSL: '8443',
  RUNTIPI_TRUSTED_PROXY_IPS: '192.0.2.0/24',
  EXPERIMENTAL_INSECURE_COOKIE: 'false',
  GUEST_DASHBOARD: 'false',
  DEMO_MODE: 'false',
  ALLOW_ERROR_MONITORING: 'false',
  PERSIST_TRAEFIK_CONFIG: 'true',
  ORBIS_HOST_SOCKET: '/run/orbis/target.sock',
  TARGET_EXTENSION: 'a literal $target # value',
};
const source = {
  timeZone: 'UTC',
  themeBase: 'slate',
  themeColor: 'purple',
  appsRepoUrl: 'https://example.invalid/restored.git',
  advancedSettings: true,
  allowAutoThemes: false,
  maxBackups: 4,
  eventsTimeout: 15,
  logLevel: 'warn',
  allowErrorMonitoring: true,
  appDataPath: '/source/path',
  demoMode: true,
  guestDashboard: true,
  domain: 'source.example.invalid',
  localDomain: 'source.lan',
  listenIp: '192.0.2.30',
  internalIp: '192.0.2.30',
  port: 90,
  sslPort: 449,
  postgresPort: 9999,
  dnsIp: '192.0.2.99',
  forwardAuthUrl: 'https://source.example.invalid/auth',
  trustedProxyIps: '0.0.0.0/0',
  persistTraefikConfig: false,
  experimental: { insecureCookie: true },
};
const serialize = (values: Record<string, string>) =>
  Object.entries(values)
    .map(([key, value]) => `${key}='${value}'`)
    .join('\n');
const options = () => ({
  targetEnvironment: serialize(target),
  databaseName: `orbis_restore_${'a'.repeat(32)}`,
  recovery: { jwtSecret: 'declared-source-fixture', userSettings: structuredClone(source) as unknown },
});

it('restores portable preferences and account encryption while preserving every target host connection and access setting', () => {
  const input = options();
  const before = structuredClone(input);
  const result = rebaseBackupConfiguration(input);
  const env = dotenv.parse(result.environment);
  const settings = JSON.parse(result.settings);
  for (const [key, value] of Object.entries(target)) {
    if (!['JWT_SECRET', 'POSTGRES_DBNAME', 'APPS_REPO_ID', 'APPS_REPO_URL', 'TZ'].includes(key)) expect(env[key]).toBe(value);
  }
  expect(env.POSTGRES_DBNAME).toBe(input.databaseName);
  expect(env.JWT_SECRET).toBe(input.recovery.jwtSecret);
  expect(env.APPS_REPO_ID).toBe(createHash('sha256').update(source.appsRepoUrl).digest('hex'));
  expect(env.APPS_REPO_URL).toBe(source.appsRepoUrl);
  expect(env.TZ).toBe('UTC');
  expect(settings).toMatchObject({
    timeZone: 'UTC',
    themeBase: 'slate',
    themeColor: 'purple',
    eventsTimeout: 15,
    maxBackups: 4,
    appDataPath: target.RUNTIPI_APP_DATA_PATH,
    domain: target.DOMAIN,
    localDomain: target.LOCAL_DOMAIN,
    listenIp: target.INTERNAL_IP,
    internalIp: target.INTERNAL_IP,
    forwardAuthUrl: target.RUNTIPI_FORWARD_AUTH_URL,
    port: 8080,
    sslPort: 8443,
    postgresPort: 5544,
    trustedProxyIps: target.RUNTIPI_TRUSTED_PROXY_IPS,
    allowErrorMonitoring: false,
    guestDashboard: false,
    demoMode: false,
    experimental_insecureCookie: false,
    persistTraefikConfig: true,
  });
  expect(result.review.restored).toHaveLength(9);
  expect(result.review.preserved).toContain('appDataPath');
  expect(JSON.stringify(result.review)).not.toContain('declared-');
  expect(input).toEqual(before);
});
it('uses target defaults for missing portable fields and existing runtime settings for host fields', () => {
  const input = options();
  input.recovery.userSettings = {};
  input.targetEnvironment = serialize(
    Object.fromEntries(Object.entries(target).filter(([key]) => !['NGINX_PORT', 'NGINX_PORT_SSL', 'POSTGRES_PORT'].includes(key))),
  );
  const result = rebaseBackupConfiguration(input);
  const settings = JSON.parse(result.settings);
  expect(settings.timeZone).toBe(target.TZ);
  expect(settings).toMatchObject({ port: 80, sslPort: 443, postgresPort: 5432, eventsTimeout: 5, maxBackups: 0, advancedSettings: false });
  expect(result.review.restored).toEqual([]);
});
it.each(["literal ' apostrophe", 'literal " double quote', 'literal \\ backslash', ''])(
  'keeps a safely representable portable value literal',
  (value) => {
    const input = options();
    input.recovery.userSettings = { timeZone: value };
    const result = rebaseBackupConfiguration(input);
    expect(dotenv.parse(result.environment).TZ).toBe(value);
    expect(JSON.parse(result.settings).timeZone).toBe(value);
  },
);
it.each(['missing', 'empty', 'duplicate', 'multiline', 'invalid-line', 'null', 'too-large'] as const)(
  'rejects %s target configuration before returning a plan',
  (kind) => {
    const input = options();
    if (kind === 'missing')
      input.targetEnvironment = serialize(Object.fromEntries(Object.entries(target).filter(([key]) => key !== 'POSTGRES_HOST')));
    if (kind === 'empty') input.targetEnvironment = serialize({ ...target, RABBITMQ_PASSWORD: '' });
    if (kind === 'duplicate') input.targetEnvironment += '\nPOSTGRES_HOST=other';
    if (kind === 'multiline') input.targetEnvironment += '\nEXTRA="one\ntwo"';
    if (kind === 'invalid-line') input.targetEnvironment += '\nexport EXTRA=value';
    if (kind === 'null') input.targetEnvironment += '\0';
    if (kind === 'too-large') input.targetEnvironment += '#'.repeat(1024 * 1024);
    expect(() => rebaseBackupConfiguration(input)).toThrow('cannot be safely adapted');
  },
);
it.each(['source', 'target-database', 'orbis_restore_bad', `orbis_restore_${'a'.repeat(31)}`, `orbis_restore_${'A'.repeat(32)}`])(
  'rejects an unowned database name',
  (databaseName) => {
    expect(() => rebaseBackupConfiguration({ ...options(), databaseName })).toThrow('cannot be safely adapted');
  },
);
it.each([
  null,
  [],
  { unexpected: 'value' },
  { eventsTimeout: 0 },
  { experimental: { unexpected: true } },
  { experimental: { insecureCookie: true }, experimental_insecureCookie: false },
  { timeZone: 'line\nbreak' },
  { timeZone: 'UTC # label' },
  { timeZone: '$TZ' },
  { themeColor: '"purple"' },
  { themeColor: "'$unsafe" },
])('rejects invalid or unrepresentable source settings without leaking their values', (userSettings) => {
  const input = options();
  input.recovery.userSettings = userSettings;
  expect(() => rebaseBackupConfiguration(input)).toThrow('cannot be safely adapted');
});
it.each(['', 'line\nbreak', '\0', 'x'.repeat(4097), "'$unsafe"])('rejects an unsafe account recovery key', (jwtSecret) => {
  const input = options();
  input.recovery.jwtSecret = jwtSecret;
  expect(() => rebaseBackupConfiguration(input)).toThrow('cannot be safely adapted');
});
it.each([
  ['ARCHITECTURE', 'unknown'],
  ['ROOT_FOLDER_HOST', '../relative'],
  ['RUNTIPI_APP_DATA_PATH', 'relative'],
  ['RUNTIPI_APP_DATA_PATH', '/target/app-data'],
  ['RUNTIPI_APP_DATA_PATH', '/target # data'],
  ['INTERNAL_IP', 'invalid'],
  ['POSTGRES_PORT', '0'],
  ['NGINX_PORT_SSL', '65536'],
  ['NGINX_PORT', '1e2'],
  ['GUEST_DASHBOARD', 'yes'],
])('rejects invalid target %s', (key, value) => {
  const input = options();
  input.targetEnvironment = serialize({ ...target, [key]: value });
  expect(() => rebaseBackupConfiguration(input)).toThrow('cannot be safely adapted');
});

it.each([source.appsRepoUrl, 'https://github.com/meienberger/runtipi-appstore'])(
  'keeps rebased settings and connection values through real startup, including the existing repository migration (%s)',
  async (appsRepoUrl) => {
    const originalEnv = { ...process.env };
    testState.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-config-rebase-'));
    try {
      expect(DATA_DIR).toBe(testState.directory);
      const input = options();
      input.recovery.userSettings = { ...source, appsRepoUrl };
      const result = rebaseBackupConfiguration(input);
      expect(result.review.repositoryMigrated).toBe(appsRepoUrl !== source.appsRepoUrl);
      await fs.mkdir(path.join(testState.directory, 'state'), { mode: 0o700 });
      await fs.writeFile(path.join(testState.directory, '.env'), result.environment, { mode: 0o600 });
      await fs.writeFile(path.join(testState.directory, 'state/settings.json'), result.settings, { mode: 0o600 });
      await fs.writeFile(path.join(testState.directory, 'state/seed'), 'declared source seed fixture', { mode: 0o600 });
      const generated = await generateSystemEnvFile({ readOnly: true });
      const actual = dotenv.parse(Array.from(generated, ([key, value]) => `${key}=${value}`).join('\n'));
      for (const [key, value] of Object.entries(dotenv.parse(result.environment))) expect(actual[key]).toBe(value);
      expect(await fs.readFile(path.join(testState.directory, '.env'), 'utf8')).toBe(result.environment);
      expect(await fs.readFile(path.join(testState.directory, 'state/settings.json'), 'utf8')).toBe(result.settings);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
      Object.assign(process.env, originalEnv);
      await fs.rm(testState.directory, { recursive: true, force: true });
      testState.directory = '';
    }
  },
);
