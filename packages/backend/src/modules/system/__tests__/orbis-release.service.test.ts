import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  latestTagFromAtom,
  OrbisReleaseService,
  parseOrbisReleaseNotes,
  withCumulativeCriticalPriority,
  type OrbisRelease,
} from '../orbis-release.service';

const TAG = 'v0.1.0-beta.9';
const FEED = `<feed><entry><id>tag:github.com,2008:Repository/1419897175/${TAG}</id><updated>2026-10-15T03:00:00Z</updated></entry></feed>`;

describe('Orbis release feed', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('uses the public Atom feed and tagged notes when the GitHub API is rate limited', async () => {
    const request = vi.spyOn(global, 'fetch').mockImplementation(async (input, _init) => {
      const url = String(input);
      expect(url).not.toContain('api.github.com');
      if (url.endsWith('/releases.atom')) return new Response(FEED);
      if (url.endsWith(`/${TAG}.md`)) return new Response('# Verified release notes');
      if (url.endsWith('/release-manifest.json')) return releaseManifestResponse(url);
      throw new Error(`unexpected release request: ${url}`);
    });
    const service = new OrbisReleaseService();
    expect(await service.latest('nightly')).toEqual({
      tag: TAG,
      publishedAt: '2026-10-15T03:00:00Z',
      body: '# Verified release notes',
      kind: 'maintenance',
      url: `https://github.com/twentylines/orbis/releases/tag/${TAG}`,
      imageManifestUrl: `https://github.com/twentylines/orbis/releases/download/${TAG}/release-manifest.json`,
    });
    await service.latest('nightly');
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('ignores malformed feed tags', () => {
    expect(latestTagFromAtom(FEED.replace(TAG, 'v0.1.0;unsafe'))).toBeNull();
  });

  it('keeps published beta releases in Stable and skips inactive build tags before fetching their assets', async () => {
    const excluded = ['v0.1.0-nightly.20261025', 'v0.1.0-dev.1', 'v0.1.0-alpha.1'];
    const feed = FEED.replace(
      '<feed>',
      `<feed>${excluded.map((tag) => `<entry><id>tag:github.com,2008:Repository/1419897175/${tag}</id></entry>`).join('')}`,
    );
    const request = vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/releases.atom')) return new Response(feed);
      if (url.endsWith(`/${TAG}.md`)) return new Response('# Current beta');
      if (url.includes(`/${TAG}/release-manifest.json`)) return new Response(null);
      throw new Error(`unexpected release request: ${url}`);
    });
    expect((await new OrbisReleaseService().latest('nightly'))?.tag).toBe(TAG);
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls.every(([url]) => !excluded.some((tag) => String(url).includes(tag)))).toBe(true);
  });

  it('rechecks an unfinished release after 30 seconds and shares concurrent requests', async () => {
    vi.useFakeTimers();
    let manifestReady = false;
    const request = vi.spyOn(global, 'fetch').mockImplementation(async (input, _init) => {
      const url = String(input);
      if (url.endsWith('/releases.atom')) return new Response(FEED);
      if (url.endsWith(`/${TAG}.md`)) return new Response('# Release notes');
      if (url.endsWith('/release-manifest.json')) return manifestReady ? releaseManifestResponse(url) : new Response(null, { status: 404 });
      throw new Error(`unexpected release request: ${url}`);
    });
    const service = new OrbisReleaseService();
    expect((await service.latest('nightly'))?.imageManifestUrl).toBeNull();
    manifestReady = true;
    vi.advanceTimersByTime(29_999);
    expect((await service.latest('nightly'))?.imageManifestUrl).toBeNull();
    expect(request).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(1);
    const refreshed = await Promise.all(Array.from({ length: 8 }, () => service.latest('nightly')));
    expect(refreshed.every((value) => value?.imageManifestUrl?.endsWith('/release-manifest.json'))).toBe(true);
    expect(request).toHaveBeenCalledTimes(6);
    vi.advanceTimersByTime(60_000);
    expect((await service.latest('nightly'))?.imageManifestUrl).not.toBeNull();
    expect(request).toHaveBeenCalledTimes(7);
  });

  it('finds a new release after one minute without downloading unchanged notes again', async () => {
    vi.useFakeTimers();
    let tag = TAG;
    const request = vi.spyOn(global, 'fetch').mockImplementation(async (input, _init) => {
      const url = String(input);
      if (url.endsWith('/releases.atom')) return new Response(FEED.replace(TAG, tag));
      if (url.endsWith(`/${tag}.md`)) return new Response(`# ${tag}`);
      if (url.endsWith('/release-manifest.json')) return releaseManifestResponse(url);
      throw new Error(`unexpected release request: ${url}`);
    });
    const service = new OrbisReleaseService();
    expect((await service.latest('nightly'))?.tag).toBe(TAG);
    vi.advanceTimersByTime(59_999);
    await service.latest('nightly');
    expect(request).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(1);
    await Promise.all(Array.from({ length: 8 }, () => service.latest('nightly')));
    expect(request).toHaveBeenCalledTimes(4);

    tag = 'v0.1.0-beta.10';
    vi.advanceTimersByTime(60_000);
    const refreshed = await Promise.all(Array.from({ length: 8 }, () => service.latest('nightly')));
    expect(refreshed.every((release) => release?.tag === tag && release.body === `# ${tag}`)).toBe(true);
    expect(request).toHaveBeenCalledTimes(7);
  });

  it('retains the last known release when a later automatic check cannot reach GitHub', async () => {
    vi.useFakeTimers();
    let offline = false;
    const request = vi.spyOn(global, 'fetch').mockImplementation(async (input, _init) => {
      const url = String(input);
      if (offline) throw new Error('network unavailable');
      if (url.endsWith('/releases.atom')) return new Response(FEED);
      if (url.endsWith(`/${TAG}.md`)) return new Response('# Release notes');
      if (url.endsWith('/release-manifest.json')) return releaseManifestResponse(url);
      throw new Error(`unexpected release request: ${url}`);
    });
    const service = new OrbisReleaseService();
    const previous = await service.latest('nightly');
    offline = true;
    vi.advanceTimersByTime(60_000);
    const results = await Promise.all(Array.from({ length: 8 }, () => service.latest('nightly')));
    expect(results.every((release) => release === previous)).toBe(true);
    expect(request).toHaveBeenCalledTimes(4);
  });

  it('keeps the previous installable release while a newer tag is building, then discovers its manifest', async () => {
    vi.useFakeTimers();
    const next = 'v0.1.0-beta.10';
    const feed = FEED.replace('<feed>', `<feed><entry><id>tag:github.com,2008:Repository/1419897175/${next}</id></entry>`);
    let ready = false;
    const request = vi.spyOn(global, 'fetch').mockImplementation(async (input, _init) => {
      const url = String(input);
      if (url.endsWith('/releases.atom')) return new Response(feed);
      if (url.endsWith('.md')) return new Response('# Release notes');
      if (url.endsWith('/release-manifest.json')) {
        return url.includes(`/${next}/`) && !ready ? new Response(null, { status: 404 }) : releaseManifestResponse(url);
      }
      throw new Error(`unexpected release request: ${url}`);
    });
    const service = new OrbisReleaseService();
    expect((await service.latest('nightly'))?.tag).toBe(TAG);
    expect((await service.latest('nightly'))?.imageManifestUrl).toContain(`/${TAG}/`);
    expect(request).toHaveBeenCalledTimes(5);

    vi.advanceTimersByTime(60_000);
    expect((await service.latest('nightly'))?.tag).toBe(TAG);
    expect(request).toHaveBeenCalledTimes(8);
    ready = true;
    vi.advanceTimersByTime(60_000);
    const updated = await Promise.all(Array.from({ length: 8 }, () => service.latest('nightly')));
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
      if (url.endsWith('/release-manifest.json')) return releaseManifestResponse(url);
      throw new Error(`unexpected release request: ${url}`);
    });
    expect((await new OrbisReleaseService().latest('nightly'))?.tag).toBe(TAG);
  });

  it('retains a known installable release on a manifest outage instead of treating the outage as an unpublished tag', async () => {
    vi.useFakeTimers();
    const next = 'v0.1.0-beta.10';
    let outage = false;
    const request = vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/releases.atom')) return new Response(outage ? FEED.replace(TAG, next) : FEED);
      if (url.endsWith('.md')) return new Response('# Release notes');
      if (url.endsWith('/release-manifest.json')) return outage ? new Response(null, { status: 503 }) : releaseManifestResponse(url);
      throw new Error(`unexpected release request: ${url}`);
    });
    const service = new OrbisReleaseService();
    const previous = await service.latest('nightly');
    outage = true;
    vi.advanceTimersByTime(60_000);
    expect(await service.latest('nightly')).toBe(previous);
    expect(request).toHaveBeenCalledTimes(6);
  });
});

const metadata = (number: number, extra: Record<string, unknown> = {}) => ({
  tag_name: `v0.1.0-beta.${number}`,
  draft: false,
  published_at: '2026-10-24T00:00:00Z',
  body: `# Orbis v0.1.0-beta.${number}\n\n- Change ${number}`,
  assets: [{ name: 'release-manifest.json', state: 'uploaded' }],
  ...extra,
});
const atom = (numbers: number[]) =>
  `<feed>${numbers.map((number) => `<entry><id>tag:github.com,2008:Repository/1419897175/v0.1.0-beta.${number}</id></entry>`).join('')}</feed>`;

const publishedRelease = (tag: string, critical = false): OrbisRelease => ({
  tag,
  publishedAt: '2026-10-24T00:00:00Z',
  body: `# Orbis ${tag}`,
  url: `https://github.com/twentylines/orbis/releases/tag/${tag}`,
  imageManifestUrl: `https://github.com/twentylines/orbis/releases/download/${tag}/release-manifest.json`,
  ...(critical ? { priority: 'critical' as const } : {}),
});

const releaseMetadata = (tag: string, critical = false) => ({
  tag_name: tag,
  draft: false,
  published_at: '2026-10-24T00:00:00Z',
  body: `${critical ? '<!-- orbis-update-priority: critical -->\n' : ''}# Orbis ${tag}`,
  assets: [{ name: 'release-manifest.json', state: 'uploaded' }],
});

const releaseManifestResponse = (url: string, criticalThrough: string | null = null) => {
  const tag = url.match(/\/download\/(v[^/]+)\/release-manifest\.json/)?.[1] ?? TAG;
  return Response.json({
    schema: 'orbis.release.v1',
    image: 'ghcr.io/twentylines/orbis',
    tag,
    commit: 'a'.repeat(40),
    releaseChannel: /-(beta|rc)\./.test(tag) ? 'nightly' : 'stable',
    updatePriority: 'normal',
    criticalThrough,
  });
};

describe('cumulative critical release priority', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('carries an unapplied intermediate critical release onto the latest and catalogue target', async () => {
    vi.stubEnv('ORBIS_VERSION', 'v1.1.0');
    const request = vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/releases/latest')) return Response.json(releaseMetadata('v1.1.3'));
      if (url.endsWith('/releases?per_page=100&page=1')) {
        return Response.json([releaseMetadata('v1.1.3'), releaseMetadata('v1.1.2', true), releaseMetadata('v1.1.1')]);
      }
      throw new Error(`unexpected release request: ${url}`);
    });
    const service = new OrbisReleaseService();

    expect(await service.latest('stable')).toMatchObject({ tag: 'v1.1.3', priority: 'critical' });
    expect((await service.listPublished('stable')).releases[0]).toMatchObject({ tag: 'v1.1.3', priority: 'critical' });
    expect(request.mock.calls.filter(([url]) => String(url).includes('/releases?per_page=100&page=')).length).toBe(1);
  });

  it('does not carry an already-applied critical release forward', async () => {
    vi.stubEnv('ORBIS_VERSION', 'v1.1.2');
    vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/releases/latest')) return Response.json(releaseMetadata('v1.1.3'));
      if (url.endsWith('/releases?per_page=100&page=1')) {
        return Response.json([releaseMetadata('v1.1.3'), releaseMetadata('v1.1.2', true)]);
      }
      throw new Error(`unexpected release request: ${url}`);
    });
    const service = new OrbisReleaseService();

    expect(await service.latest('stable')).toMatchObject({ tag: 'v1.1.3' });
    expect(await service.latest('stable')).not.toHaveProperty('priority');
    expect((await service.listPublished('stable')).releases[0]).not.toHaveProperty('priority');
  });

  it('leaves normal priority unchanged for an unknown or development install while preserving a critical target', async () => {
    vi.stubEnv('ORBIS_VERSION', 'development');
    let targetIsCritical = false;
    const request = vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/releases/latest')) return Response.json(releaseMetadata('v1.1.3', targetIsCritical));
      throw new Error(`unexpected release request: ${url}`);
    });
    const service = new OrbisReleaseService();

    expect(await service.latest('stable')).not.toHaveProperty('priority');
    expect(request).toHaveBeenCalledTimes(1);
    targetIsCritical = true;
    expect(await new OrbisReleaseService().latest('stable')).toMatchObject({ tag: 'v1.1.3', priority: 'critical' });
    expect(request).toHaveBeenCalledTimes(2);
    const criticalTarget = publishedRelease('v1.1.3', true);
    expect(withCumulativeCriticalPriority(criticalTarget, 'development', [], 'stable')).toBe(criticalTarget);
    expect(withCumulativeCriticalPriority(publishedRelease('v1.1.3'), undefined, [], 'stable')).toEqual(publishedRelease('v1.1.3'));
  });

  it('ignores critical releases newer than the target or older than the installed version', () => {
    const target = publishedRelease('v1.1.3');
    const installed = 'v1.1.0';

    expect(withCumulativeCriticalPriority(target, installed, [publishedRelease('v1.1.4', true), publishedRelease('v1.0.9', true)], 'stable')).toBe(
      target,
    );
    expect(withCumulativeCriticalPriority(target, 'v1.1.2', [publishedRelease('v1.1.2', true)], 'stable')).toBe(target);
  });

  it('keeps catalogue fallback attention on the same critical patch across ordinary candidates', () => {
    const fixes = [publishedRelease('v1.1.2', true)];
    expect(withCumulativeCriticalPriority(publishedRelease('v1.1.3'), 'v1.1.0', fixes, 'stable')).toMatchObject({ criticalThrough: 'v1.1.2' });
    expect(withCumulativeCriticalPriority(publishedRelease('v1.1.4'), 'v1.1.0', fixes, 'stable')).toMatchObject({ criticalThrough: 'v1.1.2' });
    expect(
      withCumulativeCriticalPriority(publishedRelease('v1.1.6'), 'v1.1.0', [...fixes, publishedRelease('v1.1.5', true)], 'stable'),
    ).toMatchObject({ criticalThrough: 'v1.1.5' });
  });

  it('uses the durable critical-through marker beyond the bounded release catalogue', () => {
    const target = { ...publishedRelease('v1.1.3'), criticalThrough: 'v1.1.2' };
    expect(withCumulativeCriticalPriority(target, 'v1.1.0', [], 'stable')).toMatchObject({ priority: 'critical' });
    expect(withCumulativeCriticalPriority(target, 'v1.1.2', [], 'stable')).toBe(target);
    expect(withCumulativeCriticalPriority({ ...target, criticalThrough: 'v1.1.4' }, 'v1.1.0', [], 'stable')).toEqual({
      ...target,
      criticalThrough: 'v1.1.4',
    });
    const wrongChannel = { ...target, criticalThrough: 'v1.1.2-beta.9' };
    expect(withCumulativeCriticalPriority(wrongChannel, 'v1.1.0', [], 'stable')).toBe(wrongChannel);
  });

  it('shows a normal future Nightly as critical only while beta 115 remains unapplied', () => {
    const target = { ...publishedRelease('v0.1.0-beta.116'), criticalThrough: 'v0.1.0-beta.115' };
    expect(target).not.toHaveProperty('priority');
    expect(withCumulativeCriticalPriority(target, 'v0.1.0-beta.114', [], 'nightly')).toMatchObject({ priority: 'critical' });
    expect(withCumulativeCriticalPriority(target, 'v0.1.0-beta.115', [], 'nightly')).toBe(target);
    expect(withCumulativeCriticalPriority(target, 'v0.1.0-beta.116', [], 'nightly')).toBe(target);
    expect(target).not.toHaveProperty('priority');
  });

  it('retains an old Nightly critical watermark from the bounded manifest when release APIs are unavailable', async () => {
    vi.stubEnv('ORBIS_VERSION', 'v0.1.0-beta.7');
    const request = vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('api.github.com')) return new Response(null, { status: 403 });
      if (url.endsWith('/releases.atom')) return new Response(FEED);
      if (url.endsWith(`/${TAG}.md`)) return new Response('# Nightly patch');
      if (url.endsWith('/release-manifest.json')) return releaseManifestResponse(url, 'v0.1.0-beta.8');
      throw new Error(`unexpected release request: ${url}`);
    });

    expect(await new OrbisReleaseService().latest('nightly')).toMatchObject({
      tag: TAG,
      criticalThrough: 'v0.1.0-beta.8',
      priority: 'critical',
    });
    expect((await new OrbisReleaseService().listPublished('nightly')).releases[0]).toMatchObject({
      tag: TAG,
      criticalThrough: 'v0.1.0-beta.8',
      priority: 'critical',
    });
    expect(request.mock.calls.some(([url]) => String(url).includes('/releases/tags/'))).toBe(false);
  });

  it('does not return normal-priority catalogue data when the latest manifest is unavailable', async () => {
    vi.stubEnv('ORBIS_VERSION', 'v0.1.0-beta.7');
    vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('api.github.com')) return new Response(null, { status: 429 });
      if (url.endsWith('/releases.atom')) return new Response(FEED);
      if (url.endsWith(`/${TAG}.md`)) return new Response('# Nightly patch');
      if (url.endsWith('/release-manifest.json')) return new Response(null, { status: 503 });
      throw new Error(`unexpected release request: ${url}`);
    });

    await expect(new OrbisReleaseService().listPublished('nightly')).rejects.toThrow('temporarily unavailable');
  });

  it('accepts a Stable manifest on Nightly when release APIs are unavailable and retains its critical fix', async () => {
    vi.stubEnv('ORBIS_VERSION', 'v1.1.0-beta.3');
    const tag = 'v1.1.0';
    vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('api.github.com')) return new Response(null, { status: 429 });
      if (url.endsWith('/releases.atom')) return new Response(FEED.replaceAll(TAG, tag));
      if (url.endsWith(`/${tag}.md`)) return new Response('# Stable release');
      if (url.endsWith('/release-manifest.json')) return releaseManifestResponse(url, tag);
      throw new Error(`unexpected release request: ${url}`);
    });

    const service = new OrbisReleaseService();
    expect(await service.latest('nightly')).toMatchObject({
      tag,
      criticalThrough: tag,
      priority: 'critical',
      imageManifestUrl: `https://github.com/twentylines/orbis/releases/download/${tag}/release-manifest.json`,
    });
    expect((await service.listPublished('nightly')).releases[0]).toMatchObject({ tag, priority: 'critical' });
  });

  it('reads the release-body watermark without a catalogue request', async () => {
    vi.stubEnv('ORBIS_VERSION', 'v1.1.0');
    const request = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(Response.json({ ...releaseMetadata('v1.1.3'), body: '<!-- orbis-critical-through: v1.1.2 -->\n# Release' }));
    expect(await new OrbisReleaseService().latest('stable')).toMatchObject({
      tag: 'v1.1.3',
      priority: 'critical',
      criticalThrough: 'v1.1.2',
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('fails closed when legacy cumulative-priority discovery is unavailable', async () => {
    vi.stubEnv('ORBIS_VERSION', 'v1.1.0');
    vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/releases/latest')) return Response.json(releaseMetadata('v1.1.3'));
      throw new Error('release catalog unavailable');
    });
    await expect(new OrbisReleaseService().latest('stable')).rejects.toThrow('Orbis release priority is temporarily unavailable.');
  });

  it('keeps stable and nightly critical releases isolated by selected channel', async () => {
    vi.stubEnv('ORBIS_VERSION', 'v1.1.0');
    const request = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(Response.json([releaseMetadata('v1.1.3'), releaseMetadata('v1.1.2-beta.1', true), releaseMetadata('v1.0.9', true)]));
    const service = new OrbisReleaseService();

    expect((await service.listPublished('stable')).releases[0]).not.toHaveProperty('priority');
    expect((await service.listPublished('nightly')).releases[0]).toMatchObject({ tag: 'v1.1.3', priority: 'critical' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('finds a critical release on the second bounded catalogue page without fetching a third', async () => {
    vi.stubEnv('ORBIS_VERSION', 'v1.0.0');
    const firstPage = Array.from({ length: 100 }, (_, index) => releaseMetadata(`v1.1.${200 - index}`));
    const secondPage = Array.from({ length: 100 }, (_, index) => releaseMetadata(`v1.1.${100 - index}`, index === 50));
    const request = vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/releases/latest')) return Response.json(releaseMetadata('v1.1.200'));
      if (url.endsWith('/releases?per_page=100&page=1')) return Response.json(firstPage);
      if (url.endsWith('/releases?per_page=100&page=2')) return Response.json(secondPage);
      throw new Error(`unexpected release request: ${url}`);
    });
    const service = new OrbisReleaseService();

    expect(await service.latest('stable')).toMatchObject({ tag: 'v1.1.200', priority: 'critical' });
    const catalog = await service.listPublished('stable');
    expect(catalog.complete).toBe(false);
    expect(catalog.releases[0]).toMatchObject({ tag: 'v1.1.200', priority: 'critical' });
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls.some(([url]) => String(url).includes('page=3'))).toBe(false);
  });
});

describe('Orbis included release history', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('excludes inactive build tags from API catalogues while retaining beta prereleases', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      Response.json([
        metadata(96, { prerelease: true }),
        metadata(97, { tag_name: 'v0.1.0-nightly.20261025', prerelease: true }),
        metadata(97, { tag_name: 'v0.1.0-dev.1', prerelease: true }),
        metadata(97, { tag_name: 'v0.1.0-alpha.1', prerelease: true }),
      ]),
    );
    expect((await new OrbisReleaseService().listPublished('nightly')).releases.map((release) => release.tag)).toEqual(['v0.1.0-beta.96']);
  });

  it('rejects inactive history targets before requesting the published catalogue', async () => {
    const request = vi.spyOn(global, 'fetch');
    for (const target of ['v0.1.0-nightly.20261025', '1.0.0-dev.1', 'v1.0.0-alpha.1']) {
      await expect(new OrbisReleaseService().history(TAG, target, 'nightly')).rejects.toThrow('available on this update channel');
    }
    expect(request).not.toHaveBeenCalled();
  });

  it('includes every skipped release after the installed version through the target, newest first', async () => {
    const request = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify([metadata(90), metadata(87), metadata(89), metadata(91), metadata(88)])));
    const service = new OrbisReleaseService();
    const results = await Promise.all(Array.from({ length: 8 }, () => service.history('v0.1.0-beta.87', 'v0.1.0-beta.90', 'nightly')));
    expect(results[0]?.releases.map((release) => release.tag)).toEqual(['v0.1.0-beta.90', 'v0.1.0-beta.89', 'v0.1.0-beta.88']);
    expect(results.every((result) => result.complete && !result.truncated)).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toBe('https://api.github.com/repos/twentylines/orbis/releases?per_page=100&page=1');
    expect(request.mock.calls[0]?.[1]?.headers).not.toHaveProperty('Authorization');
    await service.listPublished('nightly');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('normalizes numeric version ordering and never uses metadata URLs as a fetch destination', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify([
          metadata(9),
          metadata(10, {
            html_url: 'https://attacker.test',
            assets: [{ name: 'release-manifest.json', state: 'uploaded', browser_download_url: 'https://attacker.test' }],
          }),
          metadata(11, { draft: true }),
          metadata(12, { tag_name: 'unsafe/path' }),
          metadata(10),
        ]),
      ),
    );
    const result = await new OrbisReleaseService().history('0.1.0-beta.8', '0.1.0-beta.10', 'nightly');
    expect(result.complete).toBe(true);
    expect(result.releases.map((release) => release.tag)).toEqual(['v0.1.0-beta.10', 'v0.1.0-beta.9']);
    expect(result.releases[0]?.url).toBe('https://github.com/twentylines/orbis/releases/tag/v0.1.0-beta.10');
    expect(result.releases[0]?.imageManifestUrl).toBe('https://github.com/twentylines/orbis/releases/download/v0.1.0-beta.10/release-manifest.json');
  });

  it('bounds catalogue requests to two pages and included notes to the latest100 releases', async () => {
    const request = vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const page = String(input).endsWith('page=1') ? 1 : 2;
      return new Response(JSON.stringify(Array.from({ length: 100 }, (_, index) => metadata(201 - (page - 1) * 100 - index))));
    });
    const service = new OrbisReleaseService();
    const result = await service.history('v0.1.0-beta.1', 'v0.1.0-beta.201', 'nightly');
    expect(request).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ complete: false, truncated: true });
    expect(result.releases).toHaveLength(100);
    expect(result.releases.at(-1)?.tag).toBe('v0.1.0-beta.102');
    const recent = await service.history('v0.1.0-beta.198', 'v0.1.0-beta.201', 'nightly');
    expect(recent.complete).toBe(true);
    expect(recent.releases).toHaveLength(3);
  });

  it('falls back to tagged notes without an API token when the public release API is rate limited', async () => {
    const request = vi.spyOn(global, 'fetch').mockImplementation(async (input, _init) => {
      const url = String(input);
      if (url.includes('api.github.com')) return new Response(null, { status: 403 });
      if (url.endsWith('releases.atom')) return new Response(atom([90, 89, 88, 87]));
      if (url.endsWith('.md')) return new Response('- Tagged release change');
      if (url.endsWith('/release-manifest.json')) return releaseManifestResponse(url);
      throw new Error(`unexpected release request: ${url}`);
    });
    const result = await new OrbisReleaseService().history('v0.1.0-beta.87', 'v0.1.0-beta.90', 'nightly');
    expect(result.complete).toBe(true);
    expect(result.releases.map((release) => release.tag)).toEqual(['v0.1.0-beta.90', 'v0.1.0-beta.89', 'v0.1.0-beta.88']);
    expect(result.releases.every((release) => release.imageManifestUrl && release.body)).toBe(true);
    expect(request).toHaveBeenCalledTimes(10);
  });

  it('does not claim complete coverage if a note is missing or the installed version predates the bounded feed', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (input, _init) => {
      const url = String(input);
      if (url.includes('api.github.com')) return new Response(null, { status: 429 });
      if (url.endsWith('releases.atom')) return new Response(atom([90, 89, 88, 87]));
      if (url.includes('/v0.1.0-beta.89/')) return new Response(null, { status: 404 });
      if (url.endsWith('/release-manifest.json')) return releaseManifestResponse(url);
      return new Response('- Change');
    });
    const service = new OrbisReleaseService();
    const incomplete = await service.history('v0.1.0-beta.87', 'v0.1.0-beta.90', 'nightly');
    expect(incomplete.complete).toBe(false);
    expect(incomplete.releases.find((release) => release.tag === 'v0.1.0-beta.89')?.body).toBe('');
    expect((await service.history('v0.1.0-beta.1', 'v0.1.0-beta.90', 'nightly')).complete).toBe(false);
  });

  it('expires the shared catalogue after one minute and retains known metadata during an outage', async () => {
    vi.useFakeTimers();
    let offline = false;
    const request = vi.spyOn(global, 'fetch').mockImplementation(async () => {
      if (offline) throw new Error('offline');
      return new Response(JSON.stringify([metadata(90), metadata(89)]));
    });
    const service = new OrbisReleaseService();
    const previous = await service.listPublished('nightly');
    offline = true;
    vi.advanceTimersByTime(60_000);
    const repeated = await Promise.all(Array.from({ length: 8 }, () => service.listPublished('nightly')));
    expect(repeated.every((result) => JSON.stringify(result) === JSON.stringify(previous))).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('rejects malformed, array and backwards ranges before any network request', async () => {
    const request = vi.spyOn(global, 'fetch');
    const service = new OrbisReleaseService();
    for (const [installed, target] of [
      ['development', TAG],
      [TAG, 'unsafe/path'],
      [[TAG], TAG],
      [TAG, 'v0.1.0-beta.8'],
      [`v${'1'.repeat(150)}`, TAG],
    ]) {
      await expect(service.history(installed, target, 'nightly')).rejects.toThrow('Provide valid installed and target');
    }
    expect(await service.history(TAG, TAG, 'nightly')).toEqual({ releases: [], complete: true, truncated: false, context: null });
    expect(request).not.toHaveBeenCalled();
  });

  it('reports missing targets and oversized notes without claiming that all notes were read', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify([metadata(89), metadata(88, { body: 'x'.repeat(65 * 1024) })])));
    const service = new OrbisReleaseService();
    expect((await service.history('v0.1.0-beta.87', 'v0.1.0-beta.90', 'nightly')).complete).toBe(false);
    const result = await service.history('v0.1.0-beta.87', 'v0.1.0-beta.89', 'nightly');
    expect(result.complete).toBe(false);
    expect(result.releases[1]?.body).toBe('');
  });
  it('keeps an already-installed feature baseline as clearly separate context for a later revision', async () => {
    const rows = [
      { ...metadata(0), tag_name: 'v1.1.0-beta.0', body: '<!-- orbis-release-kind: feature -->\n# Orbis v1.1.0-beta.0\n\n- New feature' },
      { ...metadata(1), tag_name: 'v1.1.0-beta.1' },
      { ...metadata(2), tag_name: 'v1.1.0-beta.2' },
    ];
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify(rows)));
    const result = await new OrbisReleaseService().history('v1.1.0-beta.1', 'v1.1.0-beta.2', 'nightly');
    expect(result.complete).toBe(true);
    expect(result.releases.map((release) => release.tag)).toEqual(['v1.1.0-beta.2']);
    expect(result.context).toMatchObject({ tag: 'v1.1.0-beta.0', kind: 'feature', body: '# Orbis v1.1.0-beta.0\n\n- New feature' });
  });

  it('reads explicit feature significance without guessing from version numbers or note wording', () => {
    expect(parseOrbisReleaseNotes('<!-- orbis-release-kind: feature -->\n# Orbis v1.1.0\n\n- Feature')).toEqual({
      kind: 'feature',
      body: '# Orbis v1.1.0\n\n- Feature',
    });
    expect(parseOrbisReleaseNotes('<!-- orbis-release-kind: maintenance -->\n- Repair')).toEqual({ kind: 'maintenance', body: '- Repair' });
    expect(parseOrbisReleaseNotes('# New feature with no explicit metadata').kind).toBe('maintenance');
    expect(parseOrbisReleaseNotes(`- Repair\n\nImage: ghcr.io/twentylines/orbis@sha256:${'a'.repeat(64)}\n`).body).toBe('- Repair');
  });

  it('keeps release caches channel-specific while filtering the shared catalog for each channel', async () => {
    const stable = metadata(1, { tag_name: 'v1.0.0', body: '# Stable release' });
    const rc = metadata(1, { tag_name: 'v1.1.0-rc.1', body: '# Release candidate' });
    const request = vi.spyOn(global, 'fetch').mockImplementation(async (input, _init) => {
      const url = String(input);
      if (url.endsWith('/releases/latest')) return Response.json(stable);
      if (url.endsWith('/releases.atom')) return new Response(atom([90]));
      if (url.endsWith('/v0.1.0-beta.90.md')) return new Response('# Nightly beta');
      if (url.endsWith('/release-manifest.json')) return releaseManifestResponse(url);
      if (url.endsWith('/releases?per_page=100&page=1')) return Response.json([stable, metadata(90), rc]);
      throw new Error(`unexpected release request: ${url}`);
    });
    const service = new OrbisReleaseService();

    expect((await service.latest())?.tag).toBe('v1.0.0');
    expect((await service.latest('nightly'))?.tag).toBe('v0.1.0-beta.90');
    expect((await service.latest())?.tag).toBe('v1.0.0');
    expect((await service.latest('nightly'))?.tag).toBe('v0.1.0-beta.90');
    expect(request.mock.calls.filter(([url]) => String(url).endsWith('/releases/latest'))).toHaveLength(1);
    expect(request.mock.calls.filter(([url]) => String(url).endsWith('/releases.atom'))).toHaveLength(1);

    expect((await service.listPublished('stable')).releases.map((release) => release.tag)).toEqual(['v1.0.0']);
    expect((await service.listPublished('nightly')).releases.map((release) => release.tag)).toEqual(['v1.1.0-rc.1', 'v1.0.0', 'v0.1.0-beta.90']);
    expect((await service.listPublished()).releases.map((release) => release.tag)).toEqual(['v1.0.0']);
    expect(request.mock.calls.filter(([url]) => String(url).includes('/releases?per_page=100&page=1'))).toHaveLength(1);
  });

  it('never returns Beta or RC tags from the default Stable latest endpoint', async () => {
    const feed = `${atom([90])}<entry><id>tag:github.com,2008:Repository/1419897175/v1.0.0-rc.1</id></entry>`;
    const request = vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/releases/latest')) return Response.json(metadata(90));
      if (url.endsWith('/releases.atom')) return new Response(feed);
      throw new Error(`unexpected release request: ${url}`);
    });

    expect(await new OrbisReleaseService().latest()).toBeNull();
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.every(([url]) => !String(url).endsWith('.md'))).toBe(true);
  });

  it('rejects Beta and RC targets from default Stable history before network access', async () => {
    const request = vi.spyOn(global, 'fetch');
    const service = new OrbisReleaseService();
    for (const target of ['v0.1.0-beta.90', 'v1.0.0-rc.1']) {
      await expect(service.history('v0.1.0-beta.8', target)).rejects.toThrow('available on this update channel');
    }
    expect(request).not.toHaveBeenCalled();
  });

  it('strips an explicit Normal priority header without changing the default priority', () => {
    expect(parseOrbisReleaseNotes('<!-- orbis-update-priority: normal -->\n- Routine fix')).toEqual({
      kind: 'maintenance',
      body: '- Routine fix',
    });
    expect(parseOrbisReleaseNotes('- Critical issue mentioned in body')).toEqual({ kind: 'maintenance', body: '- Critical issue mentioned in body' });
  });

  it('preserves critical priority and release kind with metadata headers in either order', () => {
    expect(parseOrbisReleaseNotes('<!-- orbis-release-kind: feature -->\n<!-- orbis-update-priority: critical -->\n# Feature')).toEqual({
      kind: 'feature',
      priority: 'critical',
      body: '# Feature',
    });
    expect(parseOrbisReleaseNotes('<!-- orbis-update-priority: critical -->\n<!-- orbis-release-kind: maintenance -->\n- Urgent repair')).toEqual({
      kind: 'maintenance',
      priority: 'critical',
      body: '- Urgent repair',
    });
  });

  it('parses the generated critical-through header while preserving legacy metadata', () => {
    expect(
      parseOrbisReleaseNotes(
        '<!-- orbis-critical-through: v1.1.2 -->\n<!-- orbis-update-priority: normal -->\n<!-- orbis-release-kind: maintenance -->\n- Fix',
      ),
    ).toEqual({
      kind: 'maintenance',
      criticalThrough: 'v1.1.2',
      body: '- Fix',
    });
  });
});
