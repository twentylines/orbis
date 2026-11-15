import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { prerelease, rcompare, valid } from 'semver';
import type { OrbisReleaseChannel } from '@runtipi/common/schemas/orbis-release-channel';

const endpoint = 'https://api.github.com/repos/twentylines/orbis-sentinel/releases';
const unavailable = 'Sentinel releases could not be checked right now.';
const maximumBytes = 1024 * 1024;
const pageSize = 100;

export type SentinelRelease = {
  version: string;
  sha256: string;
  sourceCommit: string;
  prerelease: boolean;
  publishedAt: string | null;
};
export type SentinelReleaseCatalog = {
  schema: 'orbis.sentinel-releases.v1';
  channel: OrbisReleaseChannel;
  releases: SentinelRelease[];
  truncated: boolean;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function candidate(value: unknown): SentinelRelease | null {
  if (!record(value) || value.draft !== false || typeof value.tag_name !== 'string' || !value.tag_name.startsWith('v')) return null;
  const version = value.tag_name.slice(1);
  if (!version || version.length > 128 || valid(version) !== version) return null;
  const preview = prerelease(version) !== null;
  if (value.prerelease !== preview || typeof value.target_commitish !== 'string' || !/^[a-f0-9]{40}$/.test(value.target_commitish)) return null;
  if (!Array.isArray(value.assets) || value.assets.length > 32) return null;
  const assets = value.assets;
  const filename = `orbis-sentinel-${version}.tar.gz`;
  const asset = (name: string, maximum: number) => {
    const matches = assets.filter((entry: unknown) => record(entry) && entry.name === name);
    if (matches.length !== 1 || !record(matches[0])) return null;
    const entry = matches[0];
    return entry.state === 'uploaded' &&
      Number.isSafeInteger(entry.size) &&
      (entry.size as number) > 0 &&
      (entry.size as number) <= maximum &&
      typeof entry.digest === 'string' &&
      /^sha256:[a-f0-9]{64}$/.test(entry.digest)
      ? entry
      : null;
  };
  const archive = asset(filename, 72 * 1024 * 1024);
  if (!archive || !asset(`${filename}.sigstore.json`, 4 * 1024 * 1024)) return null;
  // Discovery supplies an identity; only root preparation authenticates its publisher and payload.
  return {
    version,
    sha256: (archive.digest as string).slice(7),
    sourceCommit: value.target_commitish,
    prerelease: preview,
    publishedAt: typeof value.published_at === 'string' && Number.isFinite(Date.parse(value.published_at)) ? value.published_at : null,
  };
}

async function page(number: number, signal: AbortSignal): Promise<unknown[]> {
  const response = await fetch(`${endpoint}?per_page=${pageSize}&page=${number}`, {
    method: 'GET',
    redirect: 'error',
    signal,
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Orbis-Sentinel-updates/1' },
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(unavailable);
  }
  const reader = response.body.getReader();
  const abort = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener('abort', abort, { once: true });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let body = '';
  let bytes = 0;
  let complete = false;
  try {
    while (true) {
      if (signal.aborted) throw new Error(unavailable);
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximumBytes) throw new Error(unavailable);
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
    const value: unknown = JSON.parse(body);
    if (!Array.isArray(value) || value.length > pageSize) throw new Error(unavailable);
    complete = true;
    return value;
  } finally {
    signal.removeEventListener('abort', abort);
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

@Injectable()
export class SentinelReleasesService {
  private cached?: { releases: SentinelRelease[]; truncated: boolean; until: number };
  private pending?: Promise<void>;
  private failureUntil = 0;

  async list(channel: OrbisReleaseChannel): Promise<SentinelReleaseCatalog> {
    if (!this.cached || this.cached.until <= Date.now()) {
      if (this.failureUntil > Date.now()) throw new ServiceUnavailableException(unavailable);
      this.pending ??= this.refresh();
      await this.pending;
    }
    if (!this.cached) throw new ServiceUnavailableException(unavailable);
    return {
      schema: 'orbis.sentinel-releases.v1',
      channel,
      releases: this.cached.releases.filter((release) => channel === 'nightly' || !release.prerelease).map((release) => ({ ...release })),
      truncated: this.cached.truncated,
    };
  }

  private async refresh(): Promise<void> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(unavailable));
      }, 5000);
    });
    try {
      const load = async () => {
        const releases = new Map<string, SentinelRelease>();
        let truncated = false;
        for (let number = 1; number <= 2; number++) {
          const values = await page(number, controller.signal);
          if (controller.signal.aborted) throw new Error(unavailable);
          for (const value of values) {
            const release = candidate(value);
            if (!release) continue;
            const previous = releases.get(release.version);
            if (previous && (previous.sha256 !== release.sha256 || previous.sourceCommit !== release.sourceCommit)) throw new Error(unavailable);
            releases.set(release.version, release);
          }
          if (values.length < pageSize) break;
          truncated = number === 2;
        }
        return { releases: [...releases.values()].sort((left, right) => rcompare(left.version, right.version)), truncated };
      };
      const value = await Promise.race([load(), timeout]);
      this.cached = { ...value, until: Date.now() + 60_000 };
      this.failureUntil = 0;
    } catch {
      this.failureUntil = Date.now() + 5000;
      throw new ServiceUnavailableException(unavailable);
    } finally {
      clearTimeout(timer);
      this.pending = undefined;
    }
  }
}
