import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { timeMachineComponentsMetadataSchema } from '@runtipi/common/schemas/time-machine';
import { backupMetadataBytes, decryptBackup } from '../system-backups/backup-crypto';
import { canonicalPublicationJson } from '../host-updates/host-controller-publication';
import { verifySelectedComponent } from '../system-backups/time-machine-selected-component';
import { reviewCoreCapsule } from './core-capsule-review';
import type { CapsuleManifest } from './capsule';
import { capsuleDirectorySeal, inspectCapsuleEntry, readCapsuleEntry, sameCapsuleDirectorySeal } from './verified-source';

const fail = () => new Error('The selected-components capsule did not pass verification. Components restoration is unavailable.');
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
/** Data verification only; this returns no enrollment, adoption or restoration capability. */
export async function reviewComponentsCapsule(options: {
  directory: string;
  manifest: Extract<CapsuleManifest, { schema: 'orbis.time-machine-capsule-private.v3' }>;
  signal: AbortSignal;
}) {
  const { directory, manifest, signal } = options;
  const parent = await capsuleDirectorySeal(directory);
  const seals = await Promise.all(manifest.entries.map((entry) => inspectCapsuleEntry(directory, entry, signal)));
  const metadataEntry = manifest.entries.find((entry) => entry.name === 'components-metadata.orbis');
  if (!metadataEntry) throw fail();
  const ciphertext = await readCapsuleEntry(directory, metadataEntry, signal, 2 * 1024 ** 2 + 52);
  const plaintext = await backupMetadataBytes(ciphertext, manifest.pointKey, true, 2 * 1024 ** 2);
  let metadata: typeof timeMachineComponentsMetadataSchema.infer;
  try {
    metadata = timeMachineComponentsMetadataSchema.assert(JSON.parse(plaintext.toString('utf8')));
  } finally {
    plaintext.fill(0);
  }
  const selected = metadata.selectedComponent;
  if (
    metadata.id !== manifest.pointId ||
    metadata.createdAt !== manifest.createdAt ||
    selected.receiptSha256 !== hash(canonicalPublicationJson(selected.receipt)) ||
    manifest.entries.find((entry) => entry.name === 'apps.orbis')?.sha256 !== selected.cipherSha256 ||
    manifest.entries.find((entry) => entry.name === 'apps.orbis')?.bytes !== selected.cipherBytes ||
    manifest.entries.find((entry) => entry.name === 'core.orbis')?.sha256 !== metadata.coreComponent.archiveSha256
  )
    throw fail();
  const stage = await fs.mkdtemp(path.join(directory, 'components-review-'));
  await fs.chmod(stage, 0o700);
  const stageSeal = await capsuleDirectorySeal(stage);
  const copied: string[] = [];
  const cleanup = async () => {
    if (!sameCapsuleDirectorySeal(stageSeal, await capsuleDirectorySeal(stage))) throw fail();
    for (const name of copied) {
      try {
        const file = path.join(stage, name);
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.mode & 0o077) throw fail();
        await fs.unlink(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    await fs.rmdir(stage);
  };
  try {
    const coreEntries = manifest.entries.filter((entry) => !['apps.orbis', 'components-metadata.orbis'].includes(entry.name));
    for (const entry of coreEntries) {
      await inspectCapsuleEntry(directory, entry, signal, undefined, stage);
      copied.push(entry.name);
    }
    const base = await reviewCoreCapsule({
      directory: stage,
      signal,
      manifest: {
        ...manifest,
        schema: 'orbis.time-machine-capsule-private.v2',
        pointId: metadata.coreComponent.id,
        createdAt: metadata.coreComponent.createdAt,
        entries: coreEntries,
      },
    });
    if (canonicalPublicationJson(base.summary.metadata) !== canonicalPublicationJson(metadata.coreComponent)) throw fail();
    await base.recheck(signal);
    const selectedFile = path.join(stage, 'selected.tar');
    await decryptBackup({ source: path.join(directory, 'apps.orbis'), destination: selectedFile, passphrase: manifest.pointKey, signal });
    copied.push('selected.tar');
    const source = await fs.open(selectedFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const digest = createHash('sha256');
      for await (const chunk of source.createReadStream({ autoClose: false, signal })) digest.update(chunk);
      if (digest.digest('hex') !== selected.receipt.artifact.sha256 || (await source.stat()).size !== selected.receipt.artifact.bytes) throw fail();
    } finally {
      await source.close();
    }
    await verifySelectedComponent({ file: selectedFile, receipt: selected.receipt, staging: stage, signal });
  } finally {
    await cleanup();
  }
  const recheck = async (signal: AbortSignal) => {
    if (
      !sameCapsuleDirectorySeal(parent, await capsuleDirectorySeal(directory)) ||
      (await fs.readdir(directory)).sort().join(',') !==
        manifest.entries
          .map((entry) => entry.name)
          .sort()
          .join(',')
    )
      throw fail();
    for (const [index, entry] of manifest.entries.entries()) await inspectCapsuleEntry(directory, entry, signal, seals[index]);
  };
  await recheck(signal);
  return { summary: { pointId: metadata.id, createdAt: metadata.createdAt, metadata, restoreSupported: false as const }, recheck };
}
