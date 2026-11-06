import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { backupMetadataBytes } from './backup-crypto';
import { canonicalCoreJson, corePayloadLimits } from './time-machine-core-payload';
import { createCorePayloadFixture } from './time-machine-core-payload.fixture';
import { verifyCoreSavedPoint } from './time-machine-core-verify';
import { TimeMachineStore, type StoredCoreTimeMachinePoint, type TimeMachineCoreDraftMetadata } from './time-machine-store';

const roots: string[] = [];
const signal = () => new AbortController().signal;
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Required fixture member is absent.');
  return value;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function setup(kind: 'docker' | 'oci' = 'docker') {
  const fixture = await createCorePayloadFixture(kind);
  roots.push(fixture.root);
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-saved-core-verifier-')));
  roots.push(root);
  await fs.chmod(root, 0o700);
  const stagingDirectory = path.join(root, 'verification');
  await fs.mkdir(stagingDirectory, { mode: 0o700 });
  const store = new TimeMachineStore(root);
  const created = await store.create(1, 3);
  const point = created.point as StoredCoreTimeMachinePoint;
  fixture.options.expectation.pointId = point.id;
  const inventory = structuredClone(fixture.options.imageInventory);
  inventory.images.sort((a, b) => a.imageId.localeCompare(b.imageId));
  inventory.bindings.sort((a, b) => a.key.localeCompare(b.key));
  const expected = fixture.options.expectation;
  const manifest = {
    schema: 'orbis.time-machine-core.v1' as const,
    pointId: expected.pointId,
    sourceSha256: expected.sourceSha256,
    checkpointSha256: expected.checkpointSha256,
    captureReceiptSha256: expected.captureReceiptSha256,
    resourceCount: expected.resourceCount,
    compatibility: expected.compatibility,
    inventory,
    imageInventorySha256: sha(canonicalCoreJson(inventory)),
    entries: [
      { name: 'checkpoint.tar', ...expected.checkpoint },
      ...inventory.images.map((image) => ({ name: `images/${image.archive}`, bytes: image.bytes, sha256: image.sha256 })),
    ],
  };
  const json = Buffer.from(canonicalCoreJson(manifest));
  const header = Buffer.alloc(12);
  header.write('ORBISCO1');
  header.writeUInt32BE(json.length, 8);
  const payload = { plaintext: Buffer.concat([header, json, fixture.checkpoint, fixture.saved.archive]), manifest };
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
  const directory = path.join(root, 'backups/time-machine/points', point.id);
  const f = {
    root,
    store,
    point,
    passphrase: created.passphrase,
    fixture,
    stagingDirectory,
    directory,
    draft,
    ...payload,
    options: { dataDir: root, expectation: fixture.options.expectation, stagingDirectory, signal: signal() },
  };
  await publish(f);
  return f;
}
type Fixture = Awaited<ReturnType<typeof setup>>;
async function publish(f: Omit<Fixture, never>, plaintext = f.plaintext, manifest = f.manifest, mutateCipher?: (bytes: Buffer) => Buffer) {
  let ciphertext: Buffer = await backupMetadataBytes(plaintext, f.passphrase, false, 4 * 1024 * 1024);
  if (mutateCipher) ciphertext = mutateCipher(ciphertext);
  const core = {
    version: 1 as const,
    format: 'orbis.time-machine-core.v1' as const,
    cipherBytes: ciphertext.length,
    cipherSha256: sha(ciphertext),
    manifestSha256: sha(canonicalCoreJson(manifest)),
    sourceSha256: manifest.sourceSha256,
    checkpointSha256: manifest.checkpointSha256,
    captureReceiptSha256: manifest.captureReceiptSha256,
    imageInventorySha256: manifest.imageInventorySha256,
    resourceCount: manifest.resourceCount,
    imageCount: manifest.inventory.images.length,
  };
  const metadata = { ...f.draft, core, archiveBytes: ciphertext.length, archiveSha256: sha(ciphertext), manifestSha256: core.manifestSha256 };
  const encryptedMetadata = await backupMetadataBytes(Buffer.from(JSON.stringify(metadata)), f.passphrase, false);
  await fs.writeFile(path.join(f.directory, 'core.orbis'), ciphertext, { mode: 0o600 });
  await fs.writeFile(path.join(f.directory, 'metadata.orbis'), encryptedMetadata, { mode: 0o600 });
  await fs.writeFile(
    path.join(f.directory, 'point.json'),
    JSON.stringify({
      ...f.point,
      status: 'sealed',
      issue: null,
      archiveBytes: ciphertext.length,
      archiveSha256: sha(ciphertext),
      metadataSha256: sha(encryptedMetadata),
      assetBytes: 0,
      core,
    }),
    { mode: 0o600 },
  );
}
function frame(f: Fixture, manifest: unknown, suffix?: Buffer) {
  const json = Buffer.from(canonicalCoreJson(manifest));
  const header = Buffer.alloc(12);
  header.write('ORBISCO1');
  header.writeUInt32BE(json.length, 8);
  return Buffer.concat([header, json, suffix ?? f.plaintext.subarray(12 + f.plaintext.readUInt32BE(8))]);
}
async function rejects(f: Fixture) {
  await expect(verifyCoreSavedPoint(f.options)).rejects.toThrow();
  expect(await fs.readdir(f.stagingDirectory)).toEqual([]);
}

it.each(['docker', 'oci'] as const)('independently reopens actual encrypted %s files and returns frozen secret-free data', async (kind) => {
  const f = await setup(kind);
  const result = await verifyCoreSavedPoint(f.options);
  const point = await new TimeMachineStore(f.root).load(f.point.id);
  expect(result).toMatchObject({
    schema: 'orbis.core-capture-publication.v1',
    pointId: point.id,
    ownerId: 1,
    checkpoint: f.options.expectation.checkpoint,
    imageCount: 1,
    resourceCount: 4,
    pointSha256: sha(await fs.readFile(path.join(f.directory, 'point.json'))),
    pointReservationSha256: sha(
      canonicalCoreJson({ version: point.version, id: point.id, ownerId: point.ownerId, createdAt: point.createdAt, envelope: point.envelope }),
    ),
  });
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.checkpoint)).toBe(true);
  const text = JSON.stringify(result);
  for (const privateValue of [f.passphrase, f.root, point.envelope.value, point.envelope.nonce, point.envelope.tag])
    expect(text).not.toContain(privateValue);
  expect(Object.keys(result).sort()).toEqual(
    [
      'schema',
      'pointId',
      'ownerId',
      'createdAt',
      'pointSha256',
      'pointReservationSha256',
      'metadataSha256',
      'cipherBytes',
      'cipherSha256',
      'manifestSha256',
      'imageInventorySha256',
      'captureReceiptSha256',
      'sourceSha256',
      'checkpointSha256',
      'checkpoint',
      'resourceCount',
      'imageCount',
    ].sort(),
  );
  expect(await fs.readdir(f.stagingDirectory)).toEqual([]);
});
it('handles fragmented encryption headers, manifests and rolling tags', async () => {
  const f = await setup();
  const original = TimeMachineStore.prototype.withArchive;
  vi.spyOn(TimeMachineStore.prototype, 'withArchive').mockImplementation(function (this: TimeMachineStore, point, abort, consume) {
    return original.call(this, point, abort, async (source, passphrase) =>
      consume(
        Readable.from(
          (async function* () {
            for await (const input of source) for (let i = 0; i < input.length; i += 7) yield input.subarray(i, i + 7);
          })(),
          { objectMode: false },
        ),
        passphrase,
      ),
    );
  });
  expect((await verifyCoreSavedPoint(f.options)).pointId).toBe(f.point.id);
});
it.each(['sourceSha256', 'checkpointSha256', 'captureReceiptSha256'] as const)(
  'rejects valid encryption bound to another external %s',
  async (key) => {
    const f = await setup();
    f.options.expectation = { ...f.options.expectation, [key]: 'f'.repeat(64) };
    await rejects(f);
  },
);
it.each(['digest', 'bytes', 'images', 'compatibility', 'resourceCount'] as const)(
  'rejects another external checkpoint/image binding: %s',
  async (field) => {
    const f = await setup();
    const expected = structuredClone(f.options.expectation);
    if (field === 'digest') expected.checkpoint.sha256 = 'f'.repeat(64);
    if (field === 'bytes') expected.checkpoint.bytes++;
    if (field === 'images') expected.images.controller = `sha256:${'f'.repeat(64)}`;
    if (field === 'compatibility') expected.compatibility.architecture = 'amd64';
    if (field === 'resourceCount') expected.resourceCount++;
    f.options.expectation = expected;
    await rejects(f);
  },
);
it('rejects a changed GCM tag even after mutable ciphertext and metadata digests are updated', async () => {
  const f = await setup();
  await publish(f, f.plaintext, f.manifest, (data) => {
    data[data.length - 1] = (data[data.length - 1] ?? 0) ^ 1;
    return data;
  });
  await rejects(f);
});
it.each(['truncated', 'trailing', 'magic', 'oversized', 'empty'] as const)('rejects an authenticated invalid frame: %s', async (kind) => {
  const f = await setup();
  let plaintext = Buffer.from(f.plaintext);
  if (kind === 'truncated') plaintext = plaintext.subarray(0, plaintext.length - 1);
  if (kind === 'trailing') plaintext = Buffer.concat([plaintext, Buffer.from('extra')]);
  if (kind === 'magic') plaintext[0] = (plaintext[0] ?? 0) ^ 1;
  if (kind === 'oversized') plaintext.writeUInt32BE(corePayloadLimits.manifestBytes + 1, 8);
  if (kind === 'empty') plaintext.writeUInt32BE(0, 8);
  await publish(f, plaintext);
  await rejects(f);
});
it.each(['path', 'unknown', 'binding', 'checkpoint', 'inventory', 'noncanonical', 'duplicate'] as const)(
  'rejects a rewritten authenticated manifest: %s',
  async (kind) => {
    const f = await setup();
    const manifest = structuredClone(f.manifest);
    if (kind === 'path') required(manifest.entries[1]).name = '../escape.tar';
    if (kind === 'unknown') Reflect.set(manifest, 'extra', true);
    if (kind === 'binding') required(manifest.inventory.bindings[0]).key = 'another';
    if (kind === 'checkpoint') required(manifest.entries[0]).sha256 = 'f'.repeat(64);
    if (kind === 'inventory') manifest.imageInventorySha256 = 'f'.repeat(64);
    let plaintext = frame(f, manifest);
    if (kind === 'noncanonical' || kind === 'duplicate') {
      const original = canonicalCoreJson(manifest);
      const json = Buffer.from(kind === 'noncanonical' ? ` ${original}` : original.replace('{', '{"schema":"orbis.time-machine-core.v1",'));
      const header = Buffer.from(plaintext.subarray(0, 12));
      header.writeUInt32BE(json.length, 8);
      plaintext = Buffer.concat([header, json, f.plaintext.subarray(12 + f.plaintext.readUInt32BE(8))]);
    }
    await publish(f, plaintext, manifest);
    await rejects(f);
  },
);
it('rejects a changed actual retained-image config despite rewritten archive hashes', async () => {
  const f = await setup();
  const manifest = structuredClone(f.manifest);
  const image = Buffer.from(f.fixture.saved.archive);
  const index = image.indexOf(Buffer.from('authenticated fixture'));
  expect(index).toBeGreaterThan(0);
  image[index] = (image[index] ?? 0) ^ 1;
  required(manifest.inventory.images[0]).sha256 = sha(image);
  manifest.imageInventorySha256 = sha(canonicalCoreJson(manifest.inventory));
  required(manifest.entries[1]).sha256 = sha(image);
  await publish(f, frame(f, manifest, Buffer.concat([f.fixture.checkpoint, image])), manifest);
  await rejects(f);
});
it('rejects metadata that is not authenticated by the persisted key envelope', async () => {
  const f = await setup();
  const point = await f.store.load(f.point.id);
  point.envelope.tag = 'f'.repeat(32);
  await fs.writeFile(path.join(f.directory, 'point.json'), JSON.stringify(point), { mode: 0o600 });
  await rejects(f);
});
it.each(['point.json', 'metadata.orbis', 'core.orbis'] as const)('rejects a symlink for %s', async (name) => {
  const f = await setup();
  const file = path.join(f.directory, name);
  await fs.rename(file, `${file}.original`);
  await fs.symlink(`${file}.original`, file);
  await rejects(f);
});
it('requires preexisting private canonical staging', async () => {
  const f = await setup();
  await fs.chmod(f.stagingDirectory, 0o755);
  await expect(verifyCoreSavedPoint(f.options)).rejects.toThrow();
  await fs.chmod(f.stagingDirectory, 0o700);
  f.options.stagingDirectory = path.join(f.root, 'absent');
  await expect(verifyCoreSavedPoint(f.options)).rejects.toThrow();
  await expect(fs.lstat(f.options.stagingDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('rejects cancellation before reading or during ciphertext consumption', async () => {
  const f = await setup();
  const abort = new AbortController();
  abort.abort();
  await expect(verifyCoreSavedPoint({ ...f.options, signal: abort.signal })).rejects.toThrow();
  const during = new AbortController();
  const original = TimeMachineStore.prototype.withArchive;
  vi.spyOn(TimeMachineStore.prototype, 'withArchive').mockImplementation(function (this: TimeMachineStore, point, inputSignal, consume) {
    return original.call(this, point, inputSignal, async (source, passphrase) =>
      consume(
        Readable.from(
          (async function* () {
            for await (const chunk of source) {
              during.abort();
              yield chunk;
            }
          })(),
          { objectMode: false },
        ),
        passphrase,
      ),
    );
  });
  await expect(verifyCoreSavedPoint({ ...f.options, signal: during.signal })).rejects.toThrow();
  expect(await fs.readdir(f.stagingDirectory)).toEqual([]);
});
it('postchecks the current saved point after complete image verification', async () => {
  const f = await setup();
  const original = TimeMachineStore.prototype.metadata;
  let calls = 0;
  vi.spyOn(TimeMachineStore.prototype, 'metadata').mockImplementation(async function (this: TimeMachineStore, point) {
    const result = await original.call(this, point);
    if (++calls === 2) await fs.rename(path.join(f.directory, 'point.json'), path.join(f.directory, 'point.retained'));
    return result;
  });
  await rejects(f);
});
it('preserves unexpected staging content without recursively removing it', async () => {
  const f = await setup();
  const original = TimeMachineStore.prototype.withArchive;
  vi.spyOn(TimeMachineStore.prototype, 'withArchive').mockImplementation(function (this: TimeMachineStore, point, abort, consume) {
    return original.call(this, point, abort, async (source, passphrase) => {
      const [name] = await fs.readdir(f.stagingDirectory);
      await fs.writeFile(path.join(f.stagingDirectory, required(name), 'unexpected'), 'preserve', { mode: 0o600 });
      return consume(source, passphrase);
    });
  });
  await expect(verifyCoreSavedPoint(f.options)).rejects.toThrow();
  const [name] = await fs.readdir(f.stagingDirectory);
  expect(await fs.readFile(path.join(f.stagingDirectory, required(name), 'unexpected'), 'utf8')).toBe('preserve');
});
