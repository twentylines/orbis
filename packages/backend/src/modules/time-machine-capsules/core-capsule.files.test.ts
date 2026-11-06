import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { backupMetadataBytes } from '../system-backups/backup-crypto';
import { canonicalCoreJson } from '../system-backups/time-machine-core-payload';
import { coreCapsuleFixture } from './core-capsule.fixture';
import { capsuleManifestSchema, exportCapsule, importCapsule, type CapsuleManifest, type CapsuleSource } from './capsule';
import { coreCapsuleReview, verifyCapsuleContents, withVerifiedCapsuleContents, type VerifiedCapsuleContents } from './verify';

const fixtures: Awaited<ReturnType<typeof coreCapsuleFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.dispose();
});
const signal = () => new AbortController().signal;
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
async function setup(kind: 'docker' | 'oci' = 'docker') {
  const f = await coreCapsuleFixture(kind);
  fixtures.push(f);
  return f;
}
async function exported(f: Awaited<ReturnType<typeof setup>>) {
  const result = await f.capsules.startExport(1, f.request, f.credentials, f.point.id, f.passphrase);
  result.start();
  await vi.waitFor(async () => expect((await f.capsules.list(1)).jobs.find((job) => job.id === result.job.id)?.status).toBe('ready'), {
    timeout: 15_000,
  });
  return result.job.id;
}
async function open(f: Awaited<ReturnType<typeof setup>>, source: string, passphrase = f.passphrase) {
  let token: VerifiedCapsuleContents | undefined;
  const result = await importCapsule({
    source,
    passphrase,
    stagingParent: f.root,
    signal: signal(),
    verify: async (manifest, directory, signal) => {
      token = await verifyCapsuleContents({
        manifest,
        directory,
        signal,
        database: f.database,
        target: { orbisVersion: 'fixture', runtipiVersion: 'fixture', architecture: 'arm64' },
      });
    },
  });
  if (!token) throw new Error('Missing verified token');
  return { ...result, token };
}
it.each(['docker', 'oci'] as const)('exports genuine encrypted %s core capture through download/upload and authenticated review', async (kind) => {
  const f = await setup(kind);
  const id = await exported(f);
  await expect(f.capsules.download(id, 2, f.request, f.credentials)).rejects.toThrow();
  const imported = await vi.waitFor(() => f.capsules.createImport(1, f.request, f.credentials));
  const download = await f.capsules.download(id, 1, f.request, f.credentials);
  await f.capsules.upload(imported.id, 1, download.stream, String(download.bytes), signal());
  const review = await f.capsules.review(imported.id, 1, f.request, f.credentials, f.passphrase);
  review.start();
  await vi.waitFor(async () => expect((await f.capsules.list(1)).jobs.find((job) => job.id === imported.id)?.status).toBe('verified'), {
    timeout: 15_000,
  });
  expect((await f.capsules.list(1)).jobs.every((job) => job.restoreSupported === false)).toBe(true);
  expect(f.database.review).not.toHaveBeenCalled();
  const source = path.join(f.root, 'backups/capsules', imported.id, 'capsule.orbis-tm');
  const opened = await open(f, source);
  expect(await coreCapsuleReview(opened.token, signal())).toMatchObject({
    pointId: f.point.id,
    sourceOwnerId: 1,
    metadata: { version: 3, coreFormat: 'orbis.time-machine-core.v1', restore: { ready: false } },
    restoreSupported: false,
  });
  expect(Object.isFrozen((await coreCapsuleReview(opened.token, signal())).metadata.core)).toBe(true);
  expect((await fs.readdir(opened.directory)).sort()).toEqual(['capture-draft.orbis', 'core.orbis', 'metadata.orbis']);
  await expect(withVerifiedCapsuleContents(opened.token, signal(), async () => undefined)).rejects.toThrow();
  const changed = path.join(opened.directory, 'core.orbis');
  await fs.writeFile(changed, Buffer.alloc((await fs.stat(changed)).size));
  await expect(coreCapsuleReview(opened.token, signal())).rejects.toThrow();
  await opened.dispose();
});
it('retains current account/session, ownership and inner-key checks for core exports', async () => {
  const f = await setup();
  const consume = vi.fn();
  await expect(f.machine.withPortablePoint(f.point.id, 2, f.request, f.credentials, signal(), consume)).rejects.toThrow();
  f.auth.operatorActionContext.mockResolvedValueOnce(f.actor).mockResolvedValueOnce({ ...f.actor, sessionBinding: 'c'.repeat(64) });
  await expect(f.machine.withPortablePoint(f.point.id, 1, f.request, f.credentials, signal(), consume)).rejects.toThrow();
  const directory = path.join(f.root, 'backups/time-machine/points', f.point.id);
  await fs.writeFile(path.join(directory, 'capture-draft.orbis'), await backupMetadataBytes(Buffer.from('{}'), 'a different inner point key', false));
  await expect(f.machine.withPortablePoint(f.point.id, 1, f.request, f.credentials, signal(), consume)).rejects.toThrow();
  expect(consume).not.toHaveBeenCalled();
});
it('rejects wrong outer passphrase, ciphertext tampering and mismatched schema versions', async () => {
  const f = await setup();
  const id = await exported(f);
  const source = path.join(f.root, 'backups/capsules', id, 'capsule.orbis-tm');
  await expect(open(f, source, 'a different outer passphrase')).rejects.toThrow();
  const original = await fs.readFile(source);
  const changed = Buffer.from(original);
  changed[changed.length - 1] = (changed[changed.length - 1] ?? 0) ^ 1;
  const copy = path.join(f.root, 'tampered.orbis-tm');
  await fs.writeFile(copy, changed, { mode: 0o600 });
  await expect(open(f, copy)).rejects.toThrow();
  const schema = Buffer.from(original);
  const position = schema.indexOf('orbis.time-machine-capsule.v2');
  expect(position).toBeGreaterThan(0);
  schema[position + 'orbis.time-machine-capsule.v'.length] = '1'.charCodeAt(0);
  await fs.writeFile(copy, schema);
  await expect(open(f, copy)).rejects.toThrow();
});
it.each(['owner', 'metadata-version', 'payload-version', 'inner-key', 'core-tag', 'image-layer'] as const)(
  'rejects authenticated %s rebinding inside a fresh outer capsule',
  async (attack) => {
    const f = await setup();
    const id = await exported(f);
    const source = path.join(f.root, 'backups/capsules', id, 'capsule.orbis-tm');
    let saved: CapsuleManifest | undefined;
    const extracted = await importCapsule({
      source,
      stagingParent: f.root,
      passphrase: f.passphrase,
      signal: signal(),
      verify: async (manifest) => {
        saved = manifest;
      },
    });
    if (!saved || saved.schema !== 'orbis.time-machine-capsule-private.v2') throw new Error('Missing core manifest');
    const entries: CapsuleSource[] = [];
    let changedCore: Buffer | undefined;
    let changedManifest: { sha256: string; inventorySha256: string } | undefined;
    for (const entry of saved.entries) {
      let bytes = await fs.readFile(path.join(extracted.directory, entry.name));
      if (attack === 'metadata-version' && entry.name === 'metadata.orbis') {
        const record = JSON.parse((await backupMetadataBytes(bytes, f.key, true)).toString());
        record.version = 2;
        bytes = await backupMetadataBytes(Buffer.from(JSON.stringify(record)), f.key, false);
      }
      if (attack === 'payload-version' && entry.name === 'core.orbis') {
        const plaintext = await backupMetadataBytes(bytes, f.key, true);
        plaintext.write('ORBISCO2');
        bytes = await backupMetadataBytes(plaintext, f.key, false);
        plaintext.fill(0);
        changedCore = bytes;
      }
      if (attack === 'core-tag' && entry.name === 'core.orbis') {
        bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
        changedCore = bytes;
      }
      if (attack === 'image-layer' && entry.name === 'core.orbis') {
        const plaintext = await backupMetadataBytes(bytes, f.key, true);
        const length = plaintext.readUInt32BE(8);
        const payload = JSON.parse(plaintext.subarray(12, 12 + length).toString());
        const suffix = Buffer.from(plaintext.subarray(12 + length));
        const position = suffix.indexOf('authenticated fixture');
        expect(position).toBeGreaterThan(0);
        suffix[position] = (suffix[position] ?? 0) ^ 1;
        const image = payload.entries[1];
        const start = payload.entries[0].bytes;
        const digest = hash(suffix.subarray(start, start + image.bytes));
        image.sha256 = digest;
        payload.inventory.images[0].sha256 = digest;
        payload.imageInventorySha256 = hash(Buffer.from(canonicalCoreJson(payload.inventory)));
        const encoded = Buffer.from(canonicalCoreJson(payload));
        const prefix = Buffer.alloc(12);
        prefix.write('ORBISCO1');
        prefix.writeUInt32BE(encoded.length, 8);
        changedManifest = { sha256: hash(encoded), inventorySha256: payload.imageInventorySha256 };
        bytes = await backupMetadataBytes(Buffer.concat([prefix, encoded, suffix]), f.key, false);
        plaintext.fill(0);
        changedCore = bytes;
      }
      if (changedCore && entry.name === 'metadata.orbis') {
        const metadata = JSON.parse((await backupMetadataBytes(bytes, f.key, true)).toString());
        metadata.archiveBytes = changedCore.length;
        metadata.archiveSha256 = hash(changedCore);
        metadata.core.cipherBytes = changedCore.length;
        metadata.core.cipherSha256 = hash(changedCore);
        if (changedManifest) {
          metadata.manifestSha256 = changedManifest.sha256;
          metadata.core.manifestSha256 = changedManifest.sha256;
          metadata.core.imageInventorySha256 = changedManifest.inventorySha256;
        }
        bytes = await backupMetadataBytes(Buffer.from(JSON.stringify(metadata)), f.key, false);
      }
      entries.push({ ...entry, bytes: bytes.length, sha256: hash(bytes), source: Readable.from([bytes]) });
    }
    const rewritten = path.join(f.root, 'rebound.orbis-tm');
    await exportCapsule({
      destination: rewritten,
      pointId: saved.pointId,
      createdAt: saved.createdAt,
      pointKey: attack === 'inner-key' ? 'x'.repeat(43) : saved.pointKey,
      sourceOwnerId: attack === 'owner' ? 2 : saved.sourceOwnerId,
      entries,
      passphrase: f.passphrase,
      signal: signal(),
    });
    if (attack === 'image-layer') await expect(open(f, rewritten)).rejects.toThrow('Retained container images could not be verified.');
    else await expect(open(f, rewritten)).rejects.toThrow();
    await extracted.dispose();
  },
);
it('keeps explicit core entries and source owner out of the legacy private manifest', async () => {
  const base = {
    capsuleId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    pointId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    createdAt: 1234,
    pointKey: 'x'.repeat(43),
    entries: ['core.orbis', 'capture-draft.orbis', 'metadata.orbis'].map((name) => ({ name, bytes: 52, sha256: 'a'.repeat(64) })),
  };
  expect(capsuleManifestSchema.allows({ ...base, schema: 'orbis.time-machine-capsule-private.v2', sourceOwnerId: 1 })).toBe(true);
  expect(capsuleManifestSchema.allows({ ...base, schema: 'orbis.time-machine-capsule-private.v1' })).toBe(false);
  expect(capsuleManifestSchema.allows({ ...base, schema: 'orbis.time-machine-capsule-private.v2' })).toBe(false);
});
it.each(['legacy', 'core'] as const)('rejects oversized aggregate %s contents before opening private source files', async (kind) => {
  const manifest = capsuleManifestSchema.assert({
    schema: kind === 'core' ? 'orbis.time-machine-capsule-private.v2' : 'orbis.time-machine-capsule-private.v1',
    ...(kind === 'core' ? { sourceOwnerId: 1 } : {}),
    capsuleId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    pointId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    createdAt: 1234,
    pointKey: 'x'.repeat(43),
    entries: (kind === 'core' ? ['core.orbis', 'capture-draft.orbis', 'metadata.orbis'] : ['backup.orbis', 'runtime.orbis', 'metadata.orbis']).map(
      (name) => ({ name, bytes: 64 * 1024 ** 3 - 32, sha256: 'a'.repeat(64) }),
    ),
  });
  await expect(
    verifyCapsuleContents({
      manifest,
      directory: '',
      signal: signal(),
      database: { review: vi.fn() },
      target: { orbisVersion: 'fixture', runtipiVersion: 'fixture', architecture: 'arm64' },
    }),
  ).rejects.toThrow('The capsule contents did not pass verification.');
});
it('rejects replacement of authenticated core ciphertext before the pinned decryption open', async () => {
  const f = await setup();
  const id = await exported(f);
  const source = path.join(f.root, 'backups/capsules', id, 'capsule.orbis-tm');
  const originalOpen = fs.open.bind(fs);
  let replaced = false;
  const opening = vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
    const name = String(file);
    if (
      !replaced &&
      path.basename(name) === 'core.orbis' &&
      (await fs.readdir(path.dirname(name))).some((child) => child.startsWith('core-review-'))
    ) {
      replaced = true;
      const bytes = await fs.readFile(name);
      await fs.rename(name, `${name}.old`);
      await fs.writeFile(name, bytes, { mode: 0o600 });
    }
    return originalOpen(file, flags, mode);
  });
  try {
    await expect(open(f, source)).rejects.toThrow('The core capsule did not pass read-only verification.');
    expect(replaced).toBe(true);
  } finally {
    opening.mockRestore();
  }
});
