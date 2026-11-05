import { afterEach, expect, test } from 'bun:test';
import { createSettingsBundle, createSettingsImport, settingsBundleDownloadInfo, settingsBundleRequest } from './settings-bundle-api';

const originalFetch = globalThis.fetch;

test('stages an encrypted upload with the current session without sending a password', async () => {
  const id = 'e6e2d3ef-99e9-4b99-8a72-28c4bda5d281';
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe('/api/system-backups/settings-bundles/imports');
    expect(init?.credentials).toBe('same-origin');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({});
    return Response.json({
      id,
      status: 'awaiting-upload',
      createdAt: 1,
      updatedAt: 1,
      uploadedBytes: 0,
      completedBytes: 0,
      totalBytes: null,
      message: 'Choose a backup.',
    });
  }) as typeof fetch;
  expect((await createSettingsImport()).id).toBe(id);
});

test('accepts only the matching session download path and verified metadata', async () => {
  const id = 'e6e2d3ef-99e9-4b99-8a72-28c4bda5d281';
  const valid = {
    version: 1,
    href: `/api/system-backups/settings-bundles/${id}/download`,
    filename: `orbis-settings-${id}.orbis-settings`,
    bytes: 1024,
    sha256: 'a'.repeat(64),
  };
  globalThis.fetch = (async () => Response.json(valid)) as unknown as typeof fetch;
  expect(await settingsBundleDownloadInfo(id)).toEqual({ href: valid.href, filename: valid.filename, bytes: valid.bytes, sha256: valid.sha256 });
  for (const change of [{ href: '//elsewhere/download' }, { bytes: 0 }, { sha256: 'x'.repeat(64) }, { filename: '../bad' }]) {
    globalThis.fetch = (async () => Response.json({ ...valid, ...change })) as unknown as typeof fetch;
    await expect(settingsBundleDownloadInfo(id)).rejects.toThrow('could not be verified');
  }
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});
test('omits the separate key by default and sends it only when selected', async () => {
  const selection = { version: 1 as const, settings: true, dashboard: false, wallpapers: false, themes: false, timeMachine: [] };
  const job = {
    version: 1,
    id: 'e6e2d3ef-99e9-4b99-8a72-28c4bda5d281',
    createdAt: 1,
    status: 'queued',
    stage: 'preparing',
    completedBytes: 0,
    totalBytes: null,
    bytes: 0,
    sha256: null,
    selection,
  };
  let body: Record<string, unknown> = {};
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return Response.json(job);
  }) as typeof fetch;
  await createSettingsBundle({ password: 'account-password' }, undefined, selection);
  expect(body).toEqual({ password: 'account-password', selection });
  await createSettingsBundle({ password: 'account-password' }, 'separate-key', selection);
  expect(body).toEqual({ password: 'account-password', passphrase: 'separate-key', selection });
});
test('restricts actions and sends credentials only in the request body', async () => {
  let url = '';
  let options: RequestInit | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    url = String(input);
    options = init;
    return new Response('{}');
  }) as typeof fetch;
  const id = 'e6e2d3ef-99e9-4b99-8a72-28c4bda5d281';
  await settingsBundleRequest(`/imports/${id}/review`, 'POST', { password: 'secret', passphrase: 'backup-key' });
  expect(url).toBe(`/api/system-backups/settings-bundles/imports/${id}/review`);
  expect(options?.cache).toBe('no-store');
  expect(options?.body).toBe('{"password":"secret","passphrase":"backup-key"}');
  await expect(settingsBundleRequest(`/imports/${id}/rollback`, 'POST')).rejects.toThrow('Invalid backup action');
  await expect(settingsBundleRequest('/imports/not-an-id/review', 'POST')).rejects.toThrow('Invalid backup action');
});
test('rejects oversized successful responses', async () => {
  globalThis.fetch = (async () => new Response('x'.repeat(256 * 1024 + 1))) as unknown as typeof fetch;
  await expect(settingsBundleRequest('')).rejects.toThrow('could not be verified');
});

test('distinguishes known account errors without blaming credentials for storage or server failures', async () => {
  globalThis.fetch = Object.assign(async () => Response.json({ message: 'AUTH_ERROR_INVALID_PASSWORD' }, { status: 400 }), {
    preconnect: originalFetch.preconnect,
  });
  await expect(settingsBundleRequest('', 'POST', {})).rejects.toThrow('current account password is incorrect');
  globalThis.fetch = Object.assign(async () => Response.json({ message: 'private-host-path-and-secret' }, { status: 409 }), {
    preconnect: originalFetch.preconnect,
  });
  await expect(settingsBundleRequest('', 'POST', {})).rejects.toThrow('The backup could not continue. Refresh its status');
  globalThis.fetch = Object.assign(async () => Response.json({ message: 'private-host-path-and-secret' }, { status: 400 }), {
    preconnect: originalFetch.preconnect,
  });
  await expect(settingsBundleRequest('', 'POST', {})).rejects.toThrow('The backup could not continue. Refresh its status');
});

test('sends the reviewed hash and only selected contents when restoring', async () => {
  const { restoreSettingsImport } = await import('./settings-bundle-api');
  const id = 'e6e2d3ef-99e9-4b99-8a72-28c4bda5d281';
  let body = '';
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    body = String(init?.body);
    return new Response(JSON.stringify({ id, status: 'running', stage: 'preparing', needsRecovery: false, canRollback: true }));
  }) as typeof fetch;
  const selection = {
    version: 1 as const,
    reviewId: id,
    archiveSha256: 'a'.repeat(64),
    contents: { version: 1 as const, settings: true, dashboard: false, wallpapers: false, themes: false, timeMachine: [] },
  };
  await restoreSettingsImport(id, { password: 'secret' }, 'backup-key', selection);
  expect(JSON.parse(body).selection).toEqual(selection);
});

test('upload requires a matching complete acknowledgement and supports cancellation', async () => {
  const { uploadSettingsImport } = await import('./settings-bundle-api');
  const original = globalThis.XMLHttpRequest;
  const id = 'e6e2d3ef-99e9-4b99-8a72-28c4bda5d281';
  class FakeRequest {
    upload = { onprogress: null };
    status = 200;
    responseText = '';
    timeout = 0;
    withCredentials = false;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    ontimeout: (() => void) | null = null;
    onabort: (() => void) | null = null;
    open() {}
    setRequestHeader() {}
    send() {}
    abort() {
      this.onabort?.();
    }
  }
  let request: FakeRequest | null = null;
  globalThis.XMLHttpRequest = class extends FakeRequest {
    constructor() {
      super();
      request = this;
    }
  } as unknown as typeof XMLHttpRequest;
  try {
    const file = new File(['abc'], 'test.orbis-settings');
    const controller = new AbortController();
    const pending = uploadSettingsImport(id, file, () => {}, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow('Upload cancelled');
    const pendingBad = uploadSettingsImport(id, file, () => {}, new AbortController().signal);
    const active = request as unknown as FakeRequest;
    active.responseText = JSON.stringify({
      id,
      status: 'uploaded',
      createdAt: 1,
      updatedAt: 1,
      uploadedBytes: 2,
      completedBytes: 2,
      totalBytes: 2,
      message: '',
    });
    active.onload?.();
    await expect(pendingBad).rejects.toThrow('Upload could not be verified');
  } finally {
    globalThis.XMLHttpRequest = original;
  }
});

test('validates each status channel independently', async () => {
  const { readSettingsExports, readSettingsImports, readSettingsRestore } = await import('./settings-bundle-api');
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    return Response.json(
      url.endsWith('/imports') ? { available: 'invalid', jobs: [] } : url.endsWith('/restores') ? { job: 'invalid' } : { version: 1, jobs: [] },
    );
  }) as typeof fetch;
  const signal = new AbortController().signal;
  expect(await readSettingsExports(signal)).toEqual({ version: 1, jobs: [] });
  await expect(readSettingsImports(signal)).rejects.toThrow();
  await expect(readSettingsRestore(signal)).rejects.toThrow();
});
