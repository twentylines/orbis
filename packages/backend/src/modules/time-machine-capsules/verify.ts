import fs from 'node:fs/promises';
import path from 'node:path';
import { timeMachineMetadataSchema, type TimeMachineMetadata } from '@runtipi/common/schemas/time-machine';
import { backupMetadataBytes, decryptBackup } from '../system-backups/backup-crypto';
import { admitRuntimeFile, type RuntimeAdmissionExpectation } from '../system-backups/time-machine-runtime-reader';
import { inspectFullBackup } from '../system-backups/backup-import';
import { verifyCaptureAgainstBackup } from '../system-backups/backup-image-capture';
import type { BackupDatabaseService } from '../system-backups/backup-database.service';
import { hashCaptureSnapshotFile } from '../system-backups/time-machine-capture-coherence';
import { capsuleLimits, capsuleManifestSchema, type CapsuleManifest } from './capsule';
import { verifyCapsulePreview } from './capsule-preview';
import { reviewCoreCapsule, type CoreCapsuleReview } from './core-capsule-review';
import { capsuleDirectorySeal, inspectCapsuleEntry, readCapsuleEntry, sameCapsuleDirectorySeal } from './verified-source';

declare const verifiedCapsule: unique symbol;
export type VerifiedCapsuleContents = { readonly [verifiedCapsule]: true };
export type VerifiedCapsuleBinding = { pointId: string; createdAt: number; archiveSha256: string; metadataSha256: string };
type Verification = {
  manifest: CapsuleManifest;
  metadata: Extract<TimeMachineMetadata, { version: 2 }>;
  runtimeExpectation: RuntimeAdmissionExpectation;
  recheck: (signal: AbortSignal) => Promise<void>;
  copyTo: (directory: string, signal: AbortSignal) => Promise<void>;
};
const verifications = new WeakMap<VerifiedCapsuleContents, Verification>();
const coreReviews = new WeakMap<VerifiedCapsuleContents, CoreCapsuleReview>();
/** Read-only review. Core capsules deliberately receive no legacy adoption capability. */
export async function coreCapsuleReview(token: VerifiedCapsuleContents, signal: AbortSignal) {
  const review = coreReviews.get(token);
  if (!review) throw fail();
  await review.recheck(signal);
  return review.summary;
}
const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};

/** Process-local authority; no point key or private paths are fields of the token. */
export async function withVerifiedCapsuleContents<T>(
  token: VerifiedCapsuleContents,
  signal: AbortSignal,
  consume: (verification: Readonly<Verification>) => Promise<T>,
): Promise<T> {
  const verification = verifications.get(token);
  if (!verification) throw fail();
  await verification.recheck(signal);
  return consume(verification);
}

export async function verifiedCapsuleBinding(token: VerifiedCapsuleContents, signal: AbortSignal): Promise<VerifiedCapsuleBinding> {
  return withVerifiedCapsuleContents(token, signal, async ({ manifest, metadata }) => {
    const entry = manifest.entries.find((entry) => entry.name === 'metadata.orbis');
    if (!entry) throw fail();
    return { pointId: metadata.id, createdAt: metadata.createdAt, archiveSha256: metadata.archiveSha256, metadataSha256: entry.sha256 };
  });
}

const fail = () => new Error('The capsule contents did not pass verification. Destination enrollment is still required.');
export async function verifyCapsuleContents(options: {
  manifest: CapsuleManifest;
  directory: string;
  signal: AbortSignal;
  database: Pick<BackupDatabaseService, 'review'>;
  target: { orbisVersion: string; runtipiVersion: string; architecture: string };
}): Promise<VerifiedCapsuleContents> {
  const { directory, signal } = options;
  const manifest = freeze(structuredClone(options.manifest));
  if (
    !capsuleManifestSchema.allows(manifest) ||
    !Number.isSafeInteger(manifest.createdAt) ||
    manifest.entries.reduce((sum, entry) => sum + entry.bytes, 0) > capsuleLimits.bytes
  )
    throw fail();
  if (manifest.schema === 'orbis.time-machine-capsule-private.v2') {
    const review = await reviewCoreCapsule({ ...options, manifest });
    const token = Object.freeze(Object.create(null)) as VerifiedCapsuleContents;
    coreReviews.set(token, { ...review, summary: freeze(review.summary) });
    return token;
  }
  const originalDirectory = await capsuleDirectorySeal(directory);
  const seals = await Promise.all(manifest.entries.map((entry) => inspectCapsuleEntry(directory, entry, signal)));
  const metadataEntry = manifest.entries.find((entry) => entry.name === 'metadata.orbis');
  if (!metadataEntry) throw fail();
  const ciphertext = await readCapsuleEntry(directory, metadataEntry, signal, capsuleLimits.manifestBytes + 52);
  const bytes = await backupMetadataBytes(ciphertext, manifest.pointKey, true, capsuleLimits.manifestBytes);
  let record: unknown;
  try {
    record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally {
    bytes.fill(0);
  }
  if (
    !record ||
    typeof record !== 'object' ||
    !('version' in record) ||
    record.version !== 'runtime-expectation-v1' ||
    !('metadata' in record) ||
    !('runtimeExpectation' in record) ||
    Object.keys(record).sort().join(',') !== 'metadata,runtimeExpectation,version'
  )
    throw fail();
  const metadata = timeMachineMetadataSchema.assert(record.metadata);
  const backup = manifest.entries[0];
  const runtime = manifest.entries[1];
  if (
    metadata.version !== 2 ||
    metadata.id !== manifest.pointId ||
    metadata.createdAt !== manifest.createdAt ||
    !backup ||
    !runtime ||
    metadata.archiveBytes !== backup.bytes ||
    metadata.archiveSha256 !== backup.sha256 ||
    metadata.runtime.cipherBytes !== runtime.bytes ||
    metadata.runtime.cipherSha256 !== runtime.sha256
  )
    throw fail();
  await verifyCapsulePreview(metadata, manifest, directory, signal);
  const expected = record.runtimeExpectation as RuntimeAdmissionExpectation;
  if (
    !expected ||
    Object.keys(expected).sort().join(',') !== 'manifest,manifestSha256,publication' ||
    expected.manifestSha256 !== metadata.runtime.manifestSha256
  )
    throw fail();
  const admitted = await admitRuntimeFile({
    source: path.join(directory, 'runtime.orbis'),
    stagingParent: directory,
    passphrase: manifest.pointKey,
    expected,
    signal,
    maximumBytes: 64 * 1024 ** 3 - 32,
    timeoutMs: 300_000,
  });
  const archive = path.join(directory, 'legacy.tar.gz');
  const content = path.join(directory, 'content');
  const normalized = path.join(directory, 'database');
  try {
    const inventory = admitted.capture.inventory as { images: unknown[]; bindings: unknown[] };
    if (
      admitted.manifest.pointId !== manifest.pointId ||
      admitted.manifest.legacy.cipherSha256 !== backup.sha256 ||
      admitted.manifest.legacy.bytes !== backup.bytes ||
      admitted.manifest.legacy.manifestSha256 !== metadata.manifestSha256 ||
      admitted.manifest.imageCaptureSha256 !== metadata.runtime.imageCaptureSha256 ||
      admitted.manifest.imageInventorySha256 !== metadata.runtime.imageInventorySha256 ||
      admitted.manifest.configurationSetSha256 !== metadata.runtime.configurationSetSha256 ||
      inventory.images.length !== metadata.runtime.imageCount ||
      inventory.bindings.length !== metadata.runtime.bindingCount ||
      ('coherenceSha256' in admitted.manifest ? admitted.manifest.coherenceSha256 : undefined) !== metadata.runtime.coherenceSha256
    )
      throw fail();
    await decryptBackup({ source: path.join(directory, 'backup.orbis'), destination: archive, passphrase: manifest.pointKey, signal });
    const storage = await fs.statfs(directory, { bigint: true });
    const free = storage.bavail * storage.bsize - BigInt(capsuleLimits.reserveBytes);
    if (free < 1024n) throw fail();
    const inspected = await inspectFullBackup({
      archive,
      destination: content,
      signal,
      maxExpandedBytes: Number(free < BigInt(capsuleLimits.bytes) ? free : BigInt(capsuleLimits.bytes)),
      target: options.target,
    });
    if (inspected.review.manifestSha256 !== metadata.manifestSha256) throw fail();
    await verifyCaptureAgainstBackup({
      capture: admitted.capture,
      content,
      manifestSha256: metadata.manifestSha256,
      excludedApps: metadata.excludedApps,
      appRuntime: admitted.appRuntime ?? undefined,
      signal,
    });
    if (admitted.coherence) {
      const database = await hashCaptureSnapshotFile(path.join(content, 'database.dump'), signal);
      if (database.bytes !== admitted.coherence.database.bytes || database.sha256 !== admitted.coherence.database.sha256) throw fail();
    }
    await options.database.review(content, normalized, signal, () => undefined);
  } finally {
    await admitted.dispose();
    await fs.rm(archive, { force: true });
    await fs.rm(content, { recursive: true, force: true });
    await fs.rm(normalized, { recursive: true, force: true });
  }
  const sealedDirectory = await capsuleDirectorySeal(directory);
  if (!sameCapsuleDirectorySeal(originalDirectory, sealedDirectory)) throw fail();
  const names = manifest.entries
    .map((entry) => entry.name)
    .sort()
    .join(',');
  // Child names and pinned file digests establish content; directory timestamps do not.
  const directoryUnchanged = async () =>
    sameCapsuleDirectorySeal(sealedDirectory, await capsuleDirectorySeal(directory)) && (await fs.readdir(directory)).sort().join(',') === names;
  const recheck = async (signal: AbortSignal) => {
    signal.throwIfAborted();
    if (!(await directoryUnchanged())) throw fail();
    for (const [index, entry] of manifest.entries.entries()) await inspectCapsuleEntry(directory, entry, signal, seals[index]);
    if (!(await directoryUnchanged())) throw fail();
  };
  await recheck(signal);
  const token = Object.freeze(Object.create(null)) as VerifiedCapsuleContents;
  verifications.set(
    token,
    Object.freeze({
      manifest,
      metadata: freeze(metadata),
      runtimeExpectation: freeze(structuredClone(expected)),
      recheck,
      copyTo: async (destination: string, signal: AbortSignal) => {
        await recheck(signal);
        for (const [index, entry] of manifest.entries.entries()) await inspectCapsuleEntry(directory, entry, signal, seals[index], destination);
        await recheck(signal);
      },
    }),
  );
  return token;
}
