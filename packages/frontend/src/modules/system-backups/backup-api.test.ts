import { expect, test } from 'bun:test';
import { BackupApiError, backupRequest, downloadBackup, uploadBackup } from './backup-api';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
async function withFetch(response: Response, run: (calls: { url: unknown; init?: RequestInit }[]) => Promise<void>) {
  const original = globalThis.fetch;
  const calls: { url: unknown; init?: RequestInit }[] = [];
  globalThis.fetch = Object.assign(
    async (url: unknown, init?: RequestInit) => {
      calls.push({ url, init });
      return response;
    },
    { preconnect: original.preconnect },
  );
  try {
    await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

test('credentials stay in same-origin POST body with no redirect, caching or URL secrets', async () => {
  await withFetch(Response.json({ job: null }), async (calls) => {
    await backupRequest('/restores', 'POST', { password: 'test-value', totpCode: '123456', confirmation: 'replace-server' });
    expect(calls[0]?.url).toBe('/api/system-backups/restores');
    expect(calls[0]?.init).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ password: 'test-value', totpCode: '123456', confirmation: 'replace-server' });
  });
});

test('arbitrary destinations and URL query data are rejected before fetch', async () => {
  await withFetch(Response.json({}), async (calls) => {
    for (const path of ['https://other.example', '//other.example', '/imports/../../settings', '/export?password=value'])
      await expect(backupRequest(path, 'POST')).rejects.toThrow('Invalid backup action');
    expect(calls).toHaveLength(0);
  });
});

test('missing backend, expired session, unsafe request and retry limits have actionable fixed errors', async () => {
  for (const status of [401, 403, 404, 409, 429, 500]) {
    await withFetch(Response.json({ message: 'private-value-must-not-echo' }, { status }), async () => {
      try {
        await backupRequest('');
        throw new Error('Expected rejection');
      } catch (error) {
        expect(error).toBeInstanceOf(BackupApiError);
        expect((error as BackupApiError).status).toBe(status);
        expect((error as Error).message).not.toContain('private-value');
      }
    });
  }
});

const genericConflict = 'The server could not safely continue. Refresh status and resolve active tasks, compatibility or recovery before retrying.';
const safeConflict = 'This controller cannot prepare an isolated restore worker. No server data has been changed.';

test('recognized restore conflict messages are surfaced exactly', async () => {
  await withFetch(Response.json({ message: safeConflict }, { status: 409 }), async () => {
    try {
      await backupRequest('/restores', 'POST', {});
      throw new Error('Expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(BackupApiError);
      expect((error as BackupApiError).recognizedSafeMessage).toBe(safeConflict);
      expect((error as Error).message).toBe(safeConflict);
    }
  });
});

test('unknown, malformed and credential-bearing conflict bodies stay generic', async () => {
  const bodies = [
    Response.json({ message: 'private upstream detail' }, { status: 409 }),
    new Response('{"message":', { status: 409 }),
    Response.json({ message: 'password=fixture-secret; token=private-value' }, { status: 409 }),
  ];
  for (const response of bodies) {
    await withFetch(response, async () => {
      await expect(backupRequest('/restores', 'POST', {})).rejects.toThrow(genericConflict);
    });
  }
});

test('oversized conflict response is cancelled and stays generic', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    type: 'bytes',
    start(controller) {
      controller.enqueue(new Uint8Array(16 * 1024 + 1));
    },
    cancel() {
      cancelled = true;
    },
  });
  await withFetch(new Response(body, { status: 409 }), async () => {
    await expect(backupRequest('/restores', 'POST', {})).rejects.toThrow(genericConflict);
  });
  expect(cancelled).toBe(true);
});

test('gateway HTML never escapes into inline error output', async () => {
  await withFetch(new Response('private-upstream-html', { status: 200 }), async () => {
    await expect(backupRequest('')).rejects.toThrow('The server response could not be read');
  });
});

class UploadRequest {
  static current: UploadRequest;
  upload: { onprogress?: (event: { loaded: number; total: number; lengthComputable: boolean }) => void } = {};
  status = 200;
  responseText = '';
  withCredentials = false;
  sent?: unknown;
  url?: string;
  method?: string;
  header?: [string, string];
  onload?: () => void;
  onerror?: () => void;
  onabort?: () => void;
  constructor() {
    UploadRequest.current = this;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(key: string, value: string) {
    this.header = [key, value];
  }
  send(value: unknown) {
    this.sent = value;
  }
  abort() {
    this.onabort?.();
  }
}
async function withUpload(run: () => Promise<void>) {
  const original = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = UploadRequest as unknown as typeof XMLHttpRequest;
  try {
    await run();
  } finally {
    globalThis.XMLHttpRequest = original;
  }
}
const file = new File([new Uint8Array(100)], 'backup.orbis');
const uploaded = {
  id,
  status: 'uploaded',
  stage: 'upload',
  createdAt: 1,
  updatedAt: 2,
  completedBytes: 100,
  totalBytes: 100,
  uploadedBytes: 100,
  message: 'Uploaded.',
} as const;

test('upload streams the File directly and waits for exact server byte confirmation', async () => {
  await withUpload(async () => {
    const counts: [number, number][] = [];
    let done = false;
    const promise = uploadBackup(id, file, new AbortController().signal, (completed, total) => counts.push([completed, total])).then(() => {
      done = true;
    });
    const request = UploadRequest.current;
    expect(request.sent).toBe(file);
    expect(request.method).toBe('PUT');
    expect(request.url).toBe(`/api/system-backups/imports/${id}/file`);
    expect(request.withCredentials).toBe(true);
    expect(request.header).toEqual(['Content-Type', 'application/octet-stream']);
    request.upload.onprogress?.({ loaded: 100, total: 100, lengthComputable: true });
    await Promise.resolve();
    expect(done).toBe(false);
    request.responseText = JSON.stringify(uploaded);
    request.onload?.();
    await promise;
    expect(done).toBe(true);
    expect(counts).toEqual([
      [100, 100],
      [100, 100],
    ]);
  });
});

test('partial acknowledgement cannot complete the upload', async () => {
  await withUpload(async () => {
    const promise = uploadBackup(id, file, new AbortController().signal, () => undefined);
    UploadRequest.current.responseText = JSON.stringify({ ...uploaded, uploadedBytes: 99 });
    UploadRequest.current.onload?.();
    await expect(promise).rejects.toThrow('complete upload could not be verified');
  });
});

test('upload cancellation aborts the transport and does not claim success', async () => {
  await withUpload(async () => {
    const controller = new AbortController();
    const promise = uploadBackup(id, file, controller.signal, () => undefined);
    controller.abort();
    await expect(promise).rejects.toThrow('Upload cancelled');
  });
});

test('corrupt upload response never renders upstream response text', async () => {
  await withUpload(async () => {
    const promise = uploadBackup(id, file, new AbortController().signal, () => undefined);
    UploadRequest.current.responseText = 'private-upstream-response';
    UploadRequest.current.onload?.();
    try {
      await promise;
      throw new Error('Expected rejection');
    } catch (error) {
      expect((error as Error).message).toContain('complete upload could not be verified');
      expect((error as Error).message).not.toContain('private-upstream');
    }
  });
});

test('already cancelled uploads never send the selected file', async () => {
  await withUpload(async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(uploadBackup(id, file, controller.signal, () => undefined)).rejects.toThrow('Upload cancelled');
    expect(UploadRequest.current.sent).toBeUndefined();
  });
});

test('native attachment POST clears credential fields and exposes no success claim or server text', () => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const originalInput = Object.getOwnPropertyDescriptor(globalThis, 'HTMLInputElement');
  class Field {
    name = '';
    value = '';
    type = '';
  }
  const fields: Field[] = [];
  let sent: unknown;
  let removed = false;
  let frameRemoved = false;
  const frame = {
    hidden: false,
    title: '',
    name: '',
    onload: () => undefined,
    contentDocument: { body: { textContent: '' } },
    remove: () => {
      frameRemoved = true;
    },
  };
  const form = {
    method: '',
    action: '',
    target: '',
    elements: fields,
    append: (field: Field) => fields.push(field),
    submit: () => {
      sent = { method: form.method, action: form.action, target: form.target, fields: fields.map((field) => [field.name, field.value]) };
    },
    remove: () => {
      removed = true;
    },
  };
  const documentStub = {
    createElement: (tag: string) => (tag === 'iframe' ? frame : tag === 'form' ? form : new Field()),
    body: { append: () => undefined },
  };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: documentStub });
  Object.defineProperty(globalThis, 'HTMLInputElement', { configurable: true, value: Field });
  const errors: string[] = [];
  try {
    const cleanup = downloadBackup(id, { password: 'test-value', totpCode: '123456' }, (message) => errors.push(message));
    expect(sent).toMatchObject({
      method: 'POST',
      action: `/api/system-backups/${id}/download`,
      target: frame.name,
      fields: [
        ['password', 'test-value'],
        ['totpCode', '123456'],
      ],
    });
    expect(form.action).not.toContain('test-value');
    expect(frame.hidden).toBe(true);
    expect(fields.every((field) => field.value === '')).toBe(true);
    expect(removed).toBe(true);
    frame.onload();
    expect(errors).toHaveLength(0);
    frame.contentDocument.body.textContent = 'private-server-error';
    frame.onload();
    expect(errors).toHaveLength(1);
    expect(errors[0]).not.toContain('private-server-error');
    cleanup();
    expect(frameRemoved).toBe(true);
  } finally {
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else Reflect.deleteProperty(globalThis, 'document');
    if (originalInput) Object.defineProperty(globalThis, 'HTMLInputElement', originalInput);
    else Reflect.deleteProperty(globalThis, 'HTMLInputElement');
  }
});

test('known account-auth, archive-key, storage and status failures have distinct fixed guidance', async () => {
  for (const [status, body, expected] of [
    [400, 'AUTH_ERROR_INVALID_PASSWORD', 'current account password is incorrect'],
    [400, 'AUTH_ERROR_TOTP_INVALID_CODE', 'authentication code is incorrect or expired'],
    [400, 'The backup could not be opened. Check its passphrase and file.', 'archive could not be opened'],
    [400, 'There is not enough free storage to receive this backup.', 'not enough free storage to upload'],
    [409, 'Backup import storage needs review. No server data has been changed.', 'Backup import storage needs review'],
    [409, 'Review this backup again before preparing its restore.', 'Review this backup again'],
  ] as const) {
    await withFetch(Response.json({ message: body, intlParams: { ignored: 'private-value' } }, { status }), async () => {
      await expect(backupRequest('/export', 'POST', {})).rejects.toThrow(expected);
    });
  }
});
test('unknown, wrong-status, oversized and malformed400 bodies never echo server text', async () => {
  const bodies = [
    new Response('{"message":', { status: 400 }),
    Response.json({ message: ['AUTH_ERROR_INVALID_PASSWORD'] }, { status: 400 }),
    Response.json({ message: 'AUTH_ERROR_INVALID_PASSWORD extra private-value' }, { status: 400 }),
    Response.json({ message: 'AUTH_ERROR_INVALID_PASSWORD', padding: 'x'.repeat(16 * 1024) }, { status: 400 }),
    Response.json({ message: 'AUTH_ERROR_INVALID_PASSWORD' }, { status: 500 }),
  ];
  for (const response of bodies)
    await withFetch(response, async () => {
      try {
        await backupRequest('/export', 'POST', {});
        throw new Error('Expected failure');
      } catch (error) {
        expect(error).toBeInstanceOf(BackupApiError);
        expect((error as Error).message).not.toContain('private-value');
        expect((error as Error).message).not.toContain('current account password is incorrect');
      }
    });
});
test('oversized400 streaming error is cancelled before parsing any auth guidance', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    type: 'bytes',
    start(controller) {
      controller.enqueue(new Uint8Array(16 * 1024 + 1));
    },
    cancel() {
      cancelled = true;
    },
  });
  await withFetch(new Response(body, { status: 400 }), async () => {
    await expect(backupRequest('/export', 'POST', {})).rejects.toThrow('Check your password');
  });
  expect(cancelled).toBe(true);
});

test('a complete upload returns its exact server acknowledgement for the next key-entry step', async () => {
  await withUpload(async () => {
    const promise = uploadBackup(id, file, new AbortController().signal, () => undefined);
    UploadRequest.current.responseText = JSON.stringify(uploaded);
    UploadRequest.current.onload?.();
    expect(await promise).toEqual(uploaded);
  });
  await withUpload(async () => {
    const promise = uploadBackup(id, file, new AbortController().signal, () => undefined);
    UploadRequest.current.responseText = JSON.stringify({ ...uploaded, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
    UploadRequest.current.onload?.();
    await expect(promise).rejects.toThrow('complete upload could not be verified');
  });
});
test('upload error classification uses the same bounded allowlist without echoing upstream details', async () => {
  for (const [text, expected] of [
    [JSON.stringify({ message: 'There is not enough free storage to receive this backup.' }), 'not enough free storage to upload'],
    [JSON.stringify({ message: 'private-value-must-not-echo' }), 'Check your password'],
  ] as const)
    await withUpload(async () => {
      const promise = uploadBackup(id, file, new AbortController().signal, () => undefined);
      UploadRequest.current.status = 400;
      UploadRequest.current.responseText = text;
      UploadRequest.current.onload?.();
      await expect(promise).rejects.toThrow(expected);
    });
});
