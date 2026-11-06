import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { timeMachineLimits } from '@runtipi/common/schemas/time-machine';
import { privateBackupDirectory } from './backup-files';
import { canonicalCoreJson, validateCorePayloadExpectation, type CorePayloadExpectation } from './time-machine-core-payload';
import { verifyCoreSavedPoint, type CoreSavedPointVerification } from './time-machine-core-verify';
import { TimeMachineStore } from './time-machine-store';

export const coreCatalogCapability = Object.freeze({
  schema: 'orbis.core-capture-catalog-capability.v1',
  version: 1,
  pointVersion: 3,
  payloadFormat: 'orbis.time-machine-core.v1',
  publicationSchema: 'orbis.core-capture-catalog-publication.v1',
  dataRoot: '/data',
  verification: 'authenticated-stream-and-images.v1',
  mutations: 'read-only-data-with-private-staging',
});
export function parseCoreCatalogArguments(args: readonly string[]) {
  if (args.length === 1 && args[0] === '--capability') return { mode: 'capability' as const };
  if (args.length !== 2 || args[0] !== '--verify' || typeof args[1] !== 'string' || Buffer.byteLength(args[1]) > 8192)
    throw new Error('Invalid catalog invocation.');
  const expectation = validateCorePayloadExpectation(JSON.parse(args[1]));
  if (canonicalCoreJson(expectation) !== args[1]) throw new Error('Invalid catalog invocation.');
  return { mode: 'verify' as const, expectation };
}
type Stat = Stats;
type Seal = { file: string; stat: Stat };
const fail = () => new Error('Saved core catalog point could not be verified.');
const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const equal = (a: Stat, b: Stat, directory = false) =>
  (directory ? ['dev', 'ino', 'mode', 'uid', 'gid'] : ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeMs', 'ctimeMs']).every(
    (key) => Reflect.get(a, key) === Reflect.get(b, key),
  );
async function seal(file: string, directory = false): Promise<Seal> {
  if (!path.isAbsolute(file) || path.resolve(file) !== file || (await fs.realpath(file)) !== file) throw fail();
  const stat = await fs.lstat(file);
  if (
    stat.uid !== process.getuid?.() ||
    (directory
      ? !stat.isDirectory() || (stat.mode & 0o7777) !== 0o700
      : !stat.isFile() || stat.nlink !== 1 || ![0o400, 0o600].includes(stat.mode & 0o7777))
  )
    throw fail();
  return { file, stat };
}
async function recheck(item: Seal, directory = false) {
  if ((await fs.realpath(item.file)) !== item.file || !equal(item.stat, await fs.lstat(item.file), directory)) throw fail();
}
async function readSealed(item: Seal, max: number, signal: AbortSignal) {
  if (item.stat.size < 1 || item.stat.size > max) throw fail();
  const handle = await fs.open(item.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!equal(item.stat, await handle.stat())) throw fail();
    const data = Buffer.alloc(item.stat.size);
    let offset = 0;
    while (offset < data.length) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
      if (!bytesRead) throw fail();
      offset += bytesRead;
    }
    if (!equal(item.stat, await handle.stat())) throw fail();
    await recheck(item);
    return data;
  } finally {
    await handle.close();
  }
}
export type CoreCatalogPublication = Readonly<{
  schema: 'orbis.core-capture-catalog-publication.v1';
  core: CoreSavedPointVerification;
  keyId: string;
  files: Readonly<Record<string, Readonly<{ bytes: number; sha256: string }>>>;
}>;
export async function verifyCoreCatalogPoint(options: {
  dataDir: string;
  expectation: CorePayloadExpectation;
  signal: AbortSignal;
}): Promise<CoreCatalogPublication> {
  try {
    const { dataDir, signal } = options;
    signal.throwIfAborted();
    const expectation = validateCorePayloadExpectation(options.expectation);
    const root = path.join(dataDir, 'backups/time-machine');
    const pointDir = path.join(root, 'points', expectation.pointId);
    const stagingDirectory = path.join(root, 'core-verification');
    const dirs = await Promise.all(
      [dataDir, path.join(dataDir, 'backups'), root, path.join(root, 'points'), pointDir, path.join(root, 'keys')].map((dir) => seal(dir, true)),
    );
    const keySeal = await seal(path.join(root, 'keys/master-v1.key'));
    const key = await readSealed(keySeal, 32, signal);
    let keyId: string;
    try {
      if (key.length !== 32) throw fail();
      keyId = sha(key);
    } finally {
      key.fill(0);
    }
    const names = (await fs.readdir(pointDir)).sort();
    const allowed = ['point.json', 'metadata.orbis', 'core.orbis', 'capture-draft.orbis', 'wallpaper.orbis', 'icons.orbis'];
    if (names.some((name) => !allowed.includes(name)) || !['point.json', 'metadata.orbis', 'core.orbis'].every((name) => names.includes(name)))
      throw fail();
    const seals = new Map<string, Seal>();
    for (const name of names) seals.set(name, await seal(path.join(pointDir, name)));
    const get = (name: string) => {
      const item = seals.get(name);
      if (!item) throw fail();
      return item;
    };
    const pointData = await readSealed(get('point.json'), 32768, signal);
    const metadataData = await readSealed(get('metadata.orbis'), timeMachineLimits.metadataBytes + 52, signal);
    const store = new TimeMachineStore(dataDir);
    const point = await store.load(expectation.pointId);
    if (
      point.version !== 3 ||
      point.status !== 'sealed' ||
      point.envelope.keyId !== keyId ||
      canonicalCoreJson(JSON.parse(pointData.toString())) !== canonicalCoreJson(point)
    )
      throw fail();
    const metadata = await store.metadata(point);
    if (metadata.version !== 3) throw fail();
    const wallpaper = metadata.preview.available && metadata.preview.wallpaperAsset.available ? metadata.preview.wallpaperAsset : undefined;
    const icons = metadata.preview.available ? metadata.preview.appIcons : undefined;
    if (names.includes('wallpaper.orbis') !== !!wallpaper || names.includes('icons.orbis') !== !!icons) throw fail();
    await privateBackupDirectory(stagingDirectory);
    const stage = await seal(stagingDirectory, true);
    const core = await verifyCoreSavedPoint({ dataDir, expectation, stagingDirectory, signal });
    if (core.pointSha256 !== sha(pointData) || core.metadataSha256 !== sha(metadataData)) throw fail();
    const files: Record<string, { bytes: number; sha256: string }> = {
      'point.json': { bytes: pointData.length, sha256: core.pointSha256 },
      'metadata.orbis': { bytes: metadataData.length, sha256: core.metadataSha256 },
      'core.orbis': { bytes: core.cipherBytes, sha256: core.cipherSha256 },
    };
    if (get('core.orbis').stat.size !== core.cipherBytes) throw fail();
    if (wallpaper) {
      const value = await store.wallpaper(point, wallpaper);
      value.data.fill(0);
      if (get('wallpaper.orbis').stat.size !== wallpaper.bytes + 52) throw fail();
      files['wallpaper.orbis'] = { bytes: wallpaper.bytes + 52, sha256: wallpaper.cipherSha256 };
    }
    if (icons) {
      const value = await store.appIcons(point, icons);
      value.fill(0);
      if (get('icons.orbis').stat.size !== icons.bytes + 52) throw fail();
      files['icons.orbis'] = { bytes: icons.bytes + 52, sha256: icons.cipherSha256 };
    }
    if (names.includes('capture-draft.orbis')) {
      const draftData = await readSealed(get('capture-draft.orbis'), timeMachineLimits.metadataBytes + 52, signal);
      const draft = await store.readCoreDraft(point, signal);
      const { archiveBytes: _bytes, archiveSha256: _sha, manifestSha256: _manifest, core: _core, ...expectedDraft } = metadata;
      if (canonicalCoreJson(draft) !== canonicalCoreJson(expectedDraft)) throw fail();
      files['capture-draft.orbis'] = { bytes: draftData.length, sha256: sha(draftData) };
    }
    signal.throwIfAborted();
    if (
      canonicalCoreJson(await store.load(point.id)) !== canonicalCoreJson(point) ||
      canonicalCoreJson(await store.metadata(point)) !== canonicalCoreJson(metadata) ||
      canonicalCoreJson((await fs.readdir(pointDir)).sort()) !== canonicalCoreJson(names)
    )
      throw fail();
    for (const dir of [...dirs, stage]) await recheck(dir, true);
    for (const item of [keySeal, ...seals.values()]) await recheck(item);
    signal.throwIfAborted();
    return Object.freeze({ schema: 'orbis.core-capture-catalog-publication.v1', core, keyId, files: Object.freeze(files) });
  } catch {
    throw fail();
  }
}
export async function runCoreCatalogWorker(args: readonly string[]) {
  const operation = parseCoreCatalogArguments(args);
  if (operation.mode === 'capability') return coreCatalogCapability;
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw new Error('Catalog verification requires the Linux root context.');
  return verifyCoreCatalogPoint({ dataDir: '/data', expectation: operation.expectation, signal: AbortSignal.timeout(30 * 60_000) });
}
