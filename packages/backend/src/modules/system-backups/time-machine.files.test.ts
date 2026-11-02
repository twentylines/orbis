import { CaptureFenceJournal } from './time-machine-capture-fence';
import { controllerPublicationSource } from './time-machine-capture-runtime';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultTimeMachinePreferences, timeMachineLimits } from '@runtipi/common/schemas/time-machine';
import { backupMaintenanceActive, setBackupRecoveryRequired } from '@/common/backup-maintenance';
import { SystemBackupsService } from './system-backups.service';
import { TimeMachineService } from './time-machine.service';
import { TimeMachineStore, type TimeMachineDraftMetadata } from './time-machine-store';
import { timeMachineBuiltinPhotographs } from './time-machine-assets';
import { historicalHomePreview } from './time-machine-preview';
import { timeMachineCapabilities, timeMachineIssue, timeMachineRestoreBlockers } from './time-machine-policy';
import { backupMetadataBytes, encryptBackup, decryptBackup } from './backup-crypto';
import { TimeMachineController } from './time-machine.controller';
import { BackupImportsService } from './backup-imports.service';
import { timeMachineRestoreReviewResponseSchema } from '@runtipi/common/schemas/time-machine-restore';
import type { Request, Response } from 'express';
import { EventEmitter } from 'node:events';
import { connectedCaptureFixture } from './time-machine-capture.fixture';
import { decodeRuntimePayloadManifest, decodeRuntimePublicationEntry, runtimePublicationEntryName } from './time-machine-runtime-payload';
import { BackupRestoreJournal } from './backup-restore-journal';
import { recordRetainedRestoreAdmission } from './time-machine-restore-admission';
import { AuthGuard } from '../auth/auth.guard';
import { DesktopPreferencesService } from '../desktop-preferences/desktop-preferences.service';
import { AccountSecurityService } from '../auth/account-security.service';
import { ResetState } from '../system-reset/reset-state';
import { GUARDS_METADATA, HEADERS_METADATA } from '@nestjs/common/constants';

let directory: string;
let data: string;
let backups: SystemBackupsService;
let machine: TimeMachineService;
let imports: BackupImportsService;
const reviewDatabase = { review: vi.fn() };
const authorization = { password: vi.fn(), passkey: vi.fn(), passkeyOptions: vi.fn(), admit: vi.fn() };
const pinnedDocker = { requireNoPendingAppImageUpdates: vi.fn() };
const restores = { status: vi.fn(), prepareRetained: vi.fn(), beginRetainedRoot: vi.fn() };
const credentials = { password: 'disposable-local-capture-password' };
const container = { id: 'a'.repeat(64), project: 'fixture_store', running: true };
const auth = { verifySensitiveAction: vi.fn().mockResolvedValue({ id: 1 }), operatorActionContext: vi.fn() };
const apps = { getApps: vi.fn().mockResolvedValue([{ appName: 'fixture', appStoreSlug: 'store', status: 'running' }]) };
const tasks = { read: vi.fn().mockResolvedValue({ tasks: [] }) };
const host = { status: vi.fn().mockResolvedValue({ available: false }) };
const runtime = { plan: vi.fn(), stop: vi.fn(), resume: vi.fn(), dumpDatabase: vi.fn(), verifyStopped: vi.fn() };
const queueBase = {
  pauseId: randomUUID(),
  generation: 1,
  queues: ['app-events-queue', 'repo-queue', 'system-events-queue'].map((name) => ({ name, messages: 0, consumers: 0 })),
};
const queueCapture = { verify: vi.fn(async () => ({ ...queueBase, checkedAt: Date.now() })), release: vi.fn() };
const queues = { pauseForBackup: vi.fn(async () => ({ ...queueCapture, initial: { ...queueBase, checkedAt: Date.now() } })) };
const logger = { warn: vi.fn() };
const database = { execute: vi.fn().mockResolvedValue({ rows: [{ bytes: '1024' }] }) };
const desktop = { serverName: 'Historical fixture', preset: 'forest', mode: 'dark', density: 'compact', wallpaper: 'canopy' };
let connected: Awaited<ReturnType<typeof connectedCaptureFixture>>;
let config: { get: (key: string) => unknown };
const store = () => new TimeMachineStore(data);
const createMachine = () =>
  new TimeMachineService(
    ...([
      config,
      backups,
      auth,
      logger,
      imports,
      authorization,
      pinnedDocker,
      restores,
      connected.runtime,
      new DesktopPreferencesService(config as never),
    ] as unknown as ConstructorParameters<typeof TimeMachineService>),
  );
const root = () => path.join(data, 'backups', 'time-machine');
async function terminal(id: string) {
  void machine.launchCapture(id, 1);
  let point = (await machine.list(1)).points.find((value) => value.id === id);
  await vi.waitFor(
    async () => {
      point = (await machine.list(1)).points.find((value) => value.id === id);
      expect(point?.status).not.toBe('capturing');
    },
    { timeout: 15_000 },
  );
  if (!point) throw new Error('Capture disappeared.');
  return point;
}
async function capture() {
  return terminal((await machine.capture(1, credentials, { experimentalAcknowledged: true, label: 'Historic checkpoint' })).id);
}

it('onboarding capture requires v6 without fallback and does not request a password', async () => {
  const id = randomUUID();
  await expect(machine.beginOnboardingCapture(1, id, 'First')).rejects.toMatchObject({
    response: { code: 'host-capture-support-required' },
  });
  expect(await store().list()).toHaveLength(0);
  await expect(fs.stat(path.join(data, 'state', 'onboarding', '1.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('onboarding capture persists completion before launch and reuses one owner-bound attempt after reload', async () => {
  const id = randomUUID();
  const selection = {};
  const support = vi.spyOn(connected.runtime, 'requireSupport').mockResolvedValue(selection);
  const [one, two] = await Promise.all([machine.beginOnboardingCapture(1, id, 'First'), machine.beginOnboardingCapture(1, id, 'First')]);
  expect(auth.verifySensitiveAction).not.toHaveBeenCalled();
  expect([one.id, two.id]).toEqual([id, id]);
  expect(one.status).toBe('capturing');
  expect(JSON.parse(await fs.readFile(path.join(data, 'state', 'onboarding', '1.json'), 'utf8'))).toEqual({ version: 1 });
  expect((await store().list()).map((point) => point.id)).toEqual([id]);
  expect(await machine.onboardingCapture(id, 1)).toMatchObject({ id, status: 'capturing' });
  await expect(machine.onboardingCapture(id, 2)).rejects.toMatchObject({ response: { code: 'point-not-found' } });
  await expect(machine.beginOnboardingCapture(2, id, 'First')).rejects.toMatchObject({ response: { code: 'point-not-found' } });
  await expect(machine.beginOnboardingCapture(1, randomUUID(), 'Another')).rejects.toMatchObject({ response: { code: 'invalid-request' } });
  const attempt = await fs.readFile(path.join(root(), 'onboarding-attempts', `${id}.json`), 'utf8');
  expect(attempt).not.toContain(credentials.password);
  expect(JSON.parse(attempt)).toMatchObject({ id, ownerId: 1, state: 'ready' });
  expect(support).toHaveBeenCalledWith(undefined, true);
  await machine.onModuleDestroy();
  machine = createMachine();
  expect(await machine.onboardingCapture(id, 1)).toMatchObject({ id, status: 'interrupted' });
  expect(await machine.beginOnboardingCapture(1, id, 'First')).toMatchObject({ id, status: 'interrupted' });
  expect(await store().list()).toHaveLength(1);
});

it('onboarding capture retains a failed point if completion cannot be persisted', async () => {
  const id = randomUUID();
  vi.spyOn(connected.runtime, 'requireSupport').mockResolvedValue({});
  vi.spyOn(fs, 'rename').mockImplementationOnce(async () => {
    throw new Error('write failure');
  });
  await expect(machine.beginOnboardingCapture(1, id, 'First')).rejects.toThrow();
  expect(await machine.onboardingCapture(id, 1)).toMatchObject({ id, status: 'failed' });
  expect(await machine.beginOnboardingCapture(1, id, 'First')).toMatchObject({ id, status: 'failed' });
  expect(await store().list()).toHaveLength(1);
  await machine.remove(id, 1, credentials);
  await expect(machine.beginOnboardingCapture(1, id, 'First')).rejects.toMatchObject({
    response: { code: 'capture-recovery-required' },
  });
  expect(await store().list()).toHaveLength(0);
});

it('onboarding capture refuses a reserved orphan and does not create another point', async () => {
  const id = randomUUID();
  await store().onboardingAttempt(id, 1, true);
  await expect(machine.onboardingCapture(id, 1)).rejects.toMatchObject({ response: { code: 'capture-recovery-required' } });
  await expect(machine.beginOnboardingCapture(1, id, 'First')).rejects.toMatchObject({
    response: { code: 'capture-recovery-required' },
  });
  expect(await store().list()).toHaveLength(0);
});

it('onboarding capture starts once after the response and reports an actual background failure', async () => {
  const id = randomUUID();
  vi.spyOn(connected.runtime, 'requireSupport').mockResolvedValue({});
  const operation = vi.spyOn(connected.runtime, 'operation');
  const response = new EventEmitter() as Response;
  const session = { authMethod: 'session', user: { id: 1, operator: true } } as Request;
  const controller = new TimeMachineController(machine);
  await expect(
    controller.onboardingCapture({ authMethod: 'session', user: { id: 1, operator: false } } as Request, { attemptId: id, label: 'First' }, response),
  ).rejects.toThrow();
  const point = await controller.onboardingCapture(session, { attemptId: id, label: 'First' }, response);
  expect(point).toMatchObject({ id, status: 'capturing' });
  expect(JSON.parse(await fs.readFile(path.join(data, 'state', 'onboarding', '1.json'), 'utf8'))).toEqual({ version: 1 });
  expect(operation).not.toHaveBeenCalled();
  response.emit('finish');
  response.emit('close');
  await vi.waitFor(async () => expect(await machine.onboardingCapture(id, 1)).toMatchObject({ status: 'failed' }));
  expect(operation).toHaveBeenCalledTimes(1);
  expect(await store().list()).toHaveLength(1);
});

it('onboarding capture reconciles an ambiguous point publication as interrupted after restart', async () => {
  const id = randomUUID();
  vi.spyOn(connected.runtime, 'requireSupport').mockResolvedValue({});
  const link = fs.link.bind(fs);
  vi.spyOn(fs, 'link').mockImplementation(async (source, target) => {
    await link(source, target);
    if (String(target) === path.join(root(), 'points', id, 'point.json')) throw new Error('simulated lost acknowledgement after publication');
  });
  await expect(machine.beginOnboardingCapture(1, id, 'First')).rejects.toThrow();
  await expect(machine.onboardingCapture(id, 1)).rejects.toMatchObject({ response: { code: 'storage-unavailable' } });
  vi.restoreAllMocks();
  await machine.onModuleDestroy();
  machine = createMachine();
  expect(await machine.onboardingCapture(id, 1)).toMatchObject({ id, status: 'interrupted' });
  expect(await store().list()).toHaveLength(1);
  await expect(fs.stat(path.join(data, 'state', 'onboarding', '1.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('onboarding capture refuses a marker copied to a different machine identity', async () => {
  const id = randomUUID();
  await store().onboardingAttempt(id, 1, true);
  await fs.writeFile(path.join(root(), 'keys', 'machine-v1.id'), randomUUID(), { mode: 0o600 });
  await expect(machine.onboardingCapture(id, 1)).rejects.toMatchObject({ response: { code: 'point-not-found' } });
  expect(await store().list()).toHaveLength(0);
});

it('serializes ordinary onboarding completion with first-capture admission', async () => {
  const preferences = new DesktopPreferencesService(config as never);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const admission = preferences.withIncompleteOnboarding(1, async (complete) => {
    await gate;
    await complete();
    return 'staged';
  });
  const completion = preferences.completeOnboarding(1);
  release();
  expect(await admission).toEqual({ value: 'staged' });
  expect(await completion).toEqual({ complete: true });
  const work = vi.fn();
  expect(await preferences.withIncompleteOnboarding(1, work)).toBeNull();
  expect(work).not.toHaveBeenCalled();
});

it('does not replace a concurrently created onboarding point directory', async () => {
  const id = randomUUID();
  const destination = path.join(root(), 'points', id);
  const mkdir = fs.mkdir.bind(fs);
  let inode = 0;
  vi.spyOn(fs, 'mkdir').mockImplementation((async (...args: Parameters<typeof fs.mkdir>) => {
    if (String(args[0]) === destination) {
      await mkdir(destination, { mode: 0o700 });
      inode = (await fs.stat(destination)).ino;
    }
    return mkdir(...args);
  }) as typeof fs.mkdir);
  await expect(store().create(1, 2, id)).rejects.toMatchObject({ code: 'EEXIST' });
  expect(inode).not.toBe(0);
  expect((await fs.stat(destination)).ino).toBe(inode);
  expect(await fs.readdir(destination)).toEqual([]);
  await expect(store().list()).rejects.toMatchObject({ response: { code: 'storage-unavailable' } });
});

it('fails closed if a crash leaves an onboarding point directory without its record', async () => {
  const id = randomUUID();
  const destination = path.join(root(), 'points', id);
  const mkdir = fs.mkdir.bind(fs);
  vi.spyOn(fs, 'mkdir').mockImplementation((async (...args: Parameters<typeof fs.mkdir>) => {
    const result = await mkdir(...args);
    if (String(args[0]) === destination) throw new Error('simulated crash after directory creation');
    return result;
  }) as typeof fs.mkdir);
  await expect(store().create(1, 2, id)).rejects.toThrow('simulated crash');
  await expect(store().list()).rejects.toMatchObject({ response: { code: 'storage-unavailable' } });
});
async function reviewed(id: string) {
  let result = await machine.readRestoreReview(id, 1);
  await vi.waitFor(
    async () => {
      result = await machine.readRestoreReview(id, 1);
      expect(result.review?.status).not.toBe('reviewing');
    },
    { timeout: 15_000 },
  );
  if (!result.review) throw new Error('The retained review disappeared.');
  expect(timeMachineRestoreReviewResponseSchema.allows(result)).toBe(true);
  return result.review;
}
async function retainedImport() {
  const directory = path.join(data, 'backups', 'imports');
  const ids = await fs.readdir(directory);
  expect(ids).toHaveLength(1);
  const id = ids[0];
  if (!id) throw new Error('Missing private retained review.');
  return { id, directory: path.join(directory, id) };
}
beforeEach(async () => {
  vi.clearAllMocks();
  runtime.verifyStopped.mockImplementation(async (plan) =>
    plan.containers.map((item: { id: string; project: string }) => ({ ...item, running: false })),
  );
  auth.verifySensitiveAction.mockResolvedValue({ id: 1 });
  pinnedDocker.requireNoPendingAppImageUpdates.mockResolvedValue(undefined);
  restores.status.mockReset().mockResolvedValue({ job: null });
  restores.prepareRetained.mockReset();
  restores.beginRetainedRoot.mockReset();
  authorization.admit.mockReset();
  auth.operatorActionContext.mockReset().mockResolvedValue({ userId: 1, sessionBinding: 'session', securityBinding: 'security' });
  setBackupRecoveryRequired(false);
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-time-machine-')));
  data = path.join(directory, 'data');
  await fs.mkdir(path.join(data, 'state', 'desktop'), { recursive: true });
  await fs.mkdir(path.join(directory, 'app-data'), { mode: 0o700 });
  await fs.writeFile(path.join(data, '.env'), 'DISPOSABLE_FIXTURE=true', { mode: 0o600 });
  await fs.writeFile(path.join(data, 'state', 'seed'), 'disposable-time-machine-seed', { mode: 0o600 });
  await fs.writeFile(path.join(data, 'state', 'desktop', '1.json'), JSON.stringify(desktop), { mode: 0o600 });
  await fs.writeFile(path.join(directory, 'app-data', 'document'), 'fixture application content', { mode: 0o600 });
  config = {
    get: (key) =>
      ({
        directories: { dataDir: data, appDataDir: path.join(directory, 'app-data') },
        envFilePath: path.join(data, '.env'),
        userSettings: { timeZone: 'UTC' },
        version: '4.10.1',
        architecture: 'arm64',
        jwtSecret: 'disposable fixture only',
      })[key],
  };
  runtime.plan.mockResolvedValue({
    databaseId: 'b'.repeat(64),
    containers: [container],
    images: [{ project: 'fixture_store', image: 'fixture:v1' }],
  });
  runtime.stop.mockResolvedValue(undefined);
  runtime.resume.mockResolvedValue(undefined);
  runtime.dumpDatabase.mockImplementation(async (_id, file) => {
    await fs.writeFile(file, 'PGDMPdisposable fixture', { mode: 0o600 });
  });
  backups = new SystemBackupsService(
    ...([config, auth, apps, tasks, host, runtime, logger, database, queues] as unknown as ConstructorParameters<typeof SystemBackupsService>),
  );
  // File/service tests declare the PostgreSQL boundary; native database validation is a separate acceptance gate.
  reviewDatabase.review.mockImplementation(async (_content: string, destination: string) => {
    await fs.mkdir(destination, { mode: 0o700 });
    const bytes = Buffer.from('{}\n');
    const result = {
      counts: { user: 0, app_store: 0, app: 0, link: 0 },
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
    await fs.writeFile(path.join(destination, 'records.ndjson'), bytes, { mode: 0o600 });
    await fs.writeFile(path.join(destination, 'records.json'), JSON.stringify({ version: 1, ...result }), { mode: 0o600 });
    return result;
  });
  imports = new BackupImportsService(...([config, auth, logger, reviewDatabase] as unknown as ConstructorParameters<typeof BackupImportsService>));
  connected = await connectedCaptureFixture(data, config);
  runtime.stop.mockImplementation(async () => {
    const app = connected.values.get(connected.ids.app);
    if (app) app.running = false;
  });
  runtime.resume.mockImplementation(async () => {
    const app = connected.values.get(connected.ids.app);
    if (app) app.running = true;
  });
  machine = createMachine();
});
afterEach(async () => {
  await machine.onModuleDestroy();
  await imports.onModuleDestroy();
  await backups.onModuleDestroy();
  setBackupRecoveryRequired(false);
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

it('uses the actual quiesced full-backup pipeline and retains only sealed ciphertext with immutable historical metadata', async () => {
  const point = await capture();
  expect(point.status).toBe('sealed');
  expect(runtime.stop).toHaveBeenCalledWith(container);
  expect(runtime.resume).toHaveBeenCalledWith([container]);
  expect(backupMaintenanceActive()).toBe(false);
  expect(point.metadata?.restore.ready).toBe(false);
  expect(point.metadata?.coverage.dockerImages).toBe(true);
  expect(point.metadata?.breakdown.some((item) => item.id === 'app-data' && item.bytes > 0)).toBe(true);
  const preview = point.metadata?.preview;
  expect(preview?.available).toBe(true);
  if (!preview?.available) throw new Error('Missing historical projection.');
  expect(preview.desktop.preset).toBe('forest');
  expect(preview.apps).toEqual([{ urn: 'fixture:store', name: 'fixture', running: true }]);
  await fs.writeFile(path.join(data, 'state', 'desktop', '1.json'), JSON.stringify({ ...desktop, preset: 'blush', serverName: 'Changed' }));
  expect((await machine.inspect(point.id, 1)).metadata?.preview).toEqual(preview);
  const pointDir = path.join(root(), 'points', point.id);
  expect((await fs.readdir(pointDir)).filter((name) => name !== 'wallpaper.orbis').sort()).toEqual([
    'backup.orbis',
    'metadata.orbis',
    'point.json',
    'runtime.orbis',
  ]);
  const journal = await fs.readFile(path.join(pointDir, 'point.json'), 'utf8');
  expect(journal).not.toContain(credentials.password);
  expect(journal).not.toContain('Historical fixture');
  expect(journal).not.toContain('Historic checkpoint');
  expect((await fs.readFile(path.join(pointDir, 'metadata.orbis'))).includes(Buffer.from('Historic checkpoint'))).toBe(false);
  expect((await fs.stat(path.join(root(), 'keys', 'master-v1.key'))).mode & 0o777).toBe(0o600);
  expect(await fs.readdir(path.join(data, 'backups', 'full'))).toEqual([]);
  expect((await machine.list(2)).points).toEqual([]);
  await expect(machine.inspect(point.id, 2)).rejects.toThrow();
});

it('keeps wrapping keys and retained ciphertext outside every legacy capture and restored state root', async () => {
  const first = await capture();
  const key = await fs.readFile(path.join(root(), 'keys', 'master-v1.key'));
  const second = await capture();
  expect(second.status).toBe('sealed');
  expect(second.metadata?.breakdown.find((item) => item.id === 'backups')).toBeUndefined();
  expect(await fs.readFile(path.join(root(), 'keys', 'master-v1.key'))).toEqual(key);
  await fs.rm(path.join(data, 'state'), { recursive: true });
  await fs.mkdir(path.join(data, 'state'), { mode: 0o700 });
  await machine.onModuleDestroy();
  machine = createMachine();
  expect((await machine.inspect(first.id, 1)).metadata?.label).toBe('Historic checkpoint');
});

it('manual capture uses its operator session by default and requires fresh proof only for the enabled account policy', async () => {
  const point = await machine.capture(1, {}, { label: 'Session capture' });
  expect(point.status).toBe('capturing');
  expect(auth.verifySensitiveAction).not.toHaveBeenCalled();
  await machine.onModuleDestroy();
  machine = createMachine();
  await fs.rm(root(), { recursive: true, force: true });
  const policy = new AccountSecurityService(config as never);
  await policy.update(1, { expectedRevision: 0, requireCaptureAuthentication: true }, async () => undefined);
  await expect(machine.capture(1, {}, { label: '' })).rejects.toThrow('password');
  auth.verifySensitiveAction.mockRejectedValueOnce(new Error('Invalid fixture credentials'));
  await expect(machine.capture(1, credentials, { label: '' })).rejects.toThrow('Invalid fixture credentials');
  expect((await machine.list(1)).points).toEqual([]);
});

it('polls only the current owner capture without decrypting historical points', async () => {
  await machine.preferences();
  const list = vi.spyOn(TimeMachineStore.prototype, 'list');
  const metadata = vi.spyOn(TimeMachineStore.prototype, 'metadata');
  const load = vi.spyOn(TimeMachineStore.prototype, 'load');
  expect(await machine.activity(1)).toEqual({ version: 1, point: null });
  expect(list).not.toHaveBeenCalled();
  expect(load).not.toHaveBeenCalled();

  const point = await machine.capture(1, credentials, { experimentalAcknowledged: true, label: 'Background capture' });
  list.mockClear();
  load.mockClear();
  expect(await machine.activity(2)).toEqual({ version: 1, point: null });
  expect(load).not.toHaveBeenCalled();
  expect(await machine.activity(1)).toEqual({ version: 1, point: { ...point, metadata: null } });
  expect(load).toHaveBeenCalledExactlyOnceWith(point.id);
  expect(list).not.toHaveBeenCalled();
  expect(metadata).not.toHaveBeenCalled();
  await machine.cancelCapture(point.id, 1);
  load.mockClear();
  expect(await machine.activity(1)).toEqual({ version: 1, point: null });
  expect(load).not.toHaveBeenCalled();
});

it('keeps background capture activity operator-only and uncached', async () => {
  const controller = new TimeMachineController(machine);
  const response = { setHeader: vi.fn() } as unknown as Response;
  const session = { user: { id: 1, operator: true }, authMethod: 'session' } as Request;
  const activity = vi.spyOn(machine, 'activity').mockResolvedValue({ version: 1, point: null });
  expect(Reflect.getMetadata(GUARDS_METADATA, TimeMachineController)).toContain(AuthGuard);
  await expect(controller.activity(session, response)).resolves.toEqual({ version: 1, point: null });
  expect(activity).toHaveBeenCalledExactlyOnceWith(1);
  expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  activity.mockClear();
  expect(() => controller.activity({ ...session, authMethod: 'cli' } as Request, response)).toThrow();
  expect(activity).not.toHaveBeenCalled();
});

it('serializes revision updates and refuses unsupported automatic triggers without changing the saved defaults', async () => {
  const current = await machine.preferences();
  expect(current).toEqual(defaultTimeMachinePreferences());
  const { version: _version, revision, ...value } = current;
  const request = { ...value, expectedRevision: revision };
  for (const update of [{ beforeUpdate: true }, { beforeRestart: true }, { schedule: { enabled: true, intervalHours: 24 } }])
    await expect(machine.updatePreferences({ ...request, ...update })).rejects.toMatchObject({ response: { code: 'automatic-capture-unsupported' } });
  expect(await machine.preferences()).toEqual(current);
  const results = await Promise.allSettled([
    machine.updatePreferences({ ...request, enabled: false }),
    machine.updatePreferences({ ...request, enabled: true }),
  ]);
  expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((item) => item.status === 'rejected')).toHaveLength(1);
  expect((await machine.preferences()).revision).toBe(1);
});

it('never ignores a configured unsupported app exclusion or claims native, cluster or activation support', async () => {
  const { version: _version, revision, ...value } = await machine.preferences();
  await machine.updatePreferences({ ...value, expectedRevision: revision, excludedApps: ['fixture:store'] });
  await expect(machine.capture(1, credentials, { experimentalAcknowledged: true, label: '' })).rejects.toMatchObject({
    response: { code: 'app-exclusions-unsupported' },
  });
  expect(runtime.plan).not.toHaveBeenCalled();
  const capabilities = timeMachineCapabilities();
  expect(capabilities.restore.supported).toBe(false);
  expect(capabilities.cluster).toEqual({ supported: false, requiresAllHostsSealed: true });
  expect(capabilities.osSnapshots.supported).toBe(false);
  expect(capabilities.exportSealedPoints).toBe(false);
});

it('detects ciphertext tampering and identity-bound envelope swaps', async () => {
  const point = await capture();
  const archive = path.join(root(), 'points', point.id, 'backup.orbis');
  const bytes = await fs.readFile(archive);
  bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
  await fs.writeFile(archive, bytes);
  expect((await machine.inspect(point.id, 1)).status).toBe('sealed');
  await machine.restoreReview(point.id, 1);
  expect((await reviewed(point.id)).blockers).toContainEqual(expect.objectContaining({ code: 'point-integrity-failed' }));
  const saved = store();
  const second = await capture();
  const firstStored = await saved.load(point.id);
  const secondStored = await saved.load(second.id);
  await fs.writeFile(path.join(root(), 'points', second.id, 'point.json'), JSON.stringify({ ...secondStored, envelope: firstStored.envelope }));
  await expect(saved.metadata(await saved.load(second.id))).rejects.toMatchObject({ response: { code: 'point-integrity-failed' } });
});

it('blocks retained storage capacity and unsafe wrapping-key files instead of silently replacing them', async () => {
  const saved = store();
  for (let index = 0; index < timeMachineLimits.points; index++) await saved.create(1);
  await expect(saved.create(1)).rejects.toMatchObject({ response: { code: 'capacity-exceeded' } });
  const keyFile = path.join(root(), 'keys', 'master-v1.key');
  const original = await fs.readFile(keyFile);
  await fs.chmod(keyFile, 0o644);
  await expect(saved.create(1)).rejects.toThrow();
  await fs.chmod(keyFile, 0o600);
  await fs.rm(path.join(root(), 'points'), { recursive: true });
  const outside = path.join(directory, 'outside-key');
  await fs.writeFile(outside, original, { mode: 0o600 });
  await fs.rm(keyFile);
  await fs.symlink(outside, keyFile);
  await expect(saved.create(1)).rejects.toThrow();
  expect(await fs.readFile(outside)).toEqual(original);
});

it('marks incomplete captures interrupted after restart and rejects overwriting sealed points', async () => {
  const saved = store();
  const incomplete = await saved.create(1);
  await machine.onModuleDestroy();
  machine = createMachine();
  expect((await machine.list(1)).points[0]).toMatchObject({ id: incomplete.point.id, status: 'interrupted', issue: { code: 'capture-interrupted' } });
  await expect(machine.capture(1, credentials, { experimentalAcknowledged: true, label: '' })).rejects.toMatchObject({
    response: { code: 'capture-recovery-required' },
  });
  await machine.remove(incomplete.point.id, 1, credentials);
  const sealed = await capture();
  await expect(saved.update({ ...(await saved.load(sealed.id)), status: 'failed' })).rejects.toThrow();
});

it('requires fresh destructive authentication and exact manifest identity while activation remains unavailable', async () => {
  const point = await capture();
  const digest = point.metadata?.manifestSha256 ?? '';
  auth.verifySensitiveAction.mockClear();
  await expect(machine.activate(point.id, 1, credentials, '0'.repeat(64))).rejects.toMatchObject({ response: { code: 'point-integrity-failed' } });
  await expect(machine.activate(point.id, 1, credentials, digest)).rejects.toMatchObject({ response: { code: 'activation-not-integrated' } });
  expect(auth.verifySensitiveAction).toHaveBeenCalledTimes(2);
  await machine.restoreReview(point.id, 1);
  expect((await reviewed(point.id)).ready).toBe(false);
  expect((await machine.inspect(point.id, 1)).status).toBe('sealed');
});

it('reviews actual retained ciphertext through the existing import checks without exposing its internal import or keys', async () => {
  const point = await capture();
  const sourceReview = vi.spyOn(imports, 'reviewRetained');
  const runtimeReview = vi.spyOn(TimeMachineStore.prototype, 'verifyRuntime');
  auth.verifySensitiveAction.mockClear();
  const opened = await machine.restoreReview(point.id, 1);
  expect(opened.review).toMatchObject({ pointId: point.id, status: 'reviewing', ready: false, expiresAt: null });
  const result = await reviewed(point.id);
  await expect(sourceReview.mock.results[0]?.value).resolves.toBeDefined();
  expect(result.status).toBe('blocked');
  expect(runtimeReview).toHaveBeenCalledOnce();
  expect(result.blockers.map((value) => value.code)).toEqual(['image-state-unavailable', 'controller-version-unsupported']);
  expect(reviewDatabase.review).toHaveBeenCalledTimes(1);
  expect(auth.verifySensitiveAction).not.toHaveBeenCalled();
  expect((await imports.list(1)).jobs).toEqual([]);
  const internal = await retainedImport();
  const persisted = JSON.parse(await fs.readFile(path.join(internal.directory, 'job.json'), 'utf8'));
  expect(persisted).toMatchObject({ origin: 'time-machine', retainedPointId: point.id, ownerId: 1, status: 'reviewed' });
  const serialized = JSON.stringify({ opened, result, persisted });
  expect(serialized).not.toContain(credentials.password);
  expect(JSON.stringify(result)).not.toContain(internal.id);
  expect(serialized).not.toContain('passphrase');
  expect(serialized).not.toContain(directory);
});

it('refuses legacy upload, password review and restore claims for an internal retained import', async () => {
  const point = await capture();
  await machine.restoreReview(point.id, 1);
  await reviewed(point.id);
  const internal = await retainedImport();
  await expect(imports.receive(internal.id, 1, Readable.from(['replacement']), '11')).rejects.toThrow('Time Machine');
  await expect(imports.review(internal.id, 1, credentials, 'disposable-passphrase')).rejects.toThrow('Time Machine');
  const journal = { directory: 'unused', state: { id: randomUUID() } } as BackupRestoreJournal;
  await expect(
    imports.claimReviewedSource(internal.id, 1, credentials, {
      journal,
      manifestSha256: point.metadata?.manifestSha256 ?? '',
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow('point-bound');
  expect((await imports.retainedStatus(internal.id, 1)).status).toBe('reviewed');
  expect(runtime.stop).toHaveBeenCalledTimes(1);
});

it('keeps review ownership and blockers ahead of all fresh-auth methods', async () => {
  const point = await capture();
  await machine.restoreReview(point.id, 1);
  const result = await reviewed(point.id);
  const request = {} as Request;
  await expect(machine.restoreReview(point.id, 2)).rejects.toThrow();
  await expect(machine.readRestoreReview(point.id, 2)).rejects.toThrow();
  await expect(machine.remove(point.id, 2, credentials)).rejects.toThrow();
  expect((await machine.readRestoreReview(point.id, 1)).review?.reviewId).toBe(result.reviewId);
  await expect(machine.restoreAuthOptions(point.id, 1, request, randomUUID())).rejects.toMatchObject({ response: { code: 'review-required' } });
  await expect(machine.restoreAuthOptions(point.id, 1, request, result.reviewId)).rejects.toMatchObject({
    response: { code: 'image-state-unavailable' },
  });
  await expect(machine.restoreAuthVerify(point.id, 1, request, result.reviewId, 'password', credentials)).rejects.toMatchObject({
    response: { code: 'image-state-unavailable' },
  });
  await expect(machine.restoreAuthVerify(point.id, 2, request, result.reviewId, 'passkey', {})).rejects.toThrow();
  await expect(machine.activateAuthorized(point.id, 1, request, result.reviewId, randomUUID(), result.manifestSha256)).rejects.toMatchObject({
    response: { code: 'image-state-unavailable' },
  });
  expect(authorization.password).not.toHaveBeenCalled();
  expect(authorization.passkey).not.toHaveBeenCalled();
  expect(authorization.passkeyOptions).not.toHaveBeenCalled();
});

it('reloads an exact point-to-journal status link without treating a receipt or journal phase as successful restoration', async () => {
  const point = await capture();
  const other = await capture();
  await machine.restoreReview(point.id, 1);
  const reviewedPoint = await reviewed(point.id);
  const binding = {
    pointId: point.id,
    reviewId: reviewedPoint.reviewId,
    archiveSha256: reviewedPoint.archiveSha256,
    manifestSha256: reviewedPoint.manifestSha256,
    machineId: reviewedPoint.machineId,
  };
  const journal = await BackupRestoreJournal.create(path.join(data, 'backups', 'restores'), {
    id: randomUUID(),
    nonce: randomUUID(),
    originalController: '1'.repeat(64),
    candidateController: '1'.repeat(64),
    worker: '3'.repeat(64),
    roots: ['state'],
  });
  await recordRetainedRestoreAdmission(journal, 1, (await retainedImport()).id, binding, { sha256: 'a'.repeat(64), verify: async () => undefined });
  const job = { id: journal.state.id, status: 'recovery-required', needsRecovery: true, canRecover: true };
  restores.status.mockResolvedValue({ job });
  await machine.onModuleDestroy();
  machine = createMachine();
  expect(await machine.restoreAdmissionStatus(point.id, 1)).toEqual({ version: 1, admission: { ...binding, restoreId: journal.state.id }, job });
  expect(await machine.restoreAdmissionStatus(other.id, 1)).toEqual({ version: 1, admission: null, job: null });
  await expect(machine.restoreAdmissionStatus(point.id, 2)).rejects.toThrow();
  restores.status.mockResolvedValue({ job: { ...job, id: randomUUID(), status: 'succeeded' } });
  await expect(machine.restoreAdmissionStatus(point.id, 1)).rejects.toMatchObject({ response: { code: 'restore-recovery-required' } });
  restores.status.mockResolvedValue({ job: null });
  await expect(machine.restoreAdmissionStatus(point.id, 1)).rejects.toMatchObject({ response: { code: 'restore-recovery-required' } });
});

it('expires a retained review using the existing import retention and removes its plaintext', async () => {
  const point = await capture();
  await machine.restoreReview(point.id, 1);
  await reviewed(point.id);
  const internal = await retainedImport();
  expect(await fs.readdir(internal.directory)).toContain('content');
  const time = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(time + 16 * 60_000);
  try {
    const result = await machine.readRestoreReview(point.id, 1);
    expect(result.review).toMatchObject({ status: 'blocked', ready: false, expiresAt: null, blockers: [{ code: 'review-expired' }] });
    await expect(machine.restoreAuthOptions(point.id, 1, {} as Request, result.review?.reviewId ?? '')).rejects.toMatchObject({
      response: { code: 'review-expired' },
    });
    expect((await fs.readdir(internal.directory)).sort()).toEqual(['backup.orbis', 'job.json']);
  } finally {
    clock.mockRestore();
  }
});

it('restarts without trusting an old in-memory review and replaces only its same-owner internal review', async () => {
  const point = await capture();
  await machine.restoreReview(point.id, 1);
  const first = await reviewed(point.id);
  const old = await retainedImport();
  await machine.onModuleDestroy();
  await imports.onModuleDestroy();
  imports = new BackupImportsService(...([config, auth, logger, reviewDatabase] as unknown as ConstructorParameters<typeof BackupImportsService>));
  machine = createMachine();
  expect(await machine.readRestoreReview(point.id, 1)).toEqual({ version: 1, review: null });
  expect((await imports.list(1)).jobs).toEqual([]);
  expect((await imports.retainedStatus(old.id, 1)).status).toBe('uploaded');
  await machine.restoreReview(point.id, 1);
  expect((await reviewed(point.id)).reviewId).not.toBe(first.reviewId);
  expect((await retainedImport()).id).not.toBe(old.id);
  await expect(fs.stat(old.directory)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('blocks review during maintenance or an unresolved image update before copying or opening the point', async () => {
  const point = await capture();
  const open = vi.spyOn(TimeMachineStore.prototype, 'withArchive');
  setBackupRecoveryRequired(true);
  await expect(machine.restoreReview(point.id, 1)).rejects.toMatchObject({ response: { code: 'operation-busy' } });
  setBackupRecoveryRequired(false);
  pinnedDocker.requireNoPendingAppImageUpdates.mockRejectedValueOnce(new Error('Pending metadata recovery'));
  await expect(machine.restoreReview(point.id, 1)).rejects.toMatchObject({ response: { code: 'restore-recovery-required' } });
  expect(open).not.toHaveBeenCalled();
  expect(reviewDatabase.review).not.toHaveBeenCalled();
  pinnedDocker.requireNoPendingAppImageUpdates.mockRejectedValueOnce(new Error('Pending metadata recovery'));
  runtime.plan.mockClear();
  await expect(machine.capture(1, credentials, { experimentalAcknowledged: true, label: '' })).rejects.toMatchObject({
    response: { code: 'capture-recovery-required' },
  });
  expect(runtime.plan).not.toHaveBeenCalled();
});

it('refuses incomplete archive consumption and a replaced inode after verification without handing out a key', async () => {
  const point = await capture();
  const saved = store();
  const stored = await saved.load(point.id);
  const signal = new AbortController().signal;
  await expect(saved.withArchive(stored, signal, async () => undefined)).rejects.toMatchObject({ response: { code: 'point-integrity-failed' } });
  const verify = saved.verifyArchive.bind(saved);
  const archive = path.join(root(), 'points', point.id, 'backup.orbis');
  vi.spyOn(saved, 'verifyArchive').mockImplementation(async (...args) => {
    const proof = await verify(...args);
    await fs.rename(archive, `${archive}.old`);
    await fs.copyFile(`${archive}.old`, archive);
    await fs.chmod(archive, 0o600);
    return proof;
  });
  const consumer = vi.fn();
  await expect(saved.withArchive(stored, signal, consumer)).rejects.toMatchObject({ response: { code: 'point-integrity-failed' } });
  expect(consumer).not.toHaveBeenCalled();
});

it('aborts the protected archive stream and releases the import disk lease when review shuts down', async () => {
  const point = await capture();
  let began!: () => void;
  const opening = new Promise<void>((resolve) => {
    began = resolve;
  });
  vi.spyOn(TimeMachineStore.prototype, 'withArchive').mockImplementation(async (_point, signal) => {
    began();
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  await machine.restoreReview(point.id, 1);
  await opening;
  await machine.onModuleDestroy();
  const retained = await retainedImport();
  expect((await imports.retainedStatus(retained.id, 1)).status).toBe('cancelled');
  await expect(machine.readRestoreReview(point.id, 1)).rejects.toThrow();
  const next = await imports.create(1, credentials);
  const ciphertext = await fs.readFile(path.join(root(), 'points', point.id, 'backup.orbis'));
  await imports.receive(next.id, 1, Readable.from([ciphertext]), String(ciphertext.length));
  await vi.waitFor(async () => expect((await imports.list(1)).jobs[0]?.status).toBe('uploaded'));
});

it('refuses oversized/truncated sealing streams without committing a partial point', async () => {
  const saved = store();
  const { point } = await saved.create(1);
  const metadata: TimeMachineDraftMetadata = {
    version: 1,
    id: point.id,
    createdAt: point.createdAt,
    label: '',
    source: 'manual',
    manifestSha256: 'a'.repeat(64),
    software: { orbis: 'fixture', runtipi: 'fixture', architecture: 'arm64' },
    coverage: {
      database: true,
      configuration: true,
      appData: true,
      dockerImages: false,
      controllerVersion: false,
      appearance: true,
      cluster: 'local-only',
    },
    restore: { ready: false, blockers: timeMachineRestoreBlockers() },
    preview: { available: false, reason: timeMachineIssue('preview-not-captured') },
    breakdown: [],
    excludedApps: [],
  };
  await expect(saved.seal(point, Readable.from([Buffer.from('ORBISBK1short')]), 60, metadata, new AbortController().signal)).rejects.toThrow();
  expect(await fs.readdir(path.join(root(), 'points', point.id))).toEqual(['point.json']);
  await expect(saved.seal(point, Readable.from([]), timeMachineLimits.bytes + 1, metadata, new AbortController().signal)).rejects.toMatchObject({
    response: { code: 'capacity-exceeded' },
  });
});

it('authenticates bounded metadata in memory and never produces partial plaintext after failure', async () => {
  const passphrase = 'disposable-metadata-passphrase';
  const plain = Buffer.from('historical fixture metadata');
  const encrypted = await backupMetadataBytes(plain, passphrase, false);
  expect(await backupMetadataBytes(encrypted, passphrase, true)).toEqual(plain);
  await expect(backupMetadataBytes(encrypted, 'different-disposable-passphrase', true)).rejects.toThrow();
  encrypted[40] = (encrypted[40] ?? 0) ^ 1;
  await expect(backupMetadataBytes(encrypted, passphrase, true)).rejects.toThrow();
  await expect(backupMetadataBytes(Buffer.alloc(1024 * 1024 + 1), passphrase, false)).rejects.toThrow();
});

it('never substitutes live appearance when copied preview metadata is missing or malformed', async () => {
  const snapshot = {
    content: path.join(directory, 'missing'),
    createdAt: Date.now(),
    manifestSha256: 'a'.repeat(64),
    software: { orbis: 'fixture', runtipi: 'fixture', architecture: 'arm64' },
    files: [],
    databaseBytes: 0,
    apps: [],
  };
  expect(await historicalHomePreview(snapshot, 1)).toMatchObject({ available: false, reason: { code: 'preview-not-captured' } });
  expect(await historicalHomePreview({ ...snapshot, files: [{ name: 'data/state/desktop/1.json', bytes: 1 }] }, 1)).toMatchObject({
    available: false,
    reason: { code: 'preview-invalid' },
  });
});

it('rejects nonoperator sessions and unknown credential fields at the API boundary', async () => {
  const controller = new TimeMachineController(machine);
  const session = { authMethod: 'session', user: { id: 1, operator: true } } as Parameters<TimeMachineController['capture']>[0];
  await expect(
    controller.capture(
      { ...session, authMethod: 'cli' } as typeof session,
      { ...credentials, experimentalAcknowledged: true, label: '' },
      new EventEmitter() as Response,
    ),
  ).rejects.toThrow();
  await expect(
    controller.capture(
      session,
      { ...credentials, experimentalAcknowledged: true, label: '', privatePath: '/fixture' },
      new EventEmitter() as Response,
    ),
  ).rejects.toThrow();
  expect(() => controller.activate(session, randomUUID(), { ...credentials, manifestSha256: '0'.repeat(64), confirmation: 'wrong' })).toThrow();
});

it('passes a fresh exact grant through coherent admission and protected root launch when a review is explicitly enabled in the fixture', async () => {
  const point = await capture();
  await machine.restoreReview(point.id, 1);
  const result = await reviewed(point.id);
  const reviews = Reflect.get(machine, 'reviews') as Map<string, { value: typeof result; importId: string | null; importExpiresAt: number | null }>;
  const local = reviews.get(point.id);
  if (!local?.importId || !local.importExpiresAt) throw new Error('Missing fixture import');
  local.value = {
    ...local.value,
    status: 'ready',
    ready: true,
    blockers: [],
    expiresAt: local.importExpiresAt,
    progress: { stage: 'ready', completedBytes: 0, totalBytes: null },
  };
  const grantId = randomUUID();
  const request = {} as Request;
  const journal = { state: { id: randomUUID() } };
  authorization.admit.mockResolvedValue({});
  restores.prepareRetained.mockImplementation(async (options) => {
    await options.admit(journal);
    return journal;
  });
  restores.beginRetainedRoot.mockImplementation(async (options) => {
    await options.verifyAccount();
    return {
      job: {
        id: journal.state.id,
        status: 'running',
        phase: 'allocated',
        stage: 'preparing',
        message: 'Preparing',
        needsRecovery: false,
        progressUnavailable: false,
        canCancel: false,
        canRecover: false,
      },
    };
  });
  auth.operatorActionContext
    .mockResolvedValueOnce({ userId: 1, sessionBinding: 'session', securityBinding: 'security' })
    .mockResolvedValueOnce({ userId: 1, sessionBinding: 'revoked', securityBinding: 'security' });
  await expect(machine.activateAuthorized(point.id, 1, request, result.reviewId, grantId, result.manifestSha256)).rejects.toMatchObject({
    response: { code: 'authorization-invalid' },
  });
  expect(authorization.admit).not.toHaveBeenCalled();
  expect(restores.prepareRetained).not.toHaveBeenCalled();
  await expect(machine.activateAuthorized(point.id, 1, request, result.reviewId, grantId, result.manifestSha256)).resolves.toMatchObject({
    job: { id: journal.state.id, status: 'running' },
  });
  expect(authorization.admit).toHaveBeenCalledExactlyOnceWith(
    request,
    expect.objectContaining({ pointId: point.id, reviewId: result.reviewId }),
    grantId,
    local.importId,
    journal,
  );
  expect(restores.prepareRetained).toHaveBeenCalledOnce();
  expect(restores.beginRetainedRoot).toHaveBeenCalledOnce();
});

it('routes only exact point-bound restore grants to the protected activation path', async () => {
  const controller = new TimeMachineController(machine);
  const session = { authMethod: 'session', user: { id: 1, operator: true } } as Request;
  const pointId = randomUUID();
  const reviewId = randomUUID();
  const grantId = randomUUID();
  const manifestSha256 = 'a'.repeat(64);
  const activate = vi.spyOn(machine, 'activateAuthorized').mockResolvedValue({
    job: {
      requiresFreshAuthentication: true,
      id: randomUUID(),
      status: 'running',
      phase: 'allocated',
      stage: 'preparing',
      message: 'Preparing',
      needsRecovery: false,
      progressUnavailable: false,
      canCancel: false,
      canRecover: false,
    },
  });
  await controller.activate(session, pointId, { reviewId, grantId, manifestSha256, confirmation: 'replace-server' });
  expect(activate).toHaveBeenCalledWith(pointId, 1, session, reviewId, grantId, manifestSha256);
  expect(() => controller.activate(session, pointId, { reviewId, grantId, manifestSha256, confirmation: 'replace-server', extra: true })).toThrow();
  expect(() =>
    controller.activate({ ...session, authMethod: 'cli' } as Request, pointId, { reviewId, grantId, manifestSha256, confirmation: 'replace-server' }),
  ).toThrow();
});

it('requires a session and fresh credentials for point-bound retained recovery', async () => {
  const controller = new TimeMachineController(machine);
  const session = { authMethod: 'session', user: { id: 1, operator: true } } as Request;
  const pointId = randomUUID();
  const restoreId = randomUUID();
  const recover = vi.spyOn(machine, 'recoverAuthorized').mockResolvedValue({ restoreId });
  await controller.recover(session, pointId, { restoreId, password: 'fixture-password' });
  expect(recover).toHaveBeenCalledWith(pointId, 1, session, restoreId, expect.objectContaining({ password: 'fixture-password' }));
  expect(() => controller.recover(session, pointId, { restoreId, password: 'fixture-password', extra: true })).toThrow();
  expect(() => controller.recover({ ...session, authMethod: 'cli' } as Request, pointId, { restoreId, password: 'fixture-password' })).toThrow();
});

it('keeps review and fresh-auth routes behind the session guard, operator check and strict server-derived binding', async () => {
  const controller = new TimeMachineController(machine);
  const session = { authMethod: 'session', user: { id: 1, operator: true } } as Request;
  const pointId = randomUUID();
  const reviewId = randomUUID();
  expect(Reflect.getMetadata(GUARDS_METADATA, TimeMachineController)).toContain(AuthGuard);
  for (const method of ['review', 'authOptions', 'authVerify'] as const) {
    expect(Reflect.getMetadata(HEADERS_METADATA, controller[method])).toContainEqual({ name: 'Cache-Control', value: 'no-store' });
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', controller[method])).toBe(5);
  }
  const review = vi.spyOn(machine, 'restoreReview').mockResolvedValue({ version: 1, review: null });
  await expect(controller.review(session, pointId, {})).resolves.toEqual({ version: 1, review: null });
  expect(review).toHaveBeenCalledWith(pointId, 1);
  expect(() => controller.review(session, pointId, { archiveSha256: 'a'.repeat(64) })).toThrow();
  const options = vi.spyOn(machine, 'restoreAuthOptions');
  const verify = vi.spyOn(machine, 'restoreAuthVerify');
  for (const invalid of [
    { ...session, authMethod: 'cli' },
    { ...session, user: { id: 1, operator: false } },
  ]) {
    expect(() => controller.authOptions(invalid as Request, pointId, { reviewId, method: 'passkey' })).toThrow();
    expect(() => controller.authVerify(invalid as Request, pointId, { reviewId, method: 'password', ...credentials })).toThrow();
  }
  expect(() => controller.authOptions(session, pointId, { reviewId, method: 'passkey', machineId: 'a'.repeat(64) })).toThrow();
  expect(() => controller.authVerify(session, pointId, { reviewId, method: 'totp', totpCode: '123456' })).toThrow();
  expect(options).not.toHaveBeenCalled();
  expect(verify).not.toHaveBeenCalled();
  const status = vi.spyOn(machine, 'restoreAdmissionStatus').mockResolvedValue({ version: 1, admission: null, job: null });
  const response = { setHeader: vi.fn() } as unknown as Response;
  await expect(controller.admissionStatus(session, pointId, response)).resolves.toEqual({ version: 1, admission: null, job: null });
  expect(status).toHaveBeenCalledWith(pointId, 1);
  expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  expect(() => controller.admissionStatus({ ...session, authMethod: 'cli' } as Request, pointId, response)).toThrow();
  expect(Reflect.getMetadata('THROTTLER:LIMITdefault', controller.admissionStatus)).toBe(30);
  expect(Reflect.getMetadata('THROTTLER:LIMITdefault', controller.reviewStatus)).toBe(30);
});

it('waits for reserved capture setup during shutdown and never starts Docker work after cancellation', async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = TimeMachineStore.prototype.create;
  let reserved = false;
  vi.spyOn(TimeMachineStore.prototype, 'create').mockImplementationOnce(async function (this: TimeMachineStore, ownerId) {
    reserved = true;
    await gate;
    return original.call(this, ownerId);
  });
  const pending = machine.capture(1, credentials, { experimentalAcknowledged: true, label: '' });
  void pending.catch(() => undefined);
  await vi.waitFor(() => expect(reserved).toBe(true));
  let stopped = false;
  const closing = machine.onModuleDestroy().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  release();
  await expect(pending).rejects.toMatchObject({ response: { code: 'capture-failed' } });
  await closing;
  expect(runtime.plan).not.toHaveBeenCalled();
  expect(stopped).toBe(true);
});

it('serves only point-bound encrypted custom wallpaper after the live image changes and detects sidecar tampering', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGPUiHJjYGBgYmBgYGBgAAAJbADMvnADbQAAAABJRU5ErkJggg==', 'base64');
  const identity = createHash('sha256').update(png).digest('hex');
  await fs.mkdir(path.join(data, 'state', 'wallpapers'), { mode: 0o700 });
  const live = path.join(data, 'state', 'wallpapers', '1.image');
  await fs.writeFile(live, png, { mode: 0o600 });
  await fs.writeFile(
    path.join(data, 'state', 'desktop', '1.json'),
    JSON.stringify({ ...desktop, wallpaperMode: 'custom', appearance: { wallpaperImage: identity } }),
  );
  const point = await capture();
  expect(point.metadata?.preview.available && point.metadata.preview.wallpaperAsset.available).toBe(true);
  expect((await machine.wallpaper(point.id, 1, identity)).data).toEqual(png);
  expect((await machine.wallpaper(point.id, 1, identity)).mime).toBe('image/png');
  const concurrent = await Promise.allSettled(Array.from({ length: 3 }, () => machine.wallpaper(point.id, 1, identity)));
  expect(concurrent.filter((item) => item.status === 'fulfilled')).toHaveLength(2);
  expect(concurrent.filter((item) => item.status === 'rejected')).toHaveLength(1);
  expect(concurrent.find((item) => item.status === 'rejected')).toMatchObject({ reason: { response: { code: 'operation-busy' } } });
  await fs.writeFile(live, Buffer.concat([png, Buffer.from('later-generation')]));
  expect((await machine.wallpaper(point.id, 1, identity)).data).toEqual(png);
  await expect(machine.wallpaper(point.id, 2, identity)).rejects.toThrow();
  await expect(machine.wallpaper(point.id, 1, '0'.repeat(64))).rejects.toThrow();
  const file = path.join(root(), 'points', point.id, 'wallpaper.orbis');
  const encrypted = await fs.readFile(file);
  expect(encrypted.subarray(0, 8).toString()).toBe('ORBISBK1');
  expect(encrypted.includes(png)).toBe(false);
  encrypted[encrypted.length - 1] = (encrypted[encrypted.length - 1] ?? 0) ^ 1;
  await fs.writeFile(file, encrypted);
  await expect(machine.wallpaper(point.id, 1, identity)).rejects.toMatchObject({ response: { code: 'point-integrity-failed' } });
});

it('keeps an encrypted legacy Forest photograph unchanged while new points capture the current Forest default', async () => {
  const oldPhoto = await fs.readFile(path.resolve('../frontend/public/wallpapers/forest-v2.webp'));
  const newPhoto = await fs.readFile(path.resolve('../frontend/public/wallpapers/forest-v3.webp'));
  const oldIdentity = createHash('sha256').update(oldPhoto).digest('hex');
  const newIdentity = createHash('sha256').update(newPhoto).digest('hex');
  expect(newIdentity).not.toBe(oldIdentity);
  const currentDefault = timeMachineBuiltinPhotographs.forest;
  expect(currentDefault).toBe('forest-v3.webp');
  let historical: Awaited<ReturnType<typeof capture>>;
  // Recreate an earlier capture using its then-current bundled default; stored points never consult this map again.
  Reflect.set(timeMachineBuiltinPhotographs, 'forest', 'forest-v2.webp');
  try {
    historical = await capture();
  } finally {
    Reflect.set(timeMachineBuiltinPhotographs, 'forest', currentDefault);
  }
  const oldMetadata = structuredClone(historical.metadata);
  const sidecar = path.join(root(), 'points', historical.id, 'wallpaper.orbis');
  const oldCiphertext = await fs.readFile(sidecar);
  const asset = historical.metadata?.preview.available && historical.metadata.preview.wallpaperAsset;
  expect(asset).toMatchObject({ available: true, identity: oldIdentity, bytes: oldPhoto.length, source: 'captured-builtin' });
  const current = await capture();
  const currentAsset = current.metadata?.preview.available && current.metadata.preview.wallpaperAsset;
  expect(currentAsset).toMatchObject({ available: true, identity: newIdentity, bytes: newPhoto.length, source: 'captured-builtin' });
  expect((await machine.inspect(historical.id, 1)).metadata).toEqual(oldMetadata);
  expect(await fs.readFile(sidecar)).toEqual(oldCiphertext);
  expect((await machine.wallpaper(historical.id, 1, oldIdentity)).data).toEqual(oldPhoto);
  expect((await machine.wallpaper(current.id, 1, newIdentity)).data).toEqual(newPhoto);
  await expect(machine.wallpaper(historical.id, 1, newIdentity)).rejects.toMatchObject({ response: { code: 'point-not-found' } });
}, 15_000);

it('browses validated encrypted metadata without hashing the full archive and verifies it for restore review', async () => {
  const point = await capture();
  const verify = vi.spyOn(TimeMachineStore.prototype, 'verifyArchive');
  await machine.inspect(point.id, 1);
  await machine.list(1);
  expect(verify).not.toHaveBeenCalled();
  await machine.restoreReview(point.id, 1);
  await reviewed(point.id);
  expect(verify).toHaveBeenCalledTimes(1);
});

it('allows only one full archive verification at a time and releases the slot afterward', async () => {
  const point = await capture();
  const original = TimeMachineStore.prototype.verifyArchive;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let checking = false;
  vi.spyOn(TimeMachineStore.prototype, 'verifyArchive').mockImplementationOnce(async function (this: TimeMachineStore, stored) {
    checking = true;
    await gate;
    return original.call(this, stored);
  });
  const first = await machine.restoreReview(point.id, 1);
  await vi.waitFor(() => expect(checking).toBe(true));
  await expect(machine.restoreReview(point.id, 1)).rejects.toMatchObject({ response: { code: 'operation-busy' } });
  release();
  expect(first.review?.ready).toBe(false);
  await reviewed(point.id);
  expect((await machine.restoreReview(point.id, 1)).review?.pointId).toBe(point.id);
  await reviewed(point.id);
});

it('returns the reserved point before exporting images and launches once only after the response finishes', async () => {
  const controller = new TimeMachineController(machine);
  const response = new EventEmitter() as Response;
  const session = { authMethod: 'session', user: { id: 1, operator: true } } as Request;
  const point = await controller.capture(session, { ...credentials, experimentalAcknowledged: true, label: '' }, response);
  expect(point.status).toBe('capturing');
  expect(connected.engine.saveImage).not.toHaveBeenCalled();
  expect(runtime.plan).not.toHaveBeenCalled();
  response.emit('finish');
  response.emit('close');
  const sealed = await terminal(point.id);
  expect(sealed.status).toBe('sealed');
  expect(connected.engine.saveImage).toHaveBeenCalledTimes(1);
  expect(runtime.stop).toHaveBeenCalledTimes(1);
});

it('binds ordered encrypted runtime frames to both journals without exposing private configuration', async () => {
  const original = TimeMachineStore.prototype.seal;
  vi.spyOn(TimeMachineStore.prototype, 'seal').mockImplementation(async function (this: TimeMachineStore, ...args) {
    expect(runtime.resume).toHaveBeenCalledTimes(1);
    expect(backupMaintenanceActive()).toBe(false);
    return original.apply(this, args);
  });
  const point = await capture();
  const retained = store();
  const journal = await retained.load(point.id);
  const runtimeCipher = await fs.readFile(path.join(root(), 'points', point.id, 'runtime.orbis'));
  const plaintext = await retained.withArchive(journal, new AbortController().signal, async (source, passphrase) => {
    for await (const _chunk of source) {
      /* Consume the verified legacy archive before using its protected key. */
    }
    return backupMetadataBytes(runtimeCipher, passphrase, true, 2 * 1024 * 1024);
  });
  expect(plaintext.subarray(0, 8).toString()).toBe('ORBISTM1');
  const size = plaintext.readUInt32BE(8);
  const manifestBytes = plaintext.subarray(12, 12 + size);
  const manifest = JSON.parse(manifestBytes.toString());
  expect(decodeRuntimePayloadManifest(manifest).schema).toBe('orbis.time-machine-runtime.v3');
  expect(manifest.legacy.cipherSha256).toBe(point.metadata?.archiveSha256);
  expect(manifest.legacy.manifestSha256).toBe(point.metadata?.manifestSha256);
  expect(manifest.controller.sourceImageId).toBe(connected.image.id);
  expect(manifest.controller.publishedDigest).not.toBe(connected.image.id);
  expect(manifest.controllerRuntimeCoherence).toBe(true);
  expect(manifest.restoreReady).toBe(false);
  expect(journal.version).toBe(2);
  if (journal.version !== 2) throw new Error('Missing runtime journal');
  expect(journal.runtimeCipherSha256).toBe(createHash('sha256').update(runtimeCipher).digest('hex'));
  expect(journal.runtimeManifestSha256).toBe(createHash('sha256').update(manifestBytes).digest('hex'));
  let offset = 12 + size;
  expect(manifest.entries.map((entry: { name: string }) => entry.name)).toEqual(manifest.entries.map((entry: { name: string }) => entry.name).sort());
  for (const entry of manifest.entries) {
    const bytes = plaintext.subarray(offset, offset + entry.bytes);
    expect(bytes.length).toBe(entry.bytes);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry.sha256);
    if (entry.name === runtimePublicationEntryName) {
      expect(entry.sha256).toBe(manifest.publicationProofSha256);
      const expected = connected.host.prepareControllerPublication.mock.calls[0]?.[0];
      if (!expected) throw new Error('Missing independently anchored preparation expectation');
      expect(decodeRuntimePublicationEntry(manifest, bytes, expected).metadata.pointId).toBe(point.id);
      const changed = Buffer.from(bytes);
      changed[0] = changed[0] === 123 ? 32 : 123;
      expect(() => decodeRuntimePublicationEntry(manifest, changed, expected)).toThrow();
    }
    offset += entry.bytes;
  }
  expect(offset).toBe(plaintext.length);
  expect(plaintext.includes(await fs.readFile(path.join(data, '.env')))).toBe(true);
  expect(JSON.stringify(await machine.list(1))).not.toContain('DISPOSABLE_FIXTURE');
  expect(JSON.stringify(point)).not.toContain('dataBase64');
  expect(point.metadata?.coverage.controllerVersion).toBe(false);
  expect(point.metadata?.restore.ready).toBe(false);
});

it('requires publication capability before reservation and prepares proof before app quiescence only', async () => {
  connected.host.requireControllerPublicationSupport.mockRejectedValueOnce(new Error('Unsupported publication fixture route'));
  await expect(machine.capture(1, credentials, { experimentalAcknowledged: true, label: '' })).rejects.toMatchObject({
    response: { code: 'host-capture-support-required' },
  });
  expect((await machine.list(1)).points).toEqual([]);
  expect(runtime.plan).not.toHaveBeenCalled();
  const prepare = connected.host.prepareControllerPublication.getMockImplementation();
  connected.host.prepareControllerPublication.mockImplementation(async (...args) => {
    expect(runtime.stop).not.toHaveBeenCalled();
    expect(connected.engine.saveImage).not.toHaveBeenCalled();
    if (!prepare) throw new Error('Missing publication fixture');
    return prepare(...args);
  });
  expect((await capture()).status).toBe('sealed');
  expect(connected.host.prepareControllerPublication).toHaveBeenCalledTimes(1);
  expect(connected.host.captureControllerConfiguration).toHaveBeenCalledTimes(3);
});

it('rejects publication preparation or a missing independently inspected release before stopping apps', async () => {
  connected.host.prepareControllerPublication.mockRejectedValueOnce(new Error('Offline fixture'));
  expect((await capture()).status).toBe('failed');
  expect(runtime.stop).not.toHaveBeenCalled();
  expect(connected.engine.saveImage).not.toHaveBeenCalled();
  const inspected = connected.engine.inspectControllerSource.getMockImplementation();
  connected.engine.inspectControllerSource.mockImplementation(async (...args) => {
    if (!inspected) throw new Error('Missing image fixture');
    return { ...(await inspected(...args)), Labels: { ...connected.image.labels, 'org.opencontainers.image.source': 'unrelated' } };
  });
  expect((await capture()).status).toBe('failed');
  expect(connected.host.prepareControllerPublication).toHaveBeenCalledTimes(1);
  expect(runtime.stop).not.toHaveBeenCalled();
});

it('rejects an oversized whole receipt before image preparation or app quiescence', async () => {
  connected.host.prepareControllerPublication.mockResolvedValueOnce({ read: () => Buffer.alloc(4 * 1024 * 1024 + 1) } as never);
  expect((await capture()).status).toBe('failed');
  expect(connected.engine.saveImage).not.toHaveBeenCalled();
  expect(runtime.stop).not.toHaveBeenCalled();
});

it('rejects an old host capability before reserving a point and never falls back to incomplete capture', async () => {
  connected.host.requireControllerConfigurationSupport.mockRejectedValueOnce(new Error('Unsupported fixture route'));
  await expect(machine.capture(1, credentials, { experimentalAcknowledged: true, label: '' })).rejects.toMatchObject({
    response: { code: 'host-capture-support-required' },
  });
  expect((await machine.list(1)).points).toEqual([]);
  expect(runtime.plan).not.toHaveBeenCalled();
  expect(host.status).not.toHaveBeenCalled();
});

it('fails configuration drift inside the stopped snapshot and still resumes the original app set', async () => {
  const original = connected.host.captureControllerConfiguration.getMockImplementation();
  connected.host.captureControllerConfiguration.mockImplementation(async (...args) => {
    if (connected.host.captureControllerConfiguration.mock.calls.length === 2) connected.driftConfiguration();
    if (!original) throw new Error('Missing fixture boundary');
    return original(...args);
  });
  const point = await capture();
  expect(point.status).toBe('failed');
  expect(runtime.resume).toHaveBeenCalledWith([container]);
  expect(connected.values.get(connected.ids.app)?.running).toBe(true);
  expect(backupMaintenanceActive()).toBe(false);
  expect(point.metadata).toBeNull();
  expect(await fs.readdir(path.join(root(), 'points', point.id))).toEqual(['point.json']);
});

it('cancels image preparation without stopping apps and preserves failure as an unsealed point', async () => {
  const source = new Readable({ read() {} });
  connected.engine.saveImage.mockResolvedValueOnce(source);
  const point = await machine.capture(1, credentials, { experimentalAcknowledged: true, label: '' });
  void machine.launchCapture(point.id, 1);
  await vi.waitFor(() => expect(connected.engine.saveImage).toHaveBeenCalledTimes(1));
  const cancelled = await machine.cancelCapture(point.id, 1);
  expect(cancelled.status).toBe('interrupted');
  expect(source.destroyed).toBe(true);
  expect(runtime.stop).not.toHaveBeenCalled();
  expect(backupMaintenanceActive()).toBe(false);
});

it('leaves no sealed generation when runtime publication fails after apps have resumed', async () => {
  const link = fs.link.bind(fs);
  vi.spyOn(fs, 'link').mockImplementation(async (source, destination) => {
    if (String(destination).endsWith('/runtime.orbis')) throw Object.assign(new Error('Fixture write failure'), { code: 'EIO' });
    return link(source, destination);
  });
  const point = await capture();
  expect(point.status).toBe('failed');
  expect(point.metadata).toBeNull();
  expect(runtime.resume).toHaveBeenCalledWith([container]);
  expect(connected.values.get(connected.ids.app)?.running).toBe(true);
  const names = await fs.readdir(path.join(root(), 'points', point.id));
  expect(names.filter((name) => ['metadata.orbis', 'backup.orbis', 'runtime.orbis', 'runtime.partial', 'archive.partial'].includes(name))).toEqual(
    [],
  );
});

it('inspects app sources sequentially and aborts before starting the next source', async () => {
  type Source = { source: (urn: string, enabled: boolean, signal: AbortSignal) => Promise<never> };
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const source = vi.spyOn(connected.runtime as unknown as Source, 'source').mockImplementation(async (_urn, _enabled, signal) => {
    await gate;
    signal.throwIfAborted();
    throw new Error('Unexpected next source');
  });
  const abort = new AbortController();
  const operation = connected.runtime.operation(randomUUID(), abort.signal, () => undefined);
  await operation.hostPreflight(abort.signal);
  const pending = operation.beforeQuiesce(
    {
      runtime: { databaseId: connected.ids.database, containers: [container], images: [] },
      apps: Array.from({ length: 256 }, (_, index) => ({ urn: `fixture${index}:store`, userConfigEnabled: false })),
    },
    abort.signal,
  );
  void pending.catch(() => undefined);
  await vi.waitFor(() => expect(source).toHaveBeenCalledTimes(1));
  abort.abort();
  release();
  await expect(pending).rejects.toThrow();
  expect(source).toHaveBeenCalledTimes(1);
  expect(connected.engine.saveImage).not.toHaveBeenCalled();
  await operation.dispose();
});

it('enforces combined cipher capacity before retaining bytes and leaves apps resumed', async () => {
  const saved = store();
  const list = TimeMachineStore.prototype.list;
  vi.spyOn(TimeMachineStore.prototype, 'list').mockImplementation(async function (this: TimeMachineStore) {
    const result = await list.call(this);
    return result.map((point) => ({ ...point, archiveBytes: timeMachineLimits.bytes }));
  });
  const point = await capture();
  expect(point.status).toBe('failed');
  expect(runtime.resume).toHaveBeenCalledWith([container]);
  expect((await saved.load(point.id)).metadataSha256).toBeNull();
});

it('keeps genuine version-one retained points readable and explicitly incomplete after the v2 writer is introduced', async () => {
  const current = await capture();
  if (!current.metadata) throw new Error('Missing fixture capture');
  const retained = store();
  const legacy = await retained.create(1);
  const { runtime: _runtime, ...base } = current.metadata.version === 2 ? current.metadata : { ...current.metadata, runtime: undefined };
  const metadata: TimeMachineDraftMetadata = {
    ...base,
    id: legacy.point.id,
    createdAt: legacy.point.createdAt,
    version: 1,
    coverage: {
      database: true,
      configuration: true,
      appData: true,
      dockerImages: false,
      controllerVersion: false,
      appearance: true,
      cluster: 'local-only',
    },
  };
  const plain = path.join(directory, 'legacy-content.tar.gz');
  const cipher = path.join(directory, 'legacy.orbis');
  await retained.withArchive(await retained.load(current.id), new AbortController().signal, async (source, passphrase) => {
    for await (const _chunk of source) {
    }
    await decryptBackup({ source: path.join(root(), 'points', current.id, 'backup.orbis'), destination: plain, passphrase });
  });
  await encryptBackup({ source: plain, destination: cipher, passphrase: legacy.passphrase });
  const bytes = await fs.readFile(cipher);
  await retained.seal(legacy.point, Readable.from([bytes]), bytes.length, metadata, new AbortController().signal);
  await fs.rm(plain);
  await fs.rm(cipher);
  const result = await machine.inspect(legacy.point.id, 1);
  expect(result.metadata?.version).toBe(1);
  expect(result.metadata?.coverage.dockerImages).toBe(false);
  expect(result.metadata?.restore.ready).toBe(false);
  expect(await fs.readdir(path.join(root(), 'points', legacy.point.id))).toEqual(['backup.orbis', 'metadata.orbis', 'point.json']);
});

it('rejects app source drift between image preparation and the quiesced file copy while resuming apps', async () => {
  const stop = runtime.stop.getMockImplementation();
  runtime.stop.mockImplementation(async (...args) => {
    await stop?.(...args);
    await fs.appendFile(path.join(connected.app, 'docker-compose.generated.yml'), '  unexpected:\n    image: changed:v2\n');
  });
  const point = await capture();
  expect(point.status).toBe('failed');
  expect(runtime.resume).toHaveBeenCalledWith([container]);
  expect(connected.values.get(connected.ids.app)?.running).toBe(true);
  expect(point.metadata).toBeNull();
});

it('detects changed runtime ciphertext during retained review without changing ordinary metadata browsing', async () => {
  const point = await capture();
  const runtimeFile = path.join(root(), 'points', point.id, 'runtime.orbis');
  const bytes = await fs.readFile(runtimeFile);
  bytes[40] = (bytes[40] ?? 0) ^ 1;
  await fs.writeFile(runtimeFile, bytes);
  expect((await machine.inspect(point.id, 1)).metadata?.label).toBe('Historic checkpoint');
  await machine.restoreReview(point.id, 1);
  expect((await reviewed(point.id)).status).toBe('failed');
  expect(reviewDatabase.review).not.toHaveBeenCalled();
});

it('preserves a published sealed generation after an ambiguous directory sync and reports storage unavailable', async () => {
  type SyncStore = { sync: (directory: string) => Promise<void> };
  const prototype = TimeMachineStore.prototype as unknown as SyncStore;
  const sync = prototype.sync;
  let injected = false;
  vi.spyOn(prototype, 'sync').mockImplementation(async function (this: TimeMachineStore, directory: string) {
    if (!injected) {
      try {
        const point = JSON.parse(await fs.readFile(path.join(directory, 'point.json'), 'utf8'));
        if (point.status === 'sealed') {
          injected = true;
          throw Object.assign(new Error('Fixture directory sync failure after publication'), { code: 'EIO' });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return sync.call(this, directory);
  });
  const point = await machine.capture(1, credentials, { experimentalAcknowledged: true, label: '' });
  await machine.launchCapture(point.id, 1);
  expect(injected).toBe(true);
  const retained = store();
  const committed = await retained.load(point.id);
  expect(committed.status).toBe('sealed');
  expect((await retained.metadata(committed)).version).toBe(2);
  expect(await fs.readdir(path.join(root(), 'points', point.id))).toEqual([
    'backup.orbis',
    'metadata.orbis',
    'point.json',
    'runtime.orbis',
    'wallpaper.orbis',
  ]);
  expect((await machine.list(1)).available).toBe(false);
  await expect(machine.capture(1, credentials, { experimentalAcknowledged: true, label: '' })).rejects.toMatchObject({
    response: { code: 'storage-unavailable' },
  });
  await expect(retained.fail({ ...committed, status: 'capturing' }, 'capture-failed')).rejects.toThrow();
  expect((await retained.load(point.id)).status).toBe('sealed');
  expect(runtime.resume).toHaveBeenCalledWith([container]);
});

it('records image export failure before quiescing without an unhandled reader error', async () => {
  connected.engine.saveImage.mockResolvedValueOnce(
    new Readable({
      read() {
        this.destroy(new Error('Fixture image export failure'));
      },
    }),
  );
  const point = await capture();
  expect(point.status).toBe('failed');
  expect(runtime.stop).not.toHaveBeenCalled();
  expect(backupMaintenanceActive()).toBe(false);
});

it('requires the protected host fence before app quiescence and releases it after a sealed capture', async () => {
  const acquire = connected.host.acquireControllerCaptureFence.getMockImplementation();
  connected.host.acquireControllerCaptureFence.mockImplementation(async (...args) => {
    expect(runtime.stop).not.toHaveBeenCalled();
    if (!acquire) throw new Error('Missing fence fixture');
    return acquire(...args);
  });
  expect((await capture()).status).toBe('sealed');
  expect(connected.host.acquireControllerCaptureFence).toHaveBeenCalledTimes(1);
  expect(connected.fence.renew).toHaveBeenCalled();
  expect(connected.fence.release).toHaveBeenCalledTimes(1);
});
it('fails capture and releases the host fence if final lease renewal fails', async () => {
  connected.fence.renew.mockRejectedValueOnce(new Error('fixture expired fence'));
  expect((await capture()).status).toBe('failed');
  await vi.waitFor(() => expect(connected.fence.release).toHaveBeenCalledTimes(1));
  expect(backupMaintenanceActive()).toBe(false);
});
it('fails before stopping apps if host fence acquisition is unavailable', async () => {
  connected.host.acquireControllerCaptureFence.mockRejectedValueOnce(new Error('fixture fence unavailable'));
  expect((await capture()).status).toBe('failed');
  expect(runtime.stop).not.toHaveBeenCalled();
  expect(connected.fence.release).not.toHaveBeenCalled();
});

async function persistInterruptedFence(pointId: string) {
  const configuration = await connected.host.captureControllerConfiguration({
    pointId,
    controllerId: connected.ids.core,
    imageId: connected.image.id,
  });
  const expected = controllerPublicationSource(
    configuration,
    connected.image.id,
    await connected.engine.inspectControllerSource(connected.image.id),
    'arm64',
  );
  const receipt = await connected.host.prepareControllerPublication(expected);
  const journals = new CaptureFenceJournal(data);
  return { attempt: await journals.create(expected, receipt), journals };
}
it('persists the operation key and exact verified capture identity before contacting the root acquire endpoint', async () => {
  const acquire = connected.host.acquireControllerCaptureFence.getMockImplementation();
  connected.host.acquireControllerCaptureFence.mockImplementation(async (...args) => {
    const [attempt] = await new CaptureFenceJournal(data).list();
    expect(attempt?.clientKey).toBe(args[3]);
    expect(attempt?.expected).toEqual(args[0]);
    expect(attempt?.receipt.read()).toEqual(args[1] && (args[1] as { read: () => Buffer }).read());
    if (!acquire) throw new Error('Missing capture fence fixture');
    return acquire(...args);
  });
  expect((await capture()).status).toBe('sealed');
  await vi.waitFor(async () => expect(await new CaptureFenceJournal(data).list()).toEqual([]));
});
it('reconciles a persisted attempt after backend restart and leaves the interrupted point explicitly unfinished', async () => {
  await machine.onModuleDestroy();
  const { point } = await store().create(1, 2);
  const { attempt, journals } = await persistInterruptedFence(point.id);
  machine = createMachine();
  const result = await machine.list(1);
  expect(result.available).toBe(true);
  expect(result.points.find((value) => value.id === point.id)?.status).toBe('interrupted');
  expect(connected.host.reconcileControllerCaptureFence).toHaveBeenCalledWith(attempt.expected, expect.anything(), attempt.clientKey);
  expect(await journals.list()).toEqual([]);
  expect(JSON.stringify(result)).not.toContain(attempt.clientKey);
});
it('preserves the private attempt and disables capture when startup sees a foreign or changed host fence', async () => {
  await machine.onModuleDestroy();
  const { point } = await store().create(1, 2);
  const { attempt, journals } = await persistInterruptedFence(point.id);
  connected.host.reconcileControllerCaptureFence.mockRejectedValueOnce(new Error('fixture foreign root fence'));
  machine = createMachine();
  expect((await machine.list(1)).available).toBe(false);
  expect((await journals.list())[0]?.clientKey).toBe(attempt.clientKey);
  expect(await fs.readFile(path.join(journals.directory, `${point.id}.json`))).toEqual(attempt.bytes);
});
it('does not release an orphan private attempt whose point record is missing', async () => {
  await machine.onModuleDestroy();
  const { journals } = await persistInterruptedFence(randomUUID());
  machine = createMachine();
  expect((await machine.list(1)).available).toBe(false);
  expect(connected.host.reconcileControllerCaptureFence).not.toHaveBeenCalled();
  expect(await journals.list()).toHaveLength(1);
});

it('records controller-version coverage only for the exact protected publication version', async () => {
  vi.stubEnv('ORBIS_VERSION', 'v0.5.0-beta.3');
  try {
    const point = await capture();
    expect(point.metadata?.coverage.controllerVersion).toBe(true);
    await machine.restoreReview(point.id, 1);
    const review = await reviewed(point.id);
    expect(review.status).not.toBe('failed');
    expect(review.blockers.some((issue) => issue.code === 'controller-version-unsupported')).toBe(false);
  } finally {
    vi.unstubAllEnvs();
  }
});
it('does not claim controller-version coverage when backup and protected publication versions differ', async () => {
  vi.stubEnv('ORBIS_VERSION', 'v0.5.0-beta.4');
  try {
    expect((await capture()).metadata?.coverage.controllerVersion).toBe(false);
  } finally {
    vi.unstubAllEnvs();
  }
});
it('seals an actual v3 capture and reviews the exact dump bound by its authenticated coherence receipt', async () => {
  const point = await capture();
  if (point.metadata?.version !== 2) throw new Error('Missing retained capture metadata');
  expect(point.metadata.runtime.coherenceSha256).toMatch(/^[a-f0-9]{64}$/);
  const admitted = await store().requireCoherentRuntime(await store().load(point.id), new AbortController().signal);
  try {
    expect(admitted.manifest.schema).toBe('orbis.time-machine-runtime.v3');
    expect(admitted.coherence.pointId).toBe(point.id);
    expect(admitted.coherence.database.sha256).toBe(createHash('sha256').update('PGDMPdisposable fixture').digest('hex'));
    expect(admitted.coherence.database.bytes).toBe(Buffer.byteLength('PGDMPdisposable fixture'));
    expect(admitted.coherence.hostFence.configurationSetSha256).toBe(admitted.manifest.configurationSetSha256);
    expect(admitted.controllerAuthority.metadata.pointId).toBe(point.id);
  } finally {
    await admitted.dispose();
  }
  await machine.restoreReview(point.id, 1);
  expect((await reviewed(point.id)).status).not.toBe('failed');
});
it('fails the capture if the database dump changes after the actual dump stage and before coherence sealing', async () => {
  const finalize = connected.fence.finalizeControllerArchive.getMockImplementation();
  connected.fence.finalizeControllerArchive.mockImplementationOnce(async (...args) => {
    if (!finalize) throw new Error('Missing root authority fixture');
    const authority = await finalize(...args);
    const jobs = await fs.readdir(path.join(data, 'backups', 'full'));
    const id = jobs[0];
    if (!id) throw new Error('Missing current backup job');
    await fs.writeFile(path.join(data, 'backups', 'full', id, 'content', 'database.dump'), 'PGDMPchanged after copy');
    return authority;
  });
  expect((await capture()).status).toBe('failed');
  await vi.waitFor(() => expect(connected.fence.release).toHaveBeenCalledTimes(1));
  expect(backupMaintenanceActive()).toBe(false);
  expect(runtime.resume).toHaveBeenCalled();
});
it('keeps a point unusable and releases every outage barrier if stopped-app verification changes during the snapshot', async () => {
  runtime.verifyStopped
    .mockResolvedValueOnce([{ ...container, running: false }])
    .mockRejectedValueOnce(new Error('Fixture app restarted during snapshot'));
  expect((await capture()).status).toBe('failed');
  await vi.waitFor(() => expect(connected.fence.release).toHaveBeenCalledTimes(1));
  expect(runtime.resume).toHaveBeenCalled();
  expect(backupMaintenanceActive()).toBe(false);
});
it('does not seal coherence when root archive authority finalization fails', async () => {
  connected.fence.finalizeControllerArchive.mockRejectedValueOnce(new Error('Fixture root archive verification failure'));
  expect((await capture()).status).toBe('failed');
  await vi.waitFor(() => expect(connected.fence.release).toHaveBeenCalledTimes(1));
  expect(backupMaintenanceActive()).toBe(false);
});
it('cancels controller archive finalization without publishing a receipt or stranding the app outage', async () => {
  connected.fence.finalizeControllerArchive.mockImplementationOnce(async (...args) => {
    const signal = args[4];
    if (!signal) throw new Error('Missing capture cancellation signal');
    return new Promise((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(new Error('Fixture root finalize cancelled')), { once: true }),
    );
  });
  const point = await machine.capture(1, credentials, { experimentalAcknowledged: true, label: '' });
  void machine.launchCapture(point.id, 1);
  await vi.waitFor(() => expect(connected.fence.finalizeControllerArchive).toHaveBeenCalledTimes(1));
  expect((await machine.cancelCapture(point.id, 1)).status).toBe('interrupted');
  expect(connected.fence.release).toHaveBeenCalledTimes(1);
  expect(runtime.resume).toHaveBeenCalled();
  expect(backupMaintenanceActive()).toBe(false);
  expect((await machine.inspect(point.id, 1)).metadata).toBeNull();
});
it('rejects review if the actual imported database bytes do not match the verified runtime coherence receipt', async () => {
  const point = await capture();
  const verify = TimeMachineStore.prototype.verifyRuntime;
  vi.spyOn(TimeMachineStore.prototype, 'verifyRuntime').mockImplementation(async function (this: TimeMachineStore, ...args) {
    const runtime = await verify.apply(this, args);
    if (!runtime.coherence) throw new Error('Missing produced coherence receipt');
    return { ...runtime, coherence: { ...runtime.coherence, database: { ...runtime.coherence.database, sha256: '9'.repeat(64) } } };
  });
  await machine.restoreReview(point.id, 1);
  const review = await reviewed(point.id);
  expect(review.status).toBe('failed');
  expect(review.ready).toBe(false);
});

it('exports a sealed runtime capture, downloads its actual encrypted file and verifies its uploaded capsule without activation', async () => {
  const { CapsulesService } = await import('../time-machine-capsules/capsules.service');
  const logo = path.join(data, 'apps', 'store', 'fixture', 'metadata', 'logo.jpg');
  await fs.mkdir(path.dirname(logo), { recursive: true, mode: 0o700 });
  await fs.writeFile(
    logo,
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGPUiHJjYGBgYmBgYGBgAAAJbADMvnADbQAAAABJRU5ErkJggg==', 'base64'),
    { mode: 0o600 },
  );
  const point = await capture();
  expect(point.metadata?.preview.available && point.metadata.preview.appIcons?.icons.length).toBe(1);
  auth.operatorActionContext.mockResolvedValue({ userId: 1, sessionBinding: 'a'.repeat(64), securityBinding: 'b'.repeat(64) });
  const capsules = new CapsulesService(config as never, auth as never, machine, reviewDatabase as never);
  const request = {} as Request;
  try {
    const exported = await capsules.startExport(1, request, credentials, point.id, 'fixture portable archive password');
    exported.start();
    await vi.waitFor(async () => expect((await capsules.list(1)).jobs.find((job) => job.id === exported.job.id)?.status).not.toBe('running'), {
      timeout: 20000,
    });
    expect((await capsules.list(1)).jobs.find((job) => job.id === exported.job.id)?.status).toBe('ready');
    const downloaded = await capsules.download(exported.job.id, 1, request, credentials);
    const destination = path.join(directory, 'downloaded-capture.orbis-tm');
    const file = await fs.open(destination, 'wx', 0o600);
    try {
      for await (const bytes of downloaded.stream) await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    expect((await fs.stat(destination)).size).toBe(downloaded.bytes);
    const imported = await capsules.createImport(1, request, credentials);
    const source = await fs.open(destination, 'r');
    await capsules.upload(imported.id, 1, source.createReadStream({ autoClose: true }), String(downloaded.bytes), new AbortController().signal);
    const review = await capsules.review(imported.id, 1, request, credentials, 'fixture portable archive password');
    review.start();
    await vi.waitFor(async () => expect((await capsules.list(1)).jobs.find((job) => job.id === imported.id)?.status).not.toBe('verifying'), {
      timeout: 20000,
    });
    expect((await capsules.list(1)).jobs.find((job) => job.id === imported.id)?.status).toBe('verified');
    expect((await capsules.list(1)).jobs.every((job) => job.restoreSupported === false)).toBe(true);
    expect(JSON.stringify(await capsules.list(1))).not.toContain('pointKey');
    expect(restores.prepareRetained).not.toHaveBeenCalled();
    expect((await machine.inspect(point.id, 1)).status).toBe('sealed');
  } finally {
    await capsules.onModuleDestroy();
  }
}, 30000);

it('blocks remove/capture/restore admission during an export and cancels the private callback on shutdown', async () => {
  const point = await capture();
  auth.operatorActionContext.mockResolvedValue({ userId: 1, sessionBinding: 'a'.repeat(64), securityBinding: 'b'.repeat(64) });
  let entered = false;
  const exported = machine.withPortablePoint(point.id, 1, {} as Request, credentials, new AbortController().signal, async (value) => {
    for await (const _bytes of value.source) {
      /* Consume the already authenticated archive before the cancellation gate. */
    }
    entered = true;
    await new Promise<void>((_resolve, reject) =>
      value.signal.addEventListener('abort', () => reject(new Error('fixture export cancelled')), { once: true }),
    );
  });
  const result = exported.catch((error) => error);
  await vi.waitFor(() => expect(entered).toBe(true));
  await expect(machine.remove(point.id, 1, credentials)).rejects.toThrow();
  await expect(machine.capture(1, credentials, { experimentalAcknowledged: true, label: 'blocked' })).rejects.toThrow();
  await expect(machine.restoreReview(point.id, 1)).rejects.toThrow();
  await expect(machine.activate(point.id, 1, credentials, 'a'.repeat(64))).rejects.toThrow();
  await machine.onModuleDestroy();
  expect(await result).toBeInstanceOf(Error);
});

it('does not expose an export callback after the operator security context changes during fresh authentication', async () => {
  const point = await capture();
  const actor = { userId: 1, sessionBinding: 'a'.repeat(64), securityBinding: 'b'.repeat(64) };
  auth.operatorActionContext.mockResolvedValueOnce(actor).mockResolvedValueOnce({ ...actor, securityBinding: 'c'.repeat(64) });
  const consume = vi.fn();
  await expect(machine.withPortablePoint(point.id, 1, {} as Request, credentials, new AbortController().signal, consume)).rejects.toThrow();
  expect(consume).not.toHaveBeenCalled();
});

it('captures encrypted point-bound app icons and never substitutes a later installed image', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGPUiHJjYGBgYmBgYGBgAAAJbADMvnADbQAAAABJRU5ErkJggg==', 'base64');
  const file = path.join(data, 'apps', 'store', 'fixture', 'metadata', 'logo.jpg');
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, png, { mode: 0o600 });
  const point = await capture();
  const asset = point.metadata?.preview.available ? point.metadata.preview.appIcons : undefined;
  expect(point.status).toBe('sealed');
  if (!asset) throw new Error('Missing captured icons');
  expect(asset.icons[0]?.urn).toBe('fixture:store');
  expect(JSON.stringify(asset)).not.toContain(png.toString('base64'));
  await fs.writeFile(file, Buffer.concat([png, Buffer.from('later-image')]));
  expect(JSON.parse((await machine.appIcons(point.id, 1, asset.identity)).toString()).icons[0].data).toBe(png.toString('base64'));
  await expect(machine.appIcons(point.id, 2, asset.identity)).rejects.toThrow();
  await expect(machine.appIcons(point.id, 1, '0'.repeat(64))).rejects.toThrow();
  const cipher = path.join(root(), 'points', point.id, 'icons.orbis');
  const encrypted = await fs.readFile(cipher);
  expect(encrypted.subarray(0, 8).toString()).toBe('ORBISBK1');
  expect(encrypted.includes(png)).toBe(false);
  encrypted[encrypted.length - 1] = (encrypted[encrypted.length - 1] ?? 0) ^ 1;
  await fs.writeFile(cipher, encrypted);
  await expect(machine.appIcons(point.id, 1, asset.identity)).rejects.toMatchObject({ response: { code: 'point-integrity-failed' } });
});

it('fails an icon publication safely on filesystem exhaustion and preserves source app data', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGPUiHJjYGBgYmBgYGBgAAAJbADMvnADbQAAAABJRU5ErkJggg==', 'base64');
  const logo = path.join(data, 'apps', 'store', 'fixture', 'metadata', 'logo.jpg');
  await fs.mkdir(path.dirname(logo), { recursive: true, mode: 0o700 });
  await fs.writeFile(logo, png, { mode: 0o600 });
  const link = fs.link;
  vi.spyOn(fs, 'link').mockImplementation(async (source, destination) => {
    if (String(destination).endsWith('/icons.orbis')) throw Object.assign(new Error('Fixture exhausted storage'), { code: 'ENOSPC' });
    return link(source, destination);
  });
  const point = await capture();
  expect(point.status).toBe('failed');
  expect(point.metadata).toBeNull();
  expect(runtime.resume).toHaveBeenCalled();
  expect(await fs.readFile(logo)).toEqual(png);
  expect(await fs.readFile(path.join(directory, 'app-data', 'document'), 'utf8')).toBe('fixture application content');
  expect(await fs.readdir(path.join(root(), 'points', point.id))).toEqual(['point.json']);
});

it('requires a private point-bound provisional review and unchanged protected contract before authorization', async () => {
  const point = await capture();
  await machine.restoreReview(point.id, 1);
  const original = await reviewed(point.id);
  const internal = machine as unknown as {
    reviews: Map<string, { value: typeof original; importExpiresAt: number; restoreContractSha256?: string }>;
    authorizationBinding(id: string, owner: number, reviewId: string): Promise<unknown>;
  };
  const local = internal.reviews.get(point.id);
  if (!local) throw new Error('Review missing');
  local.value = {
    ...original,
    status: 'eligible',
    ready: false,
    blockers: [],
    expiresAt: local.importExpiresAt,
    progress: { stage: 'checking', completedBytes: 0, totalBytes: null },
  };
  await expect(internal.authorizationBinding(point.id, 1, original.reviewId)).rejects.toMatchObject({ response: { code: 'review-required' } });
  local.restoreContractSha256 = 'a'.repeat(64);
  const capability = vi.spyOn(connected.runtime, 'requireV6RestoreCapability').mockResolvedValue({ contractSha256: 'a'.repeat(64) } as never);
  await expect(internal.authorizationBinding(point.id, 1, original.reviewId)).resolves.toMatchObject({
    pointId: point.id,
    reviewId: original.reviewId,
  });
  await expect(internal.authorizationBinding(point.id, 2, original.reviewId)).rejects.toThrow();
  await expect(internal.authorizationBinding(point.id, 1, randomUUID())).rejects.toThrow();
  authorization.password.mockRejectedValueOnce(new Error('Authentication failed'));
  await expect(machine.restoreAuthVerify(point.id, 1, {} as Request, original.reviewId, 'password', credentials)).rejects.toThrow(
    'Authentication failed',
  );
  expect(restores.prepareRetained).not.toHaveBeenCalled();
  expect(restores.beginRetainedRoot).not.toHaveBeenCalled();
  capability.mockResolvedValueOnce({ contractSha256: 'b'.repeat(64) } as never);
  await expect(internal.authorizationBinding(point.id, 1, original.reviewId)).rejects.toMatchObject({
    response: { code: 'image-state-unavailable' },
  });
  capability.mockRejectedValueOnce(new Error('Unavailable'));
  await expect(internal.authorizationBinding(point.id, 1, original.reviewId)).rejects.toMatchObject({
    response: { code: 'image-state-unavailable' },
  });
  restores.prepareRetained.mockResolvedValueOnce({ state: { id: randomUUID() } });
  restores.beginRetainedRoot.mockImplementationOnce(async (options) => {
    capability.mockResolvedValueOnce({ contractSha256: 'b'.repeat(64) } as never);
    await options.verifyAccount();
  });
  await expect(
    machine.activateAuthorized(point.id, 1, {} as Request, original.reviewId, randomUUID(), original.manifestSha256),
  ).rejects.toMatchObject({ response: { code: 'image-state-unavailable' } });
  expect(restores.beginRetainedRoot).toHaveBeenCalledOnce();
  restores.prepareRetained.mockResolvedValueOnce({ state: { id: randomUUID() } });
  restores.beginRetainedRoot.mockImplementationOnce(async (options) => {
    local.value = { ...local.value, expiresAt: Date.now() - 1 };
    await options.verifyAccount();
  });
  await expect(
    machine.activateAuthorized(point.id, 1, {} as Request, original.reviewId, randomUUID(), original.manifestSha256),
  ).rejects.toMatchObject({ response: { code: 'review-expired' } });
  local.value = { ...local.value, expiresAt: Date.now() - 1 };
  await expect(internal.authorizationBinding(point.id, 1, original.reviewId)).rejects.toMatchObject({ response: { code: 'review-expired' } });
});

it('removes an ordinary point with the current session by default and enforces the opted-in backup policy', async () => {
  await machine.list(1);
  const first = await store().create(1);
  await store().fail(first.point, 'capture-failed');
  await machine.removeForSession(first.point.id, 1, {} as Request);
  expect(auth.verifySensitiveAction).not.toHaveBeenCalled();
  const second = await store().create(1);
  await new AccountSecurityService(config as never).update(1, { expectedRevision: 0, requireCaptureAuthentication: true }, async () => undefined);
  await expect(machine.removeForSession(second.point.id, 1, {} as Request)).rejects.toThrow('account password');
  expect(await store().load(second.point.id)).toBeDefined();
});
it('reset presentation hides ordinary old Time Machine references while preserving actual interrupted recovery blockers', async () => {
  await machine.list(1);
  const old = await store().create(1);
  await store().fail(old.point, 'capture-failed');
  const recovery = await store().create(1);
  await store().update({ ...recovery.point, status: 'interrupted', issue: 'capture-interrupted' });
  await new ResetState(data).save({
    version: 1,
    id: randomUUID(),
    controller: 'fixture',
    users: [1],
    accounts: 'keep',
    phase: 'complete',
    createdAt: Date.now() + 10,
  });
  const listed = await machine.list(1);
  expect(listed.points.map((point) => point.id)).toEqual([recovery.point.id]);
  expect((await store().load(old.point.id)).status).toBe('failed');
  expect((await store().load(recovery.point.id)).status).toBe('interrupted');
});
