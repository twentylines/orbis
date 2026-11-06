import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { corePayloadImage } from './time-machine-core-payload.fixture';
import { canonicalCoreJson, type CorePayloadExpectation } from './time-machine-core-payload';
import { buildCoreImageInventory, parseCoreImageInventoryArguments } from './time-machine-core-image-inventory-worker';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');
async function fixture(kind: 'docker' | 'oci' = 'docker') {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'orbis-inventory-'));
  roots.push(root);
  const exportDirectory = path.join(root, 'exports');
  const outputDirectory = path.join(root, 'output');
  await fs.mkdir(exportDirectory, { mode: 0o700 });
  await fs.mkdir(outputDirectory, { mode: 0o700 });
  const value = corePayloadImage(kind);
  const imageId = value.item.imageId;
  const platform = { os: 'linux', architecture: 'arm64' };
  const inspection =
    kind === 'docker'
      ? { Id: imageId }
      : { Id: imageId, Manifests: [{ Kind: 'image', Available: true, Descriptor: { digest: value.item.identity.manifestId, platform } }] };
  const selected = { Id: kind === 'docker' ? imageId : value.item.identity.manifestId, Os: 'linux', Architecture: 'arm64' };
  const exports = { schema: 'orbis.core-image-exports.v1', images: [{ imageId, inspection, selected }] };
  const manifest = path.join(exportDirectory, 'exports.json');
  const archive = path.join(exportDirectory, value.item.archive);
  await fs.writeFile(manifest, JSON.stringify(exports), { mode: 0o600 });
  await fs.writeFile(archive, value.archive, { mode: 0o600 });
  const expectation: CorePayloadExpectation = {
    pointId: '11111111-1111-4111-8111-111111111111',
    sourceSha256: 'a'.repeat(64),
    checkpointSha256: 'b'.repeat(64),
    captureReceiptSha256: 'c'.repeat(64),
    resourceCount: 1,
    images: { controller: imageId, database: imageId, queue: imageId },
    compatibility: { os: 'linux', architecture: 'arm64', database: { engine: 'postgresql', major: 17 }, storageFormat: 'physical-pgdata.v1' },
    checkpoint: { bytes: 1, sha256: 'd'.repeat(64) },
  };
  return { root, exportDirectory, outputDirectory, value, exports, manifest, archive, expectation, signal: new AbortController().signal };
}

for (const kind of ['docker', 'oci'] as const) {
  it(`builds a verified ${kind} inventory and publishes it as one directory`, async () => {
    const f = await fixture(kind);
    const result = await buildCoreImageInventory(f);
    expect(result).toMatchObject({
      schema: 'orbis.core-image-inventory-publication.v1',
      pointId: f.expectation.pointId,
      imageCount: 1,
      totalBytes: f.value.archive.length,
    });
    expect(await fs.readdir(f.outputDirectory)).toEqual(['images']);
    const directory = path.join(f.outputDirectory, 'images');
    const inventory = await fs.readFile(path.join(directory, 'inventory.json'));
    expect(result.inventorySha256).toBe(sha(inventory));
    expect(JSON.parse(inventory.toString()).images[0].identity.kind).toBe(kind);
    expect(await fs.readFile(path.join(directory, f.value.item.archive))).toEqual(f.value.archive);
    await expect(buildCoreImageInventory(f)).rejects.toThrow();
    expect((await fs.readdir(f.exportDirectory)).sort()).toEqual([f.value.item.archive, 'exports.json'].sort());
  });
}

it('rejects malformed exports, mismatched IDs, missing and tampered archives', async () => {
  for (const mode of ['bad schema', 'id mismatch', 'missing', 'tampered']) {
    const f = await fixture();
    if (mode === 'bad schema') await fs.writeFile(f.manifest, '{}');
    if (mode === 'id mismatch')
      await fs.writeFile(f.manifest, JSON.stringify({ ...f.exports, images: [{ ...f.exports.images[0], imageId: `sha256:${'f'.repeat(64)}` }] }));
    if (mode === 'missing') await fs.unlink(f.archive);
    if (mode === 'tampered') await fs.writeFile(f.archive, Buffer.alloc(f.value.archive.length));
    await expect(buildCoreImageInventory(f), mode).rejects.toThrow();
    expect(await fs.readdir(f.outputDirectory)).not.toContain('images');
  }
});

it('rejects unsafe permissions, symbolic and hard links, and nonempty output', async () => {
  for (const mode of ['mode', 'symlink', 'hardlink', 'extra', 'output']) {
    const f = await fixture();
    if (mode === 'mode') await fs.chmod(f.archive, 0o644);
    if (mode === 'symlink') {
      await fs.rename(f.archive, path.join(f.root, 'original'));
      await fs.symlink(path.join(f.root, 'original'), f.archive);
    }
    if (mode === 'hardlink') await fs.link(f.archive, path.join(f.root, 'link'));
    if (mode === 'extra') await fs.writeFile(path.join(f.exportDirectory, 'extra'), 'x');
    if (mode === 'output') await fs.writeFile(path.join(f.outputDirectory, 'keep'), 'x');
    await expect(buildCoreImageInventory(f), mode).rejects.toThrow();
    if (mode === 'output') expect(await fs.readFile(path.join(f.outputDirectory, 'keep'), 'utf8')).toBe('x');
  }
});

it('accepts only the canonical bounded command', async () => {
  const f = await fixture();
  expect(parseCoreImageInventoryArguments(['--build', canonicalCoreJson(f.expectation)]).mode).toBe('build');
  expect(() => parseCoreImageInventoryArguments(['--build', JSON.stringify(f.expectation)])).toThrow();
  expect(() => parseCoreImageInventoryArguments(['--build', 'x'.repeat(8193)])).toThrow();
  expect(parseCoreImageInventoryArguments(['--capability']).mode).toBe('capability');
});

it('rejects a source archive replaced while the capture is running', async () => {
  const f = await fixture();
  const originalOpen = fs.open.bind(fs);
  let swapped = false;
  const spy = vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    if (!swapped && String(args[0]).includes('retained-images-') && String(args[0]).endsWith('.tar')) {
      swapped = true;
      await fs.rename(f.archive, path.join(f.root, 'original'));
      await fs.writeFile(f.archive, f.value.archive, { mode: 0o600 });
    }
    return originalOpen(...args);
  });
  try {
    await expect(buildCoreImageInventory(f)).rejects.toThrow();
    expect(swapped).toBe(true);
    expect(await fs.readdir(f.outputDirectory)).not.toContain('images');
  } finally {
    spy.mockRestore();
  }
});
