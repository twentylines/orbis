import { describe, expect, it } from 'bun:test';
import { createRequire } from 'node:module';
import { createClient } from '../packages/frontend/src/api-client/client/client.gen';
import { buildClientParams } from '../packages/frontend/src/api-client/core/params.gen';
import { getApp, login } from '../packages/frontend/src/api-client/sdk.gen';
import '../packages/frontend/src/api-client-config';
import { TranslatableError } from '../packages/frontend/src/types/error.types';
import { createStorageSafeLanguageDetector } from '../packages/frontend/src/lib/i18n/language-detector';

const frontendRequire = createRequire(new URL('../packages/frontend/package.json', import.meta.url));
const HttpBackend = frontendRequire('i18next-http-backend');

describe('generated request parameters', () => {
  for (const slot of ['body', 'headers', 'path', 'query'] as const) {
    it(`retains legitimate ${slot} values without substituting the slot prototype`, () => {
      const params = buildClientParams(
        [{ legitimate: 'kept', [`$${slot}___proto__`]: { injectedAdmin: true } }],
        [{ args: [{ in: slot, key: 'legitimate' }] }],
      );
      const values = params[slot] as Record<string, unknown>;
      expect(values.legitimate).toBe('kept');
      expect(Object.getPrototypeOf(values)).toBeNull();
      expect(values.injectedAdmin).toBeUndefined();
      expect(Object.hasOwn(values, '__proto__')).toBe(true);
      expect(Object.prototype).not.toHaveProperty('injectedAdmin');
    });
  }

  it('keeps an explicit empty array body', () => {
    expect(buildClientParams([[]], [{ in: 'body' }]).body).toEqual([]);
  });
});

describe('regenerated SDK transport', () => {
  it('rejects direct API calls with the translated server error', async () => {
    const result = login({
      baseUrl: 'http://127.0.0.1:9999',
      body: { username: 'fixture@example.test', password: 'fixture-only' },
      fetch: async (request) => {
        expect((request as Request).credentials).toBe('include');
        return Response.json({ message: 'AUTH_ERROR_INVALID_CREDENTIALS', intlParams: { remaining: '2' } }, { status: 401 });
      },
    });
    await expect(result).rejects.toBeInstanceOf(TranslatableError);
    await expect(result).rejects.toMatchObject({ message: 'AUTH_ERROR_INVALID_CREDENTIALS', intlParams: { remaining: '2' } });
  });

  it('rejects direct API calls when the transport fails', async () => {
    const failure = new TypeError('Fixture offline');
    await expect(
      getApp({
        baseUrl: 'http://127.0.0.1:9999',
        path: { urn: 'fixture:local' },
        fetch: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
  });

  it('preserves encoded app identifiers and credentials on a read', async () => {
    let sent: Request | undefined;
    const client = createClient({
      baseUrl: 'http://127.0.0.1:9999',
      credentials: 'include',
      fetch: async (request) => {
        sent = request as Request;
        return Response.json({ info: { urn: 'app name:local' } });
      },
    });
    const result = await getApp({ client, path: { urn: 'app name:local' } });
    expect(sent?.url).toBe('http://127.0.0.1:9999/api/apps/app%20name%3Alocal');
    expect(sent?.method).toBe('GET');
    expect(sent?.credentials).toBe('include');
    expect(result.data).toEqual({ info: { urn: 'app name:local' } });
  });

  it('preserves login JSON fields and response data', async () => {
    let sent: Request | undefined;
    const client = createClient({
      baseUrl: 'http://127.0.0.1:9999',
      fetch: async (request) => {
        sent = (request as Request).clone();
        return Response.json({ success: true });
      },
    });
    const result = await login({ client, body: { username: 'fixture@example.test', password: 'fixture-only' } });
    expect(sent?.method).toBe('POST');
    expect(sent?.headers.get('content-type')).toBe('application/json');
    expect(await sent?.json()).toEqual({ username: 'fixture@example.test', password: 'fixture-only' });
    expect(result.data).toEqual({ success: true });
  });
});

describe('translation URL validation', () => {
  const createBackend = (loadPath: string) => {
    const urls: string[] = [];
    const backend = new HttpBackend(null, {
      loadPath,
      reloadInterval: false,
      alternateFetch: async (url: string) => {
        urls.push(url);
        return new Response(JSON.stringify({ greeting: 'Hello' }), { headers: { 'content-type': 'application/json' } });
      },
    });
    const read = (language: string, namespace: string) =>
      new Promise<{ error: Error | null; data: unknown }>((resolve) =>
        backend.read(language, namespace, (error: Error | null, data: unknown) => resolve({ error, data })),
      );
    return { urls, read };
  };

  it('loads the normal Orbis translation path through the fetch transport', async () => {
    const backend = createBackend('/api/i18n/locales/{{ns}}/{{lng}}.json');
    const result = await backend.read('en', 'translation');
    expect(result.error).toBeNull();
    expect(result.data).toEqual({ greeting: 'Hello' });
    expect(backend.urls).toEqual(['/api/i18n/locales/translation/en.json']);
  });

  it('rejects scheme, protocol-relative and traversal values before a request', async () => {
    const backend = createBackend('{{lng}}/{{ns}}.json');
    for (const [language, namespace] of [
      ['http:127.0.0.1:9999', 'translation'],
      ['en', 'http:127.0.0.1:9999'],
      ['en', '//invalid.example/translation'],
      ['../private', 'translation'],
      ['en', '../private'],
    ] as const) {
      const result = await backend.read(language, namespace);
      expect(result.error).toBeInstanceOf(Error);
      expect(backend.urls).toEqual([]);
    }
  });
});

describe('language detection with unavailable browser storage', () => {
  const withStorage = (
    run: (browser: { readsDenied: boolean; writesDenied: boolean; cookiesDenied: boolean; values: Map<string, string> }) => void,
  ) => {
    const browser = { readsDenied: false, writesDenied: false, cookiesDenied: false, values: new Map<string, string>() };
    const descriptors = new Map(['window', 'document', 'navigator'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    const storage = {
      getItem(key: string) {
        if (browser.readsDenied) throw new DOMException('Fixture read denied', 'SecurityError');
        return browser.values.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        if (browser.writesDenied) throw new DOMException('Fixture write denied', 'QuotaExceededError');
        browser.values.set(key, value);
      },
      removeItem(key: string) {
        browser.values.delete(key);
      },
    };
    Object.defineProperties(globalThis, {
      window: { configurable: true, value: { localStorage: storage, sessionStorage: storage, location: { search: '', hash: '' } } },
      document: {
        configurable: true,
        value: {
          documentElement: { lang: 'en' },
          get cookie() {
            if (browser.cookiesDenied) throw new DOMException('Fixture cookie denied', 'SecurityError');
            return '';
          },
        },
      },
      navigator: { configurable: true, value: { languages: ['en'], language: 'en' } },
    });
    try {
      run(browser);
    } finally {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  };

  it('keeps an existing browser language and saves a changed selection', () => {
    withStorage(({ values }) => {
      values.set('i18nextLng', 'de');
      const detector = createStorageSafeLanguageDetector();
      expect(detector.detect()).toBe('de');
      detector.cacheUserLanguage('en');
      expect(values.get('i18nextLng')).toBe('en');
    });
  });

  it('falls back when reads fail even though the storage write probe succeeds', () => {
    withStorage((browser) => {
      browser.readsDenied = true;
      const detector = createStorageSafeLanguageDetector();
      expect(detector.detect()).toBe('en');
    });
  });

  it('keeps language caching optional when writes become unavailable after startup', () => {
    withStorage((browser) => {
      const detector = createStorageSafeLanguageDetector();
      expect(detector.detect()).toBe('en');
      browser.writesDenied = true;
      expect(() => detector.cacheUserLanguage('de')).not.toThrow();
      expect(detector.detect()).toBe('en');
    });
  });

  it('continues detecting languages when cookie access fails', () => {
    withStorage((browser) => {
      browser.cookiesDenied = true;
      browser.values.set('i18nextLng', 'de');
      const detector = createStorageSafeLanguageDetector();
      expect(detector.detect()).toBe('de');
    });
  });
});
