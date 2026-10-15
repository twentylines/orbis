import { Injectable, ServiceUnavailableException } from '@nestjs/common';

const REPO = 'twentylines/orbis';
const TAG = /^v[0-9]+\.[0-9]+\.[0-9]+(?:[-.][0-9A-Za-z.-]+)?$/;
const CACHE_MS = 15 * 60 * 1000;

export type OrbisRelease = {
  tag: string;
  publishedAt: string | null;
  body: string;
  url: string;
  imageManifestUrl: string | null;
};

export function latestTagFromAtom(feed: string): { tag: string; publishedAt: string | null } | null {
  const entries = feed.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];
  for (const entry of entries) {
    const tag = entry.match(/<id>tag:github\.com,2008:Repository\/[0-9]+\/([^<]+)<\/id>/)?.[1];
    if (!tag || !TAG.test(tag)) continue;
    const publishedAt = entry.match(/<updated>([^<]+)<\/updated>/)?.[1] ?? null;
    return { tag, publishedAt };
  }
  return null;
}

@Injectable()
export class OrbisReleaseService {
  private cached: { value: OrbisRelease | null; expiresAt: number } | null = null;
  private pending: Promise<OrbisRelease | null> | null = null;

  private async request(url: string, method: 'GET' | 'HEAD', maxBytes = 0): Promise<string> {
    const response = await fetch(url, { method, signal: AbortSignal.timeout(12_000), headers: { 'User-Agent': 'Orbis-update-center/1' } });
    if (!response.ok) throw new Error(`release resource returned ${response.status}`);
    if (method === 'HEAD') return '';
    const body = await response.text();
    if (body.length > maxBytes) throw new Error('release resource exceeded its size limit');
    return body;
  }

  private async load(): Promise<OrbisRelease | null> {
    const feed = await this.request(`https://github.com/${REPO}/releases.atom`, 'GET', 512 * 1024);
    const latest = latestTagFromAtom(feed);
    if (!latest) return null;
    const tag = latest.tag;
    const manifestUrl = `https://github.com/${REPO}/releases/download/${tag}/release-manifest.json`;
    const notesUrl = `https://raw.githubusercontent.com/${REPO}/${tag}/releases/${tag}.md`;
    const [body, manifest] = await Promise.all([
      this.request(notesUrl, 'GET', 64 * 1024),
      this.request(manifestUrl, 'HEAD').then(
        () => manifestUrl,
        () => null,
      ),
    ]);
    return { tag, publishedAt: latest.publishedAt, body, url: `https://github.com/${REPO}/releases/tag/${tag}`, imageManifestUrl: manifest };
  }

  async latest(): Promise<OrbisRelease | null> {
    if (this.cached && this.cached.expiresAt > Date.now()) return this.cached.value;
    if (!this.pending) {
      this.pending = this.load()
        .then((value) => {
          this.cached = { value, expiresAt: Date.now() + CACHE_MS };
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
