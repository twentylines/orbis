import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { decodeAppVolumePins } from '../docker/app-volume-pins';
import { canonicalPublicationJson as canonical } from '../host-updates/host-controller-publication';
import { makeReviewedBackupFixture } from './backup-restore-source.fixture';
import { stabilizeExistingDarwinFixtures } from './darwin-files.fixture';
import { addBackupVolumeFixture, volumeFixtureHash as sha } from './backup-volume.fixture';
import { withPreparedVolumeRestoreBindings } from './backup-volume-restore-bindings';

const prepareVolumeRestoreBindings = (options: Parameters<typeof withPreparedVolumeRestoreBindings>[0]) =>
  withPreparedVolumeRestoreBindings(options, async (plan) => plan);

let root: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'restore-bindings-')));
});
afterEach(async () => fs.rm(root, { recursive: true, force: true }));

async function fixture(replica = false) {
  const source = await makeReviewedBackupFixture(root, { manifestRunning: false });
  const { manifest, volume } = await addBackupVolumeFixture(source.content, source.manifest);
  const firstMount = volume.mounts[0];
  if (!firstMount) throw new Error('Missing fixture mount');
  if (replica) {
    const id = 'b'.repeat(64);
    manifest.containers.push({ id, project: firstMount.project, running: false });
    volume.mounts = [...volume.mounts, { ...firstMount, containerId: id, ordinal: 2 }];
  }
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  await fs.writeFile(path.join(source.content, 'manifest.json'), manifestBytes);
  const sourceSeal = { ...source.seal, manifest: { bytes: manifestBytes.length, sha256: sha(manifestBytes) } };
  const identity = { restoreId: randomUUID(), nonce: randomUUID(), imageId: `sha256:${'a'.repeat(64)}`, manifestSha256: sha(manifestBytes) };
  const generation = randomUUID();
  const preparedDirectory = path.join(root, 'prepared');
  await fs.mkdir(preparedDirectory, { mode: 0o700 });
  await fs.writeFile(path.join(preparedDirectory, 'lease.sqlite'), '', { mode: 0o600 });
  const attempt = {
    version: 1,
    schema: 'orbis.backup-volume-restore.v1',
    identity,
    generation,
    createdAt: Date.now(),
    phase: 'verified',
    targets: [
      {
        key: volume.key,
        sourceName: volume.sourceName,
        targetName: `orbis-restore-${generation}-${volume.key}`,
        archiveSha256: volume.archive.sha256,
        inventorySha256: volume.inventory.sha256,
        uploaderName: `orbis-volume-restore-${randomUUID()}`,
        uploaderId: 'c'.repeat(64),
        state: 'ready',
        volumeIdentity: 'd'.repeat(64),
        containerIdentity: 'e'.repeat(64),
        verificationSha256: 'f'.repeat(64),
      },
    ],
  };
  const write = async (name: string, value: unknown) => fs.writeFile(path.join(preparedDirectory, name), canonical(value), { mode: 0o600 });
  await write('origin.json', { version: 1, identity });
  await write(`${generation}.json`, attempt);
  await write('current.json', { version: 1, identity, generation, attemptSha256: sha(canonical(attempt)) });
  stabilizeExistingDarwinFixtures(source.directory);
  return {
    source,
    attempt,
    generation,
    volume,
    options: { sourceDirectory: source.directory, sourceSeal, preparedDirectory, identity, signal: new AbortController().signal },
  };
}

it('binds stopped apps to fresh target names and approved source and receipt digests', async () => {
  const f = await fixture();
  const plan = await prepareVolumeRestoreBindings(f.options);
  expect(plan.restore).toEqual({ ...f.options.identity, preparedReceiptSha256: sha(canonical(f.attempt)) });
  expect(plan.restoreSourceSha256).toBe(sha(canonical(f.options.sourceSeal)));
  expect(plan.preparedGeneration).toBe(f.generation);
  expect(plan.expectedTargets).toEqual(f.attempt.targets);
  expect(plan.pinDocuments).toHaveLength(1);
  const document = plan.pinDocuments[0];
  if (!document) throw new Error('Missing fixture document');
  expect(document.filename).toBe(`${sha('fixture-app:catalogue')}.json`);
  expect(document.sha256).toBe(sha(document.json));
  expect(decodeAppVolumePins(Buffer.from(document.json))).toEqual({
    version: 1,
    appUrn: 'fixture-app:catalogue',
    project: 'fixture-app_catalogue',
    services: [{ name: 'app', mounts: [{ target: '/config', volume: f.attempt.targets[0]?.targetName, readOnly: false }] }],
  });
  expect(Object.isFrozen(plan.expectedTargets[0])).toBe(true);
  expect(Object.isFrozen(plan.pinDocuments[0])).toBe(true);
});

it('collapses matching replica mounts into one stable service binding', async () => {
  const f = await fixture(true);
  const plan = await prepareVolumeRestoreBindings(f.options);
  const document = plan.pinDocuments[0];
  if (!document) throw new Error('Missing fixture document');
  expect(decodeAppVolumePins(Buffer.from(document.json)).services[0]?.mounts).toHaveLength(1);
});

it.each(['identity', 'config', 'receipt', 'cancel'] as const)('rejects %s without changing prepared storage', async (kind) => {
  const f = await fixture();
  const pointer = path.join(f.options.preparedDirectory, 'current.json');
  const before = await fs.readFile(pointer);
  if (kind === 'identity') f.options.identity.manifestSha256 = '0'.repeat(64);
  if (kind === 'config') await fs.writeFile(path.join(f.source.content, 'data/apps/catalogue/fixture-app/config.json'), '{}');
  if (kind === 'receipt') await fs.writeFile(path.join(f.options.preparedDirectory, `${f.generation}.json`), '{}');
  if (kind === 'cancel') f.options.signal = AbortSignal.abort();
  await expect(prepareVolumeRestoreBindings(f.options)).rejects.toThrow();
  expect(await fs.readFile(pointer)).toEqual(before);
});
