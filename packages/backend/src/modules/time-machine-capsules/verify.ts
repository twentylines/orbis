import { verifyAppIcons } from '../system-backups/time-machine-app-icons';
import { historicalIconLimits } from '@runtipi/common/schemas/time-machine-icons';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { timeMachineMetadataSchema } from '@runtipi/common/schemas/time-machine';
import { backupMetadataBytes, decryptBackup } from '../system-backups/backup-crypto';
import { admitRuntimeFile, type RuntimeAdmissionExpectation } from '../system-backups/time-machine-runtime-reader';
import { inspectFullBackup } from '../system-backups/backup-import';
import { verifyCaptureAgainstBackup } from '../system-backups/backup-image-capture';
import type { BackupDatabaseService } from '../system-backups/backup-database.service';
import { hashCaptureSnapshotFile } from '../system-backups/time-machine-capture-coherence';
import { capsuleLimits, type CapsuleManifest } from './capsule';

const fail = () => new Error('The capsule contents did not pass verification. Destination enrollment is still required.');
export async function verifyCapsuleContents(options: {
  manifest: CapsuleManifest;
  directory: string;
  signal: AbortSignal;
  database: Pick<BackupDatabaseService, 'review'>;
  target: { orbisVersion: string; runtipiVersion: string; architecture: string };
}) {
  const { manifest, directory, signal } = options;
  const ciphertext = await fs.readFile(path.join(directory, 'metadata.orbis'));
  if (ciphertext.length > capsuleLimits.manifestBytes + 52) throw fail();
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
  const asset = metadata.preview.available && metadata.preview.wallpaperAsset.available ? metadata.preview.wallpaperAsset : null;
  const wallpaper = manifest.entries.find((entry) => entry.name === 'wallpaper.orbis');
  if (
    Boolean(asset) !== Boolean(wallpaper) ||
    (asset && wallpaper && (wallpaper.bytes !== asset.bytes + 52 || wallpaper.sha256 !== asset.cipherSha256))
  )
    throw fail();
  if (asset && wallpaper) {
    const value = await backupMetadataBytes(await fs.readFile(path.join(directory, 'wallpaper.orbis')), manifest.pointKey, true, 32 * 1024 ** 2);
    try {
      if (value.length !== asset.bytes || createHash('sha256').update(value).digest('hex') !== asset.identity) throw fail();
    } finally {
      value.fill(0);
    }
  }
  const icons = metadata.preview.available ? metadata.preview.appIcons : undefined;
  const iconEntry = manifest.entries.find((entry) => entry.name === 'icons.orbis');
  if (
    Boolean(icons) !== Boolean(iconEntry) ||
    (icons && iconEntry && (icons.bytes + 52 !== iconEntry.bytes || icons.cipherSha256 !== iconEntry.sha256))
  )
    throw fail();
  if (icons && iconEntry) {
    const value = await backupMetadataBytes(
      await fs.readFile(path.join(directory, 'icons.orbis')),
      manifest.pointKey,
      true,
      historicalIconLimits.bundleBytes,
    );
    try {
      verifyAppIcons(value, icons);
    } finally {
      value.fill(0);
    }
  }
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
    if (
      admitted.manifest.pointId !== manifest.pointId ||
      admitted.manifest.legacy.cipherSha256 !== backup.sha256 ||
      admitted.manifest.legacy.bytes !== backup.bytes ||
      admitted.manifest.legacy.manifestSha256 !== metadata.manifestSha256
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
}
