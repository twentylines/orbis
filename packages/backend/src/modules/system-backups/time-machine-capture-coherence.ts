import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { type } from 'arktype';
import { timeMachineHashSchema as hash, timeMachineIdSchema as id } from '@runtipi/common/schemas/time-machine';
import { canonicalPublicationJson as canonical } from '../host-updates/host-controller-publication';

export const coherenceEntryName = 'coherence/receipt.json';
export const coherenceReceiptLimit = 1024 * 1024;
const timestamp = '0 < number.integer <= 9007199254740991';
export const queueCaptureCheckSchema = type({
  pauseId: id,
  generation: '0 < number.integer <= 9007199254740991',
  checkedAt: timestamp,
  queues: type({ name: "'app-events-queue' | 'repo-queue' | 'system-events-queue'", messages: '0', consumers: '0' })
    .onUndeclaredKey('reject')
    .array()
    .atLeastLength(3)
    .atMostLength(3),
}).onUndeclaredKey('reject');
export type QueueCaptureCheck = typeof queueCaptureCheckSchema.infer;
const app = type({ id: hash, project: 'string > 0 & string <= 256', wasRunning: 'boolean', state: "'stopped'" }).onUndeclaredKey('reject');
const descriptorSchema = type({
  schema: "'orbis.capture-coherence.v1'",
  scope: "'orbis-managed-writers.v1'",
  pointId: id,
  transactionId: id,
  createdAt: timestamp,
  sealedAt: timestamp,
  managedWritesHeldAt: timestamp,
  database: type({ containerId: hash, bytes: '5 <= number.integer <= 137438953472', sha256: hash }).onUndeclaredKey('reject'),
  manifestSha256: hash,
  apps: app.array().atMostLength(1024),
  queueStart: queueCaptureCheckSchema,
  queueEnd: queueCaptureCheckSchema,
  hostFence: type({ configurationSetSha256: hash, preparationSha256: hash, verifiedAt: timestamp }).onUndeclaredKey('reject'),
  publicationProofSha256: hash,
  imageCaptureSha256: hash,
  imageInventorySha256: hash,
  controllerAuthoritySha256: hash,
}).onUndeclaredKey('reject');
export const captureCoherenceReceiptSchema = descriptorSchema.merge({ sha256: hash }).onUndeclaredKey('reject');
export type CaptureCoherenceReceipt = typeof captureCoherenceReceiptSchema.infer;
export type CaptureCoherenceRuntimeBinding = Pick<
  CaptureCoherenceReceipt,
  'pointId' | 'publicationProofSha256' | 'imageCaptureSha256' | 'imageInventorySha256' | 'hostFence' | 'controllerAuthoritySha256'
>;
const sha = (value: unknown) =>
  createHash('sha256')
    .update(`orbis.capture-coherence.v1\n${canonical(value)}`)
    .digest('hex');
const fail = () => new Error('Capture coherence could not be verified.');
function check(value: CaptureCoherenceReceipt) {
  const names = ['app-events-queue', 'repo-queue', 'system-events-queue'];
  for (const queues of [value.queueStart, value.queueEnd])
    if (canonical(queues.queues.map((queue) => queue.name).sort()) !== canonical(names)) throw fail();
  if (
    value.queueStart.pauseId !== value.queueEnd.pauseId ||
    value.queueStart.generation !== value.queueEnd.generation ||
    value.createdAt > value.queueStart.checkedAt ||
    value.queueStart.checkedAt > value.managedWritesHeldAt ||
    value.queueStart.checkedAt > value.queueEnd.checkedAt ||
    value.hostFence.verifiedAt > value.queueEnd.checkedAt ||
    value.queueEnd.checkedAt > value.sealedAt ||
    value.managedWritesHeldAt > value.hostFence.verifiedAt ||
    value.hostFence.verifiedAt > value.sealedAt ||
    new Set(value.apps.map((item) => item.id)).size !== value.apps.length ||
    value.apps.some((item, index) => index > 0 && item.id <= (value.apps[index - 1]?.id ?? ''))
  )
    throw fail();
  return value;
}
export function createCaptureCoherenceReceipt(raw: typeof descriptorSchema.infer): CaptureCoherenceReceipt {
  const descriptor = descriptorSchema(raw);
  if (descriptor instanceof type.errors) throw fail();
  return verifyCaptureCoherenceReceipt({ ...descriptor, sha256: sha(descriptor) });
}
export function verifyCaptureCoherenceReceipt(
  raw: unknown,
  expected?: Partial<CaptureCoherenceRuntimeBinding> & { manifestSha256?: string; databaseId?: string },
) {
  const value = captureCoherenceReceiptSchema(raw);
  if (value instanceof type.errors || Buffer.byteLength(canonical(value)) > coherenceReceiptLimit) throw fail();
  const { sha256, ...descriptor } = value;
  if (sha(descriptor) !== sha256) throw fail();
  check(value);
  if (expected) {
    for (const key of [
      'pointId',
      'publicationProofSha256',
      'imageCaptureSha256',
      'imageInventorySha256',
      'controllerAuthoritySha256',
      'manifestSha256',
    ] as const)
      if (expected[key] !== undefined && expected[key] !== value[key]) throw fail();
    if (expected.hostFence && canonical(expected.hostFence) !== canonical(value.hostFence)) throw fail();
    if (expected.databaseId && expected.databaseId !== value.database.containerId) throw fail();
  }
  return structuredClone(value);
}

export async function hashCaptureSnapshotFile(file: string, signal: AbortSignal) {
  const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.mode & 0o077 ||
      before.size > 137438953472 ||
      (process.getuid && before.uid !== process.getuid())
    )
      throw fail();
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      signal.throwIfAborted();
      hash.update(chunk);
      bytes += chunk.length;
    }
    const after = await handle.stat();
    const current = await fs.lstat(file);
    if (
      bytes !== before.size ||
      [after, current].some((stat) =>
        ['ino', 'dev', 'mode', 'uid', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].some((key) => Reflect.get(stat, key) !== Reflect.get(before, key)),
      )
    )
      throw fail();
    return { bytes, sha256: hash.digest('hex') };
  } finally {
    await handle.close();
  }
}
