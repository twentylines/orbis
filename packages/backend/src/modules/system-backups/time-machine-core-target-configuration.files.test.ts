import { expect, it } from 'vitest';
import dotenv from 'dotenv';
import { rebaseCoreTargetConfiguration } from './backup-restore-configuration';

const target = {
  POSTGRES_HOST: 'target-db',
  POSTGRES_DBNAME: 'current',
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
  APPS_REPO_ID: 'pinned-nonstandard-id',
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
const options = () => ({
  targetEnvironment: Object.entries(target)
    .map(([key, value]) => `${key}='${value}'`)
    .join('\n'),
  databaseName: 'core_restored_1',
  recovery: {
    jwtSecret: 'a'.repeat(32),
    userSettings: { appsRepoUrl: 'https://github.com/meienberger/runtipi-appstore', timeZone: 'UTC', domain: 'source.example.invalid' } as unknown,
  },
});

it('restores portable settings while preserving destination catalog and infrastructure', () => {
  const result = rebaseCoreTargetConfiguration(options());
  const env = dotenv.parse(result.environment);
  const settings = JSON.parse(result.settings);
  for (const [key, value] of Object.entries(target)) {
    if (!['POSTGRES_DBNAME', 'JWT_SECRET', 'TZ'].includes(key)) expect(env[key]).toBe(value);
  }
  expect(env.POSTGRES_DBNAME).toBe('core_restored_1');
  expect(env.JWT_SECRET).toBe('a'.repeat(32));
  expect(env.TZ).toBe('UTC');
  expect(settings.appsRepoUrl).toBe(target.APPS_REPO_URL);
  expect(settings.domain).toBe(target.DOMAIN);
  expect(result.review.repositoryMigrated).toBe(false);
  expect(result.review.restored).not.toContain('appsRepoUrl');
  expect(result.review.preserved).toContain('appsRepoUrl');
});

it.each(['APPS_REPO_URL', 'APPS_REPO_ID'])('refuses a missing destination catalog binding %s', (key) => {
  const input = options();
  input.targetEnvironment = input.targetEnvironment
    .split('\n')
    .filter((line) => !line.startsWith(`${key}=`))
    .join('\n');
  expect(() => rebaseCoreTargetConfiguration(input)).toThrow('cannot be safely adapted');
});

it('accepts partial settings without a source catalog', () => {
  const input = options();
  input.recovery.userSettings = { timeZone: 'UTC' };
  const result = rebaseCoreTargetConfiguration(input);
  expect(JSON.parse(result.settings).appsRepoUrl).toBe(target.APPS_REPO_URL);
  expect(dotenv.parse(result.environment).APPS_REPO_ID).toBe(target.APPS_REPO_ID);
});

it.each(['', 'postgres', 'POSTGRES', 'template0', 'template1', 'current', '1bad', 'bad-name', 'bad;DROP', 'x'.repeat(64)])(
  'rejects unsafe database name %s',
  (databaseName) => {
    expect(() => rebaseCoreTargetConfiguration({ ...options(), databaseName })).toThrow('cannot be safely adapted');
  },
);

it.each(['', 'x'.repeat(31), 'x'.repeat(4097), `${'x'.repeat(32)}\nINJECTED=yes`, `${'x'.repeat(32)}'"$`])(
  'rejects invalid or unencodable JWT values',
  (jwtSecret) => {
    const input = options();
    input.recovery.jwtSecret = jwtSecret;
    expect(() => rebaseCoreTargetConfiguration(input)).toThrow('cannot be safely adapted');
  },
);

it('preserves a safely quoted JWT literally', () => {
  const input = options();
  input.recovery.jwtSecret = `${'x'.repeat(32)} $literal # value`;
  expect(dotenv.parse(rebaseCoreTargetConfiguration(input).environment).JWT_SECRET).toBe(input.recovery.jwtSecret);
});
