import { createHash } from 'node:crypto';
import fs, { constants } from 'node:fs/promises';
import path from 'node:path';
import { type } from 'arktype';
import { settingsSchema } from '@/app.dto';
import { backupMetadataBytes } from './backup-crypto';
import { validateSettingsPreferencePatch } from './settings-backup-preferences';

const maximum = 1024 * 1024;
const fail = () => new Error('The settings backup contents could not be verified. No settings were restored.');
const serverSchema = settingsSchema.omit('themeBase', 'themeColor').partial().onDeepUndeclaredKey('reject');
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a: Awaited<ReturnType<typeof fs.stat>>, b: Awaited<ReturnType<typeof fs.stat>>) =>
  (['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeMs', 'ctimeMs'] as const).every((key) => a[key] === b[key]);

export function settingsJsonPayload(kind: 'settings' | 'dashboard', value: unknown) {
  if (kind !== 'settings' && kind !== 'dashboard') throw fail();
  const keys = kind === 'settings' ? ['version', 'desktop', 'server'] : ['version', 'desktop'];
  if (!record(value) || Object.keys(value).sort().join('\0') !== keys.sort().join('\0') || value.version !== 1) throw fail();
  const desktop = validateSettingsPreferencePatch(kind, value.desktop);
  if (kind === 'settings') {
    const server = serverSchema(value.server);
    if (server instanceof type.errors) throw fail();
    return { version: 1 as const, desktop, server };
  }
  return { version: 1 as const, desktop };
}

export async function writeSettingsJsonPart(options: {
  kind: 'settings' | 'dashboard';
  value: unknown;
  destination: string;
  passphrase: string;
  signal: AbortSignal;
}) {
  options.signal.throwIfAborted();
  const value = settingsJsonPayload(options.kind, structuredClone(options.value));
  const plaintext = Buffer.from(JSON.stringify(value));
  let ciphertext: Buffer;
  try {
    ciphertext = await backupMetadataBytes(plaintext, options.passphrase, false, maximum);
  } finally {
    plaintext.fill(0);
  }
  const parent = path.dirname(options.destination);
  const stat = await fs.lstat(parent);
  if (
    !path.isAbsolute(options.destination) ||
    path.resolve(options.destination) !== options.destination ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.mode & 0o077 ||
    stat.uid !== process.getuid?.() ||
    (await fs.realpath(parent)) !== parent
  )
    throw fail();
  options.signal.throwIfAborted();
  const file = await fs.open(options.destination, 'wx', 0o600);
  try {
    await file.writeFile(ciphertext);
    await file.sync();
  } finally {
    await file.close();
  }
  return { kind: options.kind, id: null, file: options.destination, bytes: ciphertext.length, sha256: sha(ciphertext) };
}

export async function readSettingsJsonPart(options: {
  kind: 'settings' | 'dashboard';
  file: string;
  bytes: number;
  sha256: string;
  passphrase: string;
  signal: AbortSignal;
}) {
  options.signal.throwIfAborted();
  if (!Number.isSafeInteger(options.bytes) || options.bytes < 52 || options.bytes > maximum + 52 || !/^[a-f0-9]{64}$/.test(options.sha256))
    throw fail();
  const file = await fs.open(options.file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let plaintext: Buffer | undefined;
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size !== options.bytes || before.mode & 0o077 || before.uid !== process.getuid?.())
      throw fail();
    const ciphertext = await file.readFile();
    if (
      ciphertext.length !== options.bytes ||
      sha(ciphertext) !== options.sha256 ||
      !same(before, await file.stat()) ||
      !same(before, await fs.lstat(options.file))
    )
      throw fail();
    plaintext = await backupMetadataBytes(ciphertext, options.passphrase, true, maximum);
    options.signal.throwIfAborted();
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
    if (!Buffer.from(JSON.stringify(value)).equals(plaintext)) throw fail();
    return settingsJsonPayload(options.kind, value);
  } finally {
    plaintext?.fill(0);
    await file.close();
  }
}
