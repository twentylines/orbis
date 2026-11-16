import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { type } from 'arktype';
import { backupMetadataBytes, inspectBackupCiphertextSequence } from './backup-crypto';
import { resetCaptureRecoveryChunks, type ResetCaptureRecoveryFiles } from './reset-capture-recovery-files';
import { resetCaptureInventory, resetCaptureInventoryEntry } from './reset-safety-capture-inventory';
import { sealedBundleFiles } from './settings-backup-format';

const fail = () => new Error('The retained capture recovery archive could not be verified. Keep the original captures and keys.');
const hash = type('string').narrow((value) => /^[a-f0-9]{64}$/.test(value));
const uuid = type('string').narrow((value) => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value));
const integer = type('number.integer >= 0').narrow(Number.isSafeInteger);
const owner = type('number.integer > 0').narrow(Number.isSafeInteger);
const name = type('string <= 4096').narrow(
  (value) =>
    Buffer.byteLength(value) <= 4096 &&
    /^(points|components|keys|custody)(\/[A-Za-z0-9._-]{1,255})*$/.test(value) &&
    value.split('/').every((component) => component !== '.' && component !== '..') &&
    value.split('/').length <= 34,
);
const chunk = type({
  offset: integer,
  plaintextBytes: integer,
  plaintextSha256: hash,
  part: type('string').narrow((value) => value.endsWith('.orbis') && uuid.allows(value.slice(0, -6))),
  bytes: integer,
  sha256: hash,
});
const entry = type({ name, type: "'absent' | 'directory'" }).or({
  name,
  type: "'file'",
  plaintextBytes: integer,
  plaintextSha256: hash,
  chunks: chunk.array().atLeastLength(1).atMostLength(128),
});
const capture = type({
  kind: "'core' | 'components'",
  id: uuid,
  sourceOwnerId: owner,
  effectiveOwnerId: owner.or('null'),
  version: '1 | 2 | 3 | 4',
  status: "'capturing' | 'sealed' | 'failed' | 'interrupted'",
  metadataSha256: hash,
});
const schema = type({
  format: "'orbis-reset-capture-recovery'",
  version: '1',
  resetId: uuid,
  accounts: "'keep' | 'remove'",
  filesSha256: hash,
  inventory: { resetId: uuid, accounts: "'keep' | 'remove'", sha256: hash, captures: capture.array().atMostLength(12_000) },
  entries: entry.array().atLeastLength(4).atMostLength(12_000),
}).onDeepUndeclaredKey('reject');
export type ResetCaptureRecoveryManifest = typeof schema.infer;
export type ResetCaptureRecoveryBinding = Readonly<{
  resetId: string;
  accounts: 'keep' | 'remove';
  filesSha256: string;
  inventorySha256: string;
}>;

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function validateResetCaptureRecoveryManifest(input: unknown): ResetCaptureRecoveryManifest {
  try {
    // Own the parsed value so caller mutation cannot change a verified contract during asynchronous reads.
    const encoded = JSON.stringify(input);
    if (Buffer.byteLength(encoded) > 16 * 1024 ** 2) throw fail();
    const value = schema.assert(JSON.parse(encoded));
    if (
      value.inventory.resetId !== value.resetId ||
      value.inventory.accounts !== value.accounts ||
      resetCaptureInventory(value.resetId, value.accounts, value.inventory.captures).sha256 !== value.inventory.sha256
    )
      throw fail();
    const captures = new Set(value.inventory.captures.map((item) => `${item.kind}:${item.id}`));
    if (captures.size !== value.inventory.captures.length) throw fail();
    const names = new Map(value.entries.map((item) => [item.name, item]));
    const parts = new Set<string>();
    let total = 0;
    if (names.size !== value.entries.length || ['points', 'components', 'keys', 'custody'].some((root) => !names.has(root))) throw fail();
    for (const item of value.entries) {
      const parent = item.name.split('/').slice(0, -1).join('/');
      if (parent ? names.get(parent)?.type !== 'directory' : item.type === 'file') throw fail();
      if (item.type !== 'file') continue;
      const expected = resetCaptureRecoveryChunks(item.plaintextBytes);
      if (item.chunks.length !== expected.length) throw fail();
      for (const [at, part] of item.chunks.entries()) {
        if (
          part.offset !== expected[at]?.offset ||
          part.plaintextBytes !== expected[at]?.plaintextBytes ||
          part.bytes !== part.plaintextBytes + 52 ||
          parts.has(part.part)
        )
          throw fail();
        parts.add(part.part);
      }
      total += item.plaintextBytes;
      if (total > 8 * 1024 ** 4 || parts.size > 16_000) throw fail();
    }
    for (const record of value.inventory.captures) {
      const metadata = names.get(`${record.kind === 'core' ? 'points' : 'components'}/${record.id}/point.json`);
      if (metadata?.type !== 'file' || metadata.plaintextBytes > 65536) throw fail();
    }
    const projected = value.entries.map((item) =>
      item.type === 'file'
        ? {
            name: item.name,
            type: item.type,
            plaintextBytes: item.plaintextBytes,
            plaintextSha256: item.plaintextSha256,
            chunks: item.chunks.map(({ part: _part, ...rest }) => rest),
          }
        : item,
    );
    const digest = createHash('sha256')
      .update('orbis-reset-capture-recovery-files-v1\n')
      .update(
        JSON.stringify({
          resetId: value.resetId,
          accounts: value.accounts,
          inventorySha256: value.inventory.sha256,
          entries: projected,
        }),
      )
      .digest('hex');
    if (digest !== value.filesSha256) throw fail();
    return freeze(value);
  } catch {
    throw fail();
  }
}

/** Produces a portable catalog; original key and custody bytes remain evidence, without import or replay authority. */
export function resetCaptureRecoveryManifest(snapshot: ResetCaptureRecoveryFiles): ResetCaptureRecoveryManifest {
  return validateResetCaptureRecoveryManifest({
    format: 'orbis-reset-capture-recovery',
    version: snapshot.version,
    resetId: snapshot.resetId,
    accounts: snapshot.accounts,
    inventory: snapshot.inventory,
    filesSha256: snapshot.filesSha256,
    entries: snapshot.entries.map((item) =>
      item.type === 'file'
        ? {
            ...item,
            chunks: item.chunks.map(({ file, ...rest }) => ({ ...rest, part: path.basename(file) })),
          }
        : item,
    ),
  });
}

export async function inspectResetCaptureRecoveryMetadata(options: {
  manifest: ResetCaptureRecoveryManifest;
  item: Extract<ResetCaptureRecoveryManifest['entries'][number], { type: 'file' }>;
  source: string;
  passphrase: string;
  signal: AbortSignal;
}) {
  const { manifest, item, source, passphrase, signal } = options;
  const match = /^(points|components)\/([a-f0-9-]{36})\/point\.json$/.exec(item.name);
  if (!match) return;
  signal.throwIfAborted();
  const record = manifest.inventory.captures.find(
    (record) => record.kind === (match[1] === 'points' ? 'core' : 'components') && record.id === match[2],
  );
  const part = item.chunks[0];
  if (!record || item.plaintextBytes > 65536 || item.chunks.length !== 1 || !part || part.bytes > 65536 + 52) throw fail();
  const identity = (s: Awaited<ReturnType<typeof fs.lstat>>) => [s.dev, s.ino, s.mode, s.uid, s.nlink, s.size, s.mtimeMs, s.ctimeMs].join(':');
  const handle = await fs.open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const ciphertext = Buffer.alloc(part.bytes);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.mode & 0o077 || before.uid !== process.getuid?.() || before.size !== part.bytes)
      throw fail();
    let at = 0;
    while (at < ciphertext.length) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(ciphertext, at, ciphertext.length - at, at);
      if (!bytesRead) throw fail();
      at += bytesRead;
    }
    if (
      createHash('sha256').update(ciphertext).digest('hex') !== part.sha256 ||
      identity(before) !== identity(await handle.stat()) ||
      identity(before) !== identity(await fs.lstat(source))
    )
      throw fail();
  } finally {
    await handle.close();
  }
  const plaintext = await backupMetadataBytes(ciphertext, passphrase, true, 65536);
  try {
    const actual = resetCaptureInventoryEntry(
      record.kind,
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)),
      record.effectiveOwnerId,
    );
    if (
      actual.id !== record.id ||
      actual.sourceOwnerId !== record.sourceOwnerId ||
      actual.version !== record.version ||
      actual.status !== record.status ||
      actual.metadataSha256 !== record.metadataSha256
    )
      throw fail();
    signal.throwIfAborted();
  } finally {
    plaintext.fill(0);
  }
}

/** Verifies extracted encrypted members without materializing plaintext or changing the destination's keys or custody. */
export async function inspectResetCaptureRecoveryManifest(options: {
  manifest: unknown;
  expected: ResetCaptureRecoveryBinding;
  directory: string;
  passphrase: string;
  signal: AbortSignal;
}) {
  const manifest = validateResetCaptureRecoveryManifest(options.manifest);
  if (
    manifest.resetId !== options.expected.resetId ||
    manifest.accounts !== options.expected.accounts ||
    manifest.filesSha256 !== options.expected.filesSha256 ||
    manifest.inventory.sha256 !== options.expected.inventorySha256
  )
    throw fail();
  const { directory, passphrase, signal } = options;
  const seals = new Map<string, string>();
  const seal = (s: Awaited<ReturnType<typeof fs.lstat>>) => [s.dev, s.ino, s.size, s.mode, s.nlink, s.uid, s.mtimeMs, s.ctimeMs].join(':');
  if (!path.isAbsolute(directory) || path.resolve(directory) !== directory || (await fs.realpath(directory)) !== directory) throw fail();
  const storage = await fs.lstat(directory);
  if (!storage.isDirectory() || storage.mode & 0o077 || storage.uid !== process.getuid?.()) throw fail();
  const expected = new Set(manifest.entries.flatMap((item) => (item.type === 'file' ? item.chunks.map((part) => part.part) : [])));
  const checkDirectory = async () => {
    const current = await fs.lstat(directory);
    if (
      current.dev !== storage.dev ||
      current.ino !== storage.ino ||
      current.mode !== storage.mode ||
      current.uid !== storage.uid ||
      (await fs.realpath(directory)) !== directory
    )
      throw fail();
    const actual = await fs.readdir(directory);
    if (actual.length !== expected.size || actual.some((name) => !expected.has(name))) throw fail();
  };
  await checkDirectory();
  for (const item of manifest.entries) {
    signal.throwIfAborted();
    if (item.type !== 'file') continue;
    for (const part of item.chunks) {
      const source = path.join(directory, part.part);
      const before = seal(await fs.lstat(source));
      const measured = await sealedBundleFiles.measure(source, signal, part.bytes);
      if (measured.bytes !== part.bytes || measured.sha256 !== part.sha256 || before !== seal(await fs.lstat(source))) throw fail();
      seals.set(source, before);
    }
    const inspected = await inspectBackupCiphertextSequence({
      chunks: item.chunks.map((part) => ({ source: path.join(directory, part.part), plaintextBytes: part.plaintextBytes })),
      passphrase,
      signal,
    });
    if (
      inspected.plaintextBytes !== item.plaintextBytes ||
      inspected.plaintextSha256 !== item.plaintextSha256 ||
      inspected.chunks.some((part, at) => part.plaintextSha256 !== item.chunks[at]?.plaintextSha256)
    )
      throw fail();
    const first = item.chunks[0];
    if (!first) throw fail();
    await inspectResetCaptureRecoveryMetadata({ manifest, item, source: path.join(directory, first.part), passphrase, signal });
  }
  for (const [source, expected] of seals) if (seal(await fs.lstat(source)) !== expected) throw fail();
  await checkDirectory();
  signal.throwIfAborted();
  return manifest;
}
