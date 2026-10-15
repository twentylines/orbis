import { afterEach, describe, expect, it, vi } from 'vitest';
import { latestTagFromAtom, OrbisReleaseService } from '../orbis-release.service';

const TAG = 'v0.1.0-beta.9';
const FEED = `<feed><entry><id>tag:github.com,2008:Repository/1419897175/${TAG}</id><updated>2026-10-15T03:00:00Z</updated></entry></feed>`;

describe('Orbis release feed', () => {
  afterEach(() => vi.restoreAllMocks());

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
});
