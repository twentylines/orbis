import { capsuleJobSchema, capsuleListSchema } from '@runtipi/common/schemas/time-machine-capsule';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export function capsuleEndpoint(path: string) {
  const root = '/api/system-backups/capsules';
  if (path === '') return root;
  if (path === '/imports') return root + path;
  const parts = path.split('/');
  const valid =
    parts[0] === '' &&
    ((parts.length === 4 && parts[1] === 'points' && uuid.test(parts[2] ?? '') && parts[3] === 'export') ||
      (parts.length === 4 && parts[1] === 'imports' && uuid.test(parts[2] ?? '') && ['file', 'review'].includes(parts[3] ?? '')) ||
      (parts.length === 3 && uuid.test(parts[1] ?? '') && parts[2] === 'remove'));
  if (!valid) throw new Error('Choose a valid capture archive.');
  return root + path;
}
export async function capsuleRequest(path: string, method: 'GET' | 'POST' | 'DELETE', body: unknown, signal: AbortSignal) {
  const response = await fetch(capsuleEndpoint(path), {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
  });
  return readResponse(response);
}
async function readResponse(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Capture archive status is unavailable.');
  const chunks: Uint8Array[] = [];
  let count = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      count += next.value.length;
      if (count > 64 * 1024) throw new Error('Capture archive response is too large.');
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (!response.ok)
    throw new Error(
      response.status === 401 || response.status === 403
        ? 'Sign in with an operator account to continue.'
        : response.status === 429
          ? 'Wait a minute before trying again.'
          : 'The capture request could not be confirmed. Check credentials, storage and other backup operations.',
    );
  const bytes = new Uint8Array(count);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
}
export async function readCapsules(signal: AbortSignal) {
  return capsuleListSchema.assert(await capsuleRequest('', 'GET', undefined, signal));
}
export async function capsuleAction(path: string, body: unknown, signal: AbortSignal) {
  return capsuleJobSchema.assert(await capsuleRequest(path, 'POST', body, signal));
}
export async function uploadCapsule(id: string, file: File, signal: AbortSignal) {
  if (!uuid.test(id) || file.size < 64 || file.size > 128 * 1024 ** 3 + 8 * 1024 ** 2)
    throw new Error('Choose a Time Machine capture file within the supported size limit.');
  const response = await fetch(capsuleEndpoint(`/imports/${id}/file`), {
    method: 'PUT',
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
    signal,
  });
  if (!response.ok) throw new Error('The upload did not finish. Check server storage and retry.');
  const result = capsuleJobSchema.assert(await readResponse(response));
  if (
    result.id !== id ||
    result.kind !== 'import' ||
    result.status !== 'uploaded' ||
    result.bytes !== file.size ||
    result.completedBytes !== file.size ||
    result.totalBytes !== file.size
  )
    throw new Error('The upload acknowledgement did not match this file.');
  return result;
}
