import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { captureRetainedImages, type RetainedImageDocker, type RetainedImageInspection, type RetainedImagePlatform } from './backup-image-retention';
import { canonicalCoreJson, validateCorePayloadExpectation, type CorePayloadExpectation } from './time-machine-core-payload';

const fail = () => new Error('Image inventory could not be built.');
const idPattern = /^sha256:[a-f0-9]{64}$/;
const maxImage = 16 * 1024 ** 3;
const maxTotal = 64 * 1024 ** 3;
const archiveName = (id: string) => `image-${id.slice(7)}.tar`;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).sort().join(',') === [...keys].sort().join(',');
type Stat = Awaited<ReturnType<typeof fs.lstat>>;
type Snapshot = { file: string; stat: Stat; directory: boolean };
const equal = (a: Stat, b: Stat, directory: boolean) =>
  (directory ? ['dev', 'ino', 'mode', 'uid', 'gid'] : ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeMs', 'ctimeMs']).every(
    (key) => Reflect.get(a, key) === Reflect.get(b, key),
  );
async function snapshot(file: string, directory = false): Promise<Snapshot> {
  if (!path.isAbsolute(file) || path.resolve(file) !== file || (await fs.realpath(file)) !== file) throw fail();
  const stat = await fs.lstat(file);
  if (
    stat.uid !== process.getuid?.() ||
    (directory
      ? !stat.isDirectory() || (stat.mode & 0o7777) !== 0o700
      : !stat.isFile() || stat.nlink !== 1 || ![0o400, 0o600].includes(stat.mode & 0o7777))
  )
    throw fail();
  return { file, stat, directory };
}
async function recheck(item: Snapshot) {
  if ((await fs.realpath(item.file)) !== item.file || !equal(item.stat, await fs.lstat(item.file), item.directory)) throw fail();
}
async function openChecked(item: Snapshot): Promise<FileHandle> {
  const handle = await fs.open(item.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  if (!equal(item.stat, await handle.stat(), false)) {
    await handle.close();
    throw fail();
  }
  return handle;
}
async function readExports(item: Snapshot, signal: AbortSignal): Promise<unknown> {
  if (item.stat.size < 1 || item.stat.size > 1024 * 1024) throw fail();
  const handle = await openChecked(item);
  try {
    const bytes = Buffer.alloc(Number(item.stat.size));
    let offset = 0;
    while (offset < bytes.length) {
      signal.throwIfAborted();
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) throw fail();
      offset += result.bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead || !equal(item.stat, await handle.stat(), false)) throw fail();
    await recheck(item);
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } finally {
    await handle.close();
  }
}

type Export = { imageId: string; inspection: RetainedImageInspection; selected: RetainedImageInspection };
function exportsFor(value: unknown, expected: CorePayloadExpectation): Export[] {
  if (!record(value) || !exact(value, ['schema', 'images']) || value.schema !== 'orbis.core-image-exports.v1' || !Array.isArray(value.images))
    throw fail();
  const ids = [...new Set(Object.values(expected.images))].sort();
  if (ids.length < 1 || ids.length > 3 || value.images.length !== ids.length) throw fail();
  const entries: Export[] = [];
  for (const item of value.images as unknown[]) {
    if (
      !record(item) ||
      !exact(item, ['imageId', 'inspection', 'selected']) ||
      typeof item.imageId !== 'string' ||
      !idPattern.test(item.imageId) ||
      !record(item.inspection) ||
      !record(item.selected)
    )
      throw fail();
    entries.push(item as Export);
  }
  if (canonicalCoreJson(entries.map((item) => item.imageId).sort()) !== canonicalCoreJson(ids)) throw fail();
  return entries;
}

export const coreImageInventoryCapability = Object.freeze({
  schema: 'orbis.core-image-inventory-capability.v1',
  version: 1,
  dataRoot: '/data',
  mutations: 'image-inventory-output-only',
});
export function parseCoreImageInventoryArguments(args: readonly string[]) {
  if (args.length === 1 && args[0] === '--capability') return { mode: 'capability' as const };
  if (args.length !== 2 || args[0] !== '--build' || typeof args[1] !== 'string' || Buffer.byteLength(args[1]) > 8192) throw fail();
  const expectation = validateCorePayloadExpectation(JSON.parse(args[1]));
  if (canonicalCoreJson(expectation) !== args[1]) throw fail();
  return { mode: 'build' as const, expectation };
}

/** Builds only from caller-exported archives. The caller retains source and lifecycle authority. */
export async function buildCoreImageInventory(options: {
  exportDirectory: string;
  outputDirectory: string;
  expectation: CorePayloadExpectation;
  signal: AbortSignal;
}) {
  const { exportDirectory, outputDirectory, signal } = options;
  signal.throwIfAborted();
  const expectation = validateCorePayloadExpectation(options.expectation);
  if (exportDirectory === outputDirectory || exportDirectory.startsWith(`${outputDirectory}/`) || outputDirectory.startsWith(`${exportDirectory}/`))
    throw fail();
  const source = await snapshot(exportDirectory, true);
  const output = await snapshot(outputDirectory, true);
  if ((await fs.readdir(outputDirectory)).length) throw fail();
  const manifest = await snapshot(path.join(exportDirectory, 'exports.json'));
  const entries = exportsFor(await readExports(manifest, signal), expectation);
  const names = ['exports.json', ...entries.map((item) => archiveName(item.imageId))].sort();
  if (canonicalCoreJson((await fs.readdir(exportDirectory)).sort()) !== canonicalCoreJson(names)) throw fail();
  const archives = new Map<string, { item: Snapshot; handle: FileHandle }>();
  let total = 0;
  try {
    for (const entry of entries) {
      const item = await snapshot(path.join(exportDirectory, archiveName(entry.imageId)));
      total += Number(item.stat.size);
      if (item.stat.size < 1 || item.stat.size > maxImage || total > maxTotal) throw fail();
      archives.set(entry.imageId, { item, handle: await openChecked(item) });
    }
    const lookup = (id: string) => {
      const entry = entries.find((item) => item.imageId === id);
      const archive = archives.get(id);
      if (!entry || !archive) throw fail();
      return { entry, archive };
    };
    const adapter: RetainedImageDocker = {
      inspect: async (id, operationSignal, platform?: RetainedImagePlatform) => {
        operationSignal.throwIfAborted();
        const { entry } = lookup(id);
        return platform ? entry.selected : entry.inspection;
      },
      save: async (id, operationSignal) => {
        operationSignal.throwIfAborted();
        const { archive } = lookup(id);
        await recheck(archive.item);
        if (!equal(archive.item.stat, await archive.handle.stat(), false)) throw fail();
        const streamHandle = await openChecked(archive.item);
        return streamHandle.createReadStream({ autoClose: true, start: 0 }) as Readable;
      },
      load: async () => {
        throw fail();
      },
      preflightLoad: async () => {
        throw fail();
      },
    };
    const saved = await captureRetainedImages({
      stagingDirectory: outputDirectory,
      docker: adapter,
      signal,
      platform: { os: expectation.compatibility.os, architecture: expectation.compatibility.architecture },
      bindings: Object.entries(expectation.images).map(([key, imageId]) => ({ key, imageId })),
    });
    for (const { item, handle } of archives.values()) {
      if (!equal(item.stat, await handle.stat(), false)) throw fail();
      await recheck(item);
    }
    for (const item of [source, output, manifest]) await recheck(item);
    if (canonicalCoreJson((await fs.readdir(exportDirectory)).sort()) !== canonicalCoreJson(names)) throw fail();
    const inventoryBytes = Buffer.from(canonicalCoreJson(saved.inventory));
    const inventory = await fs.open(
      path.join(saved.directory, 'inventory.json'),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await inventory.writeFile(inventoryBytes);
      await inventory.sync();
    } finally {
      await inventory.close();
    }
    const directory = await fs.open(saved.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    if (canonicalCoreJson(await fs.readdir(outputDirectory)) !== canonicalCoreJson([path.basename(saved.directory)])) throw fail();
    signal.throwIfAborted();
    await fs.rename(saved.directory, path.join(outputDirectory, 'images'));
    const parent = await fs.open(outputDirectory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
    return {
      schema: 'orbis.core-image-inventory-publication.v1',
      pointId: expectation.pointId,
      sourceSha256: expectation.sourceSha256,
      inventorySha256: createHash('sha256').update(inventoryBytes).digest('hex'),
      imageCount: saved.inventory.images.length,
      totalBytes: total,
    };
  } finally {
    for (const { handle } of archives.values()) await handle.close();
  }
}

export async function runCoreImageInventoryWorker(args: readonly string[]) {
  const operation = parseCoreImageInventoryArguments(args);
  if (operation.mode === 'capability') return coreImageInventoryCapability;
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw fail();
  return buildCoreImageInventory({
    exportDirectory: '/data/image-exports',
    outputDirectory: '/data/image-inventory-output',
    expectation: operation.expectation,
    signal: AbortSignal.timeout(30 * 60_000),
  });
}
