import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultTimeMachinePreferences } from '@runtipi/common/schemas/time-machine';
import { withBackupMaintenanceLease } from '../../common/backup-maintenance-lease';
import { archiveBackedResetJournal, resetTargetNames, type ResetJournal } from '../system-reset/reset-contract';
import { ResetState } from '../system-reset/reset-state';
import { backupMetadataBytes, decryptBackup } from './backup-crypto';
import { exportSettingsBundle, sealedBundleFiles } from './settings-backup-format';
import { writeSettingsJsonPart } from './settings-backup-json-parts';
import { writeSettingsAssetPart, readSettingsAssetPart } from './settings-backup-assets';
import type { SettingsBundlePart } from './settings-backup-review';
import { emptyThemeSettings } from '../theme-settings/theme-settings.store';
import { exportResetSafetyArchive, inspectResetSafetyArchive } from './reset-safety-archive';
import { ResetBackupKeyCustody } from './reset-backup-key-custody';
import { commitResetSafetyArchive, resetSafetyArchivePath, verifyResetSafetyArchiveCommitment } from './reset-safety-commitment';
import { encodeResetSafetyState, type ResetSafetyState } from './reset-safety-state';
import { planResetSafetyExports } from './reset-safety-plan';
import {
  verifyResetExportProof,
  withResetExportAccess,
  withResetInventoryAccess,
  withResetExportAccessFromInventory,
  resetExportPlanSha256,
  type SettingsExportAccess,
  type ResetExportPlan,
  type ResetInventoryAccess,
} from './settings-export-authorization';
import { stabilizeDarwinFixtureCreation, stabilizeExistingDarwinFixtures } from './darwin-files.fixture';
import { modelLinuxProcFiles } from './linux-proc-model.fixture';
import { TimeMachineService } from './time-machine.service';
import { TimeMachineStore } from './time-machine-store';
import { TimeMachineComponentsStore } from './time-machine-components-store';
import type { ResetCaptureRecoveryFiles } from './reset-capture-recovery-files';
import {
  resetSafetyFullScopeSha256,
  resetSafetyIndexSha256,
  validateResetSafetyIndex,
  validateResetSafetyManifest,
} from './reset-safety-archive-contract';

let root: string;
let restore: () => void;
const passphrase = 'synthetic archive secret phrase';
const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
beforeEach(async () => {
  if (!process.env.TMPDIR) throw new Error('Project-scoped TMPDIR required');
  root = await fs.realpath(await fs.mkdtemp(path.join(process.env.TMPDIR, 'reset-archive-')));
  restore = stabilizeDarwinFixtureCreation(() => root);
});
afterEach(async () => {
  vi.restoreAllMocks();
  restore();
  await fs.rm(root, { recursive: true, force: true });
});
const optionsForState = (plan: ResetExportPlan): ResetSafetyState => ({
  format: 'orbis-reset-state',
  version: 1,
  resetId: plan.resetId,
  accounts: plan.accounts,
  selectionSha256: resetExportPlanSha256(plan),
  users: [{ id: 1, username: 'synthetic', operator: true, locale: 'en', hasSeenWelcome: true, createdAt: 1, updatedAt: 1 }],
  links: [],
  credentials:
    plan.accounts === 'keep'
      ? null
      : {
          version: 1,
          users: [
            {
              userId: 1,
              password: {
                format: 'argon2-phc',
                encoded: '$argon2id$v=19$m=65536,t=3,p=4$YWJjZGVmZ2hpamtsbW5vcA$YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo',
              },
              totp: { enabled: true, secret: 'ABCDEFGHIJKLMNOP' },
            },
          ],
          passkeys: { policy: 'reenroll', state: { version: 1, users: {} } },
        },
  preferences: {
    server: {
      advancedSettings: false,
      allowAutoThemes: true,
      allowErrorMonitoring: false,
      guestDashboard: false,
      themeBase: 'light',
      themeColor: 'blue',
    },
    automatic: {
      settings: { orbis: { enabled: false, mode: 'idle' }, schedule: { time: '03:00', timezone: 'UTC' } },
      systemEnabled: false,
      policy: null,
    },
    timeMachine: defaultTimeMachinePreferences(),
  },
  evidence: {
    automatic: {
      state: {
        version: 1,
        revision: 0,
        settings: { orbis: { enabled: false, mode: 'idle' }, schedule: { time: '03:00', timezone: 'UTC' } },
        rules: {},
        apps: {},
        orbis: null,
        pauseReason: null,
      },
      system: {
        version: 1,
        revision: 0,
        enabled: false,
        phase: null,
        settingsRevision: null,
        policyRevision: null,
        attempt: null,
        pauseReason: null,
      },
    },
    cluster: { hostId: randomUUID(), invite: null, sync: null },
  },
});

async function scope<T>(
  work: (
    access: SettingsExportAccess,
    plan: ResetExportPlan,
    lease: Parameters<typeof exportResetSafetyArchive>[0]['lease'],
    signal: AbortSignal,
  ) => Promise<T>,
  accounts: 'keep' | 'remove' = 'keep',
) {
  const plan = planResetSafetyExports({ resetId: randomUUID(), accounts, users: [1], captures: [] }).plan;
  const auth = {
    operatorActionContext: async () => ({ userId: 1, sessionBinding: 'synthetic-session', securityBinding: 'synthetic-security' }),
    verifySensitiveAction: async () => {},
  };
  const proof = await verifyResetExportProof(auth as never, {} as never, {} as never, accounts, { method: 'password', password: 'synthetic-proof' });
  const signal = new AbortController().signal;
  return withBackupMaintenanceLease(signal, (lease) =>
    withResetExportAccess(proof, plan, lease, signal, (access) => work(access, plan, lease, signal)),
  );
}

async function fixture(
  access: SettingsExportAccess,
  plan: ResetExportPlan,
  lease: Parameters<typeof exportResetSafetyArchive>[0]['lease'],
  signal: AbortSignal,
  secret = passphrase,
) {
  const state = await encodeResetSafetyState({ value: optionsForState(plan), plan, access, lease, signal, passphrase: secret });
  const journal: ResetJournal = {
    version: 1,
    id: plan.resetId,
    accounts: plan.accounts,
    controller: 'synthetic',
    users: [1],
    phase: 'prepared',
    createdAt: 1,
  };
  const targets: Parameters<typeof exportResetSafetyArchive>[0]['targets']['targets'][number][] = [];
  for (const name of resetTargetNames(journal)) {
    if (name === 'desktop/1.json' || name === 'wallpapers/1.image.saved') {
      const plain = name.startsWith('desktop') ? Buffer.from('{"synthetic":true}') : Buffer.alloc(0);
      const cipher = await backupMetadataBytes(plain, secret, false);
      const file = path.join(root, `target-${randomUUID()}`);
      await fs.writeFile(file, cipher, { mode: 0o600 });
      targets.push({
        name,
        type: 'file',
        file,
        bytes: cipher.length,
        sha256: sha(cipher),
        plaintextBytes: plain.length,
        plaintextSha256: sha(plain),
      });
    } else targets.push({ name, type: 'absent' });
  }
  targets.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const projected = targets.map((target) =>
    target.type === 'file'
      ? { name: target.name, type: target.type, plaintextBytes: target.plaintextBytes, plaintextSha256: target.plaintextSha256 }
      : { name: target.name, type: target.type },
  );
  const inventorySha256 = createHash('sha256').update('orbis-reset-safety-targets-v1\n').update(JSON.stringify(projected)).digest('hex');
  const parts: Parameters<typeof exportSettingsBundle>[0]['parts'] = [];
  for (const kind of ['settings', 'dashboard'] as const)
    parts.push(
      await writeSettingsJsonPart({
        kind,
        value: { version: 1, desktop: {}, ...(kind === 'settings' ? { server: {} } : {}) },
        destination: path.join(root, kind),
        passphrase: secret,
        signal,
      }),
    );
  for (const kind of ['wallpapers', 'themes'] as const) {
    parts.push(
      await writeSettingsAssetPart({
        kind,
        desktop: {},
        assets: [],
        ...(kind === 'themes' ? { state: { formatVersion: 1, installed: [], selected: null }, themeSettings: emptyThemeSettings() } : {}),
        destination: path.join(root, kind),
        passphrase: secret,
        signal,
      }),
    );
  }
  stabilizeExistingDarwinFixtures(root);
  const profileFile = path.join(root, 'profile');
  const bundleId = randomUUID();
  const profile = await exportSettingsBundle({
    id: bundleId,
    destination: profileFile,
    directory: path.join(root, 'profile-work'),
    createdAt: new Date().toISOString(),
    orbisVersion: '0.8.0-beta.1',
    parts,
    passphrase: secret,
    signal,
  });
  const binding = plan.exports[0];
  if (!binding) throw new Error('Missing synthetic binding');
  const inspectors = (directory: string) => {
    const inspectAsset = async (part: SettingsBundlePart, signal: AbortSignal) => {
      if (part.kind !== 'wallpapers' && part.kind !== 'themes') throw new Error('Unexpected fixture kind');
      const value = await readSettingsAssetPart({ ...part, kind: part.kind, passphrase: secret, directory, signal });
      return { items: value.assets.length };
    };
    return { wallpapers: inspectAsset, themes: inspectAsset };
  };
  return {
    backupId: randomUUID(),
    createdAt: new Date().toISOString(),
    orbisVersion: '0.8.0-beta.1',
    plan,
    state,
    access,
    lease,
    signal,
    passphrase: secret,
    targets: {
      version: 1 as const,
      resetId: plan.resetId,
      accounts: plan.accounts,
      users: [1],
      selectionSha256: resetExportPlanSha256(plan),
      inventorySha256,
      targets,
    },
    profiles: [{ ...binding, bundleId, file: profileFile, bytes: profile.bytes, sha256: profile.sha256 }],
    directory: path.join(root, 'work'),
    destination: path.join(root, 'published', 'archive'),
    inspectors,
  };
}

async function rawScope<T>(
  work: (
    access: SettingsExportAccess,
    inventory: ResetInventoryAccess,
    plan: ResetExportPlan,
    lease: Parameters<typeof fixture>[2],
    signal: AbortSignal,
  ) => Promise<T>,
  accounts: 'keep' | 'remove' = 'keep',
) {
  const plan = planResetSafetyExports({ resetId: randomUUID(), accounts, users: [1], captures: [] }).plan;
  const auth = {
    operatorActionContext: async () => ({ userId: 1, sessionBinding: 'synthetic-session', securityBinding: 'synthetic-security' }),
    verifySensitiveAction: async () => {},
  };
  const proof = await verifyResetExportProof(auth as never, {} as never, {} as never, accounts, { method: 'password', password: 'synthetic-proof' });
  const signal = new AbortController().signal;
  return withBackupMaintenanceLease(signal, (lease) =>
    withResetInventoryAccess(
      proof,
      {
        resetId: plan.resetId,
        accounts,
        lease,
        signal,
      },
      (inventory) => withResetExportAccessFromInventory(inventory, plan, (access) => work(access, inventory, plan, lease, signal)),
    ),
  );
}

async function withRawCapture<T>(
  options: { plan: ResetExportPlan; access: ResetInventoryAccess; lease: Parameters<typeof fixture>[2]; signal: AbortSignal; secret: string },
  work: (snapshot: ResetCaptureRecoveryFiles, originalKey: Buffer) => Promise<T>,
) {
  const dataDir = path.join(root, 'raw-source');
  const directory = path.join(root, 'raw-encrypted');
  await fs.mkdir(dataDir, { mode: 0o700 });
  await fs.mkdir(directory, { mode: 0o700 });
  const auth = {
    operatorActionContext: async () => ({ userId: 1, sessionBinding: 'synthetic-session', securityBinding: 'synthetic-security' }),
    verifySensitiveAction: async () => {},
  };
  const machine = new TimeMachineService(
    { get: (key: string) => (key === 'directories' ? { dataDir } : false) } as never,
    {} as never,
    auth as never,
    { warn: () => {} } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { recoverCaptureFences: async () => {} } as never,
  );
  await machine.onModuleInit();
  const store = new TimeMachineStore(dataDir);
  const { point } = await store.create(19, 1);
  await store.fail(point, 'capture-failed');
  const components = new TimeMachineComponentsStore(dataDir);
  const selected = await components.create(23, point.id, point.id, 'a'.repeat(64), {
    version: 1,
    reviewId: randomUUID(),
    reviewSha256: 'b'.repeat(64),
    apps: [{ urn: 'fixture:store', mountIds: ['c'.repeat(64)] }],
  });
  await components.interrupted(selected);
  await fs.writeFile(path.join(dataDir, 'backups/time-machine/points', point.id, 'archive.partial'), Buffer.alloc(2 * 1024 ** 2 + 17, 0x71), {
    mode: 0o600,
  });
  stabilizeExistingDarwinFixtures(dataDir);
  const originalKey = await fs.readFile(path.join(dataDir, 'backups/time-machine/keys/master-v1.key'));
  const restorePlatform = modelLinuxProcFiles(new Map());
  try {
    return await machine.withResetCaptureRecoveryFiles(
      {
        resetId: options.plan.resetId,
        accounts: options.plan.accounts,
        access: options.access,
        lease: options.lease,
        signal: options.signal,
        directory,
        passphrase: options.secret,
      },
      (snapshot) => work(snapshot, originalKey),
    );
  } finally {
    await machine.onModuleDestroy();
    restorePlatform();
  }
}

it.each(['keep', 'remove'] as const)(
  'version2 preserves raw orphan/equal-ID namespaces and the original key with bounded readback for %s accounts',
  async (accounts) => {
    await rawScope(async (access, inventory, plan, lease, signal) => {
      const f = await fixture(access, plan, lease, signal);
      return withRawCapture({ plan, access: inventory, lease, signal, secret: passphrase }, async (captures, originalKey) => {
        const exported = await exportResetSafetyArchive({ ...f, captures });
        const scratch = path.join(root, 'inspect-v2');
        const chunks = captures.entries.flatMap((item) => (item.type === 'file' ? item.chunks : []));
        const largest = Math.max(...chunks.map((chunk) => chunk.bytes));
        expect(chunks.reduce((sum, chunk) => sum + chunk.bytes, 0)).toBeGreaterThan(largest);
        const originalCapacity = sealedBundleFiles.capacity;
        const requested: number[] = [];
        vi.spyOn(sealedBundleFiles, 'capacity').mockImplementation(async (directory, bytes) => {
          if (directory === scratch) {
            requested.push(bytes);
            if (bytes > largest) throw new Error('Synthetic one-chunk full-archive scratch capacity');
          }
          await originalCapacity(directory, bytes);
        });
        const staged: string[] = [];
        const keyCipher = path.join(root, 'retained-key.orbis');
        const opened = await inspectResetSafetyArchive({
          source: f.destination,
          directory: scratch,
          passphrase,
          signal,
          inspectors: f.inspectors,
          expected: { ...exported, plan },
          stageVerifiedPart: async (artifact, file) => {
            staged.push(artifact.role);
            if (artifact.role === 'capture') {
              expect((await fs.readdir(path.dirname(file))).filter((name) => name.startsWith('member-'))).toHaveLength(1);
              if (artifact.name === 'keys/master-v1.key') await fs.copyFile(file, keyCipher);
            }
          },
        });
        expect(opened.manifest.version).toBe(2);
        expect(opened.manifest.captures?.inventory.captures.map((record) => [record.kind, record.sourceOwnerId])).toEqual([
          ['components', 23],
          ['core', 19],
        ]);
        expect(opened.manifest.captures?.accounts).toBe(accounts);
        expect(opened.manifest.plan.exports.every((item) => item.selection.timeMachine.length === 0)).toBe(true);
        expect(staged.filter((role) => role === 'capture')).toHaveLength(chunks.length);
        expect(requested.length).toBe(chunks.length + 4);
        const recovered = path.join(root, 'recovered-original-key');
        await decryptBackup({ source: keyCipher, destination: recovered, passphrase, signal });
        expect(await fs.readFile(recovered)).toEqual(originalKey);
        expect(await fs.readdir(path.join(root, 'raw-encrypted'))).toHaveLength(chunks.length);
        await expect(fs.lstat(scratch)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(sha(await fs.readFile(f.destination))).toBe(exported.sha256);

        let indexData = Buffer.alloc(0);
        let indexEntry = false;
        await sealedBundleFiles.readTar(f.destination, signal, exported.bytes, {
          strict: true,
          collectEntries: false,
          onEntry: async (entry) => {
            indexEntry = entry.path === 'bundle.json';
          },
          onData: async (data) => {
            if (indexEntry) indexData = Buffer.concat([indexData, data]);
          },
        });
        const index = validateResetSafetyIndex(JSON.parse(indexData.toString('utf8')));
        const missing = structuredClone(index);
        missing.parts.pop();
        const missingIndex = validateResetSafetyIndex(missing);
        expect(() => validateResetSafetyManifest({ ...opened.manifest, indexSha256: resetSafetyIndexSha256(missingIndex) }, missingIndex)).toThrow();
        const downgraded = validateResetSafetyIndex({ ...index, version: 1 });
        const downgradeManifest = { ...opened.manifest, version: 1 as const, indexSha256: resetSafetyIndexSha256(downgraded) };
        expect(() =>
          validateResetSafetyManifest({ ...downgradeManifest, fullScopeSha256: resetSafetyFullScopeSha256(downgradeManifest) }, downgraded),
        ).toThrow();
        expect(() => validateResetSafetyManifest({ ...opened.manifest, captures: undefined }, index)).toThrow();
        const reordered = structuredClone(index);
        const firstRaw = reordered.parts.length - chunks.length;
        const rawA = reordered.parts[firstRaw];
        const rawB = reordered.parts[firstRaw + 1];
        if (!rawA || !rawB) throw new Error('Missing two raw index fixtures');
        [reordered.parts[firstRaw], reordered.parts[firstRaw + 1]] = [rawB, rawA];
        const reorderedIndex = validateResetSafetyIndex(reordered);
        expect(() =>
          validateResetSafetyManifest({ ...opened.manifest, indexSha256: resetSafetyIndexSha256(reorderedIndex) }, reorderedIndex),
        ).toThrow();
      });
    }, accounts);
  },
  30_000,
);

it.each(['keep', 'remove'] as const)(
  'version2 durable commitment reopens raw captures and its sealed key for %s accounts',
  async (accounts) => {
    await rawScope(async (access, inventory, plan, lease, signal) => {
      const backupId = randomUUID();
      const binding = { resetId: plan.resetId, backupId, selectionSha256: resetExportPlanSha256(plan), users: [...plan.users] };
      const custody = new ResetBackupKeyCustody(root);
      await custody.reserve(binding);
      await custody.withReserved(binding, async (secret) => {
        const f = await fixture(access, plan, lease, signal, secret);
        return withRawCapture({ plan, access: inventory, lease, signal, secret }, async (captures) => {
          const destination = resetSafetyArchivePath(root, backupId);
          const store = path.dirname(path.dirname(destination));
          await fs.mkdir(store, { mode: 0o700 });
          const exported = await exportResetSafetyArchive({ ...f, backupId, captures, destination, directory: path.join(store, 'v2-build') });
          const options = { dataDir: root, backupId, plan, access, lease, signal, inspectors: f.inspectors };
          const committed = await commitResetSafetyArchive(options);
          expect(committed.fullScopeSha256).toBe(exported.fullScopeSha256);
          expect(committed.accounts).toBe(accounts);
          expect(committed.sha256).toBe(sha(await fs.readFile(destination)));
          expect(JSON.stringify(committed)).not.toContain(secret);
          expect(committed).not.toHaveProperty('captures');
          const journal = archiveBackedResetJournal(
            { version: 1, id: plan.resetId, controller: 'synthetic', accounts, users: plan.users, phase: 'prepared', createdAt: 1 },
            committed,
          );
          const storage = { readMounts: async () => `36 35 98:0 /application-data ${root} rw - ext4 /dev/sda1 rw\n` };
          await new ResetState(root, storage).save(journal);
          const recovered = await new ResetState(root, storage).read();
          if (recovered?.version !== 2) throw new Error('Missing archive-backed journal');
          expect(recovered.safety).toEqual(committed);
          await expect(verifyResetSafetyArchiveCommitment({ ...options, commitment: recovered.safety })).resolves.toEqual(committed);
          const reopened = await inspectResetSafetyArchive({
            source: destination,
            directory: path.join(root, 'reopen-v2'),
            passphrase: secret,
            signal,
            inspectors: f.inspectors,
            expected: { ...committed, plan },
          });
          expect(reopened.manifest.version).toBe(2);
          expect(reopened.manifest.captures?.filesSha256).toBe(captures.filesSha256);
        });
      });
    }, accounts);
  },
  30_000,
);

it('version2 retains failed encrypted members and unknown scratch evidence without changing the complete archive', async () => {
  await rawScope(async (access, inventory, plan, lease, signal) => {
    const f = await fixture(access, plan, lease, signal);
    return withRawCapture({ plan, access: inventory, lease, signal, secret: passphrase }, async (captures) => {
      const exported = await exportResetSafetyArchive({ ...f, captures });
      const chunks = captures.entries.flatMap((item) => (item.type === 'file' ? item.chunks : []));
      const first = chunks[0];
      if (!first) throw new Error('Missing raw corruption fixture');
      const memberName = `parts/${path.basename(first.file)}`;
      const data = await fs.readFile(f.destination);
      let at = 0;
      let found = false;
      while (at + 512 <= data.length) {
        const name = data
          .subarray(at, at + 100)
          .toString('utf8')
          .replace(/\0.*$/s, '');
        const size = Number.parseInt(
          data
            .subarray(at + 124, at + 136)
            .toString('ascii')
            .replace(/\0/g, ''),
          8,
        );
        if (name === memberName) {
          data[at + 512 + 36] = (data[at + 512 + 36] ?? 0) ^ 1;
          found = true;
          break;
        }
        if (!Number.isFinite(size)) break;
        at += 512 + Math.ceil(size / 512) * 512;
      }
      expect(found).toBe(true);
      const damaged = path.join(root, 'damaged-v2');
      const failed = path.join(root, 'failed-v2-readback');
      await fs.writeFile(damaged, data, { mode: 0o600 });
      await expect(inspectResetSafetyArchive({ source: damaged, directory: failed, passphrase, signal, inspectors: f.inspectors })).rejects.toThrow();
      expect((await fs.readdir(failed)).some((name) => name.startsWith('member-'))).toBe(true);
      expect(await fs.readFile(damaged)).toEqual(data);
      const unknown = path.join(root, 'unknown-v2-readback');
      let injected = false;
      await expect(
        inspectResetSafetyArchive({
          source: f.destination,
          directory: unknown,
          passphrase,
          signal,
          inspectors: f.inspectors,
          stageVerifiedPart: async (artifact, file) => {
            if (!injected && artifact.role === 'capture') {
              await fs.writeFile(path.join(path.dirname(file), 'unrelated-evidence'), 'keep this evidence', { mode: 0o600, flag: 'wx' });
              injected = true;
            }
          },
        }),
      ).rejects.toThrow();
      expect(injected).toBe(true);
      expect(await fs.readFile(path.join(unknown, 'unrelated-evidence'), 'utf8')).toBe('keep this evidence');
      expect(sha(await fs.readFile(f.destination))).toBe(exported.sha256);
      expect(await fs.readdir(path.join(root, 'raw-encrypted'))).toHaveLength(chunks.length);
    });
  });
}, 30_000);

it('version2 index budgets do not increase the version1 member or manifest limits', () => {
  const parts = Array.from({ length: 16_098 }, () => ({ name: `parts/${randomUUID()}.orbis`, bytes: 52, sha256: 'a'.repeat(64) }));
  const base = { format: 'orbis-reset-safety-index', version: 1, backupId: randomUUID(), manifest: { bytes: 52, sha256: 'b'.repeat(64) }, parts };
  expect(() => validateResetSafetyIndex(base)).toThrow();
  expect(validateResetSafetyIndex({ ...base, version: 2 }).parts).toHaveLength(16_098);
  const largeManifest = { ...base, parts: [parts[0]], manifest: { ...base.manifest, bytes: 16 * 1024 ** 2 + 53 } };
  expect(() => validateResetSafetyIndex(largeManifest)).toThrow();
  expect(validateResetSafetyIndex({ ...largeManifest, version: 2 }).version).toBe(2);
  const tooMany = Array.from({ length: 32_098 }, () => ({ name: `parts/${randomUUID()}.orbis`, bytes: 52, sha256: 'a'.repeat(64) }));
  expect(() => validateResetSafetyIndex({ ...base, version: 2, parts: tooMany })).toThrow();
});

it('publishes one fully read-back archive with exact scope, empty targets and no intermediate payload copies', async () => {
  await scope(async (access, plan, lease, signal) => {
    const f = await fixture(access, plan, lease, signal);
    const progress: Parameters<NonNullable<Parameters<typeof exportResetSafetyArchive>[0]['progress']>>[0][] = [];
    const exported = await exportResetSafetyArchive({ ...f, progress: (value) => progress.push(value) });
    expect(progress.every((value) => value.totalBytes === null || value.completedBytes <= value.totalBytes)).toBe(true);
    expect(await fs.readdir(path.dirname(f.destination))).toEqual(['archive']);
    await expect(fs.lstat(f.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(sha(await fs.readFile(f.destination))).toBe(exported.sha256);
    const staged: string[] = [];
    const opened = await inspectResetSafetyArchive({
      source: f.destination,
      directory: path.join(root, 'inspect'),
      passphrase,
      signal,
      inspectors: f.inspectors,
      expected: { ...exported, plan },
      stageVerifiedPart: async (part) => {
        staged.push(part.role);
      },
    });
    expect(opened.state.users.map((user) => user.id)).toEqual([1]);
    expect(opened.manifest.fullScopeSha256).toBe(exported.fullScopeSha256);
    expect(staged).toEqual(['state', 'target', 'target', 'profile']);
    await expect(fs.lstat(path.join(root, 'inspect'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
}, 20_000);

it('refuses incomplete scope, wrong profile selection and missing deep inspectors before publication', async () => {
  await scope(async (access, plan, lease, signal) => {
    const f = await fixture(access, plan, lease, signal);
    await expect(exportResetSafetyArchive({ ...f, targets: { ...f.targets, targets: f.targets.targets.slice(1) } })).rejects.toThrow();
    await expect(fs.lstat(path.dirname(f.destination))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      exportResetSafetyArchive({ ...f, profiles: f.profiles.map((profile) => ({ ...profile, selection: { ...profile.selection, themes: false } })) }),
    ).rejects.toThrow();
    await expect(exportResetSafetyArchive({ ...f, inspectors: () => ({}) })).rejects.toThrow();
    await expect(fs.lstat(path.dirname(f.destination))).rejects.toMatchObject({ code: 'ENOENT' });
  });
}, 20_000);

it('rejects corruption, wrong passphrases and callback mutation without applying or retaining staging', async () => {
  await scope(async (access, plan, lease, signal) => {
    const f = await fixture(access, plan, lease, signal);
    await exportResetSafetyArchive(f);
    const options = { source: f.destination, directory: path.join(root, 'inspect'), signal, passphrase, inspectors: f.inspectors };
    await expect(inspectResetSafetyArchive({ ...options, passphrase: 'incorrect synthetic key' })).rejects.toThrow();
    await expect(
      inspectResetSafetyArchive({
        ...options,
        stageVerifiedPart: async (part, file) => {
          if (part.role === 'target') await fs.writeFile(file, 'unrelated mutation', { mode: 0o600 });
        },
      }),
    ).rejects.toThrow();
    const target = f.targets.targets.find((entry) => entry.type === 'file' && entry.plaintextBytes > 0);
    if (target?.type !== 'file') throw new Error('Missing encrypted fixture');
    const bytes = await fs.readFile(f.destination);
    const at = bytes.indexOf(await fs.readFile(target.file));
    expect(at).toBeGreaterThan(0);
    bytes[at] = (bytes[at] ?? 0) ^ 1;
    const corrupt = path.join(root, 'corrupt');
    await fs.writeFile(corrupt, bytes, { mode: 0o600 });
    await expect(inspectResetSafetyArchive({ ...options, source: corrupt })).rejects.toThrow();
    await expect(fs.lstat(options.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
}, 20_000);

it('preserves existing publication directories and rejects mismatched root authority', async () => {
  await scope(async (access, plan, lease, signal) => {
    const f = await fixture(access, plan, lease, signal);
    await expect(exportResetSafetyArchive({ ...f, access: { ...access } })).rejects.toThrow();
    await fs.mkdir(path.dirname(f.destination), { mode: 0o700 });
    await fs.writeFile(path.join(path.dirname(f.destination), 'keep'), 'preserve');
    await expect(exportResetSafetyArchive(f)).rejects.toThrow();
    expect(await fs.readFile(path.join(path.dirname(f.destination), 'keep'), 'utf8')).toBe('preserve');
  });
}, 20_000);

async function committableFixture(
  access: SettingsExportAccess,
  plan: ResetExportPlan,
  lease: Parameters<typeof exportResetSafetyArchive>[0]['lease'],
  signal: AbortSignal,
) {
  const backupId = randomUUID();
  const binding = { resetId: plan.resetId, backupId, selectionSha256: resetExportPlanSha256(plan), users: [...plan.users].sort((a, b) => a - b) };
  const custody = new ResetBackupKeyCustody(root);
  await custody.reserve(binding);
  const f = await custody.withReserved(binding, (secret) => fixture(access, plan, lease, signal, secret));
  const destination = resetSafetyArchivePath(root, backupId);
  const store = path.dirname(path.dirname(destination));
  await fs.mkdir(store, { mode: 0o700 });
  const exported = await exportResetSafetyArchive({
    ...f,
    backupId,
    destination,
    directory: path.join(store, `build-${randomUUID()}`),
  });
  return {
    options: { dataDir: root, backupId, plan, access, lease, signal, inspectors: f.inspectors },
    destination,
    store,
    binding,
    custody,
    exported,
    fixture: f,
    sealed: path.join(root, 'backups', 'reset-keys', backupId, 'sealed'),
  };
}

it('durable reset commitment reopens the actual archive and sealed key after a storage restart', async () => {
  await scope(async (access, plan, lease, signal) => {
    const f = await committableFixture(access, plan, lease, signal);
    const committed = await commitResetSafetyArchive(f.options);
    expect(committed).toMatchObject({
      ...f.exported,
      format: 'orbis-reset-safety-commitment',
      version: 1,
      resetId: plan.resetId,
      accounts: 'keep',
      users: [1],
    });
    expect(Object.isFrozen(committed)).toBe(true);
    expect(Object.isFrozen(committed.users)).toBe(true);
    expect(JSON.stringify(committed)).not.toContain(f.fixture.passphrase);
    expect(committed).not.toHaveProperty('state');
    expect(committed).not.toHaveProperty('credentials');
    const reopened = await verifyResetSafetyArchiveCommitment({ ...f.options, commitment: JSON.parse(JSON.stringify(committed)) });
    expect(reopened).toEqual(committed);
    expect(await commitResetSafetyArchive(f.options)).toEqual(committed);
    await new ResetBackupKeyCustody(root).withSealed(f.binding, { archiveBytes: committed.bytes, archiveSha256: committed.sha256 }, async (secret) =>
      expect(secret).toBe(f.fixture.passphrase),
    );
    expect(await fs.readdir(f.store)).toEqual([f.options.backupId]);
    expect(sha(await fs.readFile(f.destination))).toBe(f.exported.sha256);
  });
}, 20_000);

it('durable reset commitment never creates a replacement key when custody is missing', async () => {
  await scope(async (access, plan, lease, signal) => {
    const f = await committableFixture(access, plan, lease, signal);
    const key = path.join(root, 'backups', 'reset-keys', 'key');
    const before = await fs.readFile(f.destination);
    await fs.rename(key, `${key}.retained`);
    await expect(commitResetSafetyArchive(f.options)).rejects.toThrow();
    await expect(fs.lstat(key)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(f.sealed)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(f.destination)).toEqual(before);
  });
}, 20_000);

it('durable reset commitment preserves account-removing credentials without returning them in the receipt', async () => {
  await scope(async (access, plan, lease, signal) => {
    const f = await committableFixture(access, plan, lease, signal);
    const committed = await commitResetSafetyArchive(f.options);
    expect(committed.accounts).toBe('remove');
    expect(committed.users).toEqual([1]);
    expect(JSON.stringify(committed)).not.toContain('ABCDEFGHIJKLMNOP');
    expect(JSON.stringify(committed)).not.toContain('$argon2');
    expect(committed).not.toHaveProperty('credentials');
    await expect(verifyResetSafetyArchiveCommitment({ ...f.options, commitment: committed })).resolves.toEqual(committed);
  }, 'remove');
}, 20_000);

it('durable reset commitment pins admitted plan and persisted receipt values across asynchronous inspection', async () => {
  await scope(async (access, plan, lease, signal) => {
    const f = await committableFixture(access, plan, lease, signal);
    const mutablePlan = structuredClone(plan);
    const committed = await commitResetSafetyArchive({
      ...f.options,
      plan: mutablePlan,
      inspectors: (directory) => {
        mutablePlan.accounts = 'remove';
        return f.fixture.inspectors(directory);
      },
    });
    expect(committed.accounts).toBe('keep');
    expect(mutablePlan.accounts).toBe('remove');
    const expected = structuredClone(committed);
    const reopened = await verifyResetSafetyArchiveCommitment({
      ...f.options,
      commitment: expected,
      inspectors: (directory) => {
        Object.assign(expected, { targetInventorySha256: '0'.repeat(64) });
        return f.fixture.inspectors(directory);
      },
    });
    expect(reopened).toEqual(committed);
    expect(expected.targetInventorySha256).toBe('0'.repeat(64));
  });
}, 20_000);

it('durable reset commitment refuses corrupt ciphertext and unavailable deep inspection without sealing', async () => {
  await scope(async (access, plan, lease, signal) => {
    const f = await committableFixture(access, plan, lease, signal);
    await expect(commitResetSafetyArchive({ ...f.options, inspectors: () => ({}) })).rejects.toThrow();
    await expect(fs.lstat(f.sealed)).rejects.toMatchObject({ code: 'ENOENT' });
    const changed = await fs.readFile(f.destination);
    changed[0] = (changed[0] ?? 0) ^ 1;
    await fs.writeFile(f.destination, changed);
    await expect(commitResetSafetyArchive(f.options)).rejects.toThrow();
    await expect(fs.lstat(f.sealed)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(f.destination)).toEqual(changed);
    expect(await fs.readdir(f.store)).toEqual([f.options.backupId]);
  });
}, 20_000);

it('durable reset commitment refuses forged scope, cancelled work and a released maintenance lease', async () => {
  const f = await scope(async (access, plan, lease, signal) => {
    const f = await committableFixture(access, plan, lease, signal);
    await expect(commitResetSafetyArchive({ ...f.options, access: { ...access } })).rejects.toThrow();
    await expect(commitResetSafetyArchive({ ...f.options, plan: { ...plan, accounts: 'remove' } })).rejects.toThrow();
    const stopped = new AbortController();
    stopped.abort();
    await expect(commitResetSafetyArchive({ ...f.options, signal: stopped.signal })).rejects.toThrow();
    return f;
  });
  await expect(commitResetSafetyArchive(f.options)).rejects.toThrow();
  await expect(fs.lstat(f.sealed)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(sha(await fs.readFile(f.destination))).toBe(f.exported.sha256);
}, 20_000);

it('durable reset commitment preserves the archive when key publication fails', async () => {
  await scope(async (access, plan, lease, signal) => {
    const f = await committableFixture(access, plan, lease, signal);
    vi.spyOn(ResetBackupKeyCustody.prototype, 'seal').mockRejectedValue(new Error('synthetic key-store interruption'));
    await expect(commitResetSafetyArchive(f.options)).rejects.toThrow('synthetic key-store interruption');
    await expect(fs.lstat(f.sealed)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(sha(await fs.readFile(f.destination))).toBe(f.exported.sha256);
    expect(await fs.readdir(f.store)).toEqual([f.options.backupId]);
  });
}, 20_000);

it('durable reset commitment never seals a key after an archive durability failure', async () => {
  await scope(async (access, plan, lease, signal) => {
    const f = await committableFixture(access, plan, lease, signal);
    const original = fs.open;
    const sealed = vi.spyOn(ResetBackupKeyCustody.prototype, 'seal');
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await original(...args);
      if (args[0] === f.destination) vi.spyOn(handle, 'sync').mockRejectedValue(new Error('synthetic durability failure'));
      return handle;
    });
    await expect(commitResetSafetyArchive(f.options)).rejects.toThrow('synthetic durability failure');
    expect(sealed).not.toHaveBeenCalled();
    await expect(fs.lstat(f.sealed)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(sha(await fs.readFile(f.destination))).toBe(f.exported.sha256);
    expect(await fs.readdir(f.store)).toEqual([f.options.backupId]);
  });
}, 20_000);

it('durable reset commitment retains sealed recovery evidence if the published path changes after key sealing', async () => {
  await scope(async (access, plan, lease, signal) => {
    const f = await committableFixture(access, plan, lease, signal);
    const original = ResetBackupKeyCustody.prototype.seal;
    const retained = path.join(path.dirname(f.destination), 'retained-archive.orbis');
    vi.spyOn(ResetBackupKeyCustody.prototype, 'seal').mockImplementation(async function (this: ResetBackupKeyCustody, binding, commitment) {
      await original.call(this, binding, commitment);
      await fs.rename(f.destination, retained);
      await fs.copyFile(retained, f.destination);
      await fs.chmod(f.destination, 0o600);
    });
    await expect(commitResetSafetyArchive(f.options)).rejects.toThrow();
    expect(sha(await fs.readFile(retained))).toBe(f.exported.sha256);
    expect(sha(await fs.readFile(f.destination))).toBe(f.exported.sha256);
    await f.custody.withSealed(f.binding, { archiveBytes: f.exported.bytes, archiveSha256: f.exported.sha256 }, async (secret) =>
      expect(secret).toBe(f.fixture.passphrase),
    );
  });
}, 20_000);

it('durable reset commitment rejects altered persisted scope and archive identity on verification', async () => {
  await scope(async (access, plan, lease, signal) => {
    const f = await committableFixture(access, plan, lease, signal);
    const committed = await commitResetSafetyArchive(f.options);
    for (const changed of [
      { ...committed, fullScopeSha256: '0'.repeat(64) },
      { ...committed, targetInventorySha256: '0'.repeat(64) },
      { ...committed, users: [2] },
      { ...committed, bytes: committed.bytes + 1 },
      { ...committed, unexpected: true },
    ])
      await expect(verifyResetSafetyArchiveCommitment({ ...f.options, commitment: changed })).rejects.toThrow();
    expect(sha(await fs.readFile(f.destination))).toBe(committed.sha256);
    expect(await fs.readdir(f.store)).toEqual([f.options.backupId]);
  });
}, 20_000);

it('durable reset commitment rejects linked archives, permissive storage and aliased parents', async () => {
  await scope(async (access, plan, lease, signal) => {
    const f = await committableFixture(access, plan, lease, signal);
    const link = path.join(root, 'archive-link');
    await fs.link(f.destination, link);
    await expect(commitResetSafetyArchive(f.options)).rejects.toThrow();
    await fs.unlink(link);
    await fs.chmod(f.destination, 0o644);
    await expect(commitResetSafetyArchive(f.options)).rejects.toThrow();
    await fs.chmod(f.destination, 0o600);
    const directory = path.dirname(f.destination);
    await fs.chmod(directory, 0o755);
    await expect(commitResetSafetyArchive(f.options)).rejects.toThrow();
    await fs.chmod(directory, 0o700);
    const moved = `${directory}-retained`;
    await fs.rename(directory, moved);
    await fs.symlink(moved, directory);
    await expect(commitResetSafetyArchive(f.options)).rejects.toThrow();
    await expect(fs.lstat(f.sealed)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(sha(await fs.readFile(path.join(moved, 'archive.orbis')))).toBe(f.exported.sha256);
  });
}, 20_000);
