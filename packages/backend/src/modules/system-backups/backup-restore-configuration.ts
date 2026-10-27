import { createHash } from 'node:crypto';
import { type } from 'arktype';
import dotenv from 'dotenv';
import { settingsSchema } from '@/app.dto';
import { DEFAULT_REPO_URL } from '@/common/helpers/env-helpers';
import { BackupRequirementError } from './backup-files';

const portable = {
  advancedSettings: 'ADVANCED_SETTINGS',
  allowAutoThemes: 'ALLOW_AUTO_THEMES',
  appsRepoUrl: 'APPS_REPO_URL',
  eventsTimeout: 'QUEUE_TIMEOUT_IN_MINUTES',
  logLevel: 'LOG_LEVEL',
  maxBackups: 'MAX_BACKUPS',
  timeZone: 'TZ',
  themeBase: 'THEME_BASE',
  themeColor: 'THEME_COLOR',
} as const;
const preserved = [
  'allowErrorMonitoring',
  'appDataPath',
  'demoMode',
  'dnsIp',
  'domain',
  'forwardAuthUrl',
  'guestDashboard',
  'internalIp',
  'listenIp',
  'localDomain',
  'persistTraefikConfig',
  'port',
  'postgresPort',
  'sslPort',
  'experimental_insecureCookie',
  'trustedProxyIps',
] as const;
const generatedSettings = {
  ...portable,
  appDataPath: 'RUNTIPI_APP_DATA_PATH',
  listenIp: 'INTERNAL_IP',
  dnsIp: 'DNS_IP',
  domain: 'DOMAIN',
  forwardAuthUrl: 'RUNTIPI_FORWARD_AUTH_URL',
  localDomain: 'LOCAL_DOMAIN',
  trustedProxyIps: 'RUNTIPI_TRUSTED_PROXY_IPS',
} as const;
const failed = () =>
  new BackupRequirementError('The backup configuration cannot be safely adapted to this server. Your current configuration has not been changed.');
const unsafe = (value: string) => /[\r\n\0]/.test(value);
const limit = 1024 * 1024;

function environment(value: string) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > limit || value.includes('\0')) throw failed();
  const encoded = new Map<string, string>();
  for (const line of value.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const entry = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!entry || encoded.has(entry[1] as string)) throw failed();
    const key = entry[1] as string;
    const raw = entry[2] as string;
    const parsed = dotenv.parse(line);
    if (unsafe(raw) || Object.keys(parsed).length !== 1 || !Object.hasOwn(parsed, key) || unsafe(parsed[key] as string)) throw failed();
    encoded.set(key, raw);
  }
  return { encoded, decoded: dotenv.parse(value) };
}

function encode(key: string, value: string) {
  if (unsafe(value)) throw failed();
  // Compose and dotenv must both retain literal values; do not introduce interpolation while rebasing.
  const candidates = [
    ...(value.includes("'") ? [] : [`'${value}'`]),
    ...(/[\s#'"$\\]/.test(value) ? [] : [value]),
    ...(/["$\\]/.test(value) ? [] : [`"${value}"`]),
  ];
  const result = candidates.find((candidate) => dotenv.parse(`${key}=${candidate}`)[key] === value);
  if (result === undefined) throw failed();
  return result;
}

function sourceSettings(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failed();
  const input = { ...(value as Record<string, unknown>) };
  if (Object.hasOwn(input, 'experimental')) {
    const experiment = input.experimental;
    if (
      !experiment ||
      typeof experiment !== 'object' ||
      Array.isArray(experiment) ||
      Object.keys(experiment).length !== 1 ||
      !Object.hasOwn(experiment, 'insecureCookie') ||
      typeof (experiment as Record<string, unknown>).insecureCookie !== 'boolean' ||
      (Object.hasOwn(input, 'experimental_insecureCookie') &&
        input.experimental_insecureCookie !== (experiment as Record<string, unknown>).insecureCookie)
    )
      throw failed();
    input.experimental_insecureCookie = (experiment as Record<string, unknown>).insecureCookie;
    delete input.experimental;
  }
  const parsed = settingsSchema.partial().onUndeclaredKey('reject')(input);
  if (parsed instanceof type.errors) throw failed();
  return parsed;
}

export function rebaseBackupConfiguration(options: {
  targetEnvironment: string;
  databaseName: string;
  recovery: { jwtSecret: string; userSettings: unknown };
}) {
  try {
    const { encoded, decoded } = environment(options.targetEnvironment);
    if (!/^orbis_restore_[a-f0-9]{32}$/.test(options.databaseName) || options.databaseName === decoded.POSTGRES_DBNAME) throw failed();
    if (typeof options.recovery.jwtSecret !== 'string' || !options.recovery.jwtSecret || options.recovery.jwtSecret.length > 4096) throw failed();
    for (const field of [
      'POSTGRES_HOST',
      'POSTGRES_DBNAME',
      'POSTGRES_USERNAME',
      'POSTGRES_PASSWORD',
      'RABBITMQ_HOST',
      'RABBITMQ_USERNAME',
      'RABBITMQ_PASSWORD',
      'ROOT_FOLDER_HOST',
      'RUNTIPI_APP_DATA_PATH',
      'ARCHITECTURE',
      'TIPI_VERSION',
    ])
      if (!decoded[field]) throw failed();
    if (!['amd64', 'arm64'].includes(decoded.ARCHITECTURE as string)) throw failed();
    for (const field of ['ROOT_FOLDER_HOST', 'RUNTIPI_APP_DATA_PATH']) if (!decoded[field]?.startsWith('/')) throw failed();
    const source = sourceSettings(options.recovery.userSettings);
    const repositoryMigrated = source.appsRepoUrl === 'https://github.com/meienberger/runtipi-appstore';
    if (repositoryMigrated) source.appsRepoUrl = DEFAULT_REPO_URL;
    const boolean = (key: string, fallback: boolean) => {
      if (decoded[key] === undefined) return fallback;
      if (!['true', 'false'].includes(decoded[key]?.toLowerCase() as string)) throw failed();
      return decoded[key]?.toLowerCase() === 'true';
    };
    const integer = (key: string, fallback: number) => {
      const raw = decoded[key];
      if (raw === undefined) return fallback;
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw failed();
      return Number(raw);
    };
    const target = sourceSettings({
      advancedSettings: boolean('ADVANCED_SETTINGS', false),
      allowAutoThemes: boolean('ALLOW_AUTO_THEMES', true),
      appsRepoUrl: decoded.APPS_REPO_URL,
      eventsTimeout: integer('QUEUE_TIMEOUT_IN_MINUTES', 5),
      logLevel: decoded.LOG_LEVEL ?? 'info',
      maxBackups: integer('MAX_BACKUPS', 0),
      timeZone: decoded.TZ,
      themeBase: decoded.THEME_BASE ?? 'gray',
      themeColor: decoded.THEME_COLOR ?? 'blue',
      allowErrorMonitoring: boolean('ALLOW_ERROR_MONITORING', false),
      appDataPath: decoded.RUNTIPI_APP_DATA_PATH,
      demoMode: boolean('DEMO_MODE', false),
      dnsIp: decoded.DNS_IP ?? '9.9.9.9',
      domain: decoded.DOMAIN,
      forwardAuthUrl: decoded.RUNTIPI_FORWARD_AUTH_URL,
      guestDashboard: boolean('GUEST_DASHBOARD', false),
      internalIp: decoded.INTERNAL_IP,
      listenIp: decoded.INTERNAL_IP,
      localDomain: decoded.LOCAL_DOMAIN,
      persistTraefikConfig: boolean('PERSIST_TRAEFIK_CONFIG', false),
      port: integer('NGINX_PORT', 80),
      postgresPort: integer('POSTGRES_PORT', 5432),
      sslPort: integer('NGINX_PORT_SSL', 443),
      experimental_insecureCookie: boolean('EXPERIMENTAL_INSECURE_COOKIE', false),
      trustedProxyIps: decoded.RUNTIPI_TRUSTED_PROXY_IPS ?? '',
    });
    if (!target.port || !target.sslPort || !target.postgresPort) throw failed();
    const settings = { ...target };
    const restored: (keyof typeof portable)[] = [];
    for (const key of Object.keys(portable) as (keyof typeof portable)[]) {
      const value = source[key] ?? target[key];
      if (value === undefined) throw failed();
      Object.assign(settings, { [key]: value });
      encoded.set(portable[key], encode(portable[key], String(value)));
      if (source[key] !== undefined) restored.push(key);
    }
    // Startup writes settings values back without quoting. Refuse any value it would reinterpret.
    for (const [key, field] of Object.entries(generatedSettings)) {
      const value = String(settings[key as keyof typeof settings]);
      if (unsafe(value) || value.includes('$') || (value && dotenv.parse(`${field}=${value}`)[field] !== value)) throw failed();
    }
    if (settings.appDataPath?.endsWith('/app-data')) throw failed();
    encoded.set(
      'APPS_REPO_ID',
      encode(
        'APPS_REPO_ID',
        createHash('sha256')
          .update(settings.appsRepoUrl as string)
          .digest('hex'),
      ),
    );
    encoded.set('POSTGRES_DBNAME', encode('POSTGRES_DBNAME', options.databaseName));
    encoded.set('JWT_SECRET', encode('JWT_SECRET', options.recovery.jwtSecret));
    const output = `${Array.from(encoded, ([key, value]) => `${key}=${value}`).join('\n')}\n`;
    const actual = environment(output).decoded;
    if (Buffer.byteLength(output) > limit) throw failed();
    for (const [key, value] of Object.entries(decoded)) {
      if (!['JWT_SECRET', 'POSTGRES_DBNAME', 'APPS_REPO_ID', ...Object.values(portable)].includes(key) && actual[key] !== value) throw failed();
    }
    return {
      environment: output,
      settings: `${JSON.stringify(settings)}\n`,
      review: { restored, preserved: [...preserved], repositoryMigrated },
    };
  } catch {
    throw failed();
  }
}
