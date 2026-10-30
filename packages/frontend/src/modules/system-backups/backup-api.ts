import {
  exportJobSchema,
  exportListSchema,
  importJobSchema,
  importListSchema,
  parseBackupResponse,
  restoreStatusSchema,
  type BackupSnapshot,
  type ImportJob,
} from './contracts';

export type BackupCredentials = { password: string; totpCode?: string };
const restoreConflictMessages = new Set([
  'Finish the current operation or restore recovery before starting another restore.',
  'Wait for app tasks to finish before restoring.',
  'Finish the server update or recovery before restoring.',
  'Wait for apps to reach a stable state before restoring.',
  'A running app could not be identified. Refresh Apps before restoring.',
  'Another container is writing Orbis data. Stop it before creating a full backup.',
  'Full restore requires supported writable bind storage. No server data has been changed.',
  'This controller cannot prepare an isolated restore worker. No server data has been changed.',
  'Backup import storage needs review. No server data has been changed.',
  'Review this backup again before preparing its restore.',
  'Wait for the current backup upload or review to finish.',
  'Finish the current backup or recover its apps before starting another.',
]);
const conflictBodyLimit = 16 * 1024;
const safeBadRequestMessages = new Map([
  ['AUTH_ERROR_INVALID_PASSWORD', 'The current account password is incorrect. Use the password for this server, not the backup key.'],
  ['AUTH_ERROR_TOTP_INVALID_CODE', 'The authentication code is incorrect or expired. Enter a new code for this account.'],
  ['Confirm this action with your account password.', 'Enter this server’s current account password to confirm the action.'],
  [
    'Provide your password, authentication code if enabled, and a backup passphrase of at least 12 characters.',
    'Check the current account password and authentication code. The backup key must contain 12 to 1024 characters.',
  ],
  ['Use a backup passphrase between 12 and 1024 characters.', 'Use a backup key between 12 and 1024 characters.'],
  [
    'The backup could not be opened. Check its passphrase and file.',
    'The archive could not be opened. Check its original password or separate passphrase and file.',
  ],
  ['Choose a complete encrypted Orbis backup.', 'Choose a complete encrypted Orbis backup file.'],
  ['Choose an encrypted Orbis backup file.', 'Choose an encrypted Orbis backup file.'],
  ['The backup upload did not finish. Choose the file again.', 'The backup upload did not finish. Choose the file again.'],
  ['There is not enough free storage to receive this backup.', 'There is not enough free storage to upload this backup. Free space before retrying.'],
  [
    'There is not enough free storage to open this backup. Free space and retry its review.',
    'There is not enough free storage to open this backup. Free space before verifying it again.',
  ],
]);

export function safeBackupErrorMessage(status: number, text: string): string | undefined {
  if (text.length > conflictBodyLimit || new TextEncoder().encode(text).byteLength > conflictBodyLimit) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const message = (parsed as { message?: unknown }).message;
    if (typeof message !== 'string') return undefined;
    if (status === 400) return safeBadRequestMessages.get(message);
    if (status === 409 && restoreConflictMessages.has(message)) return message;
  } catch {
    return undefined;
  }
  return undefined;
}

export class BackupApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly recognizedSafeMessage?: string,
  ) {
    super(
      (status === 400 || status === 409) && recognizedSafeMessage
        ? recognizedSafeMessage
        : status === 401
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

async function recognizedErrorMessage(response: Response): Promise<string | undefined> {
  const body = response.body;
  if (!body) return undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (total <= conflictBodyLimit) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      if (total + value.byteLength > conflictBodyLimit) {
        await reader.cancel();
        return undefined;
      }
      total += value.byteLength;
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return safeBackupErrorMessage(response.status, new TextDecoder().decode(bytes));
  } catch {
    try {
      await reader?.cancel();
    } catch {
      // The generic conflict message remains safe if the response cannot be read.
    }
    return undefined;
  } finally {
    reader?.releaseLock();
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
  if (!response.ok) {
    const safeMessage = response.status === 400 || response.status === 409 ? await recognizedErrorMessage(response) : undefined;
    throw new BackupApiError(response.status, safeMessage);
  }
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

export function uploadBackup(
  id: string,
  file: File,
  signal: AbortSignal,
  onProgress: (completed: number, total: number) => void,
): Promise<ImportJob> {
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
      if (request.status < 200 || request.status >= 300)
        return reject(new BackupApiError(request.status, safeBackupErrorMessage(request.status, request.responseText)));
      try {
        const result = parseBackupResponse(importJobSchema, JSON.parse(request.responseText));
        if (result.id !== id || result.status !== 'uploaded' || result.uploadedBytes !== file.size)
          throw new Error('The server has not confirmed the complete upload. Refresh status.');
        onProgress(file.size, file.size);
        resolve(result);
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
