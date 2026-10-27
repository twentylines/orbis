import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { ConfigurationService } from '@/core/config/configuration.service';
import { Injectable, NotFoundException } from '@nestjs/common';
import type { AppUrn } from '@runtipi/common/types';
import { AppFilesManager } from './app-files-manager';
import { AppsRepository } from './apps.repository';

export type EmbeddingCompatibility = {
  status: 'blocked' | 'not-blocked-by-headers' | 'unknown';
  reason: string;
  targetUrl: string;
  checkedAt: number;
  expiresAt: number;
};
type HeaderObservation = { statusCode: number; policies: string[]; frameOptions: string[] };
const CACHE_MS = 30_000;
const MAX_CACHE = 128;
const MAX_PENDING = 4;

export function embeddingUrl(value: unknown, originOnly = false): URL | undefined {
  if (typeof value !== 'string' || value.length > 2048 || /\p{Cc}/u.test(value)) return;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return;
    if (originOnly && (url.pathname !== '/' || url.search || url.hash)) return;
    return url;
  } catch {
    return;
  }
}

export function safeEmbeddingAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0, c = 0] = address.split('.').map(Number);
    if (a === 0 || a === 127 || a >= 224 || (a === 169 && b === 254)) return false;
    if ((a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 192 && b === 88 && c === 99) || (a === 198 && (b === 18 || b === 19))) return false;
    if ((a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) || address === '100.100.100.200') return false;
    return true;
  }
  if (isIP(address) !== 6 || address.includes('%')) return false;
  const normalized = new URL(`http://[${address}]`).hostname.slice(1, -1).toLowerCase();
  if (normalized === 'fd00:ec2::254' || normalized === 'fd20:ce::254') return false;
  if (/^f[cd][0-9a-f]{2}:/i.test(normalized)) return true;
  const [first, second] = normalized.split(':');
  if (first === '2001' && (Number.parseInt(second || '0', 16) <= 0x1ff || second === 'db8')) return false;
  return /^[23][0-9a-f]{3}:/i.test(normalized) && first !== '2002';
}

function ancestorMatches(source: string, parent: URL, target: URL): boolean | undefined {
  if (source.toLowerCase() === "'self'") return parent.origin === target.origin;
  if (source === '*') return true;
  if (/^https?:$/i.test(source))
    return source.toLowerCase() === parent.protocol || (source.toLowerCase() === 'http:' && parent.protocol === 'https:');
  const match = /^(?:(https?):\/\/)?(\*|\*\.[a-z0-9.-]+|\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::(\*|\d{1,5}))?\/?$/i.exec(source);
  if (!match) return;
  const scheme = match[1] ? `${match[1].toLowerCase()}:` : target.protocol;
  const host = match[2]?.toLowerCase();
  const port = match[3];
  if (!host || (port && port !== '*' && (Number(port) < 1 || Number(port) > 65535))) return;
  if (isIP(host.replace(/^\[|\]$/g, '')) || (host === '*' && isIP(parent.hostname.replace(/^\[|\]$/g, '')))) return;
  if (scheme !== parent.protocol && !(scheme === 'http:' && parent.protocol === 'https:')) return false;
  if (host !== '*' && host !== parent.hostname && !(host.startsWith('*.') && parent.hostname.endsWith(host.slice(1)))) return false;
  if (port === '*') return true;
  if (!port) return !parent.port;
  const parentPort = parent.port || (parent.protocol === 'https:' ? '443' : '80');
  if (scheme === 'http:' && Number(port) === 80 && parent.protocol === 'https:' && parentPort === '443') return;
  return Number(port) === Number(parentPort);
}

export function embeddingPolicy(observation: HeaderObservation, parent: URL, target: URL): Pick<EmbeddingCompatibility, 'status' | 'reason'> {
  if (observation.statusCode >= 300 && observation.statusCode < 400) return { status: 'unknown', reason: 'redirect' };
  if ([401, 403].includes(observation.statusCode)) return { status: 'unknown', reason: 'authentication-required' };
  if ([405, 501].includes(observation.statusCode)) return { status: 'unknown', reason: 'head-unsupported' };
  if (observation.statusCode < 200 || observation.statusCode >= 300 || [204, 205].includes(observation.statusCode))
    return { status: 'unknown', reason: 'unreachable' };
  let hasAncestors = false;
  let unknown = false;
  for (const policy of observation.policies.flatMap((header) => header.split(','))) {
    const directive = policy
      .split(';')
      .map((part) => part.trim().split(/\s+/))
      .find((tokens) => tokens[0]?.toLowerCase() === 'frame-ancestors');
    if (!directive) continue;
    hasAncestors = true;
    const sources = directive.slice(1);
    if (!sources.length || (sources.length === 1 && sources[0]?.toLowerCase() === "'none'"))
      return { status: 'blocked', reason: 'csp-frame-ancestors' };
    const matches = sources.filter((source) => source.toLowerCase() !== "'none'").map((source) => ancestorMatches(source, parent, target));
    if (matches.includes(true)) continue;
    if (matches.includes(undefined)) unknown = true;
    else return { status: 'blocked', reason: 'csp-frame-ancestors' };
  }
  // Enforced frame-ancestors supersedes X-Frame-Options in current browsers.
  if (hasAncestors) return { status: unknown ? 'unknown' : 'not-blocked-by-headers', reason: unknown ? 'policy-unknown' : 'no-blocking-header' };
  if (observation.frameOptions.length) {
    const value = observation.frameOptions[0]?.trim().toUpperCase();
    if (observation.frameOptions.length !== 1 || !['DENY', 'SAMEORIGIN'].includes(value ?? ''))
      return { status: 'unknown', reason: 'policy-unknown' };
    if (value === 'DENY') return { status: 'blocked', reason: 'x-frame-options-deny' };
    if (parent.origin !== target.origin) return { status: 'blocked', reason: 'x-frame-options-sameorigin' };
  }
  return { status: 'not-blocked-by-headers', reason: 'no-blocking-header' };
}

export async function embeddingHeaders(url: URL): Promise<HeaderObservation> {
  const deadline = Date.now() + 6000;
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await new Promise<LookupAddress[]>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('DNS timeout')), 6000);
        lookup(hostname, { all: true })
          .then(resolve, reject)
          .finally(() => clearTimeout(timer));
      });
  if (!addresses.length || addresses.some(({ address }) => !safeEmbeddingAddress(address))) throw new Error('Unsafe address');
  const address = addresses[0];
  if (!address) throw new Error('No address');
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request(
      {
        hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'HEAD',
        family: address.family,
        lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
        agent: false,
        maxHeaderSize: 16 * 1024,
        headers: { Accept: 'text/html', 'User-Agent': 'Orbis embedding compatibility', Connection: 'close' },
      },
      (response) => {
        const headers = (name: string) => {
          const values: string[] = [];
          for (let index = 0; index < response.rawHeaders.length; index += 2) {
            if (response.rawHeaders[index]?.toLowerCase() === name) values.push(response.rawHeaders[index + 1] ?? '');
          }
          return values;
        };
        resolve({ statusCode: response.statusCode ?? 0, policies: headers('content-security-policy'), frameOptions: headers('x-frame-options') });
        response.destroy();
      },
    );
    const timer = setTimeout(() => request.destroy(new Error('Request timeout')), Math.max(1, deadline - Date.now()));
    request.on('close', () => clearTimeout(timer));
    request.on('error', reject);
    request.end();
  });
}

@Injectable()
export class AppEmbeddingService {
  private readonly cache = new Map<string, EmbeddingCompatibility>();
  private readonly pending = new Map<string, Promise<EmbeddingCompatibility>>();

  constructor(
    private readonly repository: AppsRepository,
    private readonly files: AppFilesManager,
    private readonly configuration: ConfigurationService,
  ) {}

  public async check(urn: AppUrn, target: URL, parent: URL, refresh = false): Promise<EmbeddingCompatibility> {
    const app = await this.repository.getAppByUrn(urn);
    if (!app || app.status !== 'running') throw new NotFoundException('A running installed app is required.');
    const info = await this.files.getInstalledAppInfo(urn);
    if (!info || info.no_gui) throw new NotFoundException('The installed app has no launch destination.');
    const { internalIp, userSettings } = this.configuration.getConfig();
    const allowed: string[] = [];
    const add = (value: string) => {
      const url = embeddingUrl(value);
      if (url) allowed.push(url.href);
    };
    const suffix = info.url_suffix || '';
    if (app.openPort || !info.dynamic_config) {
      const domain = userSettings.domain ? embeddingUrl(`https://${userSettings.domain}`, true)?.hostname : undefined;
      for (const hostname of [internalIp, domain].filter((host): host is string => !!host)) {
        const host = hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname;
        add(`${(info.https ? 'https://' : 'http://') + host}:${app.port ?? info.port}${suffix}`);
      }
    }
    const tlsPort = userSettings.sslPort && userSettings.sslPort !== 443 ? `:${userSettings.sslPort}` : '';
    if (app.exposedLocal && userSettings.localDomain) {
      const subdomain = app.localSubdomain || urn.replace(':', '-');
      add(`https://${subdomain}.${userSettings.localDomain}${tlsPort}${suffix}`);
    }
    if (app.exposed && app.domain) add(`https://${app.domain}${tlsPort}${suffix}`);
    const result = (status: EmbeddingCompatibility['status'], reason: string): EmbeddingCompatibility => {
      const checkedAt = Date.now();
      return { status, reason, targetUrl: target.href, checkedAt, expiresAt: checkedAt + CACHE_MS };
    };
    if (!allowed.includes(target.href)) return result('unknown', 'unverified-destination');
    if (parent.protocol === 'https:' && target.protocol === 'http:') return result('blocked', 'mixed-content');
    if (target.origin === parent.origin) return result('blocked', 'same-origin');
    const key = JSON.stringify([urn, target.href, parent.origin]);
    const cached = this.cache.get(key);
    if (!refresh && cached && cached.expiresAt > Date.now()) return cached;
    const pending = this.pending.get(key);
    if (pending) return pending;
    if (this.pending.size >= MAX_PENDING) return result('unknown', 'busy');
    const check = embeddingHeaders(target)
      .then((headers) => {
        const policy = embeddingPolicy(headers, parent, target);
        return result(policy.status, policy.reason);
      })
      .catch(() => result('unknown', 'unreachable'))
      .then((value) => {
        this.cache.delete(key);
        this.cache.set(key, value);
        while (this.cache.size > MAX_CACHE) {
          const oldest = this.cache.keys().next().value;
          if (oldest !== undefined) this.cache.delete(oldest);
        }
        return value;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, check);
    return check;
  }
}
