import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateThemeFrameworkCatalogue } from '@runtipi/common/schemas/theme-framework-catalogue';
import { ThemeFrameworkCatalogueService, THEME_CATALOGUE_URL } from './theme-framework-catalogue.service';
import { ThemeFrameworkCatalogueController } from './theme-framework-catalogue.controller';

const theme = () => ({
  id: 'example.theme',
  version: '1.2.3',
  name: 'Example',
  description: 'Example theme',
  author: 'Example developer',
  repository: 'https://github.com/author/repository',
  requires: { api: 1, releases: ['v0.6.0-beta.1'] },
  supportsUiRevisions: [1],
  package: { url: 'https://github.com/author/repository/releases/download/v1.2.3/theme.zip', sha256: 'a'.repeat(64), bytes: 100 },
});
const catalogue = () => ({ schema: 'orbis.theme-framework-catalogue.v1', themes: [theme()] });
const response = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status: 200, headers });
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('full theme catalogue metadata', () => {
  it('accepts bounded records and an honestly empty catalogue', () => {
    expect(validateThemeFrameworkCatalogue(catalogue()).themes).toHaveLength(1);
    expect(validateThemeFrameworkCatalogue({ schema: 'orbis.theme-framework-catalogue.v1', themes: [] }).themes).toEqual([]);
    const unprefixed = catalogue();
    unprefixed.themes[0] = {
      ...theme(),
      package: { ...theme().package, url: 'https://github.com/author/repository/releases/download/1.2.3/theme.zip' },
    };
    expect(validateThemeFrameworkCatalogue(unprefixed).themes).toHaveLength(1);
  });

  it('rejects mismatched repositories, traversal, credentialed URLs, duplicate versions and invalid requirements', () => {
    for (const change of [
      (v: ReturnType<typeof theme>) => {
        v.package.url = 'https://github.com/other/repository/releases/download/v1.2.3/theme.zip';
      },
      (v: ReturnType<typeof theme>) => {
        v.package.url += '?token=x';
      },
      (v: ReturnType<typeof theme>) => {
        v.package.url = 'https://github.com/author/repository/releases/download/v1.2.3/../theme.zip';
      },
      (v: ReturnType<typeof theme>) => {
        v.repository = 'https://user@github.com/author/repository';
      },
      (v: ReturnType<typeof theme>) => {
        v.package.sha256 = 'not-a-digest';
      },
      (v: ReturnType<typeof theme>) => {
        v.requires.api = 2;
      },
      (v: ReturnType<typeof theme>) => {
        v.version = '1.2.3-beta.1';
      },
      ...['default', 'orbis-custom', 'example.constructor', 'prototype.example'].map((id) => (v: ReturnType<typeof theme>) => {
        v.id = id;
      }),
      ...(['name', 'description', 'author'] as const).map((key) => (v: ReturnType<typeof theme>) => {
        v[key] = '   ';
      }),
      (v: ReturnType<typeof theme>) => {
        v.requires.releases = ['v1.2.3', '1.2.3'];
      },
    ]) {
      const value = catalogue();
      change(value.themes[0] as ReturnType<typeof theme>);
      expect(() => validateThemeFrameworkCatalogue(value)).toThrow();
    }
    const value = catalogue();
    value.themes.push(theme());
    expect(() => validateThemeFrameworkCatalogue(value)).toThrow();
    expect(() => validateThemeFrameworkCatalogue({ ...catalogue(), themes: Array.from({ length: 257 }, theme) })).toThrow();
    const changed = theme();
    changed.version = '1.2.4';
    changed.repository = 'https://github.com/other/repository';
    changed.package.url = `${changed.repository}/releases/download/v1.2.4/theme.zip`;
    expect(() => validateThemeFrameworkCatalogue({ ...catalogue(), themes: [theme(), changed] })).toThrow();
    const getter = vi.fn(() => 'unexpected');
    const unsafe = {
      ...catalogue(),
      get extra() {
        return getter();
      },
    };
    expect(() => validateThemeFrameworkCatalogue(unsafe)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
});

describe('catalogue reader', () => {
  it('fetches only the fixed URL and distinguishes empty from unavailable', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response({ schema: 'orbis.theme-framework-catalogue.v1', themes: [] }));
    vi.stubGlobal('fetch', fetcher);
    const result = await new ThemeFrameworkCatalogueService().read();
    expect(result).toMatchObject({ status: 'ready', runtimeAvailable: false, catalogue: { themes: [] } });
    expect(fetcher.mock.calls[0]?.[0]).toBe(THEME_CATALOGUE_URL);
    fetcher.mockRejectedValueOnce(new Error('private detail'));
    expect(await new ThemeFrameworkCatalogueService().read()).toMatchObject({ status: 'unavailable', catalogue: null });
  });

  it('coalesces concurrent reads and reuses validated ETag data on 304', async () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(catalogue(), { ETag: '"version-1"' }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    vi.stubGlobal('fetch', fetcher);
    const service = new ThemeFrameworkCatalogueService();
    const values = await Promise.all([service.read(), service.read(), service.read()]);
    expect(values.every((v) => v.status === 'ready')).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    now += 300_001;
    expect((await service.read()).status).toBe('ready');
    expect(fetcher.mock.calls[1]?.[1].headers['If-None-Match']).toBe('"version-1"');
  });

  it('keeps validated stale data when refresh is invalid and rejects an unbacked 304', async () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(catalogue()))
      .mockResolvedValueOnce(response({ schema: 'wrong', themes: [] }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    vi.stubGlobal('fetch', fetcher);
    const service = new ThemeFrameworkCatalogueService();
    await service.read();
    now += 300_001;
    expect(await service.read()).toMatchObject({ status: 'stale', catalogue: { themes: [theme()] } });
    expect(await new ThemeFrameworkCatalogueService().read()).toMatchObject({ status: 'unavailable', catalogue: null });
  });

  it('rejects oversized streamed bodies and times out without leaking errors', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(new Uint8Array(1024 * 1024 + 1)));
    vi.stubGlobal('fetch', fetcher);
    expect((await new ThemeFrameworkCatalogueService().read()).status).toBe('unavailable');
    vi.useFakeTimers();
    fetcher.mockImplementationOnce(() => new Promise(() => {}));
    const pending = new ThemeFrameworkCatalogueService().read();
    await vi.advanceTimersByTimeAsync(5_001);
    expect((await pending).status).toBe('unavailable');
  });

  it('cools down failed initial and stale refreshes, then retries on demand', async () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(response(catalogue()))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(response(catalogue()));
    vi.stubGlobal('fetch', fetcher);
    const service = new ThemeFrameworkCatalogueService();
    expect((await service.read()).status).toBe('unavailable');
    expect((await Promise.all([service.read(), service.read()])).map((value) => value.status)).toEqual(['unavailable', 'unavailable']);
    expect(fetcher).toHaveBeenCalledTimes(1);
    now += 30_001;
    expect((await service.read()).status).toBe('ready');
    now += 300_001;
    expect((await service.read()).status).toBe('stale');
    expect((await Promise.all([service.read(), service.read()])).map((value) => value.status)).toEqual(['stale', 'stale']);
    expect(fetcher).toHaveBeenCalledTimes(3);
    now += 30_001;
    expect((await service.read()).status).toBe('ready');
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('does not expose the cached catalogue to caller mutation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(catalogue())));
    const service = new ThemeFrameworkCatalogueService();
    const result = await service.read();
    if (!result.catalogue) throw new Error('Expected catalogue');
    const first = result.catalogue.themes[0];
    if (!first) throw new Error('Expected theme');
    first.name = 'changed';
    first.requires.releases.push('v9.9.9');
    expect((await service.read()).catalogue?.themes[0]).toEqual(theme());
  });

  it('refreshes after clock rollback instead of retaining a future cache or retry deadline', async () => {
    let now = 100_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(catalogue(), { ETag: '"version-1"' }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    vi.stubGlobal('fetch', fetcher);
    const service = new ThemeFrameworkCatalogueService();
    await service.read();
    now = 90_000;
    expect((await service.read()).status).toBe('ready');
    now += 300_001;
    expect((await service.read()).status).toBe('stale');
    now = 50_000;
    const result = await service.read();
    expect(result).toMatchObject({ status: 'ready', checkedAt: new Date(now).toISOString() });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('cancels a late response after timeout without replacing validated cache state', async () => {
    vi.useFakeTimers();
    let complete: (value: Response) => void = () => {
      throw new Error('Request did not start');
    };
    const fetcher = vi.fn().mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          complete = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetcher);
    const service = new ThemeFrameworkCatalogueService();
    const pending = service.read();
    await vi.advanceTimersByTimeAsync(5_001);
    expect((await pending).status).toBe('unavailable');
    const cancelled = vi.fn();
    complete(new Response(new ReadableStream({ cancel: cancelled })));
    await vi.advanceTimersByTimeAsync(0);
    expect(cancelled).toHaveBeenCalledOnce();
    expect(await service.read()).toMatchObject({ status: 'unavailable', catalogue: null });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('cancels rejected response bodies and readers that fail', async () => {
    const cancelledError = vi.fn();
    const cancelledLength = vi.fn();
    const body = (cancel: () => void) => new ReadableStream<Uint8Array>({ cancel });
    const reader = {
      read: vi.fn().mockRejectedValue(new Error('stream failure')),
      cancel: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn(),
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(body(cancelledError), { status: 503 }))
      .mockResolvedValueOnce(new Response(body(cancelledLength), { headers: { 'Content-Length': '1048577' } }))
      .mockResolvedValueOnce({ status: 200, ok: true, headers: new Headers(), body: { getReader: () => reader } });
    vi.stubGlobal('fetch', fetcher);
    expect((await new ThemeFrameworkCatalogueService().read()).status).toBe('unavailable');
    expect((await new ThemeFrameworkCatalogueService().read()).status).toBe('unavailable');
    expect((await new ThemeFrameworkCatalogueService().read()).status).toBe('unavailable');
    expect(cancelledError).toHaveBeenCalledOnce();
    expect(cancelledLength).toHaveBeenCalledOnce();
    expect(reader.cancel).toHaveBeenCalledOnce();
    expect(reader.releaseLock).toHaveBeenCalledOnce();
  });

  it('requires an operator session', () => {
    const controller = new ThemeFrameworkCatalogueController(new ThemeFrameworkCatalogueService());
    expect(() => controller.read({ authMethod: 'api-key', user: { operator: true } } as never)).toThrow();
    expect(() => controller.read({ authMethod: 'session', user: { operator: false } } as never)).toThrow();
  });
});
