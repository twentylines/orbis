import fs from 'node:fs/promises';
import path from 'node:path';
import { assertBackupMaintenanceLease } from '../../common/backup-maintenance-lease';
import { legacyResetJournalSchema, type ResetJournal } from '../system-reset/reset-contract';
import { privateBackupDirectory } from './backup-files';
import { ResetBackupKeyCustody } from './reset-backup-key-custody';
import { exportResetSafetyArchive } from './reset-safety-archive';
import { commitResetSafetyArchive, resetSafetyArchivePath } from './reset-safety-commitment';
import { withResetSafetyState, type ResetSafetySourceOptions } from './reset-safety-source';
import { encodeResetSafetyState } from './reset-safety-state';
import { withResetSafetyTargets } from './reset-safety-targets';
import { sealedBundleFiles } from './settings-backup-format';
import type { SettingsBackupSourceService } from './settings-backup-source.service';
import type { TimeMachineService } from './time-machine.service';
import { planResetSafetyExports } from './reset-safety-plan';
import { resetCaptureRecoveryManifest } from './reset-capture-recovery-manifest';
import type { ResetCaptureRecoveryFiles } from './reset-capture-recovery-files';
import { withResetSafetyDatabaseCohort } from './reset-safety-database';
import {
  assertResetExportAccess,
  resetExportPlanSha256,
  withResetInventoryAccess,
  withResetExportAccessFromInventory,
  type ResetExportProof,
  assertResetInventoryAccess,
  type ResetInventoryAccess,
} from './settings-export-authorization';

export type ResetSafetyPreparationOptions = Omit<ResetSafetySourceOptions, 'captureRecovery' | 'machine'> & {
  journal: ResetJournal;
  backupId: string;
  createdAt: string;
  orbisVersion: string;
  profiles: Pick<SettingsBackupSourceService, 'writeForReset' | 'inspectors'>;
  machine: ResetSafetySourceOptions['machine'] & Partial<Pick<TimeMachineService, 'withResetCaptureRecoveryFiles'>>;
  rawCaptures?: { access: ResetInventoryAccess; inventorySha256: string };
};
const fail = () => new Error('The complete reset backup could not be prepared. Keep its archive and recovery key for review.');

function freshJournal(value: ResetJournal) {
  if (value.version !== 1) throw new Error('This reset already has a recovery archive. Verify that archive before continuing.');
  return legacyResetJournalSchema.assert(structuredClone(value));
}

export type ResetSafetyInventoryPreparationOptions = Omit<ResetSafetyPreparationOptions, 'plan' | 'access' | 'machine' | 'rawCaptures'> & {
  proof: ResetExportProof;
  machine: Pick<
    TimeMachineService,
    'withResetPreferencesSnapshot' | 'withResetCapturePreferencesSnapshot' | 'withResetCaptureRecoveryFiles' | 'resetCaptureInventory'
  >;
};

/** Derives the complete export plan from the protected raw stores without a second password/passkey confirmation. */
export async function prepareResetSafetyArchiveFromInventory(options: ResetSafetyInventoryPreparationOptions) {
  const { proof, ...source } = options;
  const journal = freshJournal(source.journal);
  if (journal.phase !== 'prepared') throw fail();
  return withResetInventoryAccess(
    proof,
    { resetId: journal.id, accounts: journal.accounts, lease: source.lease, signal: source.signal },
    async (inventoryAccess) => {
      const inventory = await source.machine.resetCaptureInventory({
        resetId: journal.id,
        accounts: journal.accounts,
        lease: source.lease,
        signal: source.signal,
        access: inventoryAccess,
      });
      const planned = planResetSafetyExports({
        resetId: journal.id,
        accounts: journal.accounts,
        users: journal.users,
        captures: [],
      });
      return withResetExportAccessFromInventory(inventoryAccess, planned.plan, (access) =>
        prepareResetSafetyArchive({
          ...source,
          journal,
          plan: planned.plan,
          access,
          rawCaptures: { access: inventoryAccess, inventorySha256: inventory.sha256 },
        }),
      );
    },
  );
}

/** Assembles storage evidence under continuing source fences. It neither persists a reset journal nor authorizes erasure. */
export async function prepareResetSafetyArchive(options: ResetSafetyPreparationOptions) {
  const captured = { ...options, journal: freshJournal(options.journal) };
  return withResetSafetyDatabaseCohort(captured, () => prepareArchive(captured));
}

async function prepareArchive(options: ResetSafetyPreparationOptions) {
  const { backupId, createdAt, orbisVersion } = options;
  const plan = structuredClone(options.plan);
  const journal = freshJournal(options.journal);
  const machine = options.machine;
  const raw = options.rawCaptures ? { ...options.rawCaptures } : undefined;
  const selectionSha256 = resetExportPlanSha256(plan);
  const users = [...plan.users].sort((a, b) => a - b);
  if (
    journal.phase !== 'prepared' ||
    journal.id !== plan.resetId ||
    journal.accounts !== plan.accounts ||
    JSON.stringify([...journal.users].sort((a, b) => a - b)) !== JSON.stringify(users) ||
    !Number.isFinite(Date.parse(createdAt)) ||
    !orbisVersion ||
    orbisVersion.length > 128
  )
    throw fail();
  const guard = async () => {
    options.signal.throwIfAborted();
    assertBackupMaintenanceLease(options.lease);
    await assertResetExportAccess(options.access, plan);
    if (raw) {
      await assertResetInventoryAccess(raw.access, { resetId: plan.resetId, accounts: plan.accounts, lease: options.lease, signal: options.signal });
      if (
        !machine.withResetCaptureRecoveryFiles ||
        !machine.withResetCapturePreferencesSnapshot ||
        plan.exports.some((item) => item.selection.timeMachine.length !== 0)
      )
        throw fail();
    }
    options.signal.throwIfAborted();
    assertBackupMaintenanceLease(options.lease);
  };
  await guard();
  const dataDir = options.config.get('directories').dataDir;
  const destination = resetSafetyArchivePath(dataDir, backupId);
  const store = path.dirname(path.dirname(destination));
  const work = path.join(store, `.prepare-${backupId}`);
  const packaging = path.join(store, `.package-${backupId}`);
  // A missing live source must never be silently recreated as an empty backup.
  const live = await fs.lstat(dataDir);
  if (!live.isDirectory() || live.isSymbolicLink() || (await fs.realpath(dataDir)) !== dataDir) throw fail();
  await privateBackupDirectory(path.join(dataDir, 'backups'));
  await privateBackupDirectory(store);
  for (const name of [path.dirname(destination), work, packaging]) {
    await fs.lstat(name).then(
      () => {
        throw fail();
      },
      (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      },
    );
  }
  await guard();
  const owned = await sealedBundleFiles.fresh(work);
  const targetDirectory = path.join(work, 'targets');
  await sealedBundleFiles.fresh(targetDirectory);
  const custody = new ResetBackupKeyCustody(dataDir);
  const binding = { resetId: plan.resetId, backupId, selectionSha256, users };
  await custody.reserve(binding);
  const result = await custody.withReserved(binding, async (passphrase) => {
    const assemble = (captures?: ResetCaptureRecoveryFiles) =>
      withResetSafetyState(
        {
          ...options,
          machine,
          plan,
          captureRecovery: captures && raw ? { access: raw.access, manifest: resetCaptureRecoveryManifest(captures) } : undefined,
        },
        async (value) => {
          const state = await encodeResetSafetyState({
            value,
            plan,
            access: options.access,
            lease: options.lease,
            signal: options.signal,
            passphrase,
          });
          try {
            return await withResetSafetyTargets(
              {
                dataDir,
                journal,
                plan,
                access: options.access,
                lease: options.lease,
                directory: targetDirectory,
                passphrase,
                signal: options.signal,
              },
              async (targets) => {
                const profiles: Parameters<typeof exportResetSafetyArchive>[0]['profiles'] = [];
                for (const item of plan.exports) {
                  await guard();
                  const directory = path.join(work, item.exportId);
                  await sealedBundleFiles.fresh(directory);
                  const file = path.join(directory, 'profile.orbis-settings');
                  const exported = await options.profiles.writeForReset(
                    {
                      ...item,
                      directory,
                      destination: file,
                      passphrase,
                      signal: options.signal,
                    },
                    options.access,
                  );
                  profiles.push({ ...item, file, bundleId: exported.manifest.id, bytes: exported.bytes, sha256: exported.sha256 });
                }
                await guard();
                await exportResetSafetyArchive({
                  backupId,
                  createdAt,
                  orbisVersion,
                  plan,
                  state,
                  targets,
                  profiles,
                  captures,
                  access: options.access,
                  lease: options.lease,
                  directory: packaging,
                  destination,
                  passphrase,
                  signal: options.signal,
                  inspectors: (directory) => options.profiles.inspectors(passphrase, directory),
                });
                return commitResetSafetyArchive({
                  dataDir,
                  backupId,
                  plan,
                  access: options.access,
                  lease: options.lease,
                  signal: options.signal,
                  inspectors: (directory, secret) => options.profiles.inspectors(secret, directory),
                });
              },
            );
          } finally {
            state.ciphertext.fill(0);
          }
        },
      );
    if (!raw) return assemble();
    const rawDirectory = path.join(work, 'raw-captures');
    await sealedBundleFiles.fresh(rawDirectory);
    if (!machine.withResetCaptureRecoveryFiles) throw fail();
    return machine.withResetCaptureRecoveryFiles(
      {
        resetId: plan.resetId,
        accounts: plan.accounts,
        access: raw.access,
        lease: options.lease,
        signal: options.signal,
        directory: rawDirectory,
        passphrase,
      },
      async (captures) => {
        if (captures.inventory.sha256 !== raw.inventorySha256) throw fail();
        return assemble(captures);
      },
    );
  });
  // Uncertain or failed preparation deliberately retains its owned workspace and durable key.
  // Only the fully verified path removes redundant encrypted staging copies.
  await guard();
  await sealedBundleFiles.cleanup(work, owned);
  await guard();
  return result;
}
