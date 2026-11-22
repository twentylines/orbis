import crypto from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { APP_CATEGORIES, appInfoSchema, dynamicComposeSchemaYaml, type AppCategory, type AppInfo } from '@runtipi/common/schemas';
import type { AppUrn } from '@runtipi/common/types';
import { type } from 'arktype';
import { parse } from 'yaml';

export const UMBREL_TEXT_LIMIT = 256 * 1024;
export const UMBREL_ASSET_LIMIT = 16 * 1024 * 1024;
const identifier = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const serviceIdentifier = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
function reject(reason: string): never {
  throw new Error(reason);
}
const text = (value: unknown, field: string, limit = 2000): string =>
  typeof value === 'string' && value.length <= limit ? value : reject(`Invalid Umbrel ${field}.`);
const port = (value: unknown): number => {
  const result = Number(value);
  return Number.isInteger(result) && result > 0 && result <= 65535 ? result : reject('Invalid Umbrel application port.');
};
const url = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || value.length > 2048) return;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? parsed.href : undefined;
  } catch {
    return;
  }
};

export function parseUmbrelYaml(source: string): unknown {
  if (Buffer.byteLength(source) > UMBREL_TEXT_LIMIT) reject('Umbrel definition exceeds its size limit.');
  const result: unknown = parse(source, { maxAliasCount: 25, uniqueKeys: true });
  let nodes = 0;
  const seen = new Set<object>();
  const inspect = (value: unknown, depth: number) => {
    if (++nodes > 20000 || depth > 40) reject('Umbrel definition exceeds its structure limit.');
    if (!value || typeof value !== 'object') return;
    if (seen.has(value)) reject('Umbrel definitions cannot contain recursive or shared aliases.');
    seen.add(value);
    for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) reject('Invalid Umbrel definition key.');
      inspect(item, depth + 1);
    }
  };
  inspect(result, 0);
  return result;
}

const serviceKeys = new Set([
  'image',
  'restart',
  'stop_grace_period',
  'user',
  'init',
  'environment',
  'volumes',
  'depends_on',
  'command',
  'entrypoint',
  'healthcheck',
  'working_dir',
  'hostname',
  'read_only',
  'tmpfs',
  'shm_size',
  'mem_limit',
  'mem_reservation',
  'cpus',
  'pids_limit',
  'expose',
  'stdin_open',
  'tty',
  'cap_drop',
]);
const categoryMap: Record<string, AppCategory> = {
  files: 'data',
  productivity: 'utilities',
  networking: 'network',
  bitcoin: 'finance',
  finance: 'finance',
  social: 'social',
  media: 'media',
  automation: 'automation',
  ai: 'ai',
  'developer tools': 'development',
};

function environment(value: unknown): Record<string, string> {
  const entries = Array.isArray(value)
    ? value.map((item) => {
        if (typeof item !== 'string' || !item.includes('=')) reject('Umbrel environment inheritance is unsupported.');
        const index = (item as string).indexOf('=');
        return [(item as string).slice(0, index), (item as string).slice(index + 1)];
      })
    : record(value)
      ? Object.entries(value)
      : reject('Invalid Umbrel environment.');
  const result: Record<string, string> = {};
  for (const [key, item] of entries) {
    if (!key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || item === null || !['string', 'number', 'boolean'].includes(typeof item))
      reject('Invalid Umbrel environment.');
    if (Object.hasOwn(result, key)) reject('Duplicate Umbrel environment variable.');
    result[key] = String(item);
  }
  return result;
}

function translateCompose(input: unknown, id: string, manifest: Record<string, unknown>, urn: AppUrn) {
  if (!record(input) || !record(input.services)) reject('Umbrel Compose services are missing.');
  for (const key of Object.keys(input))
    if (!['version', 'services'].includes(key) && !key.startsWith('x-')) reject(`Unsupported Umbrel Compose option: ${key}.`);
  const names = Object.keys(input.services);
  if (names.length < 2 || names.length > 32 || names.some((name) => !serviceIdentifier.test(name))) reject('Unsupported Umbrel service list.');
  const proxy = input.services.app_proxy;
  if (!record(proxy) || Object.keys(proxy).some((key) => key !== 'environment')) reject('Umbrel application gateway requires an adapter.');
  const proxyEnv = environment(proxy.environment);
  if (Object.keys(proxyEnv).some((key) => !['APP_HOST', 'APP_PORT', 'PROXY_AUTH_ADD', 'PROXY_AUTH_WHITELIST'].includes(key)))
    reject('Unsupported Umbrel gateway option.');
  if (proxyEnv.PROXY_AUTH_ADD !== undefined && !['true', 'false'].includes(proxyEnv.PROXY_AUTH_ADD))
    reject('Unsupported Umbrel gateway authentication setting.');
  const main = names.find((name) => name !== 'app_proxy' && proxyEnv.APP_HOST === `${id}_${name}_1`);
  if (!main) reject('Umbrel gateway target requires dynamic platform addressing.');
  const internalPort = port(proxyEnv.APP_PORT);
  const requiresAuth = proxyEnv.PROXY_AUTH_ADD !== 'false';
  if (requiresAuth && proxyEnv.PROXY_AUTH_WHITELIST?.trim()) reject('Umbrel authentication exceptions require per-path routing support.');
  const randomVariables = new Set<string>();
  const variables = (value: string): string =>
    value.replace(/(?<!\$)\$(?:\{([^}]+)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (_match, braced: string | undefined, plain: string | undefined) => {
      const name = braced ?? plain ?? '';
      if (name === 'APP_DATA_DIR') return '${APP_DATA_DIR}';
      if (name === 'APP_PASSWORD' || name === 'APP_SEED') {
        const scopedName = `UMBREL_${crypto.createHash('sha256').update(urn).digest('hex').slice(0, 20).toUpperCase()}_${name}`;
        randomVariables.add(scopedName);
        return `\${${scopedName}}`;
      }
      return reject(`Unsupported Umbrel runtime variable: ${name.split(/[^A-Za-z0-9_]/)[0]}.`);
    });
  const rewrite = (value: unknown): unknown => {
    if (typeof value === 'string') {
      let result = variables(value);
      for (const name of names.filter((name) => name !== 'app_proxy')) result = result.replaceAll(`${id}_${name}_1`, name);
      return result;
    }
    if (Array.isArray(value)) return value.map(rewrite);
    if (record(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item)]));
    return value;
  };
  const services: Record<string, unknown> = {};
  for (const [name, source] of Object.entries(input.services)) {
    if (name === 'app_proxy') continue;
    if (!record(source) || typeof source.image !== 'string' || !source.image.trim() || /[\s$]/.test(source.image))
      reject(`Invalid Umbrel image for ${name}.`);
    for (const key of Object.keys(source)) if (!serviceKeys.has(key)) reject(`Unsupported Umbrel service option: ${key}.`);
    const service = rewrite(source) as Record<string, unknown>;
    if (source.environment !== undefined) service.environment = rewrite(environment(source.environment));
    if (source.cap_drop !== undefined && (!Array.isArray(source.cap_drop) || source.cap_drop.some((cap) => typeof cap !== 'string')))
      reject('Invalid Umbrel dropped capabilities.');
    if (source.volumes !== undefined) {
      if (!Array.isArray(source.volumes) || source.volumes.length > 64) reject('Invalid Umbrel volume list.');
      service.volumes = source.volumes.map((mount) => {
        if (typeof mount !== 'string') reject('Umbrel long volume syntax requires an adapter.');
        const [from, target, options, ...extra] = (mount as string).split(':');
        const normalized = from?.replace(/^\$APP_DATA_DIR(?=\/|$)/, '${APP_DATA_DIR}');
        if (
          !normalized?.startsWith('${APP_DATA_DIR}/data') ||
          !/^\$\{APP_DATA_DIR\}\/data(?:\/[^:$\0\r\n]*)?$/.test(normalized) ||
          normalized.split('/').some((part) => part === '..' || part === '.')
        )
          reject('Umbrel mount requires storage outside this application.');
        if (
          !target?.startsWith('/') ||
          target === '/' ||
          /[\0\r\n$]/.test(target) ||
          target.split('/').includes('..') ||
          extra.length ||
          (options !== undefined && !['ro', 'rw'].includes(options))
        )
          reject('Invalid Umbrel mount target or options.');
        return `${normalized}:${target}${options ? `:${options}` : ''}`;
      });
    }
    if (source.depends_on !== undefined) {
      const deps = Array.isArray(source.depends_on)
        ? source.depends_on
        : record(source.depends_on)
          ? Object.keys(source.depends_on)
          : reject('Invalid Umbrel service dependency.');
      if (deps.some((dep) => typeof dep !== 'string' || dep === 'app_proxy' || !names.includes(dep)))
        reject('Umbrel service dependency is outside this application.');
    }
    if (name === main) service['x-runtipi'] = { is_main: true, internal_port: internalPort };
    services[name] = service;
  }
  const compose = dynamicComposeSchemaYaml({ services, 'x-runtipi': { schema_version: 2 }, 'x-orbis-umbrel': { requires_auth: requiresAuth } });
  if (compose instanceof type.errors) reject('Translated Umbrel Compose is invalid.');
  // Do not infer tor endpoints, privileged permissions, dependency exports or platform-managed settings.
  for (const key of ['dependencies', 'permissions', 'implements', 'folderAccess', 'environment']) {
    const value = manifest[key];
    if (value !== undefined && (!Array.isArray(value) || value.length)) reject(`Umbrel ${key} requires platform integration.`);
  }
  if (manifest.torOnly === true) reject('Tor-only Umbrel applications require a Tor gateway.');
  return { compose, requiresAuth, randomVariables: [...randomVariables] };
}

export function translateUmbrelApp(input: {
  manifest: string;
  compose: string;
  urn: AppUrn;
  revision: string;
  packageIssues?: string[];
  previous?: { catalog_revision?: string; tipi_version?: number };
}) {
  const manifest = parseUmbrelYaml(input.manifest);
  if (!record(manifest)) reject('Invalid Umbrel manifest.');
  const id = text(manifest.id, 'id', 128);
  if (!identifier.test(id) || id !== input.urn.split(':')[0]) reject('Umbrel manifest id does not match its package.');
  const reasons = [...(input.packageIssues ?? [])];
  if (manifest.manifestVersion !== 1) reasons.push('This Umbrel manifest version requires additional platform integration.');
  if (manifest.requiresHttps === true || manifest.nativeTlsHostnameSuffixes !== undefined)
    reasons.push('This Umbrel app requires native TLS integration.');
  if (
    manifest.storage !== undefined &&
    (!record(manifest.storage) || manifest.storage.dataRoot !== 'data' || Object.keys(manifest.storage).length !== 1)
  )
    reasons.push('This Umbrel storage contract requires platform integration.');
  let translation: ReturnType<typeof translateCompose> | undefined;
  try {
    translation = translateCompose(parseUmbrelYaml(input.compose), id, manifest, input.urn);
  } catch (error) {
    reasons.push(error instanceof Error ? error.message : 'Unsupported Umbrel Compose.');
  }
  const declaredCategory = String(manifest.category ?? '').toLowerCase();
  const category = APP_CATEGORIES.includes(declaredCategory as AppCategory)
    ? (declaredCategory as AppCategory)
    : (categoryMap[declaredCategory] ?? 'utilities');
  const previousVersion = input.previous?.tipi_version ?? 0;
  const revision = crypto
    .createHash('sha256')
    .update(input.manifest)
    .update('\0')
    .update(input.compose)
    .update('\0')
    .update(input.revision)
    .digest('hex');
  const gallery = Array.isArray(manifest.gallery)
    ? manifest.gallery.slice(0, 12).flatMap((item) => {
        const remote = url(item);
        if (remote) return [remote];
        return typeof item === 'string' && /^[a-zA-Z0-9_-]+\.(jpg|jpeg|png|webp)$/.test(item)
          ? [`https://raw.githubusercontent.com/getumbrel/umbrel-apps-gallery/master/${id}/${item}`]
          : [];
      })
    : [];
  const infoInput = {
    id,
    urn: input.urn,
    name: text(manifest.name, 'name', 200),
    short_desc: text(manifest.tagline ?? '', 'tagline', 1000),
    description: text(manifest.description ?? '', 'description', 100000),
    author: text(manifest.developer ?? '', 'developer'),
    version: text(manifest.version, 'version', 200),
    source: url(manifest.repo) ?? '',
    website: url(manifest.website),
    port: port(manifest.port),
    tipi_version: input.previous?.catalog_revision === revision ? previousVersion || 1 : previousVersion + 1,
    available: reasons.length === 0,
    categories: [category],
    dynamic_config: true,
    exposable: true,
    catalog_format: 'umbrel',
    catalog_revision: revision,
    gallery,
    release_notes: text(manifest.releaseNotes ?? '', 'release notes', 100000),
    url_suffix: typeof manifest.path === 'string' && /^\/(?!\/)[^\r\n]*$/.test(manifest.path) ? manifest.path : undefined,
    form_fields:
      translation?.randomVariables.map((env_variable) => ({
        type: 'random',
        label: env_variable.endsWith('_APP_PASSWORD') ? 'Application password' : 'Application seed',
        env_variable,
        min: 64,
        encoding: 'hex',
      })) ?? [],
    compatibility: { supported: reasons.length === 0, reasons, requires_auth: translation?.requiresAuth ?? true },
  };
  const info = appInfoSchema(Object.fromEntries(Object.entries(infoInput).filter(([, value]) => value !== undefined)));
  if (info instanceof type.errors) reject('Invalid translated Umbrel app metadata.');
  return { info: info as AppInfo, compose: reasons.length ? null : (translation?.compose ?? null) };
}

export function assertUmbrelRuntimeAccess(
  info: Pick<AppInfo, 'catalog_format' | 'compatibility' | 'available'>,
  form: { enableAuth?: boolean; openPort?: boolean; exposed?: boolean; exposedLocal?: boolean },
) {
  if (info.catalog_format !== 'umbrel') return;
  if (!info.available || !info.compatibility?.supported)
    throw new BadRequestException(info.compatibility?.reasons.join(' ') || 'This Umbrel package requires additional platform integration.');
  if (info.compatibility.requires_auth && (form.enableAuth !== true || form.openPort === true || (!form.exposedLocal && !form.exposed)))
    throw new BadRequestException(
      'This Umbrel app requires Orbis authentication through a protected local or public domain, with direct port access disabled.',
    );
}
