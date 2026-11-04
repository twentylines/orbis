// Read-only probe for the explicitly reviewed legacy controller bootstrap.
import fs from 'node:fs';
import crypto from 'node:crypto';
import YAML from 'yaml';
import dotenv from 'dotenv';
import validator from 'validator';
import { DatabaseSync } from 'node:sqlite';

const sha = (value: crypto.BinaryLike) => crypto.createHash('sha256').update(value).digest('hex');
const read = (file: string, limit = 1048576) => {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > BigInt(limit)) throw new Error('Unsupported bootstrap input');
    const chunks = [];
    let count = 0;
    while (count <= limit) {
      const chunk = Buffer.alloc(Math.min(16384, limit + 1 - count));
      const size = fs.readSync(fd, chunk);
      if (!size) break;
      count += size;
      chunks.push(chunk.subarray(0, size));
    }
    const keys = ['dev', 'ino', 'size', 'mode', 'uid', 'gid', 'mtimeNs', 'ctimeNs', 'nlink'] as const;
    for (const after of [fs.fstatSync(fd, { bigint: true }), fs.lstatSync(file, { bigint: true })]) {
      if (keys.some((key) => before[key] !== after[key])) throw new Error('Bootstrap input changed');
    }
    if (count > limit || BigInt(count) !== before.size) throw new Error('Bootstrap input changed');
    return Buffer.concat(chunks);
  } finally {
    fs.closeSync(fd);
  }
};
const capability = {
  schema: 'orbis.controller-overlay-startup.v1',
  version: 1,
  preserveNetworkAccess: true,
  preserveRunningApps: true,
  environment: 'ORBIS_CONTROLLER_PRESERVE_NETWORK_ACCESS=1',
};
const codeSha256 = sha(read('/app/main.mjs', 32 * 1024 * 1024));
if (process.env.ORBIS_CONTROLLER_PRESERVE_NETWORK_ACCESS === '1' && fs.existsSync('/app/controller-overlay-capability.json')) {
  const actual = JSON.parse(read('/app/controller-overlay-capability.json', 4096).toString('utf8'));
  if (
    JSON.stringify(Object.keys(actual).sort()) !== JSON.stringify(Object.keys(capability).sort()) ||
    (Object.keys(capability) as (keyof typeof capability)[]).some((key) => actual[key] !== capability[key])
  )
    throw new Error('Unsupported source capability');
  process.stdout.write(
    JSON.stringify({ schema: 'orbis.controller-bootstrap-profile.v1', profile: 'controller-preservation.v1', codeSha256, observedAt: Date.now() }),
  );
} else {
  const envBody = read('/data/.env');
  const settingsBody = read('/data/state/settings.json');
  const env = { ...process.env, ...dotenv.parse(envBody) };
  const settingsValue: unknown = JSON.parse(settingsBody.toString('utf8'));
  if (!settingsValue || Array.isArray(settingsValue) || typeof settingsValue !== 'object') throw new Error('Unsupported settings');
  const settings = settingsValue as Record<string, unknown>;
  const baseVersion = env.TIPI_VERSION ?? process.env.TIPI_VERSION;
  if (baseVersion !== 'v4.10.1') throw new Error('Unsupported base version');
  const persist =
    typeof settings.persistTraefikConfig === 'boolean'
      ? settings.persistTraefikConfig
      : (env.PERSIST_TRAEFIK_CONFIG ?? 'false').toLowerCase() === 'true';
  if (persist) throw new Error('This legacy profile requires the reviewed copy branch');
  const localDomain = settings.localDomain || env.LOCAL_DOMAIN || 'tipi.lan';
  if (typeof localDomain !== 'string' || !/^[A-Za-z0-9.-]{1,253}$/.test(localDomain)) throw new Error('Unsupported local domain');
  const trusted = typeof settings.trustedProxyIps === 'string' ? settings.trustedProxyIps.trim() : env.RUNTIPI_TRUSTED_PROXY_IPS || '';
  const trustedProxyIps = trusted
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (trustedProxyIps.some((value) => !validator.isIP(value) && !validator.isIPRange(value))) throw new Error('Unsupported trusted proxy input');
  const staticAsset = read('/app/assets/traefik/traefik.yml');
  const parsed = YAML.parse(staticAsset.toString('utf8'));
  for (const name of ['web', 'websecure']) {
    parsed.entryPoints ??= {};
    parsed.entryPoints[name] ??= {};
    const entry = parsed.entryPoints[name];
    if (trustedProxyIps.length) {
      if (!entry.forwardedHeaders || typeof entry.forwardedHeaders !== 'object' || Array.isArray(entry.forwardedHeaders)) entry.forwardedHeaders = {};
      entry.forwardedHeaders.trustedIPs = [...new Set(trustedProxyIps)];
    } else if (entry.forwardedHeaders && typeof entry.forwardedHeaders === 'object' && !Array.isArray(entry.forwardedHeaders)) {
      delete entry.forwardedHeaders.trustedIPs;
      if (Object.keys(entry.forwardedHeaders).length === 0) delete entry.forwardedHeaders;
    }
  }
  const staticBody = read('/data/traefik/traefik.yml');
  const staticSha256 = sha(staticBody);
  if (staticSha256 !== sha(YAML.stringify(parsed))) {
    const canonical = (value: unknown): unknown =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
          )
        : Array.isArray(value)
          ? value.map(canonical)
          : value;
    const sameConfiguration = JSON.stringify(canonical(parsed)) === JSON.stringify(canonical(YAML.parse(staticBody.toString('utf8'))));
    throw new Error(`Legacy static copy would change network configuration; semantic equality: ${sameConfiguration}`);
  }
  const dynamicAsset = read('/app/assets/traefik/dynamic/dynamic.yml');
  const dynamicBody = read('/data/traefik/dynamic/dynamic.yml');
  const dynamicSha256 = sha(dynamicBody);
  if (dynamicSha256 !== sha(dynamicAsset)) throw new Error('Legacy dynamic copy would change network configuration');
  const db = new DatabaseSync('/cache/cache.sqlite', { readOnly: true });
  const row = db.prepare('SELECT value FROM keyv WHERE key = ?').get('buster');
  db.close();
  if (!row || typeof row.value !== 'string') throw new Error('Legacy cache buster is unavailable');
  const buster = JSON.parse(row.value);
  const now = Date.now();
  if (!buster || buster.value !== baseVersion || !Number.isSafeInteger(buster.expiration) || buster.expiration <= now + 300000)
    throw new Error('Legacy bootstrap could restart applications');
  const marker = read(`/data/traefik/tls/${localDomain}.txt`, 4096);
  const cert = read('/data/traefik/tls/cert.pem', 65536);
  const key = read('/data/traefik/tls/key.pem', 65536);
  const certificate = new crypto.X509Certificate(cert);
  const certificateNotAfter = Date.parse(certificate.validTo);
  if (!Number.isSafeInteger(certificateNotAfter) || certificateNotAfter <= now + 86400000 + 300000)
    throw new Error('Legacy bootstrap could replace TLS material');
  const result = {
    schema: 'orbis.controller-bootstrap-profile.v1',
    profile: 'legacy-idempotent.v1',
    codeSha256,
    observedAt: now,
    baseVersion,
    persistTraefikConfig: false,
    cacheBusterSha256: sha(row.value),
    cacheBusterExpiresAt: buster.expiration,
    staticSha256,
    dynamicSha256,
    staticAssetSha256: sha(staticAsset),
    dynamicAssetSha256: sha(dynamicAsset),
    localDomainSha256: sha(localDomain),
    tlsMarkerSha256: sha(marker),
    certificateSha256: sha(cert),
    privateKeySha256: sha(key),
    certificateNotAfter,
    envSha256: sha(envBody),
    settingsSha256: sha(settingsBody),
  };
  process.stdout.write(JSON.stringify(result));
}
