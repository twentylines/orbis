import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Request } from 'express';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultSettingsBackupSelection } from '@runtipi/common/schemas/settings-backup';
import {
  backupMaintenanceActive,
  setBackupRecoveryRequired,
  setResetRecoveryRequired,
  setRestoreRecoveryRequired,
} from '@/common/backup-maintenance';
import { withBackupMaintenanceLease } from '@/common/backup-maintenance-lease';
import { DesktopPreferencesService, DEFAULT_DESKTOP_PREFERENCES } from '../desktop-preferences/desktop-preferences.service';
import { DesktopWallpaperService } from '../desktop-preferences/desktop-wallpaper.service';
import { ThemePacksService } from '../theme-packs/theme-packs.service';
import { ThemeSettingsService } from '../theme-settings/theme-settings.service';
import { SettingsBackupSourceService } from './settings-backup-source.service';
import { ResetBackupKeyCustody } from './reset-backup-key-custody';
import { openSettingsBackupReview } from './settings-backup-review';
import {
  authorizeSettingsPasswordExport,
  withSettingsExportAccess,
  verifyResetExportProof,
  withResetExportAccess,
  resetExportPlanSha256,
  type ResetExportPlan,
  type SettingsExportAccess,
} from './settings-export-authorization';
import { stabilizeDarwinFixtureCreation } from './darwin-files.fixture';

let root: string;
let restore: () => void;
let desktop: DesktopPreferencesService;
let source: SettingsBackupSourceService;
let current = { userId: 7, sessionBinding: 'a'.repeat(64), securityBinding: 'b'.repeat(64) };
const auth = { operatorActionContext: vi.fn(), verifySensitiveAction: vi.fn() };
const passkeys = { verifySensitive: vi.fn() };
const request = {} as Request;
const machine = { withPortablePointForExport: vi.fn(), withComponentsPortablePointForExport: vi.fn() };
const signal = () => AbortSignal.timeout(15_000);
const binding = (ownerId: number) => ({ exportId: randomUUID(), ownerId, selection: defaultSettingsBackupSelection() });
const planFor = (exports: ResetExportPlan['exports']): ResetExportPlan => ({
  resetId: randomUUID(),
  accounts: 'remove',
  users: [...new Set(exports.map((value) => value.ownerId))].sort((a, b) => a - b),
  exports,
});
const options = (item: ResetExportPlan['exports'][number], destination = path.join(root, `${item.exportId}.orbis-settings`)) => ({
  ...item,
  passphrase: 'fixture archive secret',
  directory: root,
  destination,
  signal: signal(),
});

beforeEach(async () => {
  if (!process.env.TMPDIR) throw new Error('Project-scoped TMPDIR required');
  root = await fs.realpath(await fs.mkdtemp(path.join(process.env.TMPDIR, 'reset-export-')));
  restore = stabilizeDarwinFixtureCreation(() => root);
  vi.resetAllMocks();
  current = { userId: 7, sessionBinding: 'a'.repeat(64), securityBinding: 'b'.repeat(64) };
  auth.operatorActionContext.mockImplementation(async () => ({ ...current }));
  auth.verifySensitiveAction.mockResolvedValue({ operator: true });
  passkeys.verifySensitive.mockResolvedValue(undefined);
  setBackupRecoveryRequired(false);
  setResetRecoveryRequired(false);
  setRestoreRecoveryRequired(false);
  const config = {
    get: (key: string) => {
      if (key === 'directories') return { dataDir: root };
      if (key === 'userSettings') return { guestDashboard: false, timeZone: 'UTC' };
      if (key === 'version') return 'fixture-1';
      if (key === 'architecture') return 'amd64';
      throw new Error('Unexpected configuration');
    },
  } as never;
  desktop = new DesktopPreferencesService(config);
  const wallpaper = new DesktopWallpaperService(config, desktop);
  const packs = new ThemePacksService(config);
  source = new SettingsBackupSourceService(
    config,
    auth as never,
    desktop,
    wallpaper,
    packs,
    new ThemeSettingsService(config, packs, desktop),
    machine as never,
    {} as never,
  );
});
afterEach(async () => {
  expect(backupMaintenanceActive()).toBe(false);
  restore();
  await fs.rm(root, { recursive: true, force: true });
});

it('exports two real profiles under one passkey-approved lease and reopens their committed encrypted archives', async () => {
  for (const ownerId of [7, 8]) await desktop.write(ownerId, { ...DEFAULT_DESKTOP_PREFERENCES, serverName: `Saved profile ${ownerId}` });
  await fs.mkdir(path.join(root, 'app-data'), { mode: 0o700 });
  await fs.writeFile(path.join(root, 'app-data/media'), 'Docker media stays untouched', { mode: 0o600 });
  const plan = planFor([binding(7), binding(8)]);
  const proof = await verifyResetExportProof(auth as never, passkeys as never, request, plan.accounts, {
    method: 'passkey',
    challengeId: randomUUID(),
    response: {},
  });
  const custody = new ResetBackupKeyCustody(root);
  await withBackupMaintenanceLease(signal(), (lease) =>
    withResetExportAccess(proof, plan, lease, signal(), async (access) => {
      for (const item of plan.exports) {
        const keyBinding = { resetId: plan.resetId, backupId: item.exportId, selectionSha256: resetExportPlanSha256(plan), users: plan.users };
        await custody.reserve(keyBinding);
        const value = options(item);
        const result = await custody.withReserved(keyBinding, (passphrase) => source.writeForReset({ ...value, passphrase }, access));
        const archive = await fs.readFile(value.destination);
        expect(createHash('sha256').update(archive).digest('hex')).toBe(result.sha256);
        const commitment = { archiveSha256: result.sha256, archiveBytes: result.bytes };
        await custody.seal(keyBinding, commitment);
        await new ResetBackupKeyCustody(root).withSealed(keyBinding, commitment, async (passphrase) => {
          const review = await openSettingsBackupReview({
            source: value.destination,
            directory: path.join(root, `review-${item.exportId}`),
            passphrase,
            signal: signal(),
            inspect: source.inspectors(passphrase, root),
          });
          try {
            await review.withSelection(
              { version: 1, reviewId: review.summary.reviewId, archiveSha256: result.sha256, contents: item.selection },
              async ({ parts }) =>
                expect(parts.find((part) => part.part.kind === 'settings')?.payload?.desktop.serverName).toBe(`Saved profile ${item.ownerId}`),
            );
          } finally {
            await review.dispose();
          }
        });
      }
    }),
  );
  expect(passkeys.verifySensitive).toHaveBeenCalledOnce();
  expect(auth.verifySensitiveAction).not.toHaveBeenCalled();
  expect(machine.withPortablePointForExport).not.toHaveBeenCalled();
  expect(await fs.readFile(path.join(root, 'app-data/media'), 'utf8')).toBe('Docker media stays untouched');
  for (const ownerId of [7, 8]) expect((await desktop.backupSnapshot(ownerId)).serverName).toBe(`Saved profile ${ownerId}`);
}, 15_000);

it('refuses forged access and ordinary export access on the reset-only writer', async () => {
  const item = binding(7);
  await expect(source.writeForReset(options(item), {} as SettingsExportAccess)).rejects.toThrow();
  const ticket = await authorizeSettingsPasswordExport(auth as never, request, { password: 'fixture password' }, item);
  await withSettingsExportAccess(ticket, item, signal(), async (access) => {
    await expect(source.writeForReset(options(item), access)).rejects.toThrow();
  });
  expect(await fs.readdir(root)).toEqual([]);
});

it('rejects unplanned profiles and changed contents before creating an output archive', async () => {
  const item = binding(7);
  const plan = planFor([item]);
  const proof = await verifyResetExportProof(auth as never, passkeys as never, request, plan.accounts, {
    method: 'password',
    password: 'fixture password',
  });
  await withBackupMaintenanceLease(signal(), (lease) =>
    withResetExportAccess(proof, plan, lease, signal(), async (access) => {
      await expect(source.writeForReset({ ...options(item), ownerId: 8 }, access)).rejects.toThrow();
      await expect(source.writeForReset({ ...options(item), selection: { ...item.selection, themes: false } }, access)).rejects.toThrow();
    }),
  );
  expect(await fs.readdir(root)).toEqual([]);
  expect(auth.verifySensitiveAction).toHaveBeenCalledOnce();
});

it('keeps preferences and an unsealed key reservation when account security changes during backup', async () => {
  await desktop.write(7, { ...DEFAULT_DESKTOP_PREFERENCES, serverName: 'Keep this profile' });
  const item = binding(7);
  const plan = planFor([item]);
  const keyBinding = { resetId: plan.resetId, backupId: item.exportId, selectionSha256: resetExportPlanSha256(plan), users: plan.users };
  const custody = new ResetBackupKeyCustody(root);
  await custody.reserve(keyBinding);
  const proof = await verifyResetExportProof(auth as never, passkeys as never, request, plan.accounts, {
    method: 'password',
    password: 'fixture password',
  });
  const value = options(item);
  await expect(
    withBackupMaintenanceLease(signal(), (lease) =>
      withResetExportAccess(proof, plan, lease, signal(), (access) =>
        custody.withReserved(keyBinding, (passphrase) =>
          source.writeForReset(
            {
              ...value,
              passphrase,
              progress: (progress) => {
                if (progress.stage === 'encrypting') current = { ...current, securityBinding: 'c'.repeat(64) };
              },
            },
            access,
          ),
        ),
      ),
    ),
  ).rejects.toThrow();
  expect((await desktop.backupSnapshot(7)).serverName).toBe('Keep this profile');
  await expect(fs.lstat(value.destination)).rejects.toThrow();
  await expect(custody.withSealed(keyBinding, { archiveSha256: 'a'.repeat(64), archiveBytes: 1 }, async () => true)).rejects.toThrow();
  expect((await fs.readdir(root)).some((name) => name.startsWith('.settings-source-'))).toBe(false);
});
