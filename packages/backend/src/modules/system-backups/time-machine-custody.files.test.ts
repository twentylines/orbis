import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { withBackupMaintenanceLease } from '@/common/backup-maintenance-lease';
import { coreCapsuleFixture } from '../time-machine-capsules/core-capsule.fixture';
import { exportPortablePoint } from '../time-machine-capsules/portable-point-export';
import { importCapsule } from '../time-machine-capsules/capsule';
import { verifyCapsuleContents } from '../time-machine-capsules/verify';
import type { ResetJournal } from '../system-reset/reset-contract';
import { SettingsBackupSourceService } from './settings-backup-source.service';

type Fixture = Awaited<ReturnType<typeof coreCapsuleFixture>>;
const fixtures: Fixture[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});
const signal = () => new AbortController().signal;
async function setup() {
  const fixture = await coreCapsuleFixture();
  fixtures.push(fixture);
  return fixture;
}
async function fingerprints(f: Fixture) {
  const directory = path.join(f.root, 'backups/time-machine/points', f.point.id);
  return Object.fromEntries(
    await Promise.all(
      (await fs.readdir(directory)).map(async (name) => [
        name,
        createHash('sha256')
          .update(await fs.readFile(path.join(directory, name)))
          .digest('hex'),
      ]),
    ),
  );
}
async function prepare(f: Fixture, userId: number) {
  f.actor.userId = userId;
  const journal: ResetJournal = {
    version: 1,
    id: randomUUID(),
    controller: 'fixture-controller',
    accounts: 'remove',
    users: [userId],
    phase: 'prepared',
    createdAt: Date.now(),
  };
  await withBackupMaintenanceLease(signal(), async () => f.machine.prepareResetOwnership(journal, [userId]));
  return journal;
}

it.each([1, 7])('retains a real encrypted core capture when the reset account is %i, including historical orphans', async (oldAccount) => {
  const f = await setup();
  const original = await fingerprints(f);
  const operation = await prepare(f, oldAccount);
  await f.machine.completeResetOwnership({ ...operation, phase: 'complete' }, async () => true);
  f.actor.userId = 8;
  await expect(f.machine.inspect(f.point.id, 8)).rejects.toThrow();
  expect((await f.machine.inspect(f.point.id, 8, f.request)).status).toBe('sealed');
  expect((await f.machine.list(8, f.request)).points.map((point) => point.id)).toEqual([f.point.id]);
  expect((await f.machine.inspect(f.point.id, 8)).status).toBe('sealed');
  expect(await f.machine.coreInspectionBindingPoint(f.point.id, 8)).toMatchObject({
    pointId: f.point.id,
    ownerId: 8,
    archiveSha256: f.point.archiveSha256,
  });
  await expect(f.machine.inspect(f.point.id, 1)).rejects.toThrow();
  expect((await f.store.load(f.point.id)).ownerId).toBe(1);

  const destination = path.join(f.root, 'retained.orbis-tm');
  await exportPortablePoint({
    machine: f.machine,
    dataDir: f.root,
    pointId: f.point.id,
    ownerId: 8,
    request: f.request,
    credentials: f.credentials,
    passphrase: f.passphrase,
    destination,
    signal: signal(),
  });
  const imported = await importCapsule({
    source: destination,
    stagingParent: f.root,
    passphrase: f.passphrase,
    signal: signal(),
    verify: async (manifest, directory, currentSignal) => {
      expect(manifest).toMatchObject({ pointId: f.point.id, sourceOwnerId: 1, pointKey: f.key });
      await verifyCapsuleContents({
        manifest,
        directory,
        signal: currentSignal,
        database: f.database,
        target: { orbisVersion: 'fixture', runtipiVersion: 'fixture', architecture: 'arm64' },
      });
    },
  });
  await imported.dispose();
  expect(await fingerprints(f)).toEqual(original);
  await f.machine.remove(f.point.id, 8, f.credentials);
  expect(f.auth.verifySensitiveAction).toHaveBeenLastCalledWith(8, f.credentials.password, undefined);
  await expect(f.store.load(f.point.id)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('does not transfer capture access without a real completion receipt or change legacy completed journals', async () => {
  const f = await setup();
  const operation = await prepare(f, 1);
  await expect(f.machine.completeResetOwnership({ ...operation, phase: 'complete' }, async () => false)).rejects.toThrow();
  f.actor.userId = 8;
  expect((await f.machine.list(8, f.request)).points).toEqual([]);
  expect((await f.store.load(f.point.id)).ownerId).toBe(1);
  const legacy = { ...operation, id: randomUUID(), phase: 'complete' as const };
  await f.machine.completeResetOwnership(legacy, async () => {
    throw new Error('legacy journal has no capture-custody authority');
  });
  expect((await f.machine.list(8, f.request)).points).toEqual([]);
});

it('exports a retained capture in the first settings backup request without visiting its list', async () => {
  const f = await setup();
  const original = await fingerprints(f);
  const operation = await prepare(f, 1);
  await f.machine.completeResetOwnership({ ...operation, phase: 'complete' }, async () => true);
  f.actor.userId = 8;
  await expect(f.machine.inspect(f.point.id, 8)).rejects.toThrow();
  const config = { get: (key: string) => (key === 'directories' ? { dataDir: f.root } : key === 'architecture' ? 'arm64' : 'fixture') };
  const source = new SettingsBackupSourceService(
    config as never,
    f.auth as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    f.machine,
    f.database as never,
  );
  const result = await source.write({
    ownerId: 8,
    request: f.request,
    credentials: f.credentials,
    selection: { version: 1, settings: false, dashboard: false, wallpapers: false, themes: false, timeMachine: [f.point.id] },
    passphrase: f.passphrase,
    directory: f.root,
    destination: path.join(f.root, 'first-settings-backup.orbis-settings'),
    signal: signal(),
  });
  expect(result.verifiedContents.map((part) => part.kind)).toEqual(['time-machine']);
  expect(result.verifiedContents[0]).toMatchObject({
    id: f.point.id,
    pointId: f.point.id,
    capturedAt: f.point.createdAt,
    orbisVersion: '0.8.0-beta.2',
  });
  expect((await f.machine.inspect(f.point.id, 8)).status).toBe('sealed');
  expect((await f.store.load(f.point.id)).ownerId).toBe(1);
  expect(await fingerprints(f)).toEqual(original);
  expect(f.auth.verifySensitiveAction).toHaveBeenCalledWith(8, f.credentials.password, undefined);
});

it('reconciles the first restore-review request without granting restore activation', async () => {
  const f = await setup();
  const operation = await prepare(f, 1);
  await f.machine.completeResetOwnership({ ...operation, phase: 'complete' }, async () => true);
  f.actor.userId = 8;
  await expect(f.machine.inspect(f.point.id, 8)).rejects.toThrow();
  await expect(f.machine.restoreReview(f.point.id, 8, f.request)).rejects.toThrow();
  expect((await f.machine.inspect(f.point.id, 8)).status).toBe('sealed');
  expect((await f.store.load(f.point.id)).ownerId).toBe(1);
});
