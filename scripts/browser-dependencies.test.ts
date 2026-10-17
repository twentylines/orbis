import { describe, expect, it } from 'bun:test';
import { createRequire } from 'node:module';
import { createClient } from '../packages/frontend/src/api-client/client/client.gen';
import { buildClientParams } from '../packages/frontend/src/api-client/core/params.gen';
import { getApp, login } from '../packages/frontend/src/api-client/sdk.gen';

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
