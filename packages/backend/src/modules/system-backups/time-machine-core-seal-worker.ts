import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { privateBackupDirectory } from './backup-files';
import { validateRetainedImageInventory } from './backup-image-retention';
import { canonicalCoreJson, prepareCorePayload, validateCorePayloadExpectation, type CorePayloadExpectation } from './time-machine-core-payload';
import { verifyCoreSavedPoint } from './time-machine-core-verify';
import { TimeMachineStore } from './time-machine-store';

export const coreSealCapability = Object.freeze({
  schema: 'orbis.core-capture-seal-capability.v1',
  version: 1,
  pointVersion: 3,
  payloadFormat: 'orbis.time-machine-core.v1',
  dataRoot: '/data',
  mutations: 'staged-point-files-only',
});

export function parseCoreSealArguments(args: readonly string[]) {
  if (args.length === 1 && args[0] === '--capability') return { mode: 'capability' as const };
  if (args.length !== 2 || args[0] !== '--seal' || typeof args[1] !== 'string' || Buffer.byteLength(args[1]) > 8192)
    throw new Error('Invalid capture sealing invocation.');
  const expectation = validateCorePayloadExpectation(JSON.parse(args[1]));
  if (canonicalCoreJson(expectation) !== args[1]) throw new Error('Invalid capture sealing invocation.');
  return { mode: 'seal' as const, expectation };
}

type Stat = Awaited<ReturnType<typeof fs.lstat>>;
type Snapshot = { file: string; stat: Stat; directory: boolean };
const fail = () => new Error('Core capture could not be sealed.');
const equal = (a: Stat, b: Stat, directory: boolean) =>
  (directory ? ['dev', 'ino', 'mode', 'uid', 'gid'] : ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeMs', 'ctimeMs']).every(
    (key) => Reflect.get(a, key) === Reflect.get(b, key),
  );
async function snapshot(file: string, directory = false): Promise<Snapshot> {
  if (path.resolve(file) !== file || (await fs.realpath(file)) !== file) throw fail();
  const stat = await fs.lstat(file);
  if (
    process.getuid?.() !== stat.uid ||
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
async function inventoryFile(file: string, signal: AbortSignal) {
  const item = await snapshot(file);
  if (item.stat.size < 1 || item.stat.size > 2 * 1024 * 1024) throw fail();
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!equal(item.stat, await handle.stat(), false)) throw fail();
    const bytes = Buffer.alloc(Number(item.stat.size));
    let offset = 0;
    while (offset < bytes.length) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw fail();
      offset += bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead || !equal(item.stat, await handle.stat(), false)) throw fail();
    await recheck(item);
    const inventory = validateRetainedImageInventory(JSON.parse(bytes.toString('utf8')));
    if (!bytes.equals(Buffer.from(canonicalCoreJson(inventory)))) throw fail();
    return { item, inventory };
  } finally {
    await handle.close();
  }
}

/** Seals staged data only. The caller must establish reservation and source authority. */
export async function sealCoreSavedPoint(options: { dataDir: string; expectation: CorePayloadExpectation; signal: AbortSignal }) {
  const { dataDir, signal } = options;
  signal.throwIfAborted();
  const expectation = validateCorePayloadExpectation(options.expectation);
  if (!path.isAbsolute(dataDir) || path.resolve(dataDir) !== dataDir || (await fs.realpath(dataDir)) !== dataDir) throw fail();
  const root = path.join(dataDir, 'backups/time-machine');
  const input = path.join(root, 'core-publish-input', expectation.pointId);
  const imageDirectory = path.join(input, 'images');
  const pointDirectory = path.join(root, 'points', expectation.pointId);
  const directories = await Promise.all(
    [
      dataDir,
      path.join(dataDir, 'backups'),
      root,
      path.join(root, 'core-publish-input'),
      input,
      imageDirectory,
      path.join(root, 'points'),
      pointDirectory,
      path.join(root, 'keys'),
    ].map((file) => snapshot(file, true)),
  );
  const pointFiles = await fs.readdir(pointDirectory);
  const allowed = ['point.json', 'capture-draft.orbis', 'wallpaper.orbis', 'icons.orbis'];
  if (pointFiles.some((name) => !allowed.includes(name)) || !pointFiles.includes('point.json') || !pointFiles.includes('capture-draft.orbis'))
    throw fail();
  const pointSnapshots = await Promise.all(pointFiles.map((name) => snapshot(path.join(pointDirectory, name))));
  const key = await snapshot(path.join(root, 'keys/master-v1.key'));
  const checkpointFile = path.join(input, 'checkpoint.tar');
  const checkpoint = await snapshot(checkpointFile);
  const { item: inventorySnapshot, inventory } = await inventoryFile(path.join(imageDirectory, 'inventory.json'), signal);
  const names = ['inventory.json', ...inventory.images.map((image) => image.archive)].sort();
  if (
    canonicalCoreJson((await fs.readdir(imageDirectory)).sort()) !== canonicalCoreJson(names) ||
    canonicalCoreJson((await fs.readdir(input)).sort()) !== canonicalCoreJson(['checkpoint.tar', 'images'])
  )
    throw fail();
  const images = await Promise.all(inventory.images.map((image) => snapshot(path.join(imageDirectory, image.archive))));
  const store = new TimeMachineStore(dataDir);
  const point = await store.load(expectation.pointId);
  if (point.version !== 3 || point.status !== 'capturing' || point.id !== expectation.pointId) throw fail();
  const draft = await store.readCoreDraft(point, signal);
  const payload = await prepareCorePayload({ expectation, checkpointFile, imageInventory: inventory, imageDirectory, signal });
  for (const item of [...directories, ...pointSnapshots, key, checkpoint, inventorySnapshot, ...images]) await recheck(item);
  if (
    canonicalCoreJson((await fs.readdir(pointDirectory)).sort()) !== canonicalCoreJson(pointFiles.sort()) ||
    canonicalCoreJson((await fs.readdir(imageDirectory)).sort()) !== canonicalCoreJson(names)
  )
    throw fail();
  signal.throwIfAborted();
  await store.sealCore(point, payload, draft, signal);
  for (const item of [
    ...directories,
    ...pointSnapshots.filter((item) => path.basename(item.file) !== 'point.json'),
    key,
    checkpoint,
    inventorySnapshot,
    ...images,
  ])
    await recheck(item);
  const stagingDirectory = path.join(root, 'core-verification');
  await privateBackupDirectory(stagingDirectory);
  return verifyCoreSavedPoint({ dataDir, expectation, stagingDirectory, signal });
}

export async function runCoreSealWorker(args: readonly string[]) {
  const operation = parseCoreSealArguments(args);
  if (operation.mode === 'capability') return coreSealCapability;
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw new Error('Capture sealing requires the Linux root context.');
  return sealCoreSavedPoint({ dataDir: '/data', expectation: operation.expectation, signal: AbortSignal.timeout(30 * 60_000) });
}
