import { afterEach, describe, expect, it, vi } from 'vitest';
import { latestTagFromAtom, OrbisReleaseService } from '../orbis-release.service';

const TAG = 'v0.1.0-beta.9';
const FEED = `<feed><entry><id>tag:github.com,2008:Repository/1419897175/${TAG}</id><updated>2026-10-15T03:00:00Z</updated></entry></feed>`;

describe('Orbis release feed', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('uses the public Atom feed and tagged notes when the GitHub API is rate limited', async () => {
    const request = vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      expect(url).not.toContain('api.github.com');
      if (url.endsWith('/releases.atom')) return new Response(FEED);
      if (url.endsWith(`/${TAG}.md`)) return new Response('# Verified release notes');
      if (url.endsWith('/release-manifest.json') && init?.method === 'HEAD') return new Response(null, { status: 200 });
      throw new Error(`unexpected release request: ${url}`);
    });
    const service = new OrbisReleaseService();
    expect(await service.latest()).toEqual({
      tag: TAG,
      publishedAt: '2026-10-15T03:00:00Z',
      body: '# Verified release notes',
      url: `https://github.com/twentylines/orbis/releases/tag/${TAG}`,
      imageManifestUrl: `https://github.com/twentylines/orbis/releases/download/${TAG}/release-manifest.json`,
    });
    await service.latest();
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('ignores malformed feed tags', () => {
    expect(latestTagFromAtom(FEED.replace(TAG, 'v0.1.0;unsafe'))).toBeNull();
  });

  it('rechecks an unfinished release after 30 seconds and shares concurrent requests', async () => {
    vi.useFakeTimers();
    let manifestReady = false;
    const request = vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/releases.atom')) return new Response(FEED);
      if (url.endsWith(`/${TAG}.md`)) return new Response('# Release notes');
      if (url.endsWith('/release-manifest.json') && init?.method === 'HEAD') return new Response(null, { status: manifestReady ? 200 : 404 });
      throw new Error(`unexpected release request: ${url}`);
    });
    const service = new OrbisReleaseService();
    expect((await service.latest())?.imageManifestUrl).toBeNull();
    manifestReady = true;
    vi.advanceTimersByTime(29_999);
    expect((await service.latest())?.imageManifestUrl).toBeNull();
    expect(request).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(1);
    const refreshed = await Promise.all(Array.from({ length: 8 }, () => service.latest()));
    expect(refreshed.every((value) => value?.imageManifestUrl?.endsWith('/release-manifest.json'))).toBe(true);
    expect(request).toHaveBeenCalledTimes(6);
    vi.advanceTimersByTime(60_000);
    expect((await service.latest())?.imageManifestUrl).not.toBeNull();
    expect(request).toHaveBeenCalledTimes(7);
  });

  it('finds a new release after one minute without downloading unchanged notes again', async () => {
    vi.useFakeTimers();
    let tag = TAG;
    const request = vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/releases.atom')) return new Response(FEED.replace(TAG, tag));
      if (url.endsWith(`/${tag}.md`)) return new Response(`# ${tag}`);
      if (url.endsWith('/release-manifest.json') && init?.method === 'HEAD') return new Response(null);
      throw new Error(`unexpected release request: ${url}`);
    });
    const service = new OrbisReleaseService();
    expect((await service.latest())?.tag).toBe(TAG);
    vi.advanceTimersByTime(59_999);
    await service.latest();
    expect(request).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(1);
    await Promise.all(Array.from({ length: 8 }, () => service.latest()));
    expect(request).toHaveBeenCalledTimes(4);

    tag = 'v0.1.0-beta.10';
    vi.advanceTimersByTime(60_000);
    const refreshed = await Promise.all(Array.from({ length: 8 }, () => service.latest()));
    expect(refreshed.every((release) => release?.tag === tag && release.body === `# ${tag}`)).toBe(true);
    expect(request).toHaveBeenCalledTimes(7);
  });

  it('retains the last known release when a later automatic check cannot reach GitHub', async () => {
    vi.useFakeTimers();
    let offline = false;
    const request = vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (offline) throw new Error('network unavailable');
      if (url.endsWith('/releases.atom')) return new Response(FEED);
      if (url.endsWith(`/${TAG}.md`)) return new Response('# Release notes');
      if (url.endsWith('/release-manifest.json') && init?.method === 'HEAD') return new Response(null);
      throw new Error(`unexpected release request: ${url}`);
    });
    const service = new OrbisReleaseService();
    const previous = await service.latest();
    offline = true;
    vi.advanceTimersByTime(60_000);
    const results = await Promise.all(Array.from({ length: 8 }, () => service.latest()));
    expect(results.every((release) => release === previous)).toBe(true);
    expect(request).toHaveBeenCalledTimes(4);
  });

  it('keeps the previous installable release while a newer tag is building, then discovers its manifest', async () => {
    vi.useFakeTimers();
    const next = 'v0.1.0-beta.10';
    const feed = FEED.replace('<feed>', `<feed><entry><id>tag:github.com,2008:Repository/1419897175/${next}</id></entry>`);
    let ready = false;
    const request = vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/releases.atom')) return new Response(feed);
      if (url.endsWith('.md')) return new Response('# Release notes');
      if (url.endsWith('/release-manifest.json') && init?.method === 'HEAD') {
        return new Response(null, { status: url.includes(`/${next}/`) && !ready ? 404 : 200 });
      }
      throw new Error(`unexpected release request: ${url}`);
    });
    const service = new OrbisReleaseService();
    expect((await service.latest())?.tag).toBe(TAG);
    expect((await service.latest())?.imageManifestUrl).toContain(`/${TAG}/`);
    expect(request).toHaveBeenCalledTimes(5);

    vi.advanceTimersByTime(60_000);
    expect((await service.latest())?.tag).toBe(TAG);
    expect(request).toHaveBeenCalledTimes(8);
    ready = true;
    vi.advanceTimersByTime(60_000);
    const updated = await Promise.all(Array.from({ length: 8 }, () => service.latest()));
    expect(updated.every((release) => release?.tag === next && release.imageManifestUrl?.includes(`/${next}/`))).toBe(true);
    expect(request).toHaveBeenCalledTimes(11);
  });

  it('skips an unpublished tag whose notes are missing', async () => {
    const next = 'v0.1.0-beta.10';
    const feed = FEED.replace('<feed>', `<feed><entry><id>tag:github.com,2008:Repository/1419897175/${next}</id></entry>`);
    vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/releases.atom')) return new Response(feed);
      if (url.includes(`/${next}/`)) return new Response(null, { status: 404 });
      if (url.endsWith(`/${TAG}.md`)) return new Response('# Published release');
      if (url.endsWith('/release-manifest.json')) return new Response(null);
      throw new Error(`unexpected release request: ${url}`);
    });
    expect((await new OrbisReleaseService().latest())?.tag).toBe(TAG);
  });

  it('retains a known installable release on a manifest outage instead of treating the outage as an unpublished tag', async () => {
    vi.useFakeTimers();
    const next = 'v0.1.0-beta.10';
    let outage = false;
    const request = vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/releases.atom')) return new Response(outage ? FEED.replace(TAG, next) : FEED);
      if (url.endsWith('.md')) return new Response('# Release notes');
      if (url.endsWith('/release-manifest.json')) return new Response(null, { status: outage ? 503 : 200 });
      throw new Error(`unexpected release request: ${url}`);
    });
    const service = new OrbisReleaseService();
    const previous = await service.latest();
    outage = true;
    vi.advanceTimersByTime(60_000);
    expect(await service.latest()).toBe(previous);
    expect(request).toHaveBeenCalledTimes(6);
  });
});
