import {
  exportJobSchema,
  exportListSchema,
  importJobSchema,
  importListSchema,
  parseBackupResponse,
  restoreStatusSchema,
  type BackupSnapshot,
} from './contracts';

export type BackupCredentials = { password: string; totpCode?: string };
export class BackupApiError extends Error {
  constructor(public readonly status: number) {
    super(
      status === 401
        ? 'Sign in again to continue. Backup status will be checked after sign-in.'
        : status === 403
          ? 'This action needs an operator session and a valid authentication code, if enabled.'
          : status === 404
            ? 'Full backup support or this saved backup is unavailable on this server.'
            : status === 409
              ? 'The server could not safely continue. Refresh status and resolve active tasks, compatibility or recovery before retrying.'
              : status === 400
                ? 'Check your password, authentication code, backup passphrase and selected file, then try again.'
                : status === 429
                  ? 'Too many attempts. Wait a minute before trying again.'
                  : 'The backup request did not finish. Check the connection and refresh status before retrying.',
    );
  }
}
const root = '/api/system-backups';
function endpoint(path: string) {
  if (!/^\/(?:imports|restores|export|[a-f0-9-]{36})(?:\/[a-f0-9-]{36})?(?:\/(?:file|review|cancel|recover|download))?$/.test(path) && path !== '')
    throw new Error('Invalid backup action.');
  return `${root}${path}`;
}
export async function backupRequest(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(endpoint(path), {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    signal,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new BackupApiError(response.status);
  try {
    return await response.json();
  } catch {
    throw new Error('The server response could not be read. Refresh backup status before retrying.');
  }
}
export async function readBackups(signal?: AbortSignal): Promise<BackupSnapshot> {
  const [exports, imports, restore] = await Promise.all([
    backupRequest('', 'GET', undefined, signal),
    backupRequest('/imports', 'GET', undefined, signal),
    backupRequest('/restores', 'GET', undefined, signal),
  ]);
  return {
    exports: parseBackupResponse(exportListSchema, exports),
    imports: parseBackupResponse(importListSchema, imports),
    restore: parseBackupResponse(restoreStatusSchema, restore),
  };
}
export async function startExport(credentials: BackupCredentials, passphrase: string, signal?: AbortSignal) {
  return parseBackupResponse(exportJobSchema, await backupRequest('/export', 'POST', { ...credentials, passphrase }, signal));
}
export async function createImport(credentials: BackupCredentials, signal?: AbortSignal) {
  return parseBackupResponse(importJobSchema, await backupRequest('/imports', 'POST', credentials, signal));
}

export function uploadBackup(id: string, file: File, signal: AbortSignal, onProgress: (completed: number, total: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('PUT', endpoint(`/imports/${id}/file`));
    request.withCredentials = true;
    request.setRequestHeader('Content-Type', 'application/octet-stream');
    const abort = () => request.abort();
    signal.addEventListener('abort', abort, { once: true });
    const clean = () => signal.removeEventListener('abort', abort);
    request.upload.onprogress = (event) => onProgress(event.loaded, event.lengthComputable ? event.total : file.size);
    request.onload = () => {
      clean();
      if (request.status < 200 || request.status >= 300) return reject(new BackupApiError(request.status));
      try {
        const result = parseBackupResponse(importJobSchema, JSON.parse(request.responseText));
        if (result.status !== 'uploaded' || result.uploadedBytes !== file.size)
          throw new Error('The server has not confirmed the complete upload. Refresh status.');
        onProgress(file.size, file.size);
        resolve();
      } catch {
        reject(new Error('The complete upload could not be verified. Refresh status before retrying.'));
      }
    };
    request.onerror = () => {
      clean();
      reject(new BackupApiError(0));
    };
    request.onabort = () => {
      clean();
      reject(new DOMException('Upload cancelled. Check server status before retrying.', 'AbortError'));
    };
    if (signal.aborted) {
      clean();
      reject(new DOMException('Upload cancelled.', 'AbortError'));
      return;
    }
    request.send(file);
  });
}

// Let the browser stream the attachment to disk instead of building an unbounded Blob in memory.
let downloadSequence = 0;
export function downloadBackup(id: string, credentials: BackupCredentials, onError: (message: string) => void): () => void {
  const frame = document.createElement('iframe');
  frame.hidden = true;
  frame.title = 'Encrypted backup download';
  frame.name = `orbis-backup-download-${Date.now()}-${++downloadSequence}`;
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = endpoint(`/${id}/download`);
  form.target = frame.name;
  for (const [name, value] of Object.entries(credentials)) {
    if (!value) continue;
    const field = document.createElement('input');
    field.type = 'hidden';
    field.name = name;
    field.value = value;
    form.append(field);
  }
  let submitted = false;
  frame.onload = () => {
    if (!submitted) return;
    try {
      const content = frame.contentDocument?.body?.textContent?.trim();
      if (content) onError('The download could not start. Check your credentials and refresh backup status before retrying.');
    } catch {
      onError('The download could not be confirmed. Check the browser download status.');
    }
  };
  document.body.append(frame, form);
  submitted = true;
  form.submit();
  for (const field of Array.from(form.elements)) if (field instanceof HTMLInputElement) field.value = '';
  form.remove();
  return () => frame.remove();
}
