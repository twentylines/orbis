import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { eq, gt, lte, rcompare, valid } from 'semver';

const REPO = 'twentylines/orbis';
const TAG = /^v[0-9]+\.[0-9]+\.[0-9]+(?:[-.][0-9A-Za-z.-]+)?$/;
const CACHE_MS = 60 * 1000;
const PENDING_RELEASE_CACHE_MS = 30 * 1000;
const CATALOG_PAGE_SIZE = 100;
const CATALOG_MAX_PAGES = 2;
const HISTORY_LIMIT = 100;

export type OrbisRelease = {
  tag: string;
  publishedAt: string | null;
  body: string;
  url: string;
  imageManifestUrl: string | null;
  kind?: 'feature' | 'maintenance';
};

export type OrbisReleaseCatalog = { releases: OrbisRelease[]; complete: boolean };
export type OrbisReleaseHistory = OrbisReleaseCatalog & { truncated: boolean; context?: OrbisRelease | null };

export function parseOrbisReleaseNotes(notes: string): { body: string; kind: 'feature' | 'maintenance' } {
  const metadata = notes.match(/^\uFEFF?[\t ]*<!--[\t ]*orbis-release-kind:[\t ]*(feature|maintenance)[\t ]*-->[\t ]*\r?\n*/);
  return {
    body: notes.slice(metadata?.[0].length ?? 0).replace(/\n\nImage: ghcr\.io\/twentylines\/orbis@sha256:[a-f0-9]{64}\s*$/, ''),
    kind: metadata?.[1] === 'feature' ? 'feature' : 'maintenance',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function releaseFromMetadata(value: unknown): OrbisRelease | null {
  if (!isRecord(value) || value.draft === true || typeof value.tag_name !== 'string' || !TAG.test(value.tag_name) || !valid(value.tag_name)) {
    return null;
  }
  const tag = value.tag_name;
  const manifest =
    Array.isArray(value.assets) &&
    value.assets.some((asset: unknown) => isRecord(asset) && asset.name === 'release-manifest.json' && asset.state === 'uploaded');
  return {
    tag,
    publishedAt: typeof value.published_at === 'string' && Number.isFinite(Date.parse(value.published_at)) ? value.published_at : null,
    ...parseOrbisReleaseNotes(typeof value.body === 'string' && value.body.length <= 64 * 1024 ? value.body : ''),
    url: `https://github.com/${REPO}/releases/tag/${tag}`,
    imageManifestUrl: manifest ? `https://github.com/${REPO}/releases/download/${tag}/release-manifest.json` : null,
  };
}

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
  private catalog: { value: OrbisReleaseCatalog; expiresAt: number } | null = null;
  private catalogPending: Promise<OrbisReleaseCatalog> | null = null;

  private async request(url: string, method: 'GET' | 'HEAD', maxBytes = 0, timeout = 12_000): Promise<string> {
    const response = await fetch(url, {
      method,
      signal: AbortSignal.timeout(timeout),
      headers: { 'User-Agent': 'Orbis-update-center/1', Accept: url.startsWith('https://api.github.com/') ? 'application/vnd.github+json' : '*/*' },
    });
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
      const release = {
        tag,
        publishedAt,
        ...parseOrbisReleaseNotes(body),
        url: `https://github.com/${REPO}/releases/tag/${tag}`,
        imageManifestUrl: manifest,
      };
      if (manifest) return release;
      unfinished ??= release;
    }
    return this.cached?.value?.imageManifestUrl ? this.cached.value : unfinished;
  }

  private async loadCatalog(): Promise<OrbisReleaseCatalog> {
    const releases = new Map<string, OrbisRelease>();
    let complete = false;
    for (let page = 1; page <= CATALOG_MAX_PAGES; page += 1) {
      const body = await this.request(
        `https://api.github.com/repos/${REPO}/releases?per_page=${CATALOG_PAGE_SIZE}&page=${page}`,
        'GET',
        2 * 1024 * 1024,
        3_000,
      );
      const entries: unknown = JSON.parse(body);
      if (!Array.isArray(entries) || entries.length > CATALOG_PAGE_SIZE) throw new Error('invalid release catalog');
      for (const entry of entries) {
        const release = releaseFromMetadata(entry);
        if (release && !releases.has(release.tag)) releases.set(release.tag, release);
      }
      if (entries.length < CATALOG_PAGE_SIZE) {
        complete = true;
        break;
      }
    }
    return { releases: [...releases.values()].sort((a, b) => rcompare(a.tag, b.tag)), complete };
  }

  private async catalogFromFeed(): Promise<OrbisReleaseCatalog> {
    const feed = await this.request(`https://github.com/${REPO}/releases.atom`, 'GET', 512 * 1024, 3_000);
    const tags = tagsFromAtom(feed);
    const releases: OrbisRelease[] = [];
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, tags.length) }, async () => {
        while (next < tags.length) {
          const entry = tags[next++];
          if (!entry || !valid(entry.tag)) continue;
          if (this.cached?.value?.tag === entry.tag && this.cached.value.imageManifestUrl) {
            releases.push(this.cached.value);
            continue;
          }
          const manifestUrl = `https://github.com/${REPO}/releases/download/${entry.tag}/release-manifest.json`;
          try {
            const [body, manifest] = await Promise.all([
              this.request(`https://raw.githubusercontent.com/${REPO}/${entry.tag}/releases/${entry.tag}.md`, 'GET', 64 * 1024, 3_000),
              this.request(manifestUrl, 'HEAD', 0, 3_000)
                .then(() => manifestUrl)
                .catch(() => null),
            ]);
            releases.push({
              ...entry,
              ...parseOrbisReleaseNotes(body),
              imageManifestUrl: manifest,
              url: `https://github.com/${REPO}/releases/tag/${entry.tag}`,
            });
          } catch {
            releases.push({ ...entry, body: '', imageManifestUrl: null, url: `https://github.com/${REPO}/releases/tag/${entry.tag}` });
          }
        }
      }),
    );
    if (!releases.length) throw new Error('release catalog unavailable');
    return { releases: releases.sort((a, b) => rcompare(a.tag, b.tag)), complete: false };
  }

  async listPublished(): Promise<OrbisReleaseCatalog> {
    if (this.catalog && this.catalog.expiresAt > Date.now()) return this.catalog.value;
    if (!this.catalogPending) {
      this.catalogPending = this.loadCatalog()
        .catch(() => this.catalog?.value ?? this.catalogFromFeed())
        .then((value) => {
          this.catalog = { value, expiresAt: Date.now() + CACHE_MS };
          return value;
        })
        .catch(() => {
          throw new ServiceUnavailableException('Orbis release history is temporarily unavailable.');
        })
        .finally(() => {
          this.catalogPending = null;
        });
    }
    return this.catalogPending;
  }

  async history(installed: unknown, target: unknown): Promise<OrbisReleaseHistory> {
    if (
      typeof installed !== 'string' ||
      typeof target !== 'string' ||
      installed.length > 128 ||
      target.length > 128 ||
      !valid(installed) ||
      !valid(target) ||
      gt(installed, target)
    ) {
      throw new BadRequestException('Provide valid installed and target Orbis versions.');
    }
    if (!gt(target, installed)) return { releases: [], complete: true, truncated: false, context: null };
    const catalog = await this.listPublished();
    const included = catalog.releases.filter((release) => gt(release.tag, installed) && lte(release.tag, target));
    const truncated = included.length > HISTORY_LIMIT;
    const covered = catalog.complete || catalog.releases.some((release) => lte(release.tag, installed));
    const first = included.at(-1);
    const context =
      first && first.kind !== 'feature'
        ? (catalog.releases.find((release) => release.kind === 'feature' && lte(release.tag, installed)) ?? null)
        : null;
    return {
      releases: included.slice(0, HISTORY_LIMIT),
      complete:
        !truncated && covered && included.some((release) => eq(release.tag, target)) && included.every((release) => release.body.trim().length > 0),
      truncated,
      context,
    };
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
