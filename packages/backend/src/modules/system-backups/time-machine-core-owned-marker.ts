import fs, { type FileHandle } from 'node:fs/promises';
import { constants, type BigIntStats } from 'node:fs';

type Directory = {
  at: string;
  parent: FileHandle;
  binding: readonly BigIntStats[];
  recheck: () => Promise<void>;
};
declare const ownedMarkerBrand: unique symbol;
export type OwnedCoreCaptureMarker = { readonly [ownedMarkerBrand]: true };
type Receipt = { directory: readonly BigIntStats[]; created: BigIntStats; expected: Buffer };
const receipts = new WeakMap<OwnedCoreCaptureMarker, Receipt>();
const fail = () => new Error('Interrupted snapshot record requires review.');
const ownerFields = ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink'] as const;
const sealFields = [...ownerFields, 'size', 'mtimeNs', 'ctimeNs'] as const;
const sameOwner = (a: BigIntStats, b: BigIntStats) => ownerFields.every((key) => a[key] === b[key]);
const sameSeal = (a: BigIntStats, b: BigIntStats) => sealFields.every((key) => a[key] === b[key]);
function privateFile(stat: BigIntStats) {
  if (
    !stat.isFile() ||
    typeof process.getuid !== 'function' ||
    stat.uid !== BigInt(process.getuid()) ||
    (stat.mode & 0o7777n) !== 0o600n ||
    stat.nlink !== 1n
  )
    throw fail();
}
function sameDirectory(first: readonly BigIntStats[], second: readonly BigIntStats[]) {
  return (
    first.length === second.length &&
    first.every((entry, index) => {
      const other = second[index];
      return other && ['dev', 'ino', 'uid', 'gid', 'mode'].every((key) => Reflect.get(entry, key) === Reflect.get(other, key));
    })
  );
}

/** Ownership is captured before the first write; an existing file never receives a receipt. */
export async function createOwnedCoreCaptureMarker(dir: Directory, bytes: Buffer, retain: (token: OwnedCoreCaptureMarker) => void) {
  if (bytes.length < 1 || bytes.length > 8192) throw fail();
  await dir.recheck();
  const handle = await fs.open(dir.at, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const created = await handle.stat({ bigint: true });
    privateFile(created);
    if (created.size !== 0n || !sameSeal(created, await fs.lstat(dir.at, { bigint: true }))) throw fail();
    await dir.recheck();
    const token = Object.freeze({}) as OwnedCoreCaptureMarker;
    receipts.set(token, { directory: dir.binding, created, expected: Buffer.from(bytes) });
    retain(token);
    await handle.writeFile(bytes);
    await handle.sync();
    await dir.parent.sync();
    await dir.recheck();
  } finally {
    await handle.close();
  }
}

/** Completes only the missing suffix of this attempt's original, unchanged private inode. */
export async function reconcileOwnedCoreCaptureMarker(dir: Directory, token: OwnedCoreCaptureMarker, signal: AbortSignal) {
  const receipt = receipts.get(token);
  if (!receipt || !sameDirectory(receipt.directory, dir.binding)) throw fail();
  signal.throwIfAborted();
  await dir.recheck();
  const handle = await fs.open(dir.at, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    privateFile(before);
    if (!sameOwner(receipt.created, before) || before.size < 0n || before.size > BigInt(receipt.expected.length)) throw fail();
    const prefix = Buffer.alloc(Number(before.size) + 1);
    let count = 0;
    while (count < prefix.length) {
      const { bytesRead } = await handle.read(prefix, count, prefix.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    if (count !== Number(before.size) || !prefix.subarray(0, count).equals(receipt.expected.subarray(0, count))) throw fail();
    await dir.recheck();
    if (!sameSeal(before, await handle.stat({ bigint: true })) || !sameSeal(before, await fs.lstat(dir.at, { bigint: true }))) throw fail();
    signal.throwIfAborted();
    while (count < receipt.expected.length) {
      const { bytesWritten } = await handle.write(receipt.expected, count, receipt.expected.length - count, count);
      if (!bytesWritten) throw fail();
      count += bytesWritten;
    }
    await handle.sync();
    await dir.parent.sync();
    const after = await handle.stat({ bigint: true });
    privateFile(after);
    if (!sameOwner(receipt.created, after) || after.size !== BigInt(receipt.expected.length)) throw fail();
    const complete = Buffer.alloc(receipt.expected.length + 1);
    let read = 0;
    while (read < complete.length) {
      const { bytesRead } = await handle.read(complete, read, complete.length - read, read);
      if (!bytesRead) break;
      read += bytesRead;
    }
    if (read !== receipt.expected.length || !complete.subarray(0, read).equals(receipt.expected)) throw fail();
    if (!sameSeal(after, await handle.stat({ bigint: true })) || !sameSeal(after, await fs.lstat(dir.at, { bigint: true }))) throw fail();
    await dir.recheck();
    signal.throwIfAborted();
    return { bytes: Buffer.from(receipt.expected), seal: after };
  } finally {
    await handle.close();
  }
}
