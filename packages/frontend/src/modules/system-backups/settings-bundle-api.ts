import { type } from 'arktype';
import { settingsBackupJobSchema, settingsBackupRestoreSelectionSchema, type SettingsBackupSelection } from '@runtipi/common/schemas/settings-backup';
import {
  settingsBackupImportJobSchema,
  settingsBackupImportListSchema,
  settingsBackupRestoreJobSchema,
} from '@runtipi/common/schemas/settings-backup-import';
import { parseBackupResponse } from './contracts';
import { safeBackupErrorMessage, type BackupCredentials } from './backup-api';

const root = '/api/system-backups/settings-bundles';
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const listSchema = type({ version: '1', jobs: settingsBackupJobSchema.array().atMostLength(32) }).onDeepUndeclaredKey('reject');
const restoreSchema = type({ job: settingsBackupRestoreJobSchema.or('null') }).onDeepUndeclaredKey('reject');
const limit = 256 * 1024;
function path(value: string) {
  if (value === '' || value === '/imports' || value === '/restores') return root + value;
  const match = value.match(/^\/(?:([^/]+)\/remove|imports\/([^/]+)\/(?:file|review|restore|remove)|restores\/([^/]+)\/rollback)$/);
  const id = match?.[1] ?? match?.[2] ?? match?.[3];
  if (!id || !idPattern.test(id)) throw new Error('Invalid backup action.');
  return root + value;
}
async function readBody(response: Response) {
  if (!response.body) throw new Error('The server response could not be read.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error('Response too large.');
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } finally {
    reader.releaseLock();
  }
}
export async function settingsBundleRequest(url: string, method = 'GET', body?: unknown, signal?: AbortSignal) {
  const response = await fetch(path(url), {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    let guidance: string | undefined;
    if (response.status === 400) {
      try {
        guidance = safeBackupErrorMessage(400, JSON.stringify(await readBody(response)));
      } catch {
        // Only known account and backup errors are safe to display.
      }
    }
    throw new Error(
      guidance ??
        (response.status === 401
          ? 'Sign in again to continue.'
          : response.status === 429
            ? 'Too many attempts. Wait a minute and try again.'
            : 'The backup could not continue. Refresh its status before trying again.'),
    );
  }
  try {
    return await readBody(response);
  } catch {
    throw new Error('The server response could not be verified. Refresh status before retrying.');
  }
}
export async function readSettingsExports(signal: AbortSignal) {
  return parseBackupResponse(listSchema, await settingsBundleRequest('', 'GET', undefined, signal));
}
export async function readSettingsImports(signal: AbortSignal) {
  return parseBackupResponse(settingsBackupImportListSchema, await settingsBundleRequest('/imports', 'GET', undefined, signal));
}
export async function readSettingsRestore(signal: AbortSignal) {
  return parseBackupResponse(restoreSchema, await settingsBundleRequest('/restores', 'GET', undefined, signal));
}
export async function createSettingsBundle(
  credentials: BackupCredentials,
  passphrase: string,
  selection: SettingsBackupSelection,
  signal?: AbortSignal,
) {
  return parseBackupResponse(settingsBackupJobSchema, await settingsBundleRequest('', 'POST', { ...credentials, passphrase, selection }, signal));
}
export async function createSettingsImport(credentials: BackupCredentials, signal?: AbortSignal) {
  return parseBackupResponse(settingsBackupImportJobSchema, await settingsBundleRequest('/imports', 'POST', credentials, signal));
}
export async function uploadSettingsImport(id: string, file: File, onProgress: (done: number, total: number) => void, signal: AbortSignal) {
  const url = path(`/imports/${id}/file`);
  return new Promise<ReturnType<typeof settingsBackupImportJobSchema.assert>>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('PUT', url);
    request.timeout = 30 * 60_000;
    request.withCredentials = true;
    request.setRequestHeader('Content-Type', 'application/octet-stream');
    request.upload.onprogress = (event) => onProgress(event.loaded, event.lengthComputable ? event.total : file.size);
    const abort = () => request.abort();
    const clean = () => signal.removeEventListener('abort', abort);
    if (signal.aborted) {
      reject(new DOMException('Upload cancelled. Refresh status.', 'AbortError'));
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    request.onerror = request.ontimeout = () => {
      clean();
      reject(new Error('Upload disconnected. Refresh status before retrying.'));
    };
    request.onabort = () => {
      clean();
      reject(new DOMException('Upload cancelled. Refresh status.', 'AbortError'));
    };
    request.onprogress = () => {
      if (request.responseText.length > limit) request.abort();
    };
    request.onload = () => {
      clean();
      try {
        if (request.status < 200 || request.status >= 300 || request.responseText.length > limit) throw new Error();
        const job = parseBackupResponse(settingsBackupImportJobSchema, JSON.parse(request.responseText));
        if (job.id !== id || job.status !== 'uploaded' || job.uploadedBytes !== file.size) throw new Error();
        resolve(job);
      } catch {
        reject(new Error('Upload could not be verified. Refresh status before retrying.'));
      }
    };
    request.send(file);
  });
}
export async function reviewSettingsImport(id: string, credentials: BackupCredentials, passphrase: string, signal?: AbortSignal) {
  return parseBackupResponse(
    settingsBackupImportJobSchema,
    await settingsBundleRequest(`/imports/${id}/review`, 'POST', { ...credentials, passphrase }, signal),
  );
}
export async function restoreSettingsImport(
  id: string,
  credentials: BackupCredentials,
  passphrase: string,
  selection: { version: 1; reviewId: string; archiveSha256: string; contents: SettingsBackupSelection },
  signal?: AbortSignal,
) {
  settingsBackupRestoreSelectionSchema.assert(selection);
  return parseBackupResponse(
    settingsBackupRestoreJobSchema,
    await settingsBundleRequest(`/imports/${id}/restore`, 'POST', { ...credentials, passphrase, selection }, signal),
  );
}
export async function rollbackSettingsRestore(id: string, credentials: BackupCredentials, signal?: AbortSignal) {
  return parseBackupResponse(settingsBackupRestoreJobSchema, await settingsBundleRequest(`/restores/${id}/rollback`, 'POST', credentials, signal));
}
