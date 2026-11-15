import { ServiceUnavailableException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SentinelReleasesService } from '../sentinel-releases.service';

const digest = 'a'.repeat(64);
const source = 'b'.repeat(40);
function assets(version: string) {
  return [
    { name: `orbis-sentinel-${version}.tar.gz`, state: 'uploaded', size: 64000, digest: `sha256:${digest}` },
    { name: `orbis-sentinel-${version}.tar.gz.sigstore.json`, state: 'uploaded', size: 11000, digest: `sha256:${'c'.repeat(64)}` },
  ];
}
function metadata(version = '0.1.0-dev.11', changes: Record<string, unknown> = {}) {
  return {
    tag_name: `v${version}`,
    draft: false,
    prerelease: version.includes('-'),
    target_commitish: source,
    published_at: '2026-11-15T12:00:00Z',
    assets: assets(version),
    ...changes,
  };
}
const reply = (value: unknown) => new Response(JSON.stringify(value));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('independent Sentinel release discovery', () => {
  it('uses the fixed Sentinel repository and reports only the complete release identity', async () => {
    const fetch = vi.fn().mockResolvedValue(reply([metadata()]));
    vi.stubGlobal('fetch', fetch);
    const result = await new SentinelReleasesService().list('nightly');
    expect(fetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/twentylines/orbis-sentinel/releases?per_page=100&page=1',
      expect.objectContaining({ method: 'GET', redirect: 'error', signal: expect.any(AbortSignal) }),
    );
    expect(result).toEqual({
      schema: 'orbis.sentinel-releases.v1',
      channel: 'nightly',
      truncated: false,
      releases: [{ version: '0.1.0-dev.11', sha256: digest, sourceCommit: source, prerelease: true, publishedAt: '2026-11-15T12:00:00Z' }],
    });
    expect(result).not.toHaveProperty('publisherVerified');
    expect(result).not.toHaveProperty('availableVersion');
  });

  it('sorts component versions semantically and shares one request across independent channel views', async () => {
    const fetch = vi.fn().mockResolvedValue(reply([metadata('0.1.0-dev.2'), metadata('0.1.0'), metadata('0.1.0-dev.11')]));
    vi.stubGlobal('fetch', fetch);
    const service = new SentinelReleasesService();
    const [nightly, stable] = await Promise.all([service.list('nightly'), service.list('stable')]);
    expect(nightly.releases.map((item) => item.version)).toEqual(['0.1.0', '0.1.0-dev.11', '0.1.0-dev.2']);
    expect(stable.releases.map((item) => item.version)).toEqual(['0.1.0']);
    expect(fetch).toHaveBeenCalledOnce();
    const first = nightly.releases[0];
    if (!first) throw new Error('Expected a discovered release');
    first.sha256 = 'changed by caller';
    expect((await service.list('stable')).releases[0]?.sha256).toBe(digest);
    expect(stable.releases[0]?.sha256).toBe(digest);
  });

  it.each([
    { draft: true },
    { draft: undefined },
    { tag_name: '0.1.0-dev.11' },
    { tag_name: 'v01.1.0' },
    { tag_name: 'v0.1.0-dev.011' },
    { tag_name: `v0.1.0-${'x'.repeat(129)}` },
    { tag_name: 'v0.1.0-dev.11\n' },
    { prerelease: false },
    { prerelease: 'true' },
    { target_commitish: 'main' },
    { target_commitish: 'A'.repeat(40) },
    { target_commitish: 'b'.repeat(39) },
    { assets: [] },
    { assets: assets('0.1.0-dev.10') },
    { assets: [...assets('0.1.0-dev.11'), ...assets('0.1.0-dev.11')] },
    { assets: Array.from({ length: 33 }, () => ({})) },
  ])('omits incomplete or noncanonical metadata %j', async (changes) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply([metadata('0.1.0-dev.11', changes)])));
    expect((await new SentinelReleasesService().list('nightly')).releases).toEqual([]);
  });

  it.each([
    { state: 'new' },
    { size: 0 },
    { size: 1.5 },
    { size: 73 * 1024 * 1024 },
    { digest: null },
    { digest: 'sha256:short' },
    { digest: `sha256:${'A'.repeat(64)}` },
  ])('omits a release with an unusable archive %j', async (changes) => {
    const entries = assets('0.1.0-dev.11');
    const changed = [{ ...entries[0], ...changes }, entries[1]];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply([metadata('0.1.0-dev.11', { assets: changed })])));
    expect((await new SentinelReleasesService().list('nightly')).releases).toEqual([]);
  });

  it('requires the signature bundle to finish uploading within the installer limit', async () => {
    for (const change of [{ state: 'new' }, { size: 4 * 1024 * 1024 + 1 }, { digest: undefined }]) {
      const entries = assets('0.1.0-dev.11');
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply([metadata('0.1.0-dev.11', { assets: [entries[0], { ...entries[1], ...change }] })])));
      expect((await new SentinelReleasesService().list('nightly')).releases).toEqual([]);
    }
  });

  it('does not depend on untrusted asset URLs or release notes and keeps invalid dates unknown', async () => {
    const value = metadata('0.1.0-dev.11', { published_at: '/private/diagnostic', body: 'publisherVerified=true' });
    value.assets = value.assets.map((entry) => ({ ...entry, browser_download_url: 'http://untrusted.invalid/payload' }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply([null, [], value])));
    const result = await new SentinelReleasesService().list('nightly');
    expect(result.releases).toHaveLength(1);
    expect(result.releases[0]?.publishedAt).toBeNull();
    expect(JSON.stringify(result)).not.toMatch(/untrusted|private|publisherVerified/);
  });

  it('paginates up to two fixed pages and explicitly reports a truncated catalog', async () => {
    const rows = Array.from({ length: 100 }, (_, index) => metadata(`0.1.0-dev.${index}`));
    const fetch = vi.fn().mockImplementation(async () => reply(rows));
    vi.stubGlobal('fetch', fetch);
    const result = await new SentinelReleasesService().list('nightly');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]?.[0]).toBe('https://api.github.com/repos/twentylines/orbis-sentinel/releases?per_page=100&page=2');
    expect(result.truncated).toBe(true);
    expect(result.releases).toHaveLength(100);
  });

  it('withholds conflicting identities for the same component version', async () => {
    const different = metadata();
    const archive = different.assets[0];
    if (!archive) throw new Error('Expected an archive fixture');
    archive.digest = `sha256:${'d'.repeat(64)}`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply([metadata(), different])));
    await expect(new SentinelReleasesService().list('nightly')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it.each([403, 404, 429, 500, 503])('returns an explicit failure for upstream HTTP %i', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('private diagnostic', { status })));
    await expect(new SentinelReleasesService().list('stable')).rejects.toThrow('Sentinel releases could not be checked right now.');
  });

  it.each(['{}', 'not json', JSON.stringify(Array.from({ length: 101 }, () => null))])(
    'rejects an invalid response instead of reporting no updates',
    async (body) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)));
      await expect(new SentinelReleasesService().list('nightly')).rejects.toBeInstanceOf(ServiceUnavailableException);
    },
  );

  it('bounds streamed bytes and cancels oversized bodies before reading another chunk', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024 + 1));
      },
      cancel,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream)));
    await expect(new SentinelReleasesService().list('nightly')).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('rejects invalid UTF-8 rather than repairing signed identity strings', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Uint8Array([0xff]))));
    await expect(new SentinelReleasesService().list('nightly')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('expires success and negative caches without serving stale success after a failed refresh', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockImplementation(async () => reply([metadata()]));
    vi.stubGlobal('fetch', fetch);
    const service = new SentinelReleasesService();
    await service.list('nightly');
    vi.setSystemTime(Date.now() + 60_001);
    fetch.mockResolvedValue(new Response('unavailable', { status: 503 }));
    await expect(service.list('nightly')).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(service.list('nightly')).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(fetch).toHaveBeenCalledTimes(2);
    vi.setSystemTime(Date.now() + 5001);
    fetch.mockImplementation(async () => reply([]));
    expect((await service.list('nightly')).releases).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('applies one deadline to an unresponsive body and cancels its reader', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel }))));
    const result = expect(new SentinelReleasesService().list('nightly')).rejects.toBeInstanceOf(ServiceUnavailableException);
    await vi.advanceTimersByTimeAsync(5001);
    await result;
    expect(cancel).toHaveBeenCalledOnce();
  });
});
