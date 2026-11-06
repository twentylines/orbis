import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { normaliseDesktopAppearance } from '@runtipi/common/schemas/desktop-appearance';
import { capturedWallpaper } from './time-machine-assets';
import { snapshotAppIcons } from './time-machine-app-icons';
import { backupMetadataBytes } from './backup-crypto';
import { canonicalCoreJson } from './time-machine-core-payload';
import { createCorePayloadFixture } from './time-machine-core-payload.fixture';
import { verifyCoreCatalogPoint } from './time-machine-core-catalog-worker';
import { TimeMachineStore, type StoredCoreTimeMachinePoint, type TimeMachineCoreDraftMetadata } from './time-machine-store';

const roots: string[] = [];
const signal = () => new AbortController().signal;
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function setup(kind: 'docker' | 'oci' = 'docker', withAssets = false) {
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
  if (withAssets) {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGPUiHJjYGBgYmBgYGBgAAAJbADMvnADbQAAAABJRU5ErkJggg==', 'base64');
    const wallpaperAsset = await store.retainWallpaper(point, capturedWallpaper(Buffer.from(png), 'captured-builtin'), signal());
    const content = path.join(root, 'fixture-content');
    const name = 'data/apps/store/notes/metadata/logo.jpg';
    await fs.mkdir(path.dirname(path.join(content, name)), { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(content, name), png, { mode: 0o600 });
    const icons = await snapshotAppIcons(
      {
        content,
        apps: [{ urn: 'notes:store', name: 'Notes', running: true }],
        files: [{ name, bytes: png.length }],
        createdAt: 1,
        manifestSha256: 'a'.repeat(64),
        software: { orbis: 'fixture', runtipi: 'fixture', architecture: 'arm64' },
        databaseBytes: 0,
      },
      signal(),
    );
    if (!icons) throw new Error('missing icons');
    const appIcons = await store.retainAppIcons(point, icons, signal());
    draft.preview = {
      available: true,
      kind: 'historical-home-projection',
      version: 1,
      capturedAt: point.createdAt,
      desktop: {
        serverName: 'test',
        preset: 'frost',
        mode: 'light',
        density: 'comfortable',
        wallpaper: 'sandstone',
        wallpaperMode: 'theme',
        wallpaperPreset: null,
        appearance: normaliseDesktopAppearance(undefined),
        workspace: { order: [], hidden: [], wide: [], showAllApps: false, pinnedApps: [] },
      },
      theme: null,
      customWallpaperAvailable: false,
      wallpaperAsset,
      appIcons,
      screenshot: { available: false, reason: { code: 'screenshot-not-captured', message: '' } },
      resolvedSystemMode: null,
      apps: [{ urn: 'notes:store', name: 'Notes', running: true }],
    };
  }
  await store.saveCoreDraft(point, draft, signal());
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
      assetBytes: f.draft.preview.available
        ? (f.draft.preview.wallpaperAsset.available ? f.draft.preview.wallpaperAsset.bytes + 52 : 0) +
          (f.draft.preview.appIcons ? f.draft.preview.appIcons.bytes + 52 : 0)
        : 0,
      core,
    }),
    { mode: 0o600 },
  );
}

async function adoption(kind: 'docker' | 'oci' = 'docker', assets = false) {
  const f = await setup(kind, assets);
  const publication = await verifyCoreCatalogPoint(f.options);
  const source = path.join(f.root, 'backups/time-machine/adoption');
  await fs.mkdir(source, { mode: 0o700 });
  for (const name of Object.keys(publication.files)) await fs.copyFile(path.join(f.directory, name), path.join(source, name));
  await fs.unlink(path.join(f.directory, 'core.orbis'));
  await fs.unlink(path.join(f.directory, 'metadata.orbis'));
  await fs.writeFile(path.join(f.directory, 'point.json'), JSON.stringify(f.point), { mode: 0o600 });
  return { ...f, source, publication };
}
it.each(['docker', 'oci'] as const)('adopts the exact %s catalog files and survives lost acknowledgement', async (kind) => {
  const f = await adoption(kind, true);
  const original = await fs.readFile(path.join(f.source, 'point.json'));
  const inode = (await fs.stat(path.join(f.source, 'core.orbis'))).ino;
  await f.store.adoptPublishedCorePoint(f.point, f.source, f.publication, signal());
  expect(await fs.readFile(path.join(f.directory, 'point.json'))).toEqual(original);
  expect((await fs.stat(path.join(f.directory, 'core.orbis'))).ino).toBe(inode);
  await f.store.adoptPublishedCorePoint(f.point, f.source, f.publication, signal());
  const sealed = (await f.store.load(f.point.id)) as StoredCoreTimeMachinePoint;
  await f.store.adoptPublishedCorePoint(sealed, f.source, f.publication, signal());
});
it.each(['corrupt', 'reservation', 'key', 'asset', 'conflict', 'symlink'] as const)('rejects %s without replacing destination', async (kind) => {
  const f = await adoption('docker', true);
  let publication = f.publication;
  if (kind === 'corrupt') await fs.writeFile(path.join(f.source, 'core.orbis'), 'bad');
  if (kind === 'reservation') publication = { ...publication, core: { ...publication.core, pointReservationSha256: '0'.repeat(64) } };
  if (kind === 'key') publication = { ...publication, keyId: '0'.repeat(64) };
  if (kind === 'asset') await fs.writeFile(path.join(f.directory, 'wallpaper.orbis'), 'bad');
  if (kind === 'conflict') await fs.writeFile(path.join(f.directory, 'core.orbis'), 'unrelated', { mode: 0o600 });
  if (kind === 'symlink') {
    await fs.unlink(path.join(f.source, 'core.orbis'));
    await fs.symlink(path.join(f.directory, 'point.json'), path.join(f.source, 'core.orbis'));
  }
  await expect(f.store.adoptPublishedCorePoint(f.point, f.source, publication, signal())).rejects.toThrow();
  if (kind === 'conflict') expect(await fs.readFile(path.join(f.directory, 'core.orbis'), 'utf8')).toBe('unrelated');
});
it.each(['linked', 'moved', 'metadata-linked'] as const)('resumes an interrupted %s promotion', async (kind) => {
  const f = await adoption();
  const name = kind === 'metadata-linked' ? 'metadata.orbis' : 'core.orbis';
  const src = path.join(f.source, name);
  const dst = path.join(f.directory, name);
  await fs.link(src, dst);
  if (kind === 'moved') await fs.unlink(src);
  await f.store.adoptPublishedCorePoint(f.point, f.source, f.publication, signal());
  expect((await fs.stat(dst)).nlink).toBe(1);
});
it('rejects a same-byte source inode swap at the link boundary', async () => {
  const f = await adoption();
  const link = fs.link.bind(fs);
  vi.spyOn(fs, 'link').mockImplementation(async (source, destination) => {
    if (source === path.join(f.source, 'core.orbis')) {
      await fs.rename(source, path.join(f.source, 'held-original'));
      await fs.copyFile(path.join(f.source, 'held-original'), source);
    }
    return link(source, destination);
  });
  await expect(f.store.adoptPublishedCorePoint(f.point, f.source, f.publication, signal())).rejects.toThrow();
  expect((await f.store.load(f.point.id)).status).toBe('capturing');
});

it('accepts protected shared ancestors with ordinary read and execute permissions', async () => {
  const f = await adoption();
  await fs.chmod(f.root, 0o755);
  await fs.chmod(path.join(f.root, 'backups'), 0o755);
  await f.store.adoptPublishedCorePoint(f.point, f.source, f.publication, signal());
  expect((await f.store.load(f.point.id)).status).toBe('sealed');
});

it.each(['data', 'backups', 'point', 'source'] as const)('refuses unsafe %s directory permissions', async (kind) => {
  const f = await adoption();
  const directory = kind === 'data' ? f.root : kind === 'backups' ? path.join(f.root, 'backups') : kind === 'point' ? f.directory : f.source;
  await fs.chmod(directory, kind === 'data' || kind === 'backups' ? 0o777 : 0o755);
  await expect(f.store.adoptPublishedCorePoint(f.point, f.source, f.publication, signal())).rejects.toThrow();
});

it('bounds full archive reads while rechecking each promoted file generation', async () => {
  const f = await adoption();
  const open = fs.open.bind(fs);
  const archiveNames = [path.join(f.source, 'core.orbis'), path.join(f.directory, 'core.orbis')];
  let readBytes = 0;
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (!archiveNames.includes(String(args[0]))) return handle;
    return new Proxy(handle, {
      get(target, key) {
        if (key === 'read')
          return async (...parameters: unknown[]) => {
            const result = await Reflect.apply(target.read, target, parameters);
            readBytes += result.bytesRead;
            return result;
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  });
  await f.store.adoptPublishedCorePoint(f.point, f.source, f.publication, signal());
  expect(readBytes).toBeGreaterThanOrEqual(f.publication.core.cipherBytes);
  expect(readBytes).toBeLessThanOrEqual(3 * f.publication.core.cipherBytes);
});
