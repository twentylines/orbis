import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { TimeMachineStore, type StoredCoreTimeMachinePoint, type TimeMachineCoreDraftMetadata } from './time-machine-store';
import { prepareCorePayload, type VerifiedCorePayload } from './time-machine-core-payload';
import { createCorePayloadFixture, corePayloadTar } from './time-machine-core-payload.fixture';
import { backupMetadataBytes } from './backup-crypto';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
const signal = () => new AbortController().signal;
function draft(point: StoredCoreTimeMachinePoint, compatibility: TimeMachineCoreDraftMetadata['compatibility']): TimeMachineCoreDraftMetadata {
  return {
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
    compatibility,
  };
}
async function setup(kind: 'docker' | 'oci' = 'docker') {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-core-library-')));
  roots.push(root);
  const store = new TimeMachineStore(root);
  const created = await store.create(1, 3);
  const fixture = await createCorePayloadFixture(kind);
  roots.push(fixture.root);
  fixture.options.expectation.pointId = created.point.id;
  const token = await prepareCorePayload(fixture.options);
  const directory = path.join(root, 'backups/time-machine/points', created.point.id);
  return {
    root,
    store,
    point: created.point,
    passphrase: created.passphrase,
    fixture,
    token,
    directory,
    metadata: draft(created.point, fixture.options.expectation.compatibility),
  };
}
async function absence(file: string) {
  await expect(fs.lstat(file)).rejects.toMatchObject({ code: 'ENOENT' });
}
it.each(['docker', 'oci'] as const)('seals a %s core payload, reloads the library and decrypts using the persisted key', async (kind) => {
  const f = await setup(kind);
  const metadata = await f.store.sealCore(f.point, f.token, f.metadata, signal());
  const restarted = new TimeMachineStore(f.root);
  const point = await restarted.load(f.point.id);
  expect(point.version).toBe(3);
  expect(point.status).toBe('sealed');
  expect(await restarted.metadata(point)).toEqual(metadata);
  expect((await restarted.list()).map((p) => p.id)).toEqual([point.id]);
  expect(metadata.coverage.appData).toBe(false);
  expect(metadata.core.imageCount).toBe(1);
  expect(metadata.core.resourceCount).toBe(4);
  const beforeRead = await fs.stat(path.join(f.directory, 'core.orbis'));
  let completion: { ended: boolean; bytes: unknown } | undefined;
  try {
    await restarted.withArchive(point, signal(), async (source, passphrase) => {
      const parts: Buffer[] = [];
      for await (const part of source) parts.push(Buffer.from(part));
      const plaintext = await backupMetadataBytes(Buffer.concat(parts), passphrase, true, 1024 * 1024);
      expect(plaintext.subarray(0, 8).toString()).toBe('ORBISCO1');
      const manifest = JSON.parse(plaintext.subarray(12, 12 + plaintext.readUInt32BE(8)).toString());
      expect(manifest.pointId).toBe(point.id);
      expect(manifest.sourceSha256).toBe(metadata.core.sourceSha256);
      completion = { ended: source.readableEnded, bytes: Reflect.get(source, 'bytesRead') };
    });
  } catch (cause) {
    const afterRead = await fs.stat(path.join(f.directory, 'core.orbis'));
    const changed = ['dev', 'ino', 'mode', 'uid', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].filter(
      (key) => Reflect.get(beforeRead, key) !== Reflect.get(afterRead, key),
    );
    throw new Error(`Archive read failed; completion=${JSON.stringify(completion)}; changed=${changed.join(',')}`, { cause });
  }
  expect((await fs.stat(path.join(f.directory, 'core.orbis'))).mode & 0o777).toBe(0o600);
  expect(await fs.readFile(path.join(f.directory, 'point.json'), 'utf8')).not.toContain(f.passphrase);
  await absence(path.join(f.directory, 'backup.orbis'));
});
it('keeps the same key and pending point across a store restart before sealing', async () => {
  const f = await setup();
  const keyFile = path.join(f.root, 'backups/time-machine/keys/master-v1.key');
  const key = await fs.readFile(keyFile);
  const restarted = new TimeMachineStore(f.root);
  expect(await restarted.load(f.point.id)).toEqual(f.point);
  await restarted.sealCore(f.point, f.token, f.metadata, signal());
  expect(await fs.readFile(keyFile)).toEqual(key);
  expect((await fs.stat(keyFile)).mode & 0o777).toBe(0o600);
});
it('refuses legacy sealing and forged payload capabilities for a core point', async () => {
  const f = await setup();
  await expect(f.store.seal(f.point, Readable.from(Buffer.alloc(52)), 52, f.metadata as never, signal())).rejects.toThrow();
  await expect(f.store.sealCore(f.point, {} as VerifiedCorePayload, f.metadata, signal())).rejects.toThrow();
  expect((await f.store.load(f.point.id)).status).toBe('capturing');
  await absence(path.join(f.directory, 'metadata.orbis'));
  await absence(path.join(f.directory, 'core.orbis'));
});
it('rejects wrong point or compatibility metadata without publishing', async () => {
  const f = await setup();
  const metadata = { ...f.metadata, compatibility: { ...f.metadata.compatibility, architecture: 'amd64' as const } };
  await expect(f.store.sealCore(f.point, f.token, metadata, signal())).rejects.toThrow();
  expect((await f.store.load(f.point.id)).status).toBe('capturing');
  await absence(path.join(f.directory, 'core.orbis'));
});
it('does not publish after the source changes during the consumer completion boundary', async () => {
  const f = await setup();
  const probe = await fs.open(f.fixture.options.checkpointFile, 'r');
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalSync = prototype.sync;
  let changed = false;
  vi.spyOn(prototype, 'sync').mockImplementation(async function (this: unknown) {
    await originalSync.call(this);
    if (!changed) {
      changed = true;
      await fs.rename(f.fixture.options.checkpointFile, `${f.fixture.options.checkpointFile}.retained`);
      await fs.writeFile(f.fixture.options.checkpointFile, f.fixture.checkpoint, { mode: 0o600 });
    }
  });
  await expect(f.store.sealCore(f.point, f.token, f.metadata, signal())).rejects.toThrow();
  expect(changed).toBe(true);
  expect((await f.store.load(f.point.id)).status).toBe('capturing');
  await absence(path.join(f.directory, 'metadata.orbis'));
  await absence(path.join(f.directory, 'core.orbis'));
});
it('preserves a committed generation when the acknowledgement and immediate reread both fail', async () => {
  const f = await setup();
  const update = f.store.update.bind(f.store);
  vi.spyOn(f.store, 'update').mockImplementationOnce(async (point) => {
    await update(point);
    vi.spyOn(f.store, 'load').mockRejectedValueOnce(new Error('temporary read failure'));
    throw new Error('lost commit acknowledgement');
  });
  await expect(f.store.sealCore(f.point, f.token, f.metadata, signal())).rejects.toThrow('lost commit acknowledgement');
  const restarted = new TimeMachineStore(f.root);
  const point = await restarted.load(f.point.id);
  expect(point.status).toBe('sealed');
  await expect(restarted.verifyArchive(point, signal())).resolves.toBeDefined();
  expect((await restarted.metadata(point)).version).toBe(3);
});
it('never erases a sealed core point through a stale capture failure', async () => {
  const f = await setup();
  await f.store.sealCore(f.point, f.token, f.metadata, signal());
  await expect(f.store.fail(f.point, 'capture-failed')).rejects.toThrow();
  const current = await f.store.load(f.point.id);
  expect(current.status).toBe('sealed');
  await expect(f.store.verifyArchive(current, signal())).resolves.toBeDefined();
});
it('retains legacy point creation and includes all generations in one library', async () => {
  const f = await setup();
  const legacy = await f.store.create(1, 1);
  const runtime = await f.store.create(1, 2);
  expect(new Set((await f.store.list()).map((p) => p.version))).toEqual(new Set([1, 2, 3]));
  expect(legacy.point.envelope.keyId).toBe(f.point.envelope.keyId);
  expect(runtime.point.envelope.keyId).toBe(f.point.envelope.keyId);
});
it('accepts a metadata-only change after reading authenticated core ciphertext', async () => {
  const f = await setup();
  await f.store.sealCore(f.point, f.token, f.metadata, signal());
  const point = await f.store.load(f.point.id);
  let received = 0;
  await f.store.withArchive(point, signal(), async (source) => {
    for await (const chunk of source) received += Buffer.byteLength(chunk);
    await fs.chmod(path.join(f.directory, 'core.orbis'), 0o600);
  });
  expect(received).toBe(point.archiveBytes);
});
it('still rejects a permission change after reading the exact core ciphertext', async () => {
  const f = await setup();
  await f.store.sealCore(f.point, f.token, f.metadata, signal());
  const point = await f.store.load(f.point.id);
  await expect(
    f.store.withArchive(point, signal(), async (source) => {
      for await (const _chunk of source) {
        /* Drain the bounded fixture. */
      }
      await fs.chmod(path.join(f.directory, 'core.orbis'), 0o640);
    }),
  ).rejects.toThrow();
});
it('rejects a changed core file after initial verification and incomplete consumers', async () => {
  const f = await setup();
  await f.store.sealCore(f.point, f.token, f.metadata, signal());
  const point = await f.store.load(f.point.id);
  await expect(
    f.store.withArchive(point, signal(), async (source) => {
      source.pause();
    }),
  ).rejects.toThrow();
  await expect(
    f.store.withArchive(point, signal(), async (source) => {
      for await (const _chunk of source) {
        /* Drain before the deliberate file change. */
      }
      await fs.writeFile(path.join(f.directory, 'core.orbis'), Buffer.alloc(point.archiveBytes), { mode: 0o600 });
    }),
  ).rejects.toThrow();
});
it('authenticates delivered bytes even when a midstream change restores the original timestamps', async () => {
  const f = await setup();
  const checkpoint = corePayloadTar([{ name: 'state/fixture', data: Buffer.alloc(2 * 1024 * 1024) }]);
  await fs.writeFile(f.fixture.options.checkpointFile, checkpoint, { mode: 0o600 });
  f.fixture.options.expectation.checkpoint = { bytes: checkpoint.length, sha256: createHash('sha256').update(checkpoint).digest('hex') };
  const token = await prepareCorePayload(f.fixture.options);
  await f.store.sealCore(f.point, token, f.metadata, signal());
  const point = await f.store.load(f.point.id);
  const file = path.join(f.directory, 'core.orbis');
  const fixed = new Date('2020-01-01T00:00:00Z');
  await fs.utimes(file, fixed, fixed);
  const before = await fs.stat(file);
  let changed = false;
  let received = 0;
  await expect(
    f.store.withArchive(point, signal(), async (source) => {
      for await (const chunk of source) {
        received += Buffer.byteLength(chunk);
        if (!changed) {
          changed = true;
          const writer = await fs.open(file, 'r+');
          try {
            const byte = Buffer.alloc(1);
            await writer.read(byte, 0, 1, point.archiveBytes - 1);
            byte[0] = (byte[0] ?? 0) ^ 1;
            await writer.write(byte, 0, 1, point.archiveBytes - 1);
          } finally {
            await writer.close();
          }
          await fs.utimes(file, fixed, fixed);
        }
      }
      const after = await fs.stat(file);
      for (const key of ['ino', 'dev', 'size', 'mode', 'uid', 'gid', 'nlink', 'mtimeMs'])
        expect(Reflect.get(after, key)).toBe(Reflect.get(before, key));
    }),
  ).rejects.toThrow('integrity');
  expect(changed).toBe(true);
  expect(received).toBe(point.archiveBytes);
});
