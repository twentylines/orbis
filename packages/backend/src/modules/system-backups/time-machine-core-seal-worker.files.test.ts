import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { canonicalCoreJson } from './time-machine-core-payload';
import { createCorePayloadFixture } from './time-machine-core-payload.fixture';
import { coreSealCapability, parseCoreSealArguments, runCoreSealWorker, sealCoreSavedPoint } from './time-machine-core-seal-worker';
import { TimeMachineStore, type StoredCoreTimeMachinePoint, type TimeMachineCoreDraftMetadata } from './time-machine-store';

const roots: string[] = [];
const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function setup(kind: 'docker' | 'oci' = 'docker') {
  const fixture = await createCorePayloadFixture(kind);
  roots.push(fixture.root);
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-core-seal-')));
  roots.push(root);
  await fs.chmod(root, 0o700);
  const store = new TimeMachineStore(root);
  const created = await store.create(1, 3);
  const point = created.point as StoredCoreTimeMachinePoint;
  fixture.options.expectation.pointId = point.id;
  const draft: TimeMachineCoreDraftMetadata = {
    version: 3,
    kind: 'orbis-core',
    coreFormat: 'orbis.time-machine-core.v1',
    id: point.id,
    createdAt: point.createdAt,
    label: 'Orbis capture',
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
    compatibility: fixture.options.expectation.compatibility,
  };
  await store.saveCoreDraft(point, draft, new AbortController().signal);
  const input = path.join(root, 'backups/time-machine/core-publish-input', point.id);
  const images = path.join(input, 'images');
  await fs.mkdir(images, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(input, 'checkpoint.tar'), fixture.checkpoint, { mode: 0o600 });
  await fs.writeFile(path.join(images, fixture.saved.item.archive), fixture.saved.archive, { mode: 0o600 });
  await fs.writeFile(path.join(images, 'inventory.json'), canonicalCoreJson(fixture.options.imageInventory), { mode: 0o600 });
  return {
    root,
    input,
    images,
    fixture,
    point,
    passphrase: created.passphrase,
    directory: path.join(root, 'backups/time-machine/points', point.id),
    options: { dataDir: root, expectation: fixture.options.expectation, signal: new AbortController().signal },
  };
}
it.each(['docker', 'oci'] as const)('seals and independently verifies encrypted %s data without changing inputs', async (kind) => {
  const f = await setup(kind);
  const files = [path.join(f.input, 'checkpoint.tar'), path.join(f.images, 'inventory.json'), path.join(f.images, f.fixture.saved.item.archive)];
  const before = await Promise.all(files.map(async (file) => sha(await fs.readFile(file))));
  const result = await sealCoreSavedPoint(f.options);
  expect(result).toMatchObject({
    schema: 'orbis.core-capture-publication.v1',
    pointId: f.point.id,
    checkpoint: f.options.expectation.checkpoint,
    imageCount: 1,
  });
  expect((await new TimeMachineStore(f.root).load(f.point.id)).status).toBe('sealed');
  expect(JSON.stringify(result)).not.toContain(f.passphrase);
  expect(await Promise.all(files.map(async (file) => sha(await fs.readFile(file))))).toEqual(before);
  await expect(sealCoreSavedPoint(f.options)).rejects.toThrow();
});
it.each(['expectation', 'inventory', 'checkpoint', 'image', 'symlink', 'hardlink', 'permissions', 'workspace', 'partial', 'cancel'] as const)(
  'rejects unsafe %s without replacing preexisting outputs',
  async (change) => {
    const f = await setup();
    const checkpoint = path.join(f.input, 'checkpoint.tar');
    if (change === 'expectation') f.options.expectation.checkpoint.sha256 = 'f'.repeat(64);
    if (change === 'inventory') await fs.appendFile(path.join(f.images, 'inventory.json'), ' ');
    if (change === 'checkpoint') await fs.appendFile(checkpoint, 'x');
    if (change === 'image') await fs.appendFile(path.join(f.images, f.fixture.saved.item.archive), 'x');
    if (change === 'symlink') {
      await fs.rename(checkpoint, `${checkpoint}.original`);
      await fs.symlink(`${checkpoint}.original`, checkpoint);
    }
    if (change === 'hardlink') await fs.link(checkpoint, path.join(f.input, 'other'));
    if (change === 'permissions') await fs.chmod(checkpoint, 0o644);
    if (change === 'workspace') await fs.chmod(f.root, 0o777);
    if (change === 'partial') await fs.writeFile(path.join(f.directory, 'core.orbis'), 'preserve', { mode: 0o600 });
    if (change === 'cancel') {
      const controller = new AbortController();
      controller.abort();
      f.options.signal = controller.signal;
    }
    await expect(sealCoreSavedPoint(f.options)).rejects.toThrow();
    if (change === 'partial') expect(await fs.readFile(path.join(f.directory, 'core.orbis'), 'utf8')).toBe('preserve');
    expect((await new TimeMachineStore(f.root).load(f.point.id)).status).toBe('capturing');
  },
);
it('restricts arguments and capability and requires Linux root for sealing', async () => {
  const f = await setup();
  const json = canonicalCoreJson(f.options.expectation);
  expect(parseCoreSealArguments(['--seal', json])).toEqual({ mode: 'seal', expectation: f.options.expectation });
  expect(() => parseCoreSealArguments(['--seal', ` ${json}`])).toThrow();
  expect(() => parseCoreSealArguments(['--seal', json, 'extra'])).toThrow();
  expect(await runCoreSealWorker(['--capability'])).toEqual(coreSealCapability);
  if (process.platform !== 'linux' || process.getuid?.() !== 0) await expect(runCoreSealWorker(['--seal', json])).rejects.toThrow();
});
