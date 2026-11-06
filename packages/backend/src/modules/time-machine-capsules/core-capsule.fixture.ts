import fs from 'node:fs/promises';
import type { Request } from 'express';
import { vi } from 'vitest';
import { createCorePayloadFixture } from '../system-backups/time-machine-core-payload.fixture';
import { prepareCorePayload } from '../system-backups/time-machine-core-payload';
import { TimeMachineStore, type StoredCoreTimeMachinePoint, type TimeMachineCoreDraftMetadata } from '../system-backups/time-machine-store';
import { TimeMachineService } from '../system-backups/time-machine.service';
import { stabilizeDarwinFixtureCreation, stabilizeExistingDarwinFixtures } from '../system-backups/darwin-files.fixture';
import { CapsulesService } from './capsules.service';

export async function coreCapsuleFixture(kind: 'docker' | 'oci' = 'docker') {
  const payload = await createCorePayloadFixture(kind);
  const root = payload.root;
  const restoreDarwin = stabilizeDarwinFixtureCreation(() => root);
  const store = new TimeMachineStore(root);
  const created = await store.create(1, 3);
  const point = created.point as StoredCoreTimeMachinePoint;
  payload.options.expectation.pointId = point.id;
  const draft: TimeMachineCoreDraftMetadata = {
    version: 3,
    kind: 'orbis-core',
    coreFormat: 'orbis.time-machine-core.v1',
    id: point.id,
    createdAt: point.createdAt,
    label: 'Portable Orbis capture',
    source: 'manual',
    software: { orbis: '0.8.0-beta.2', runtipi: 'fixture', architecture: 'arm64' },
    coverage: {
      database: true,
      configuration: true,
      appearance: true,
      controllerConfiguration: true,
      controllerVersion: true,
      dockerImages: true,
      appData: false,
      cluster: 'local-only',
    },
    restore: { ready: false, blockers: [{ code: 'activation-not-integrated', message: 'Restore is not integrated.' }] },
    preview: { available: false, reason: { code: 'preview-not-captured', message: 'No preview in this fixture.' } },
    breakdown: [],
    excludedApps: [],
    restorePolicy: { managedApps: 'preserve-current', proxy: 'preserve-current', recoveryAuthority: 'preserve-current', queue: 'current-drained' },
    compatibility: payload.options.expectation.compatibility,
  };
  stabilizeExistingDarwinFixtures(root);
  await store.saveCoreDraft(point, draft, payload.options.signal);
  await store.sealCore(point, await prepareCorePayload(payload.options), draft, payload.options.signal);
  const actor = { userId: 1, sessionBinding: 'a'.repeat(64), securityBinding: 'b'.repeat(64) };
  const auth = { operatorActionContext: vi.fn(async () => actor), verifySensitiveAction: vi.fn(async () => ({ operator: true })) };
  const config = { get: (key: string) => (key === 'directories' ? { dataDir: root } : key === 'architecture' ? 'arm64' : 'fixture') };
  const machine = new TimeMachineService(
    ...([config, {}, auth, { warn: vi.fn() }, {}, {}, {}, {}, { recoverCaptureFences: vi.fn() }, undefined, {}] as unknown as ConstructorParameters<
      typeof TimeMachineService
    >),
  );
  const database = { review: vi.fn() };
  const capsules = new CapsulesService(config as never, auth as never, machine, database as never);
  const credentials = { password: 'fixture local account password' };
  const request = {} as Request;
  const passphrase = 'fixture portable archive passphrase';
  return {
    root,
    payload,
    store,
    point: await store.load(point.id),
    key: created.passphrase,
    machine,
    capsules,
    auth,
    actor,
    credentials,
    request,
    passphrase,
    database,
    dispose: async () => {
      await capsules.onModuleDestroy();
      await machine.onModuleDestroy();
      restoreDarwin();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}
