import { Injectable, ServiceUnavailableException } from '@nestjs/common';

const REPO = 'twentylines/orbis';
const TAG = /^v[0-9]+\.[0-9]+\.[0-9]+(?:[-.][0-9A-Za-z.-]+)?$/;
const CACHE_MS = 60 * 1000;
const PENDING_RELEASE_CACHE_MS = 30 * 1000;

export type OrbisRelease = {
  tag: string;
  publishedAt: string | null;
  body: string;
  url: string;
  imageManifestUrl: string | null;
};

function tagsFromAtom(feed: string): Array<{ tag: string; publishedAt: string | null }> {
  const tags: Array<{ tag: string; publishedAt: string | null }> = [];
  const entries = feed.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];
  for (const entry of entries) {
    const tag = entry.match(/<id>tag:github\.com,2008:Repository\/[0-9]+\/([^<]+)<\/id>/)?.[1];
    if (!tag || !TAG.test(tag) || tags.some((entry) => entry.tag === tag)) continue;
    const publishedAt = entry.match(/<updated>([^<]+)<\/updated>/)?.[1] ?? null;
    tags.push({ tag, publishedAt });
    if (tags.length === 10) break;
  }
  return tags;
}

export function latestTagFromAtom(feed: string): { tag: string; publishedAt: string | null } | null {
  return tagsFromAtom(feed)[0] ?? null;
}

class ReleaseResourceError extends Error {
  constructor(readonly status: number) {
    super(`release resource returned ${status}`);
  }
}

@Injectable()
export class OrbisReleaseService {
  private cached: { value: OrbisRelease | null; expiresAt: number } | null = null;
  private pending: Promise<OrbisRelease | null> | null = null;

  private async request(url: string, method: 'GET' | 'HEAD', maxBytes = 0): Promise<string> {
    const response = await fetch(url, { method, signal: AbortSignal.timeout(12_000), headers: { 'User-Agent': 'Orbis-update-center/1' } });
    if (!response.ok) throw new ReleaseResourceError(response.status);
    if (method === 'HEAD') return '';
    const body = await response.text();
    if (body.length > maxBytes) throw new Error('release resource exceeded its size limit');
    return body;
  }

  private async load(): Promise<OrbisRelease | null> {
    const feed = await this.request(`https://github.com/${REPO}/releases.atom`, 'GET', 512 * 1024);
    let unfinished: OrbisRelease | null = null;
    for (const latest of tagsFromAtom(feed)) {
      if (this.cached?.value?.tag === latest.tag && this.cached.value.imageManifestUrl) return this.cached.value;
      const { tag, publishedAt } = latest;
      const manifestUrl = `https://github.com/${REPO}/releases/download/${tag}/release-manifest.json`;
      const notesUrl = `https://raw.githubusercontent.com/${REPO}/${tag}/releases/${tag}.md`;
      const optional = (request: Promise<string>) =>
        request.catch((error: unknown) => {
          if (error instanceof ReleaseResourceError && error.status === 404) return null;
          throw error;
        });
      const [body, manifest] = await Promise.all([
        optional(this.request(notesUrl, 'GET', 64 * 1024)),
        optional(this.request(manifestUrl, 'HEAD')).then((value) => (value === null ? null : manifestUrl)),
      ]);
      if (body === null) continue;
      const release = { tag, publishedAt, body, url: `https://github.com/${REPO}/releases/tag/${tag}`, imageManifestUrl: manifest };
      if (manifest) return release;
      unfinished ??= release;
    }
    return this.cached?.value?.imageManifestUrl ? this.cached.value : unfinished;
  }

  async latest(): Promise<OrbisRelease | null> {
    if (this.cached && this.cached.expiresAt > Date.now()) return this.cached.value;
    if (!this.pending) {
      this.pending = this.load()
        .then((value) => {
          const cacheMs = value?.imageManifestUrl ? CACHE_MS : PENDING_RELEASE_CACHE_MS;
          this.cached = { value, expiresAt: Date.now() + cacheMs };
          return value;
        })
        .catch(() => {
          if (this.cached) return this.cached.value;
          throw new ServiceUnavailableException('Orbis releases are temporarily unavailable.');
        })
        .finally(() => {
          this.pending = null;
        });
    }
    return this.pending;
  }
}
