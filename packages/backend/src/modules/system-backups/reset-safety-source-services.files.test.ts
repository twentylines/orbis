import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Request } from 'express';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultTimeMachinePreferences } from '@runtipi/common/schemas/time-machine';
import { withBackupMaintenanceLease } from '@/common/backup-maintenance-lease';
import { AutomaticUpdatesService } from '../host-updates/automatic-updates.service';
import { TimeMachineService } from './time-machine.service';
import { TimeMachineStore } from './time-machine-store';
import { stabilizeDarwinFixtureCreation } from './darwin-files.fixture';
import type { ResetSafetySourceOptions } from './reset-safety-source';
import { planResetSafetyExports } from './reset-safety-plan';
import { verifyResetExportProof, withResetExportAccess } from './settings-export-authorization';

type Context = Pick<ResetSafetySourceOptions, 'plan' | 'access' | 'lease' | 'signal'>;
let root: string;
let restoreCreation: () => void;
const auth = { operatorActionContext: vi.fn(), verifySensitiveAction: vi.fn() };
const keys = { verifySensitive: vi.fn() };
const ownedAutomatic: AutomaticUpdatesService[] = [];

beforeEach(async () => {
  if (!process.env.TMPDIR) throw new Error('Project-scoped TMPDIR required');
  root = await fs.realpath(await fs.mkdtemp(path.join(process.env.TMPDIR, 'reset-source-services-')));
  restoreCreation = stabilizeDarwinFixtureCreation(() => root);
  auth.operatorActionContext.mockImplementation(async () => ({
    userId: 1,
    sessionBinding: 'synthetic-session',
    securityBinding: 'synthetic-security',
  }));
  auth.verifySensitiveAction.mockResolvedValue({});
  keys.verifySensitive.mockResolvedValue({});
});
afterEach(async () => {
  for (const service of ownedAutomatic.splice(0)) service.onModuleDestroy();
  vi.restoreAllMocks();
  restoreCreation();
  await fs.rm(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

async function scope<T>(accounts: 'keep' | 'remove', work: (context: Context) => Promise<T>) {
  const plan = planResetSafetyExports({ resetId: randomUUID(), accounts, users: [1, 2], captures: [] }).plan;
  const signal = AbortSignal.timeout(15_000);
  const proof = await verifyResetExportProof(auth as never, keys as never, {} as Request, accounts, {
    method: 'password',
    password: 'synthetic password',
  });
  return withBackupMaintenanceLease(signal, (lease) =>
    withResetExportAccess(proof, plan, lease, signal, (access) => work({ plan, access, lease, signal })),
  );
}
function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function realConfig() {
  return { get: (key: string) => (key === 'directories' ? { dataDir: root } : key === 'userSettings' ? { timeZone: 'UTC' } : false) };
}
async function realAutomatic() {
  const service = new AutomaticUpdatesService(
    realConfig() as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { warn: vi.fn() } as never,
    {} as never,
  );
  ownedAutomatic.push(service);
  await service.onModuleInit();
  return service;
}
async function realMachine() {
  const service = new TimeMachineService(
    realConfig() as never,
    {} as never,
    auth as never,
    { warn: vi.fn() } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { recoverCaptureFences: vi.fn(async () => {}) } as never,
  );
  await service.onModuleInit();
  return service;
}
const automaticSettings = {
  orbis: { enabled: false, mode: 'scheduled' },
  schedule: { time: '03:00', timezone: 'UTC' },
  orbisSchedule: { time: '04:00' },
};

it('reads real automatic state with independent schedules and rejects a changed on-disk policy', async () => {
  const automatic = await realAutomatic();
  await automatic.update(automaticSettings);
  const value = await scope('keep', (context) => automatic.snapshotForReset(context));
  expect(value.policy?.orbis.time).toBe('04:00');
  expect(Object.isFrozen(value.state.settings.orbis)).toBe(true);
  const file = path.join(root, 'state/automatic-updates/schedule-policy.json');
  const changed = JSON.parse(await fs.readFile(file, 'utf8'));
  changed.orbis.time = '05:00';
  await fs.writeFile(file, JSON.stringify(changed));
  await expect(scope('keep', (context) => automatic.snapshotForReset(context))).rejects.toThrow();
});

it('waits for earlier real automatic writes instead of reading a queued partial schedule', async () => {
  const automatic = await realAutomatic();
  const entered = deferred();
  const release = deferred();
  const rename = fs.rename.bind(fs);
  let held = false;
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (!held && String(to).endsWith('/automatic-updates/settings.json')) {
      held = true;
      entered.resolve();
      await release.promise;
    }
    return rename(from, to);
  });
  const update = automatic.update(automaticSettings);
  await entered.promise;
  const started = deferred();
  let completed = false;
  const snapshot = scope('keep', async (context) => {
    started.resolve();
    const value = await automatic.snapshotForReset(context);
    completed = true;
    return value;
  });
  await started.promise;
  expect(completed).toBe(false);
  release.resolve();
  await update;
  expect((await snapshot).policy?.orbis.time).toBe('04:00');
});

it('drains earlier real Time Machine writes, blocks new ordinary preference writes during the callback, and preserves legacy reset writes afterward', async () => {
  const machine = await realMachine();
  const entered = deferred();
  const release = deferred();
  const rename = fs.rename.bind(fs);
  let held = false;
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (!held && String(to).endsWith('/preferences.json')) {
      held = true;
      entered.resolve();
      await release.promise;
    }
    return rename(from, to);
  });
  const { version: _version, revision: _revision, ...defaults } = defaultTimeMachinePreferences();
  const update = machine.updatePreferences({ ...defaults, expectedRevision: 0 });
  await entered.promise;
  const started = deferred();
  let consumed = false;
  const snapshot = scope('keep', (context) => {
    started.resolve();
    return machine.withResetPreferencesSnapshot(context, async (preferences) => {
      consumed = true;
      expect(preferences.revision).toBe(1);
      expect(Object.isFrozen(preferences.schedule)).toBe(true);
      await expect(machine.updatePreferences({ ...defaults, expectedRevision: 1 })).rejects.toThrow();
      return preferences;
    });
  });
  await started.promise;
  expect(consumed).toBe(false);
  release.resolve();
  await update;
  expect((await snapshot).revision).toBe(1);
  await scope('keep', async () => {
    expect((await machine.updatePreferences({ ...defaults, expectedRevision: 1 })).revision).toBe(2);
  });
});

it('detects an external Time Machine preference change while the serialized callback is running', async () => {
  const store = new TimeMachineStore(root);
  const { version: _version, revision: _revision, ...defaults } = defaultTimeMachinePreferences();
  await store.updatePreferences({ ...defaults, expectedRevision: 0 });
  await expect(
    store.withPreferencesSnapshot(async (preferences) => {
      await fs.writeFile(path.join(root, 'backups/time-machine/preferences.json'), JSON.stringify({ ...preferences, revision: 2 }));
    }),
  ).rejects.toThrow();
});
