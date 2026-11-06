import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { corePayloadImage as image, createCorePayloadFixture } from './time-machine-core-payload.fixture';
import { backupGcmPlaintextLimit } from './backup-crypto';
import { canonicalCoreJson, corePayloadLimits, prepareCorePayload, withCorePayload, type VerifiedCorePayload } from './time-machine-core-payload';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const signal = () => new AbortController().signal;
function first<T>(values: T[]): T {
  const value = values[0];
  if (value === undefined) throw new Error('Expected fixture entry');
  return value;
}
async function fixture(kind: 'docker' | 'oci' = 'docker') {
  const value = await createCorePayloadFixture(kind);
  roots.push(value.root);
  return value;
}
async function collect(source: Readable) {
  const parts: Buffer[] = [];
  for await (const part of source) parts.push(Buffer.from(part));
  return Buffer.concat(parts);
}
it.each(['docker', 'oci'] as const)('streams canonical frame and exact authenticated %s content with immutable portable metadata', async (kind) => {
  const value = await fixture(kind);
  const token = await prepareCorePayload(value.options);
  expect(Object.isFrozen(token)).toBe(true);
  await withCorePayload(token, signal(), async ({ source, bytes, manifest, manifestSha256 }) => {
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.inventory.images[0]?.identity)).toBe(true);
    expect(Object.isFrozen(manifest.entries)).toBe(true);
    const result = await collect(source);
    expect(result.length).toBe(bytes);
    expect(result.subarray(0, 8).toString('ascii')).toBe('ORBISCO1');
    const length = result.readUInt32BE(8);
    const encoded = result.subarray(12, 12 + length);
    expect(encoded.toString('utf8')).toBe(canonicalCoreJson(manifest));
    expect(manifestSha256).toBe(sha(encoded));
    expect(manifest.imageInventorySha256).toBe(sha(canonicalCoreJson(manifest.inventory)));
    expect(manifest.entries.map((entry) => entry.name)).toEqual(['checkpoint.tar', `images/${value.saved.item.archive}`]);
    expect(manifest.inventory.bindings.map((binding) => binding.key)).toEqual(['controller', 'database', 'queue']);
    expect(encoded.toString()).not.toContain(value.root);
    expect(encoded.toString()).not.toMatch(/operatorAuthorizationId|\/Users\/|\/proc\/|command|journal/);
    let offset = 12 + length;
    for (const entry of manifest.entries) {
      const data = result.subarray(offset, offset + entry.bytes);
      expect(sha(data)).toBe(entry.sha256);
      offset += entry.bytes;
    }
    expect(offset).toBe(result.length);
    expect(result.subarray(12 + length, 12 + length + value.checkpoint.length)).toEqual(value.checkpoint);
    expect(result.subarray(12 + length + value.checkpoint.length)).toEqual(value.saved.archive);
  });
  await expect(withCorePayload(token, signal(), async ({ source }) => collect(source))).rejects.toThrow();
});
it.each([
  'role',
  'extra-role',
  'duplicate-role',
  'extra-inventory-key',
  'extra-image-key',
  'unused-image',
  'platform',
  'extra-platform-key',
] as const)('rejects %s inventory or compatibility', async (mode) => {
  const value = await fixture();
  const inventory = value.options.imageInventory;
  if (mode === 'role') first(inventory.bindings).key = 'app';
  if (mode === 'extra-role') inventory.bindings.push({ key: 'app', imageId: value.saved.item.imageId });
  if (mode === 'duplicate-role') first(inventory.bindings).key = 'controller';
  if (mode === 'extra-inventory-key') Object.assign(inventory, { nativePath: value.root });
  if (mode === 'extra-image-key') Object.assign(first(inventory.images), { nativePath: value.root });
  if (mode === 'unused-image') inventory.images.push(image('docker', 'amd64').item);
  if (mode === 'platform') value.options.expectation.compatibility.architecture = 'amd64';
  if (mode === 'extra-platform-key') Object.assign(value.options.expectation.compatibility, { nativePath: value.root });
  await expect(prepareCorePayload(value.options)).rejects.toThrow();
});
it.each([
  'pointId',
  'sourceSha256',
  'checkpointSha256',
  'captureReceiptSha256',
  'resourceCount',
  'checkpoint-hash',
  'checkpoint-length',
  'extra',
] as const)('rejects malformed or unbound %s expectation', async (mode) => {
  const value = await fixture();
  const expected = value.options.expectation;
  if (mode === 'pointId') expected.pointId = '../native-path';
  if (mode === 'sourceSha256' || mode === 'checkpointSha256' || mode === 'captureReceiptSha256') expected[mode] = 'wrong';
  if (mode === 'resourceCount') expected.resourceCount = 4097;
  if (mode === 'checkpoint-hash') expected.checkpoint.sha256 = '0'.repeat(64);
  if (mode === 'checkpoint-length') expected.checkpoint.bytes += 1;
  if (mode === 'extra') Object.assign(expected, { operatorAuthorizationId: value.root });
  await expect(prepareCorePayload(value.options)).rejects.toThrow();
});
it.each(['changed-bytes', 'replacement', 'hardlink', 'symlink', 'loose-mode', 'trailing', 'short'] as const)(
  'rejects checkpoint %s after preparation',
  async (mode) => {
    const value = await fixture();
    const token = await prepareCorePayload(value.options);
    const file = value.options.checkpointFile;
    if (mode === 'changed-bytes') await fs.writeFile(file, Buffer.alloc(value.checkpoint.length, 1));
    if (mode === 'replacement') {
      await fs.rename(file, `${file}.old`);
      await fs.writeFile(file, value.checkpoint, { mode: 0o600 });
    }
    if (mode === 'hardlink') await fs.link(file, `${file}.alias`);
    if (mode === 'symlink') {
      await fs.rename(file, `${file}.old`);
      await fs.symlink(`${file}.old`, file);
    }
    if (mode === 'loose-mode') await fs.chmod(file, 0o644);
    if (mode === 'trailing') await fs.appendFile(file, 'tail');
    if (mode === 'short') await fs.truncate(file, value.checkpoint.length - 1);
    let called = false;
    await expect(
      withCorePayload(token, signal(), async ({ source }) => {
        called = true;
        return collect(source);
      }),
    ).rejects.toThrow();
    expect(called).toBe(false);
  },
);
it('rechecks checkpoint changes during the consumer before accepting its result', async () => {
  const value = await fixture();
  const token = await prepareCorePayload(value.options);
  await expect(
    withCorePayload(token, signal(), async ({ source }) => {
      await fs.writeFile(value.options.checkpointFile, Buffer.alloc(value.checkpoint.length, 2));
      await collect(source);
      return 'must not seal';
    }),
  ).rejects.toThrow();
});
it.each(['checksum', 'archive-proof', 'post-prepare'] as const)('rejects image %s tampering', async (mode) => {
  const value = await fixture();
  const file = path.join(value.options.imageDirectory, value.saved.item.archive);
  let token: VerifiedCorePayload | undefined;
  if (mode === 'post-prepare') token = await prepareCorePayload(value.options);
  const corrupt = Buffer.alloc(value.saved.archive.length, 0x61);
  await fs.writeFile(file, corrupt);
  if (mode === 'archive-proof') first(value.options.imageInventory.images).sha256 = sha(corrupt);
  if (token) await expect(withCorePayload(token, signal(), async ({ source }) => collect(source))).rejects.toThrow();
  else await expect(prepareCorePayload(value.options)).rejects.toThrow();
});
it('rejects forged capabilities without invoking consumers', async () => {
  let called = false;
  await expect(
    withCorePayload(Object.freeze({}) as VerifiedCorePayload, signal(), async () => {
      called = true;
    }),
  ).rejects.toThrow();
  expect(called).toBe(false);
});
it.each(['none', 'partial', 'throw'] as const)('rejects a %s consumer', async (mode) => {
  const value = await fixture();
  const token = await prepareCorePayload(value.options);
  await expect(
    withCorePayload(token, signal(), async ({ source }) => {
      if (mode === 'throw') throw new Error('consumer failed');
      if (mode === 'partial') for await (const _part of source) break;
      return 'incomplete';
    }),
  ).rejects.toThrow();
});
it('cancels an uncooperative pending consumer and destroys the stream', async () => {
  const value = await fixture();
  const token = await prepareCorePayload(value.options);
  const controller = new AbortController();
  let captured: Readable | undefined;
  await expect(
    withCorePayload(token, controller.signal, async ({ source }) => {
      captured = source;
      controller.abort(new Error('cancelled'));
      return new Promise<never>(() => {});
    }),
  ).rejects.toThrow('cancelled');
  expect(captured?.destroyed).toBe(true);
});
it('rejects pre-aborted preparation and capability consumption', async () => {
  const value = await fixture();
  const controller = new AbortController();
  const token = await prepareCorePayload(value.options);
  controller.abort();
  await expect(prepareCorePayload({ ...value.options, signal: controller.signal })).rejects.toThrow();
  await expect(withCorePayload(token, controller.signal, async ({ source }) => collect(source))).rejects.toThrow();
});
it.each(['checkpoint-mode', 'image-mode', 'directory-mode', 'directory-symlink', 'checkpoint-symlink', 'checkpoint-hardlink'] as const)(
  'rejects %s before preparing a capability',
  async (mode) => {
    const value = await fixture();
    if (mode === 'checkpoint-mode') await fs.chmod(value.options.checkpointFile, 0o644);
    if (mode === 'image-mode') await fs.chmod(path.join(value.options.imageDirectory, value.saved.item.archive), 0o644);
    if (mode === 'directory-mode') await fs.chmod(value.options.imageDirectory, 0o755);
    if (mode === 'directory-symlink') {
      const original = value.options.imageDirectory;
      await fs.rename(original, `${original}.old`);
      await fs.symlink(`${original}.old`, original);
    }
    if (mode === 'checkpoint-symlink') {
      await fs.rename(value.options.checkpointFile, `${value.options.checkpointFile}.old`);
      await fs.symlink(`${value.options.checkpointFile}.old`, value.options.checkpointFile);
    }
    if (mode === 'checkpoint-hardlink') await fs.link(value.options.checkpointFile, `${value.options.checkpointFile}.alias`);
    await expect(prepareCorePayload(value.options)).rejects.toThrow();
  },
);
it('reserves encryption headroom before opening oversized checkpoint inputs', async () => {
  const value = await fixture();
  value.options.expectation.checkpoint.bytes = backupGcmPlaintextLimit - corePayloadLimits.reserveBytes;
  await expect(prepareCorePayload(value.options)).rejects.toThrow();
});
it('orders three distinct role images by image ID and does not freeze or trust later caller mutation', async () => {
  const value = await fixture();
  for (const content of ['second', 'third']) {
    const saved = image('docker', 'arm64', content);
    await fs.writeFile(path.join(value.options.imageDirectory, saved.item.archive), saved.archive, { mode: 0o600 });
    value.options.imageInventory.images.push(saved.item);
  }
  value.options.imageInventory.bindings = value.options.imageInventory.images.map((item, index) => ({
    key: ['controller', 'database', 'queue'][index] ?? '',
    imageId: item.imageId,
  }));
  for (const binding of value.options.imageInventory.bindings) {
    if (binding.key === 'controller' || binding.key === 'database' || binding.key === 'queue')
      value.options.expectation.images[binding.key] = binding.imageId;
  }
  const token = await prepareCorePayload(value.options);
  expect(Object.isFrozen(value.options.imageInventory)).toBe(false);
  value.options.expectation.sourceSha256 = '0'.repeat(64);
  value.options.imageInventory.bindings[0] = { key: 'unexpected', imageId: 'wrong' };
  await withCorePayload(token, signal(), async ({ source, manifest }) => {
    const ids = manifest.inventory.images.map((item) => item.imageId);
    expect(ids).toEqual([...ids].sort());
    expect(manifest.entries.slice(1).map((entry) => entry.name)).toEqual(manifest.inventory.images.map((item) => `images/${item.archive}`));
    expect(manifest.sourceSha256).toBe('a'.repeat(64));
    await collect(source);
  });
});
it('rejects valid image archives that differ from the trusted captured role bindings', async () => {
  const value = await fixture();
  value.options.expectation.images.database = `sha256:${'9'.repeat(64)}`;
  await expect(prepareCorePayload(value.options)).rejects.toThrow();
});
it('rejects a foreign directory owner before opening payload files', async () => {
  const value = await fixture();
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('Ownership verification requires getuid');
  vi.spyOn(process, 'getuid').mockReturnValue(uid + 1);
  await expect(prepareCorePayload(value.options)).rejects.toThrow();
});
it('rejects an OCI platform mismatch without confusing source, manifest, config and index IDs', async () => {
  const value = await fixture('oci');
  const identity = value.saved.item.identity;
  expect(new Set([value.saved.item.imageId, identity.configId, identity.manifestId, identity.archiveRootId]).size).toBe(4);
  value.options.expectation.compatibility.architecture = 'amd64';
  await expect(prepareCorePayload(value.options)).rejects.toThrow();
});
it('does not accept metadata returned by a consumer that changes a source after reading it', async () => {
  const value = await fixture();
  const token = await prepareCorePayload(value.options);
  await expect(
    withCorePayload(token, signal(), async ({ source }) => {
      await collect(source);
      await fs.chmod(value.options.checkpointFile, 0o644);
      return 'unsealed';
    }),
  ).rejects.toThrow();
});
it('closes every opened file descriptor after a partial consumer fails', async () => {
  const value = await fixture();
  const token = await prepareCorePayload(value.options);
  const original = fs.open.bind(fs);
  const descriptors: { handle: Awaited<ReturnType<typeof fs.open>>; close: ReturnType<typeof vi.fn> }[] = [];
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await original(...args);
    descriptors.push({ handle, close: vi.spyOn(handle, 'close') });
    return handle;
  });
  await expect(
    withCorePayload(token, signal(), async ({ source }) => {
      for await (const _part of source) break;
    }),
  ).rejects.toThrow();
  expect(descriptors.length).toBeGreaterThanOrEqual(2);
  for (const { handle, close } of descriptors) {
    expect(close).toHaveBeenCalled();
    expect(handle.fd).toBe(-1);
  }
});
it('streams a larger checkpoint in bounded chunks without collecting the payload', async () => {
  const value = await fixture();
  const checkpoint = Buffer.alloc(2 * 1024 * 1024, 0x61);
  await fs.writeFile(value.options.checkpointFile, checkpoint);
  value.options.expectation.checkpoint = { bytes: checkpoint.length, sha256: sha(checkpoint) };
  const token = await prepareCorePayload(value.options);
  await withCorePayload(token, signal(), async ({ source, bytes }) => {
    let received = 0;
    let largest = 0;
    await new Promise<void>((resolve, reject) => {
      source.on('data', (chunk: Buffer) => {
        received += chunk.length;
        largest = Math.max(largest, chunk.length);
      });
      source.once('end', resolve);
      source.once('error', reject);
    });
    expect(received).toBe(bytes);
    expect(largest).toBeLessThanOrEqual(corePayloadLimits.chunkBytes);
  });
});
