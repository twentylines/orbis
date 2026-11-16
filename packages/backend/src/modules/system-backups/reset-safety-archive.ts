import { createHash, randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertBackupMaintenanceLease, type BackupMaintenanceLease } from '../../common/backup-maintenance-lease';
import { backupMetadataBytes, decryptBackup } from './backup-crypto';
import { sealedBundleFiles } from './settings-backup-format';
import { openSettingsBackupReview } from './settings-backup-review';
import {
  assertResetExportAccess,
  resetExportPlanSha256,
  type ResetExportPlan,
  type SettingsExportAccess,
  type SettingsExportBinding,
} from './settings-export-authorization';
import { decodeResetSafetyState, type encodeResetSafetyState, type ResetSafetyState } from './reset-safety-state';
import type { ResetSafetyTargets } from './reset-safety-targets';
import { writeResetSafetyTar } from './reset-safety-tar';
import { resetCaptureRecoveryManifest } from './reset-capture-recovery-manifest';
import type { ResetCaptureRecoveryFiles } from './reset-capture-recovery-files';
import { resetSafetyCaptureReader } from './reset-safety-capture-reader';
import {
  parseResetSafetyJson,
  resetSafetyArchiveLimits as limits,
  resetSafetyExportInventorySha256,
  resetSafetyFullScopeSha256,
  resetSafetyIndexSha256,
  resetSafetyJson,
  resetSafetySelectionKey,
  validateResetSafetyIndex,
  validateResetSafetyManifest,
  type ResetSafetyArchiveIndex,
  type ResetSafetyArchiveManifest,
  type ResetSafetyArchivePart,
} from './reset-safety-archive-contract';

type EncodedState = Awaited<ReturnType<typeof encodeResetSafetyState>>;
type Profile = SettingsExportBinding & { bundleId: string; file: string; bytes: number; sha256: string };
type Inspectors = NonNullable<Parameters<typeof openSettingsBackupReview>[0]['inspect']>;
type Progress = (value: { stage: 'packaging' | 'verifying'; completedBytes: number; totalBytes: number | null }) => void;
type Artifact =
  | { role: 'state'; part: ResetSafetyArchivePart }
  | { role: 'target'; target: ResetSafetyArchiveManifest['targets']['targets'][number] }
  | { role: 'capture'; name: string; offset: number; plaintextBytes: number; part: ResetSafetyArchivePart }
  | { role: 'profile'; profile: ResetSafetyArchiveManifest['profiles'][number] };
const fail = () => new Error('The reset safety archive could not be verified. Your settings and apps were kept.');
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Reads one encrypted member at a time. Staging callbacks must never apply live changes before this promise succeeds. */
export async function inspectResetSafetyArchive(options: {
  source: string;
  directory: string;
  passphrase: string;
  signal: AbortSignal;
  inspectors: (directory: string) => Inspectors;
  expected?: { backupId: string; plan: ResetExportPlan; fullScopeSha256?: string; bytes?: number; sha256?: string };
  stageVerifiedPart?: (artifact: Artifact, file: string, manifest: ResetSafetyArchiveManifest) => Promise<void>;
  progress?: Progress;
}) {
  const { source, directory, signal, passphrase } = options;
  sealedBundleFiles.outside(directory, source);
  signal.throwIfAborted();
  const owned = await sealedBundleFiles.fresh(directory);
  let index: ResetSafetyArchiveIndex | undefined;
  let manifest: ResetSafetyArchiveManifest | undefined;
  let state: ResetSafetyState | undefined;
  let output: Awaited<ReturnType<typeof fs.open>> | undefined;
  let file = '';
  let current = '';
  let chunks: Buffer[] = [];
  let member = createHash('sha256');
  let memberBytes = 0;
  let completed = 0;
  let position = 0;
  let indexBytes = 0;
  let selected: ResetSafetyArchivePart | undefined;
  let captures: ReturnType<typeof resetSafetyCaptureReader> | undefined;
  let completedInspection = false;
  const names = new Set<string>();
  try {
    const archive = await sealedBundleFiles.readTar(source, signal, limits.archiveBytes, {
      strict: true,
      collectEntries: false,
      get maxEntries() {
        return (index?.version === 2 ? limits.v2Parts : limits.parts) + 2;
      },
      maxExpandedBytes: limits.archiveBytes,
      onEntry: async (entry) => {
        signal.throwIfAborted();
        current = entry.path;
        if (entry.type !== '-' || names.has(current) || !Number.isSafeInteger(entry.size) || entry.size < 1) throw fail();
        names.add(current);
        member = createHash('sha256');
        memberBytes = 0;
        chunks = [];
        selected = undefined;
        if (position === 0) {
          if (current !== 'bundle.json' || entry.size > limits.v2IndexBytes) throw fail();
        } else if (position === 1) {
          if (!index || current !== 'manifest.orbis' || entry.size !== index.manifest.bytes) throw fail();
        } else {
          selected = index?.parts[position - 2];
          if (!manifest || !selected || current !== selected.name || entry.size !== selected.bytes) throw fail();
          await sealedBundleFiles.capacity(directory, entry.size);
          file = path.join(directory, `member-${randomUUID()}`);
          output = await fs.open(file, 'wx', 0o600);
        }
      },
      onData: async (data) => {
        signal.throwIfAborted();
        member.update(data);
        memberBytes += data.length;
        completed += data.length;
        if (position < 2) chunks.push(Buffer.from(data));
        else {
          if (!output) throw fail();
          let offset = 0;
          while (offset < data.length) {
            const written = await output.write(data, offset, data.length - offset);
            if (!written.bytesWritten) throw fail();
            offset += written.bytesWritten;
          }
        }
        options.progress?.({
          stage: 'verifying',
          completedBytes: completed,
          totalBytes: index ? index.parts.reduce((total, part) => total + part.bytes, index.manifest.bytes + indexBytes) : null,
        });
      },
      onEntryEnd: async () => {
        const digest = member.digest('hex');
        if (position === 0) {
          index = validateResetSafetyIndex(parseResetSafetyJson(Buffer.concat(chunks)));
          indexBytes = memberBytes;
        } else if (position === 1) {
          if (!index || digest !== index.manifest.sha256 || memberBytes !== index.manifest.bytes) throw fail();
          const plaintext = await backupMetadataBytes(
            Buffer.concat(chunks),
            passphrase,
            true,
            index.version === 2 ? limits.v2ManifestBytes : limits.manifestBytes,
          );
          try {
            manifest = validateResetSafetyManifest(parseResetSafetyJson(plaintext), index);
          } finally {
            plaintext.fill(0);
          }
          if (manifest.captures) captures = resetSafetyCaptureReader({ manifest: manifest.captures, passphrase, signal });
          if (
            options.expected &&
            (manifest.backupId !== options.expected.backupId ||
              resetExportPlanSha256(manifest.plan) !== resetExportPlanSha256(options.expected.plan) ||
              (options.expected.fullScopeSha256 !== undefined && manifest.fullScopeSha256 !== options.expected.fullScopeSha256))
          )
            throw fail();
        } else {
          await output?.sync();
          await output?.close();
          output = undefined;
          if (!selected || !manifest || memberBytes !== selected.bytes || digest !== selected.sha256) throw fail();
          const measured = await sealedBundleFiles.measure(file, signal, selected.bytes);
          if (measured.bytes !== selected.bytes || measured.sha256 !== selected.sha256) throw fail();
          let artifact: Artifact;
          if (current === manifest.state.part.name) {
            state = await decodeResetSafetyState({
              ciphertext: await fs.readFile(file),
              ...manifest.state.part,
              payloadSha256: manifest.state.payloadSha256,
              plan: manifest.plan,
              passphrase,
              signal,
            });
            artifact = { role: 'state', part: manifest.state.part };
          } else if (captures?.has(current)) {
            artifact = { role: 'capture', ...(await captures.inspect(current, file)), part: selected };
          } else {
            const target = manifest.targets.targets.find((target) => target.type === 'file' && target.part.name === current);
            const profile = manifest.profiles.find((profile) => profile.part.name === current);
            if (target?.type === 'file') {
              const plaintext = path.join(directory, `decoded-${randomUUID()}`);
              try {
                await decryptBackup({ source: file, destination: plaintext, passphrase, signal });
                const decoded = await sealedBundleFiles.measure(plaintext, signal, target.plaintextBytes);
                if (decoded.bytes !== target.plaintextBytes || decoded.sha256 !== target.plaintextSha256) throw fail();
              } finally {
                await fs.rm(plaintext, { force: true });
              }
              artifact = { role: 'target', target };
            } else if (profile) {
              const reviewDirectory = path.join(directory, `profile-${randomUUID()}`);
              const review = await openSettingsBackupReview({
                source: file,
                directory: reviewDirectory,
                passphrase,
                signal,
                expectedBundleId: profile.bundleId,
                inspect: options.inspectors(manifest.version === 2 ? reviewDirectory : directory),
              });
              try {
                if (
                  review.summary.archiveSha256 !== profile.part.sha256 ||
                  resetSafetySelectionKey(review.summary.available) !== resetSafetySelectionKey(profile.selection)
                )
                  throw fail();
              } finally {
                await review.dispose();
              }
              artifact = { role: 'profile', profile };
            } else throw fail();
          }
          await options.stageVerifiedPart?.(artifact, file, manifest);
          const after = await sealedBundleFiles.measure(file, signal, selected.bytes);
          if (after.bytes !== selected.bytes || after.sha256 !== selected.sha256) throw fail();
          await fs.unlink(file);
          file = '';
        }
        position++;
      },
    });
    if (
      !index ||
      !manifest ||
      !state ||
      position !== index.parts.length + 2 ||
      (options.expected?.bytes !== undefined && archive.bytes !== options.expected.bytes) ||
      (options.expected?.sha256 !== undefined && archive.sha256 !== options.expected.sha256)
    )
      throw fail();
    captures?.finish();
    if (index.version === 2) {
      const remaining = await fs.opendir(directory);
      try {
        if (await remaining.read()) throw fail();
      } finally {
        await remaining.close();
      }
    }
    signal.throwIfAborted();
    completedInspection = true;
    return Object.freeze({ ...archive, manifest, state });
  } finally {
    await output?.close();
    if (completedInspection || index?.version !== 2) await sealedBundleFiles.cleanup(directory, owned);
  }
}

export async function exportResetSafetyArchive(options: {
  backupId: string;
  createdAt: string;
  orbisVersion: string;
  plan: ResetExportPlan;
  state: EncodedState;
  targets: ResetSafetyTargets;
  profiles: Profile[];
  captures?: ResetCaptureRecoveryFiles;
  access: SettingsExportAccess;
  lease: BackupMaintenanceLease;
  directory: string;
  destination: string;
  passphrase: string;
  signal: AbortSignal;
  inspectors: (directory: string) => Inspectors;
  progress?: Progress;
}) {
  const { directory, destination, signal } = options;
  const captures = options.captures
    ? {
        manifest: resetCaptureRecoveryManifest(options.captures),
        members: options.captures.entries.flatMap((item) =>
          item.type === 'file'
            ? item.chunks.map((chunk) => ({ name: `parts/${path.basename(chunk.file)}`, file: chunk.file, bytes: chunk.bytes, sha256: chunk.sha256 }))
            : [],
        ),
      }
    : undefined;
  if (captures) {
    const expected = captures.manifest.entries.flatMap((item) =>
      item.type === 'file' ? item.chunks.map((chunk) => ({ name: `parts/${chunk.part}`, bytes: chunk.bytes, sha256: chunk.sha256 })) : [],
    );
    if (
      expected.length !== captures.members.length ||
      expected.some((part, at) => {
        const actual = captures.members[at];
        return !actual || part.name !== actual.name || part.bytes !== actual.bytes || part.sha256 !== actual.sha256;
      })
    )
      throw fail();
  }
  const recheck = async () => {
    signal.throwIfAborted();
    assertBackupMaintenanceLease(options.lease);
    await assertResetExportAccess(options.access, options.plan);
    assertBackupMaintenanceLease(options.lease);
  };
  await recheck();
  const destinationDirectory = path.dirname(destination);
  if (
    !path.isAbsolute(destination) ||
    path.resolve(destination) !== destination ||
    directory === destinationDirectory ||
    path.dirname(directory) !== path.dirname(destinationDirectory)
  )
    throw fail();
  await fs.lstat(destinationDirectory).then(
    () => {
      throw fail();
    },
    (error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    },
  );
  sealedBundleFiles.outside(directory, destination);
  const owned = await sealedBundleFiles.fresh(directory);
  let published: Stats | undefined;
  let completed = false;
  try {
    const members: { name: string; file: string; bytes: number; sha256: string }[] = [];
    const reference = (input: { file: string; bytes: number; sha256: string }): ResetSafetyArchivePart => {
      sealedBundleFiles.outside(directory, input.file);
      const part = { name: `parts/${randomUUID()}.orbis`, bytes: input.bytes, sha256: input.sha256 };
      members.push({ ...part, file: input.file });
      return part;
    };
    const statePart = { name: `parts/${randomUUID()}.orbis`, bytes: options.state.bytes, sha256: options.state.sha256 };
    if (
      options.state.ciphertext.length !== statePart.bytes ||
      statePart.bytes > limits.stateBytes ||
      sha(options.state.ciphertext) !== statePart.sha256
    )
      throw fail();
    const targets = {
      ...options.targets,
      targets: options.targets.targets.map((target) =>
        target.type === 'file'
          ? {
              name: target.name,
              type: target.type,
              part: reference(target),
              plaintextBytes: target.plaintextBytes,
              plaintextSha256: target.plaintextSha256,
            }
          : { ...target },
      ),
    };
    const profiles = options.profiles.map((profile) => ({
      exportId: profile.exportId,
      ownerId: profile.ownerId,
      selection: structuredClone(profile.selection),
      bundleId: profile.bundleId,
      part: reference(profile),
    }));
    for (const member of captures?.members ?? []) {
      sealedBundleFiles.outside(directory, member.file);
      members.push(member);
    }
    const version: 1 | 2 = captures ? 2 : 1;
    const partial = {
      format: 'orbis-reset-safety-index' as const,
      version,
      backupId: options.backupId,
      parts: [statePart, ...members.map(({ file: _file, ...part }) => part)],
    };
    const body = {
      format: 'orbis-reset-safety' as const,
      version,
      backupId: options.backupId,
      createdAt: options.createdAt,
      orbisVersion: options.orbisVersion,
      indexSha256: resetSafetyIndexSha256(partial),
      exportInventorySha256: resetSafetyExportInventorySha256(options.plan),
      plan: structuredClone(options.plan),
      state: { part: statePart, payloadSha256: options.state.payloadSha256 },
      targets,
      profiles,
      ...(captures ? { captures: captures.manifest } : {}),
    };
    const manifest = { ...body, fullScopeSha256: resetSafetyFullScopeSha256(body as Omit<ResetSafetyArchiveManifest, 'fullScopeSha256'>) };
    const plaintext = resetSafetyJson(manifest);
    let encrypted: Buffer;
    try {
      encrypted = await backupMetadataBytes(plaintext, options.passphrase, false, version === 2 ? limits.v2ManifestBytes : limits.manifestBytes);
    } finally {
      plaintext.fill(0);
    }
    const index = validateResetSafetyIndex({ ...partial, manifest: { bytes: encrypted.length, sha256: sha(encrypted) } });
    validateResetSafetyManifest(manifest, index);
    const indexBytes = resetSafetyJson(index);
    if (indexBytes.length > (version === 2 ? limits.v2IndexBytes : limits.indexBytes)) throw fail();
    const candidate = path.join(directory, 'candidate.tar');
    await recheck();
    const archive = await writeResetSafetyTar({
      destination: candidate,
      maxEntries: version === 2 ? limits.v2Parts + 2 : limits.parts + 2,
      entries: [
        { name: 'bundle.json', data: indexBytes },
        { name: 'manifest.orbis', data: encrypted },
        { name: statePart.name, data: options.state.ciphertext },
        ...members,
      ],
      signal,
      progress: (completedBytes, totalBytes) => options.progress?.({ stage: 'packaging', completedBytes, totalBytes }),
    });
    await recheck();
    const verified = await inspectResetSafetyArchive({
      source: candidate,
      directory: path.join(directory, 'verify'),
      passphrase: options.passphrase,
      signal,
      inspectors: options.inspectors,
      expected: { backupId: options.backupId, plan: options.plan, fullScopeSha256: manifest.fullScopeSha256, ...archive },
      progress: options.progress,
    });
    await recheck();
    if (verified.sha256 !== archive.sha256) throw fail();
    published = await sealedBundleFiles.fresh(destinationDirectory);
    if (published.dev !== owned.dev) throw fail();
    const before = await fs.lstat(candidate);
    await fs.rename(candidate, destination);
    const after = await fs.lstat(destination);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.mode !== after.mode ||
      before.uid !== after.uid ||
      after.nlink !== 1
    )
      throw fail();
    const parent = await fs.open(destinationDirectory, 'r');
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
    const store = await fs.open(path.dirname(destinationDirectory), 'r');
    try {
      await store.sync();
    } finally {
      await store.close();
    }
    await recheck();
    completed = true;
    return Object.freeze({
      ...archive,
      backupId: options.backupId,
      selectionSha256: resetExportPlanSha256(options.plan),
      fullScopeSha256: manifest.fullScopeSha256,
      exportInventorySha256: manifest.exportInventorySha256,
      targetInventorySha256: manifest.targets.inventorySha256,
    });
  } catch (error) {
    if (published && !completed && !captures) {
      try {
        const names = await fs.readdir(destinationDirectory);
        if (names.some((name) => name !== path.basename(destination))) throw fail();
        await sealedBundleFiles.cleanup(destinationDirectory, published);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'The safety archive and its staging directory need review.');
      }
    }
    throw error;
  } finally {
    if (completed || !captures) await sealedBundleFiles.cleanup(directory, owned);
  }
}
