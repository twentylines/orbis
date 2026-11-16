import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertBackupMaintenanceLease, type BackupMaintenanceLease } from '../../common/backup-maintenance-lease';
import { ResetBackupKeyCustody } from './reset-backup-key-custody';
import { inspectResetSafetyArchive } from './reset-safety-archive';
import { sealedBundleFiles } from './settings-backup-format';
import { assertResetExportAccess, resetExportPlanSha256, type ResetExportPlan, type SettingsExportAccess } from './settings-export-authorization';
import { resetSafetyArchiveCommitmentSchema, type ResetSafetyArchiveCommitment } from './reset-safety-commitment-contract';

export type { ResetSafetyArchiveCommitment };

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
type Inspection = Awaited<ReturnType<typeof inspectResetSafetyArchive>>;
type Options = {
  dataDir: string;
  backupId: string;
  plan: ResetExportPlan;
  access: SettingsExportAccess;
  lease: BackupMaintenanceLease;
  signal: AbortSignal;
  inspectors: (directory: string, passphrase: string) => ReturnType<Parameters<typeof inspectResetSafetyArchive>[0]['inspectors']>;
};
const fail = () => new Error('The durable reset backup could not be verified. Keep the archive and recovery key for review.');
const identity = (s: Stats) => `${s.dev}:${s.ino}:${s.uid}:${s.mode}`;

export function resetSafetyArchivePath(dataDir: string, backupId: string) {
  if (!path.isAbsolute(dataDir) || path.resolve(dataDir) !== dataDir || !uuid.test(backupId)) throw fail();
  return path.join(dataDir, 'backups', 'reset-safety', backupId, 'archive.orbis');
}

async function open(options: Options) {
  const { dataDir, backupId, signal, lease, access, inspectors } = options;
  const plan: ResetExportPlan = structuredClone(options.plan);
  const source = resetSafetyArchivePath(dataDir, backupId);
  const selectionSha256 = resetExportPlanSha256(plan);
  const binding = { resetId: plan.resetId, backupId, selectionSha256, users: [...plan.users].sort((a, b) => a - b) };
  const scope = async () => {
    signal.throwIfAborted();
    assertBackupMaintenanceLease(lease);
    await assertResetExportAccess(access, plan);
    signal.throwIfAborted();
  };
  await scope();
  const parents: { name: string; handle: Awaited<ReturnType<typeof fs.open>>; stat: Stats }[] = [];
  let archive: Awaited<ReturnType<typeof sealedBundleFiles.open>> | undefined;
  const close = async () => {
    await archive?.handle.close();
    await Promise.all(parents.map(({ handle }) => handle.close()));
  };
  try {
    for (const name of [dataDir, path.join(dataDir, 'backups'), path.dirname(path.dirname(source)), path.dirname(source)]) {
      const handle = await fs.open(name, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      let stat: Stats;
      try {
        stat = await handle.stat();
      } catch (error) {
        await handle.close();
        throw error;
      }
      parents.push({ name, handle, stat });
      if (
        !stat.isDirectory() ||
        (process.getuid && stat.uid !== process.getuid()) ||
        (name !== dataDir && stat.mode & 0o077) ||
        (await fs.realpath(name)) !== name
      )
        throw fail();
    }
    archive = await sealedBundleFiles.open(source);
    const pinned = archive;
    const check = async () => {
      await scope();
      for (const parent of parents) {
        if (identity(await parent.handle.stat()) !== identity(parent.stat) || identity(await fs.lstat(parent.name)) !== identity(parent.stat))
          throw fail();
      }
      if (
        sealedBundleFiles.seal(await pinned.handle.stat()) !== sealedBundleFiles.seal(pinned.stat) ||
        sealedBundleFiles.seal(await fs.lstat(source)) !== sealedBundleFiles.seal(pinned.stat)
      )
        throw fail();
      let entries = 0;
      for await (const entry of await fs.opendir(path.dirname(source))) {
        if (++entries > 1 || entry.name !== 'archive.orbis') throw fail();
      }
      if (entries !== 1) throw fail();
    };
    await check();
    const inspect = (passphrase: string, expected?: ResetSafetyArchiveCommitment) =>
      inspectResetSafetyArchive({
        source,
        directory: path.join(path.dirname(path.dirname(source)), `.verify-${randomUUID()}`),
        passphrase,
        signal,
        inspectors: (directory) => inspectors(directory, passphrase),
        expected: {
          backupId,
          plan,
          ...(expected ? { fullScopeSha256: expected.fullScopeSha256, bytes: expected.bytes, sha256: expected.sha256 } : {}),
        },
      });
    return {
      binding,
      custody: new ResetBackupKeyCustody(dataDir),
      inspect,
      check,
      close,
      sync: async () => {
        await check();
        await pinned.handle.sync();
        for (const parent of [...parents].reverse()) await parent.handle.sync();
        await check();
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

function receipt(verified: Inspection): ResetSafetyArchiveCommitment {
  const manifest = verified.manifest;
  return Object.freeze({
    format: 'orbis-reset-safety-commitment',
    version: 1,
    resetId: manifest.plan.resetId,
    backupId: manifest.backupId,
    accounts: manifest.plan.accounts,
    users: Object.freeze([...manifest.plan.users].sort((a, b) => a - b)),
    selectionSha256: resetExportPlanSha256(manifest.plan),
    fullScopeSha256: manifest.fullScopeSha256,
    exportInventorySha256: manifest.exportInventorySha256,
    targetInventorySha256: manifest.targets.inventorySha256,
    bytes: verified.bytes,
    sha256: verified.sha256,
  });
}

/** Durable storage evidence only; this neither authorizes erasure nor applies restored state. */
export async function commitResetSafetyArchive(options: Options): Promise<ResetSafetyArchiveCommitment> {
  const context = await open(options);
  const challenge = randomBytes(32);
  let keyCheck: Buffer | undefined;
  try {
    const verified = await context.custody.withReserved(context.binding, async (passphrase) => {
      const result = receipt(await context.inspect(passphrase));
      keyCheck = createHmac('sha256', passphrase).update(challenge).digest();
      return result;
    });
    await context.sync();
    const commitment = { archiveBytes: verified.bytes, archiveSha256: verified.sha256 };
    await context.custody.seal(context.binding, commitment);
    await context.custody.withSealed(context.binding, commitment, async (passphrase) => {
      const reopened = createHmac('sha256', passphrase).update(challenge).digest();
      try {
        if (!keyCheck || !timingSafeEqual(keyCheck, reopened)) throw fail();
      } finally {
        reopened.fill(0);
      }
    });
    await context.check();
    return verified;
  } finally {
    keyCheck?.fill(0);
    challenge.fill(0);
    await context.close();
  }
}

export async function verifyResetSafetyArchiveCommitment(options: Options & { commitment: ResetSafetyArchiveCommitment }) {
  const expected: ResetSafetyArchiveCommitment = structuredClone(options.commitment);
  resetSafetyArchiveCommitmentSchema.assert(expected);
  const context = await open(options);
  try {
    const verified = await context.custody.withSealed(
      context.binding,
      { archiveBytes: expected.bytes, archiveSha256: expected.sha256 },
      async (passphrase) => receipt(await context.inspect(passphrase, expected)),
    );
    if (Object.keys(expected).some((key) => JSON.stringify(Reflect.get(expected, key)) !== JSON.stringify(Reflect.get(verified, key)))) throw fail();
    await context.check();
    return verified;
  } finally {
    await context.close();
  }
}
