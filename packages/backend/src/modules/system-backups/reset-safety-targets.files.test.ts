import { createHash, randomUUID } from 'node:crypto';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { Request } from 'express';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { withBackupMaintenanceLease, type BackupMaintenanceLease } from '@/common/backup-maintenance-lease';
import { backupDiskActive } from '@/common/backup-disk';
import { user, link } from '@/core/database/drizzle/schema';
import { defaultTimeMachinePreferences } from '@runtipi/common/schemas/time-machine';
import { PasskeyStore, type PasskeyState } from '../auth/passkey.store';
import { settingsBackupSelectionSchema } from '@runtipi/common/schemas/settings-backup';
import { DesktopPreferencesService, DEFAULT_DESKTOP_PREFERENCES } from '../desktop-preferences/desktop-preferences.service';
import { DesktopWallpaperService } from '../desktop-preferences/desktop-wallpaper.service';
import { ThemePacksService } from '../theme-packs/theme-packs.service';
import { ThemeSettingsService } from '../theme-settings/theme-settings.service';
import { resetTargetNames, type ResetJournal } from '../system-reset/reset-contract';
import { decryptBackup } from './backup-crypto';
import { stabilizeDarwinFixtureCreation, stabilizeExistingDarwinFixtures } from './darwin-files.fixture';
import { planResetSafetyExports } from './reset-safety-plan';
import { writeResetSafetyTargets, withResetSafetyTargets, type ResetSafetyTargetsOptions } from './reset-safety-targets';
import { prepareResetSafetyArchive, prepareResetSafetyArchiveFromInventory, type ResetSafetyPreparationOptions } from './reset-safety-preparation';
import { TimeMachineService } from './time-machine.service';
import { TimeMachineStore } from './time-machine-store';
import { TimeMachineComponentsStore } from './time-machine-components-store';
import { SettingsBackupSourceService } from './settings-backup-source.service';
import { resetSafetyArchivePath, verifyResetSafetyArchiveCommitment } from './reset-safety-commitment';
import { ResetBackupKeyCustody } from './reset-backup-key-custody';
import { inspectResetSafetyArchive } from './reset-safety-archive';
import {
  authorizeSettingsPasswordExport,
  verifyResetExportProof,
  withResetExportAccess,
  withSettingsExportAccess,
  type ResetExportPlan,
  type ResetExportProof,
  type ResetInventoryAccess,
  type SettingsExportAccess,
} from './settings-export-authorization';

const nativePlatform = process.platform;
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
let root: string;
let dataDir: string;
let directory: string;
let journal: ResetJournal;
let plan: ResetExportPlan;
let current: { userId: number; sessionBinding: string; securityBinding: string };
let afterRead: ((file: string) => Promise<void>) | undefined;
let afterOpenDirectory: ((file: string) => Promise<void>) | undefined;
let differentMount: string | undefined;
let independentStateMount: boolean;
let foreignTarget: string | undefined;
let observed: string[];
let restoreCreation: () => void;
const auth = { operatorActionContext: vi.fn(), verifySensitiveAction: vi.fn() };
const passkeys = { verifySensitive: vi.fn() };
const signal = () => AbortSignal.timeout(20_000);
const passphrase = 'fixture target archive secret';

// Darwin has no directory traversal through /dev/fd. This models Linux proc-fd
// resolution for real fixture handles; it is not evidence of a native Linux run.
function modelProcDescriptors() {
  if (nativePlatform === 'linux') return;
  const opened = new Map<number, string>();
  const original = {
    open: fs.open.bind(fs),
    stat: fs.stat.bind(fs),
    lstat: fs.lstat.bind(fs),
    opendir: fs.opendir.bind(fs),
    readFile: fs.readFile.bind(fs),
    rename: fs.rename.bind(fs),
    unlink: fs.unlink.bind(fs),
  };
  const translated = (file: unknown): string => {
    const value = String(file);
    const match = /^\/proc\/self\/fd\/(\d+)(\/.*)?$/.exec(value);
    if (!match) return value;
    const base = opened.get(Number(match[1]));
    if (!base) throw new Error('Unknown fixture descriptor');
    return `${base}${match[2] ?? ''}`;
  };
  vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
    const resolved = translated(file);
    observed.push(resolved);
    const handle = await original.open(resolved, flags, mode);
    opened.set(handle.fd, resolved);
    const read = handle.read.bind(handle);
    vi.spyOn(handle, 'read').mockImplementation((async (...args: Parameters<FileHandle['read']>) => {
      const value = await read(...args);
      if (afterRead && resolved.startsWith(`${dataDir}/`)) await afterRead(resolved);
      return value;
    }) as FileHandle['read']);
    return handle;
  });
  vi.spyOn(fs, 'stat').mockImplementation(((file, options) => original.stat(translated(file), options)) as typeof fs.stat);
  vi.spyOn(fs, 'lstat').mockImplementation((async (file, options) => {
    const resolved = translated(file);
    const value = await original.lstat(resolved, options);
    if (resolved === foreignTarget) return Object.assign(Object.create(Object.getPrototypeOf(value)), value, { uid: (process.getuid?.() ?? 0) + 1 });
    return value;
  }) as typeof fs.lstat);
  vi.spyOn(fs, 'opendir').mockImplementation((async (file, options) => {
    const resolved = translated(file);
    observed.push(resolved);
    const result = await original.opendir(resolved, options);
    if (afterOpenDirectory) await afterOpenDirectory(resolved);
    return result;
  }) as typeof fs.opendir);
  vi.spyOn(fs, 'readFile').mockImplementation(((file, options) => {
    const match = /^\/proc\/self\/fdinfo\/(\d+)$/.exec(String(file));
    if (match) {
      const name = opened.get(Number(match[1])) ?? '';
      const inState = name === path.join(dataDir, 'state') || name.startsWith(`${dataDir}/state/`);
      const mount = name === differentMount ? '3' : independentStateMount && inState ? '2' : '1';
      return Promise.resolve(`mnt_id:\t${mount}\n`);
    }
    return original.readFile(translated(file), options);
  }) as typeof fs.readFile);
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    const source = translated(from);
    const destination = translated(to);
    await original.rename(source, destination);
    for (const [fd, value] of opened)
      if (value === source || value.startsWith(`${source}/`)) opened.set(fd, `${destination}${value.slice(source.length)}`);
  });
  vi.spyOn(fs, 'unlink').mockImplementation((file) => original.unlink(translated(file)));
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
}

async function put(name: string, value: string) {
  const file = path.join(dataDir, name);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, value, { mode: 0o600 });
}

beforeEach(async () => {
  if (!process.env.TMPDIR) throw new Error('Project-scoped TMPDIR required');
  root = await fs.realpath(await fs.mkdtemp(path.join(process.env.TMPDIR, 'reset-targets-')));
  dataDir = path.join(root, 'source');
  directory = path.join(root, 'encrypted');
  await fs.mkdir(dataDir, { mode: 0o700 });
  await fs.mkdir(directory, { mode: 0o700 });
  journal = { version: 1, id: randomUUID(), controller: 'fixture', accounts: 'remove', users: [7, 8], phase: 'prepared', createdAt: Date.now() };
  plan = planResetSafetyExports({ resetId: journal.id, accounts: journal.accounts, users: journal.users, captures: [] }).plan;
  current = { userId: 7, sessionBinding: 'a'.repeat(64), securityBinding: 'b'.repeat(64) };
  auth.operatorActionContext.mockImplementation(async () => ({ ...current }));
  auth.verifySensitiveAction.mockResolvedValue({ operator: true });
  passkeys.verifySensitive.mockResolvedValue(undefined);
  afterRead = undefined;
  afterOpenDirectory = undefined;
  differentMount = undefined;
  independentStateMount = false;
  foreignTarget = undefined;
  observed = [];
  await put('state/desktop/7.json', '{"serverName":"saved"}');
  await put('state/onboarding/7.json', '{"version":1}');
  await put('state/theme-settings/7.json', '{"version":1}');
  await put('state/theme-packs/7/nested/asset.bin', 'theme image');
  await put('state/wallpapers/7.image', 'current wallpaper');
  await put('state/wallpapers/7.image.saved', 'saved wallpaper');
  await put('.orbis-onboarding-origin.json', '{"version":1,"source":"runtipi"}');
  await put('state/password-change-request', 'old authorization evidence');
  await put('app-data/private/media', 'never traverse');
  await put('backups/private/archive', 'never traverse');
  await put('state/auth/private/key', 'never traverse');
  stabilizeExistingDarwinFixtures(dataDir);
  restoreCreation = stabilizeDarwinFixtureCreation(() => root);
  modelProcDescriptors();
});
afterEach(async () => {
  vi.restoreAllMocks();
  restoreCreation();
  if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor);
  await fs.rm(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

async function authorized<T>(work: (options: ResetSafetyTargetsOptions) => Promise<T>, value = plan) {
  const proof = await verifyResetExportProof(auth as never, passkeys as never, {} as Request, value.accounts, {
    method: 'passkey',
    challengeId: randomUUID(),
    response: {},
  });
  const abort = signal();
  return withBackupMaintenanceLease(abort, (lease) =>
    withResetExportAccess(proof, value, lease, abort, (access) =>
      work({ dataDir, directory, journal, plan: value, access, lease, signal: abort, passphrase }),
    ),
  );
}

async function preparationFixture(context: ResetSafetyTargetsOptions) {
  // Replace this test's arbitrary byte targets with real settings-service state.
  await fs.rm(path.join(dataDir, 'state'), { recursive: true });
  const server = {
    advancedSettings: false,
    allowAutoThemes: true,
    allowErrorMonitoring: false,
    guestDashboard: true,
    themeBase: 'dark',
    themeColor: 'blue',
  };
  const config = {
    get: (key: string) => {
      if (key === 'directories') return { dataDir };
      if (key === 'userSettings') return server;
      if (key === 'version') return '0.8.0-beta.1';
      if (key === 'architecture') return 'arm64';
      throw new Error('Unexpected synthetic configuration key');
    },
  };
  const desktop = new DesktopPreferencesService(config as never);
  const wallpaper = new DesktopWallpaperService(config as never, desktop);
  const packs = new ThemePacksService(config as never);
  const themes = new ThemeSettingsService(config as never, packs, desktop);
  for (const id of journal.users) {
    await desktop.write(id, { ...DEFAULT_DESKTOP_PREFERENCES, serverName: `Saved ${id}` });
    await packs.backupSnapshot(id);
    await themes.backupSnapshot(id);
  }
  const rows = journal.users.map((id) => ({
    id,
    username: `synthetic-${id}`,
    operator: id === 7,
    locale: 'en',
    hasSeenWelcome: true,
    createdAt: 1,
    updatedAt: 2,
    password: '$argon2id$v=19$m=65536,t=3,p=4$YWJjZGVmZ2hpamtsbW5vcA$YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo',
    totpEnabled: false,
    totpSecret: null,
    salt: null,
  }));
  const transaction = vi.fn(async (work: (tx: unknown) => Promise<unknown>, settings: unknown) => {
    expect(settings).toEqual({ isolationLevel: 'repeatable read', accessMode: 'read only' });
    return work({
      select: (columns: Record<string, unknown>) => ({
        from: (table: unknown) => {
          expect(table === user || table === link).toBe(true);
          const records = table === user ? rows : [];
          if ('count' in columns) return Promise.resolve([{ count: String(records.length), bytes: String(records.length * 512) }]);
          return {
            orderBy: () => ({
              limit: () =>
                Promise.resolve(
                  structuredClone(records.map((row) => Object.fromEntries(Object.keys(columns).map((key) => [key, row[key as keyof typeof row]])))),
                ),
            }),
          };
        },
      }),
    });
  });
  let cohortHeld = false;
  const cohortTransaction = vi.fn(async (work: (tx: unknown) => Promise<unknown>, settings: unknown) => {
    expect(settings).toEqual({ isolationLevel: 'read committed', accessMode: 'read write' });
    try {
      return await work({
        execute: async () => {
          expect(cohortHeld).toBe(false);
          cohortHeld = true;
        },
        select: (columns: Record<string, unknown>) => ({
          from: (table: unknown) => {
            expect(table).toBe(user);
            expect(Object.keys(columns)).toEqual(['id']);
            return { orderBy: () => ({ limit: () => Promise.resolve(rows.map(({ id }) => ({ id }))) }) };
          },
        }),
      });
    } finally {
      cohortHeld = false;
    }
  });
  let fenced = false;
  const machine = {
    withResetPreferencesSnapshot: async (
      _context: unknown,
      work: (preferences: ReturnType<typeof defaultTimeMachinePreferences>) => Promise<unknown>,
    ) => {
      expect(fenced).toBe(false);
      fenced = true;
      try {
        return await work(defaultTimeMachinePreferences());
      } finally {
        fenced = false;
      }
    },
  };
  const profiles = new SettingsBackupSourceService(config as never, auth as never, desktop, wallpaper, packs, themes, machine as never, {} as never);
  const actualWrite = profiles.writeForReset.bind(profiles);
  const write: typeof actualWrite = async (...args) => {
    // The proc-fd model needs Linux admission; native BSD tar still needs Darwin's --no-fflags.
    if (nativePlatform !== 'linux') Object.defineProperty(process, 'platform', { value: nativePlatform, configurable: true });
    try {
      return await actualWrite(...args);
    } finally {
      if (nativePlatform !== 'linux') Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    }
  };
  const writes = vi.spyOn(profiles, 'writeForReset').mockImplementation(async (...args) => {
    expect(fenced).toBe(true);
    expect(cohortHeld).toBe(true);
    return write(...args);
  });
  const settings = { orbis: { enabled: false, mode: 'idle' }, schedule: { time: '03:00', timezone: 'UTC' } };
  const credentialStore = new PasskeyStore(config as never);
  const dependencies = {
    database: {
      transaction: (work: (tx: unknown) => Promise<unknown>, settings: { accessMode: string }) =>
        settings.accessMode === 'read write' ? cohortTransaction(work, settings) : transaction(work, settings),
    },
    config,
    machine,
    profiles,
    automatic: {
      snapshotForReset: async () => ({
        state: { version: 1, revision: 0, settings, rules: {}, apps: {}, orbis: null, pauseReason: null },
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
        policy: null,
      }),
    },
    cluster: { read: async () => ({ id: '00000000-0000-4000-8000-000000000005', invite: null }) },
    sync: {
      read: async () => ({
        version: 1,
        hostId: '00000000-0000-4000-8000-000000000005',
        revision: 0,
        receiving: { revision: 0, userId: null, categories: [], trustRevision: null },
        plans: [],
        receipts: {},
      }),
    },
    passkeys: credentialStore,
    encryption: {
      decrypt: () => {
        throw new Error('No TOTP ciphertext in this fixture');
      },
    },
  };
  const options = {
    ...context,
    ...dependencies,
    backupId: randomUUID(),
    createdAt: new Date().toISOString(),
    orbisVersion: '0.8.0-beta.1',
  } as unknown as ResetSafetyPreparationOptions;
  return {
    options,
    credentialStore,
    writes,
    write,
    rows,
    server,
    desktop,
    wallpaper,
    packs,
    themes,
    config,
    fenced: () => fenced,
    cohortHeld: () => cohortHeld,
    transaction,
    cohortTransaction,
  };
}

async function connectedPreparationFixture(context: ResetSafetyTargetsOptions) {
  const fixture = await preparationFixture(context);
  const machine = new TimeMachineService(
    fixture.config as never,
    {} as never,
    auth as never,
    { warn: vi.fn() } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { recoverCaptureFences: vi.fn(async () => {}) } as never,
  );
  const profiles = new SettingsBackupSourceService(
    fixture.config as never,
    auth as never,
    fixture.desktop,
    fixture.wallpaper,
    fixture.packs,
    fixture.themes,
    machine,
    {} as never,
  );
  const write = profiles.writeForReset.bind(profiles);
  const writes = vi.spyOn(profiles, 'writeForReset').mockImplementation(async (...args) => {
    expect(fixture.cohortHeld()).toBe(true);
    const { version: _version, revision, ...preferences } = defaultTimeMachinePreferences();
    await expect(machine.updatePreferences({ ...preferences, expectedRevision: revision })).rejects.toMatchObject({
      response: { code: 'operation-busy' },
    });
    if (nativePlatform !== 'linux') Object.defineProperty(process, 'platform', { value: nativePlatform, configurable: true });
    try {
      return await write(...args);
    } finally {
      if (nativePlatform !== 'linux') Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    }
  });
  await machine.onModuleInit();
  const points = new TimeMachineStore(dataDir);
  const { point } = await points.create(19, 1);
  await points.fail(point, 'capture-failed');
  const components = new TimeMachineComponentsStore(dataDir);
  const selected = await components.create(23, point.id, point.id, 'a'.repeat(64), {
    version: 1,
    reviewId: randomUUID(),
    reviewSha256: 'b'.repeat(64),
    apps: [{ urn: 'fixture:store', mountIds: ['c'.repeat(64)] }],
  });
  await components.interrupted(selected);
  await fs.writeFile(path.join(dataDir, 'backups/time-machine/points', point.id, 'archive.partial'), 'original failed capture payload', {
    mode: 0o600,
  });
  stabilizeExistingDarwinFixtures(dataDir);
  const originalKey = await fs.readFile(path.join(dataDir, 'backups/time-machine/keys/master-v1.key'));
  const verifications = auth.verifySensitiveAction.mock.calls.length;
  const proof = await verifyResetExportProof(auth as never, passkeys as never, {} as Request, context.plan.accounts, {
    method: 'password',
    password: 'synthetic password',
  });
  return { fixture, machine, profiles, writes, points, point, originalKey, verifications, options: { ...fixture.options, machine, profiles, proof } };
}

it('refuses a busy database cohort before creating reset backup staging or reserving a recovery key', async () => {
  await authorized(async (context) => {
    const fixture = await preparationFixture(context);
    const options = {
      ...fixture.options,
      database: {
        transaction: async (work: (tx: unknown) => Promise<unknown>) =>
          work({
            execute: async () => {
              throw Object.assign(new Error('Fixture writer'), { code: '55P03' });
            },
          }),
      } as never,
    };
    await expect(prepareResetSafetyArchive(options)).rejects.toMatchObject({ code: 'busy' });
    expect(fixture.writes).not.toHaveBeenCalled();
    await expect(fs.lstat(path.join(dataDir, 'backups/reset-safety'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

it.each(['keep', 'remove'] as const)(
  'derives the version2 archive from raw orphan/equal-ID captures and retains its fence for %s accounts',
  async (accounts) => {
    journal.accounts = accounts;
    plan = planResetSafetyExports({ resetId: journal.id, accounts, users: journal.users, captures: [] }).plan;
    await authorized(async (context) => {
      const { fixture, machine, profiles, writes, point, originalKey, verifications, options } = await connectedPreparationFixture(context);
      try {
        const receipt = await prepareResetSafetyArchiveFromInventory(options);
        expect(receipt.users).toEqual([7, 8]);
        expect(receipt.accounts).toBe(accounts);
        expect(writes.mock.calls.map(([options]) => options.ownerId)).toEqual([7, 8]);
        expect(auth.verifySensitiveAction).toHaveBeenCalledTimes(verifications + 1);
        expect(fixture.transaction).toHaveBeenCalledTimes(3);
        expect(fixture.cohortTransaction).toHaveBeenCalledTimes(1);
        expect(await fs.readFile(resetSafetyArchivePath(dataDir, receipt.backupId))).toBeInstanceOf(Buffer);
        expect(writes.mock.calls.every(([value]) => settingsBackupSelectionSchema.assert(value.selection).timeMachine.length === 0)).toBe(true);
        const keyCipher = path.join(root, 'preserved-master-key.orbis');
        await new ResetBackupKeyCustody(dataDir).withSealed(
          { resetId: journal.id, backupId: receipt.backupId, selectionSha256: receipt.selectionSha256, users: [...receipt.users] },
          { archiveBytes: receipt.bytes, archiveSha256: receipt.sha256 },
          async (secret) => {
            const opened = await inspectResetSafetyArchive({
              source: resetSafetyArchivePath(dataDir, receipt.backupId),
              directory: path.join(root, 'inspect-connected-v2'),
              passphrase: secret,
              signal: context.signal,
              inspectors: (directory) => profiles.inspectors(secret, directory),
              stageVerifiedPart: async (artifact, file) => {
                if (artifact.role === 'capture' && artifact.name === 'keys/master-v1.key') await fs.copyFile(file, keyCipher);
              },
            });
            expect(opened.manifest.version).toBe(2);
            expect(opened.manifest.captures?.inventory.captures.map((record) => [record.kind, record.sourceOwnerId])).toEqual([
              ['components', 23],
              ['core', 19],
            ]);
            expect(opened.manifest.fullScopeSha256).toBe(receipt.fullScopeSha256);
            expect(opened.sha256).toBe(receipt.sha256);
            expect(opened.state.users.map((user) => user.id)).toEqual([7, 8]);
            expect(opened.state.credentials?.users.length ?? null).toBe(accounts === 'remove' ? 2 : null);
            const recovered = path.join(root, 'preserved-master-key');
            await decryptBackup({ source: keyCipher, destination: recovered, passphrase: secret, signal: context.signal });
            expect(await fs.readFile(recovered)).toEqual(originalKey);
          },
        );
        expect(await fs.readFile(path.join(dataDir, 'backups/time-machine/points', point.id, 'archive.partial'), 'utf8')).toBe(
          'original failed capture payload',
        );
        expect(await fs.readFile(path.join(dataDir, 'backups/time-machine/keys/master-v1.key'))).toEqual(originalKey);
        expect(backupDiskActive()).toBe(false);
      } finally {
        await machine.onModuleDestroy();
      }
    });
  },
  20_000,
);

it('rejects forged raw inventory authority before allocating a recovery key or reading raw sources', async () => {
  await authorized(async (context) => {
    const fixture = await preparationFixture(context);
    const inventory = vi.fn(async () => {
      throw new Error('Raw inventory must remain unopened');
    });
    const recovery = vi.fn(async () => {
      throw new Error('Raw files must remain unopened');
    });
    const preferences = vi.fn(async () => {
      throw new Error('Preferences must remain unopened');
    });
    const machine = {
      ...fixture.options.machine,
      resetCaptureInventory: inventory,
      withResetCaptureRecoveryFiles: recovery,
      withResetCapturePreferencesSnapshot: preferences,
    };
    await expect(prepareResetSafetyArchiveFromInventory({ ...fixture.options, machine, proof: {} as ResetExportProof })).rejects.toThrow();
    await expect(
      prepareResetSafetyArchive({
        ...fixture.options,
        machine,
        rawCaptures: { access: {} as ResetInventoryAccess, inventorySha256: 'a'.repeat(64) },
      }),
    ).rejects.toThrow();
    expect(inventory).not.toHaveBeenCalled();
    expect(recovery).not.toHaveBeenCalled();
    expect(preferences).not.toHaveBeenCalled();
    expect(fixture.writes).not.toHaveBeenCalled();
    await expect(fs.lstat(path.join(dataDir, 'backups/reset-keys'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(path.dirname(path.dirname(resetSafetyArchivePath(dataDir, fixture.options.backupId))))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

it('withholds v2 readiness when raw inventory changes after pre-plan admission', async () => {
  await authorized(async (context) => {
    const { fixture, machine, writes, points, originalKey, options } = await connectedPreparationFixture(context);
    const inventory = machine.resetCaptureInventory.bind(machine);
    vi.spyOn(machine, 'resetCaptureInventory').mockImplementationOnce(async (...args) => {
      const before = await inventory(...args);
      const added = await points.create(31, 1);
      await points.fail(added.point, 'capture-failed');
      return before;
    });
    try {
      await expect(prepareResetSafetyArchiveFromInventory(options)).rejects.toThrow();
      expect(writes).not.toHaveBeenCalled();
      expect(fixture.transaction).not.toHaveBeenCalled();
      const archive = resetSafetyArchivePath(dataDir, options.backupId);
      await expect(fs.lstat(archive)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await fs.readdir(path.dirname(path.dirname(archive)))).toContain(`.prepare-${options.backupId}`);
      expect(await fs.readdir(path.join(dataDir, 'backups/reset-keys', options.backupId))).toContain('record.json');
      expect(await fs.readFile(path.join(dataDir, 'backups/time-machine/keys/master-v1.key'))).toEqual(originalKey);
      expect(await points.list()).toHaveLength(2);
      expect(backupDiskActive()).toBe(false);
    } finally {
      await machine.onModuleDestroy();
    }
  });
}, 20_000);

it('withholds v2 readiness after a source-key identity replacement and retains archive, key and raw staging', async () => {
  await authorized(async (context) => {
    const { machine, writes, point, originalKey, options } = await connectedPreparationFixture(context);
    const write = writes.getMockImplementation();
    if (!write) throw new Error('Missing connected profile writer');
    writes.mockImplementationOnce(async (...args) => {
      const result = await write(...args);
      const replacement = path.join(root, 'same-bytes-replacement-key');
      await fs.writeFile(replacement, originalKey, { mode: 0o600 });
      await fs.rename(replacement, path.join(dataDir, 'backups/time-machine/keys/master-v1.key'));
      return result;
    });
    let released = false;
    try {
      await expect(
        prepareResetSafetyArchiveFromInventory(options).then((receipt) => {
          released = true;
          return receipt;
        }),
      ).rejects.toThrow();
      expect(released).toBe(false);
      expect(writes).toHaveBeenCalledTimes(2);
      const archive = resetSafetyArchivePath(dataDir, options.backupId);
      expect((await fs.lstat(archive)).size).toBeGreaterThan(0);
      const store = path.dirname(path.dirname(archive));
      const raw = path.join(store, `.prepare-${options.backupId}`, 'raw-captures');
      expect((await fs.readdir(raw)).length).toBeGreaterThan(0);
      expect(await fs.readdir(path.join(dataDir, 'backups/reset-keys', options.backupId))).toContain('record.json');
      expect(await fs.readFile(path.join(dataDir, 'backups/time-machine/keys/master-v1.key'))).toEqual(originalKey);
      expect(await fs.readFile(path.join(dataDir, 'backups/time-machine/points', point.id, 'archive.partial'), 'utf8')).toBe(
        'original failed capture payload',
      );
      expect(backupDiskActive()).toBe(false);
    } finally {
      await machine.onModuleDestroy();
    }
  });
}, 20_000);

it.each(['keep', 'remove'] as const)(
  'assembles real profiles, exact files, state, archive and sealed key for %s accounts under continuing fences',
  async (accounts) => {
    journal.accounts = accounts;
    plan = planResetSafetyExports({ resetId: journal.id, accounts, users: journal.users, captures: [] }).plan;
    await authorized(async (context) => {
      const fixture = await preparationFixture(context);
      const receipt = await prepareResetSafetyArchive(fixture.options);
      expect(fixture.writes.mock.calls.map(([value]) => value.ownerId)).toEqual([7, 8]);
      expect(fixture.transaction).toHaveBeenCalledTimes(3);
      expect(fixture.fenced()).toBe(false);
      expect(backupDiskActive()).toBe(false);
      expect(Object.isFrozen(receipt)).toBe(true);
      expect(receipt.users).toEqual([7, 8]);
      expect(receipt.accounts).toBe(accounts);
      expect(JSON.stringify(receipt)).not.toContain('argon2');
      expect(await fs.readdir(path.dirname(path.dirname(resetSafetyArchivePath(dataDir, receipt.backupId))))).toEqual([receipt.backupId]);
      const verified = await verifyResetSafetyArchiveCommitment({
        ...context,
        backupId: receipt.backupId,
        commitment: receipt,
        inspectors: (directory, secret) => fixture.options.profiles.inspectors(secret, directory),
      });
      expect(verified).toEqual(receipt);
      const custody = new ResetBackupKeyCustody(dataDir);
      await custody.withSealed(
        { resetId: plan.resetId, backupId: receipt.backupId, users: [...receipt.users], selectionSha256: receipt.selectionSha256 },
        { archiveSha256: receipt.sha256, archiveBytes: receipt.bytes },
        async (secret) => {
          const saved = await inspectResetSafetyArchive({
            source: resetSafetyArchivePath(dataDir, receipt.backupId),
            directory: path.join(root, 'inspect-prepared'),
            passphrase: secret,
            signal: context.signal,
            inspectors: (directory) => fixture.options.profiles.inspectors(secret, directory),
            expected: { backupId: receipt.backupId, plan, bytes: receipt.bytes, sha256: receipt.sha256 },
          });
          expect(saved.manifest.profiles.map((profile) => profile.ownerId)).toEqual([7, 8]);
          expect(saved.state.users.map((account) => account.id)).toEqual([7, 8]);
          expect(saved.state.credentials?.users.length ?? null).toBe(accounts === 'remove' ? 2 : null);
          const target = saved.manifest.targets.targets.find((target) => target.name === 'desktop/7.json');
          if (target?.type !== 'file') throw new Error('Missing archived desktop');
          expect(target.plaintextSha256).toBe(digest(await fs.readFile(path.join(dataDir, 'state/desktop/7.json'))));
        },
      );
      await expect(prepareResetSafetyArchive(fixture.options)).rejects.toThrow();
      expect(await fs.readFile(path.join(dataDir, 'app-data/private/media'), 'utf8')).toBe('never traverse');
    });
  },
  20_000,
);

it('retains the reserved recovery key and partial exports when a real profile fails', async () => {
  await authorized(async (context) => {
    const fixture = await preparationFixture(context);
    fixture.writes.mockImplementation(async (...args) => {
      if (args[0].ownerId === 8) throw new Error('Synthetic second profile unavailable');
      return fixture.write(...args);
    });
    await expect(prepareResetSafetyArchive(fixture.options)).rejects.toThrow('Synthetic second profile unavailable');
    expect(fixture.fenced()).toBe(false);
    expect(backupDiskActive()).toBe(false);
    const archive = resetSafetyArchivePath(dataDir, fixture.options.backupId);
    await expect(fs.lstat(archive)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readdir(path.dirname(path.dirname(archive)))).toContain(`.prepare-${fixture.options.backupId}`);
    expect(await fs.readdir(path.join(dataDir, 'backups/reset-keys', fixture.options.backupId))).toContain('record.json');
    await expect(prepareResetSafetyArchive(fixture.options)).rejects.toThrow();
    expect((await fixture.desktop.read(7)).serverName).toBe('Saved 7');
  });
}, 20_000);

it('holds real passkey writers throughout complete reset archive preparation', async () => {
  await authorized(async (context) => {
    const fixture = await preparationFixture(context);
    await fixture.credentialStore.change((state) => {
      state.users[7] = { handle: 'synthetic_original', credentials: [] };
    });
    const original = await fixture.credentialStore.snapshot();
    const mutate = vi.fn((state: PasskeyState) => {
      const account = state.users[7];
      if (!account) throw new Error('Missing synthetic passkey account');
      account.handle = 'synthetic_changed';
    });
    fixture.writes.mockImplementation(async (...args) => {
      await expect(fixture.credentialStore.change(mutate)).rejects.toThrow('snapshot');
      return fixture.write(...args);
    });
    const committed = await prepareResetSafetyArchive(fixture.options);
    expect(committed.accounts).toBe('remove');
    expect(mutate).not.toHaveBeenCalled();
    expect(await fixture.credentialStore.snapshot()).toEqual(original);
    await fixture.credentialStore.change(mutate);
    expect(mutate).toHaveBeenCalledOnce();
  });
}, 20_000);

it('withholds a complete archive when an identical passkey file replaces the pinned source during export', async () => {
  await authorized(async (context) => {
    const fixture = await preparationFixture(context);
    await fixture.credentialStore.change((state) => {
      state.users[7] = { handle: 'synthetic_original', credentials: [] };
    });
    const file = path.join(dataDir, 'state/auth/passkeys.json');
    const bytes = await fs.readFile(file);
    fixture.writes.mockImplementation(async (...args) => {
      const result = await fixture.write(...args);
      if (args[0].ownerId === 8) {
        await fs.rename(file, `${file}.retained`);
        await fs.writeFile(file, bytes, { mode: 0o600 });
      }
      return result;
    });
    await expect(prepareResetSafetyArchive(fixture.options)).rejects.toThrow('snapshot');
    expect(await fs.readFile(file)).toEqual(bytes);
    expect(await fs.readFile(resetSafetyArchivePath(dataDir, fixture.options.backupId))).toBeInstanceOf(Buffer);
    await expect(fixture.credentialStore.change(() => undefined)).rejects.toThrow('unavailable');
  });
}, 20_000);

it('rejects an interrupted or mismatched reset journal before creating backup storage', async () => {
  await authorized(async (context) => {
    const fixture = await preparationFixture(context);
    for (const journal of [
      { ...context.journal, phase: 'preferences' as const },
      { ...context.journal, id: randomUUID() },
    ]) {
      await expect(prepareResetSafetyArchive({ ...fixture.options, journal })).rejects.toThrow();
    }
    expect(fixture.writes).not.toHaveBeenCalled();
    expect(fixture.transaction).not.toHaveBeenCalled();
    await expect(fs.lstat(path.join(dataDir, 'backups/reset-safety'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(path.join(dataDir, 'backups/reset-keys'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

it.each(['database', 'target'] as const)(
  'withholds assembled archive readiness if %s changes during actual profile export',
  async (change) => {
    await authorized(async (context) => {
      const fixture = await preparationFixture(context);
      fixture.writes.mockImplementation(async (...args) => {
        const value = await fixture.write(...args);
        if (args[0].ownerId === 8) {
          if (change === 'database') {
            const row = fixture.rows[0];
            if (!row) throw new Error('Missing synthetic account');
            row.username = 'changed';
          } else await fixture.desktop.write(7, { ...DEFAULT_DESKTOP_PREFERENCES, serverName: 'Changed during export' });
        }
        return value;
      });
      await expect(prepareResetSafetyArchive(fixture.options)).rejects.toThrow();
      expect(fixture.fenced()).toBe(false);
      expect(backupDiskActive()).toBe(false);
      const store = path.dirname(path.dirname(resetSafetyArchivePath(dataDir, fixture.options.backupId)));
      expect(await fs.readdir(store)).toContain(`.prepare-${fixture.options.backupId}`);
      expect(await fs.readFile(resetSafetyArchivePath(dataDir, fixture.options.backupId))).toBeInstanceOf(Buffer);
      expect((await fixture.desktop.read(7)).serverName).toBe(change === 'target' ? 'Changed during export' : 'Saved 7');
    });
  },
  20_000,
);

it('encrypts every exact root, absent account target, saved wallpaper and nested theme file without visiting excluded data', async () => {
  const result = await authorized(writeResetSafetyTargets);
  const names = result.targets.map((entry) => entry.name);
  for (const name of resetTargetNames(journal)) expect(names).toContain(name);
  expect(names).toContain('theme-packs/7/nested');
  expect(names).toContain('theme-packs/7/nested/asset.bin');
  expect(result.targets.find((entry) => entry.name === 'desktop/8.json')).toEqual({ name: 'desktop/8.json', type: 'absent' });
  const saved = result.targets.find((entry) => entry.name === 'wallpapers/7.image.saved');
  if (saved?.type !== 'file') throw new Error('Missing saved wallpaper');
  expect(saved.plaintextSha256).toBe(digest('saved wallpaper'));
  expect(digest(await fs.readFile(saved.file))).toBe(saved.sha256);
  const decoded = path.join(root, 'decoded');
  await decryptBackup({ source: saved.file, destination: decoded, passphrase });
  expect(await fs.readFile(decoded, 'utf8')).toBe('saved wallpaper');
  expect(observed.some((file) => /(^|\/)(app-data|backups|auth)(\/|$)/.test(path.relative(dataDir, file)))).toBe(false);
  expect((await fs.readdir(directory)).every((name) => /^[a-f0-9-]{36}\.orbis$/.test(name))).toBe(true);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.users)).toBe(true);
  expect(result.targets.every(Object.isFrozen)).toBe(true);
  expect(passkeys.verifySensitive).toHaveBeenCalledOnce();
  expect(auth.verifySensitiveAction).not.toHaveBeenCalled();
}, 20_000);

it('produces the same portable inventory digest with different randomized ciphertext destinations', async () => {
  const first = await authorized(writeResetSafetyTargets);
  directory = path.join(root, 'second');
  await fs.mkdir(directory, { mode: 0o700 });
  const second = await authorized(writeResetSafetyTargets);
  expect(first.inventorySha256).toBe(second.inventorySha256);
  expect(first.targets.filter((entry) => entry.type === 'file').map((entry) => entry.file)).not.toEqual(
    second.targets.filter((entry) => entry.type === 'file').map((entry) => entry.file),
  );
});

it('keeps exact target descriptors through preparation and releases only its verified result', async () => {
  const result = await authorized((options) =>
    withResetSafetyTargets(options, async (targets) => {
      expect(Object.isFrozen(targets)).toBe(true);
      const saved = targets.targets.find((entry) => entry.name === 'wallpapers/7.image.saved');
      if (saved?.type !== 'file') throw new Error('Missing target fixture');
      expect(digest(await fs.readFile(saved.file))).toBe(saved.sha256);
      return { verifiedInventory: targets.inventorySha256 };
    }),
  );
  expect(result.verifiedInventory).toMatch(/^[a-f0-9]{64}$/);
  expect((await fs.readdir(directory)).length).toBeGreaterThan(0);
}, 20_000);

it.each(['file-content', 'file-replacement', 'absent-target', 'directory-replacement'] as const)(
  'withholds prepared results if %s changes while target descriptors are retained',
  async (change) => {
    const result = authorized((options) =>
      withResetSafetyTargets(options, async () => {
        const file = path.join(dataDir, 'state/desktop/7.json');
        if (change === 'file-content') await fs.writeFile(file, 'external edit', { mode: 0o600 });
        if (change === 'file-replacement') {
          await fs.rename(file, `${file}.original`);
          await fs.writeFile(file, 'replacement must survive', { mode: 0o600 });
        }
        if (change === 'absent-target') await put('state/desktop/8.json', 'new target must survive');
        if (change === 'directory-replacement') {
          const selected = path.join(dataDir, 'state/theme-packs/7');
          await fs.rename(selected, `${selected}.original`);
          await fs.mkdir(selected, { mode: 0o700 });
          await fs.writeFile(path.join(selected, 'replacement'), 'preserve replacement', { mode: 0o600 });
        }
        return { mustNotBeReleased: true };
      }),
    );
    await expect(result).rejects.toThrow();
    expect(await fs.readdir(directory)).toEqual([]);
    if (change === 'file-replacement') expect(await fs.readFile(path.join(dataDir, 'state/desktop/7.json'), 'utf8')).toBe('replacement must survive');
    if (change === 'absent-target') expect(await fs.readFile(path.join(dataDir, 'state/desktop/8.json'), 'utf8')).toBe('new target must survive');
    if (change === 'directory-replacement')
      expect(await fs.readFile(path.join(dataDir, 'state/theme-packs/7/replacement'), 'utf8')).toBe('preserve replacement');
  },
  20_000,
);

it('preserves changed staging ciphertext for review instead of deleting its replacement', async () => {
  let changed = '';
  await expect(
    authorized((options) =>
      withResetSafetyTargets(options, async (targets) => {
        const target = targets.targets.find((entry) => entry.type === 'file');
        if (target?.type !== 'file') throw new Error('Missing target fixture');
        changed = target.file;
        await fs.writeFile(changed, 'replacement ciphertext', { mode: 0o600 });
        return { mustNotBeReleased: true };
      }),
    ),
  ).rejects.toThrow();
  expect(await fs.readFile(changed, 'utf8')).toBe('replacement ciphertext');
}, 20_000);

it('cleans owned ciphertext after a preparation callback fails and preserves source files', async () => {
  await expect(
    authorized((options) =>
      withResetSafetyTargets(options, async () => {
        throw new Error('synthetic callback interruption');
      }),
    ),
  ).rejects.toThrow('synthetic callback interruption');
  expect(await fs.readdir(directory)).toEqual([]);
  expect(await fs.readFile(path.join(dataDir, 'state/desktop/7.json'), 'utf8')).toBe('{"serverName":"saved"}');
}, 20_000);

it('rejects authorization lost after the encrypted target snapshot was created', async () => {
  await expect(
    authorized((options) =>
      withResetSafetyTargets(options, async () => {
        current = { ...current, securityBinding: 'changed-after-snapshot' };
        return { mustNotBeReleased: true };
      }),
    ),
  ).rejects.toThrow();
  expect(await fs.readdir(directory)).toEqual([]);
}, 20_000);

it('derives the keep-account target set without exporting password-reset authorization', async () => {
  journal = { ...journal, accounts: 'keep' };
  plan = planResetSafetyExports({ resetId: journal.id, accounts: journal.accounts, users: journal.users, captures: [] }).plan;
  const result = await authorized(writeResetSafetyTargets);
  expect(result.targets.some((entry) => entry.name === 'password-change-request')).toBe(false);
});

it('rejects forged tokens, stale leases, ordinary export access and changed action/cohort before opening sources', async () => {
  await expect(
    writeResetSafetyTargets({
      dataDir,
      directory,
      journal,
      plan,
      access: {} as SettingsExportAccess,
      lease: {} as BackupMaintenanceLease,
      passphrase,
      signal: signal(),
    }),
  ).rejects.toThrow();
  await authorized(async (options) => {
    for (const changed of [
      { ...plan, resetId: randomUUID() },
      { ...plan, accounts: 'keep' as const },
      { ...plan, users: [7] },
    ])
      await expect(writeResetSafetyTargets({ ...options, plan: changed })).rejects.toThrow();
    await expect(writeResetSafetyTargets({ ...options, lease: {} as BackupMaintenanceLease })).rejects.toThrow();
  });
  const item = plan.exports[0];
  if (!item) throw new Error('Missing fixture binding');
  const ticket = await authorizeSettingsPasswordExport(auth as never, {} as Request, { password: 'fixture password' }, item);
  await withSettingsExportAccess(ticket, item, signal(), (access) =>
    withBackupMaintenanceLease(signal(), (lease) =>
      expect(writeResetSafetyTargets({ dataDir, directory, journal, plan, access, lease, passphrase, signal: signal() })).rejects.toThrow(),
    ),
  );
  expect(observed).toEqual([]);
  expect(await fs.readdir(directory)).toEqual([]);
});

it.each(['file-symlink', 'directory-symlink', 'hardlink', 'file-permissions', 'directory-permissions', 'shared-state'])(
  'rejects %s without modifying source data',
  async (scenario) => {
    const file = path.join(dataDir, 'state/desktop/7.json');
    const themes = path.join(dataDir, 'state/theme-packs/7');
    if (scenario === 'file-symlink') {
      await fs.unlink(file);
      await fs.symlink(path.join(dataDir, 'backups/private/archive'), file);
    } else if (scenario === 'directory-symlink') {
      await fs.rename(themes, `${themes}-original`);
      await fs.symlink(path.join(dataDir, 'app-data/private'), themes);
    } else if (scenario === 'hardlink') await fs.link(file, path.join(root, 'alias'));
    else if (scenario === 'file-permissions') await fs.chmod(file, 0o644);
    else if (scenario === 'directory-permissions') await fs.chmod(themes, 0o755);
    else await fs.chmod(path.join(dataDir, 'state'), 0o777);
    await expect(authorized(writeResetSafetyTargets)).rejects.toThrow();
    expect(await fs.readdir(directory)).toEqual([]);
    expect(await fs.readFile(path.join(dataDir, 'backups/private/archive'), 'utf8')).toBe('never traverse');
  },
);

it.skipIf(nativePlatform === 'linux')('rejects foreign ownership before opening a selected file', async () => {
  foreignTarget = path.join(dataDir, 'state/desktop/7.json');
  await expect(authorized(writeResetSafetyTargets)).rejects.toThrow();
  expect(await fs.readdir(directory)).toEqual([]);
});

it.skipIf(nativePlatform === 'linux').each([false, true])('rejects a deeper bind alias with independent state=%s', async (independent) => {
  independentStateMount = independent;
  differentMount = path.join(dataDir, 'state/theme-packs/7');
  await expect(authorized(writeResetSafetyTargets)).rejects.toThrow();
  expect(await fs.readdir(directory)).toEqual([]);
});

it.skipIf(nativePlatform === 'linux')('accepts a private independently mounted structural state root after pinning its identity', async () => {
  independentStateMount = true;
  const result = await authorized(writeResetSafetyTargets);
  expect(result.targets.find((entry) => entry.name === 'wallpapers/7.image.saved')).toMatchObject({ type: 'file' });
});

it.skipIf(nativePlatform === 'linux')('rejects source replacement during descriptor reads and removes only its own ciphertext', async () => {
  afterRead = async (file) => {
    if (!file.endsWith('/desktop/7.json')) return;
    afterRead = undefined;
    await fs.rename(file, `${file}.original`);
    await fs.writeFile(file, 'replacement must survive', { mode: 0o600 });
  };
  await expect(authorized(writeResetSafetyTargets)).rejects.toThrow();
  expect(await fs.readFile(path.join(dataDir, 'state/desktop/7.json'), 'utf8')).toBe('replacement must survive');
  expect(await fs.readdir(directory)).toEqual([]);
});

it.skipIf(nativePlatform === 'linux')('rejects selected-directory replacement after enumeration starts', async () => {
  afterOpenDirectory = async (file) => {
    if (file !== path.join(dataDir, 'state/theme-packs/7')) return;
    afterOpenDirectory = undefined;
    await fs.rename(file, `${file}.original`);
    await fs.mkdir(file, { mode: 0o700 });
    await fs.writeFile(path.join(file, 'unrelated'), 'preserve replacement', { mode: 0o600 });
  };
  await expect(authorized(writeResetSafetyTargets)).rejects.toThrow();
  expect(await fs.readFile(path.join(dataDir, 'state/theme-packs/7/unrelated'), 'utf8')).toBe('preserve replacement');
  expect(await fs.readdir(directory)).toEqual([]);
});

it.skipIf(nativePlatform === 'linux')('rejects absent-to-present targets before completion', async () => {
  afterRead = async (file) => {
    if (!file.endsWith('/7.image.saved')) return;
    afterRead = undefined;
    await put('state/desktop/8.json', 'new target');
  };
  await expect(authorized(writeResetSafetyTargets)).rejects.toThrow();
  expect(await fs.readdir(directory)).toEqual([]);
});

it.skipIf(nativePlatform === 'linux')('cleans encrypted partials after cancellation and preserves the original preference', async () => {
  const controller = new AbortController();
  afterRead = async () => {
    afterRead = undefined;
    controller.abort();
  };
  await expect(authorized((options) => writeResetSafetyTargets({ ...options, signal: controller.signal }))).rejects.toThrow();
  expect(await fs.readdir(directory)).toEqual([]);
  expect(await fs.readFile(path.join(dataDir, 'state/desktop/7.json'), 'utf8')).toBe('{"serverName":"saved"}');
});

it.skipIf(nativePlatform === 'linux')('rejects expired actor authorization during encryption', async () => {
  afterRead = async () => {
    afterRead = undefined;
    current = { ...current, securityBinding: 'c'.repeat(64) };
  };
  await expect(authorized(writeResetSafetyTargets)).rejects.toThrow();
  expect(await fs.readdir(directory)).toEqual([]);
});

it('requires an empty private staging directory and refuses unsupported platforms', async () => {
  await fs.writeFile(path.join(directory, 'unrelated'), 'preserve', { mode: 0o600 });
  await expect(authorized(writeResetSafetyTargets)).rejects.toThrow();
  expect(await fs.readFile(path.join(directory, 'unrelated'), 'utf8')).toBe('preserve');
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  await expect(authorized(writeResetSafetyTargets)).rejects.toMatchObject({ code: 'unsupported' });
});

it('rejects excessive file size before encryption without truncating the original', async () => {
  const file = path.join(dataDir, 'state/desktop/7.json');
  await fs.truncate(file, 32 * 1024 ** 2 + 1);
  await expect(authorized(writeResetSafetyTargets)).rejects.toThrow();
  expect((await fs.stat(file)).size).toBe(32 * 1024 ** 2 + 1);
  expect(await fs.readdir(directory)).toEqual([]);
});

it('keeps empty files distinct from absent targets', async () => {
  await fs.truncate(path.join(dataDir, 'state/desktop/7.json'), 0);
  const result = await authorized(writeResetSafetyTargets);
  const empty = result.targets.find((entry) => entry.name === 'desktop/7.json');
  expect(empty).toMatchObject({ type: 'file', plaintextBytes: 0, plaintextSha256: digest('') });
});

it.skipIf(nativePlatform === 'linux')('preserves a replacement staging directory when its original inode is moved mid-encryption', async () => {
  afterRead = async () => {
    afterRead = undefined;
    await fs.rename(directory, `${directory}.original`);
    await fs.mkdir(directory, { mode: 0o700 });
    await fs.writeFile(path.join(directory, 'unrelated'), 'preserve replacement', { mode: 0o600 });
  };
  await expect(authorized(writeResetSafetyTargets)).rejects.toThrow();
  expect(await fs.readFile(path.join(directory, 'unrelated'), 'utf8')).toBe('preserve replacement');
  expect((await fs.readdir(`${directory}.original`)).every((name) => name.endsWith('.partial'))).toBe(true);
});

it('rejects nonprivate and aliased staging paths before source reads', async () => {
  await fs.chmod(directory, 0o755);
  await expect(authorized(writeResetSafetyTargets)).rejects.toThrow();
  await fs.chmod(directory, 0o700);
  const alias = path.join(root, 'alias');
  await fs.symlink(directory, alias);
  await expect(authorized((options) => writeResetSafetyTargets({ ...options, directory: alias }))).rejects.toThrow();
  expect(observed.every((file) => !file.startsWith(`${dataDir}/`))).toBe(true);
});

it.each(['preferences', 'accounts', 'complete', 'recovery'] as const)(
  'refuses journal phase %s instead of certifying partial state',
  async (phase) => {
    journal = { ...journal, phase };
    await expect(authorized(writeResetSafetyTargets)).rejects.toThrow();
    expect(observed).toEqual([]);
  },
);
