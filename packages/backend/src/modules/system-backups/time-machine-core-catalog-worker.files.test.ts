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
import { verifyCoreCatalogPoint, parseCoreCatalogArguments, runCoreCatalogWorker } from './time-machine-core-catalog-worker';
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

it.each(['docker', 'oci'] as const)('authenticates a complete encrypted %s point and draft', async (kind) => {
  const f = await setup(kind);
  const result = await verifyCoreCatalogPoint(f.options);
  expect(result.schema).toBe('orbis.core-capture-catalog-publication.v1');
  expect(Object.keys(result.files).sort()).toEqual(['capture-draft.orbis', 'core.orbis', 'metadata.orbis', 'point.json']);
  for (const [name, info] of Object.entries(result.files)) {
    const bytes = await fs.readFile(path.join(f.directory, name));
    expect(info).toEqual({ bytes: bytes.length, sha256: sha(bytes) });
  }
  expect(result.keyId).toBe(sha(await fs.readFile(path.join(f.root, 'backups/time-machine/keys/master-v1.key'))));
  expect(JSON.stringify(result)).not.toContain(f.passphrase);
});
it.each(['extra', 'unreferenced', 'missing', 'draft', 'mode', 'symlink', 'hardlink', 'key'] as const)(
  'rejects %s without changing point data',
  async (kind) => {
    const f = await setup();
    const draft = path.join(f.directory, 'capture-draft.orbis');
    if (kind === 'extra') await fs.writeFile(path.join(f.directory, 'extra'), 'extra', { mode: 0o600 });
    if (kind === 'unreferenced') await fs.writeFile(path.join(f.directory, 'wallpaper.orbis'), 'extra', { mode: 0o600 });
    if (kind === 'missing') await fs.unlink(path.join(f.directory, 'core.orbis'));
    if (kind === 'draft') {
      const b = await fs.readFile(draft);
      b[0] = (b[0] ?? 0) ^ 1;
      await fs.writeFile(draft, b);
    }
    if (kind === 'mode') await fs.chmod(draft, 0o644);
    if (kind === 'symlink') {
      await fs.rename(draft, path.join(f.root, 'target'));
      await fs.symlink(path.join(f.root, 'target'), draft);
    }
    if (kind === 'hardlink') await fs.link(draft, path.join(f.root, 'link'));
    if (kind === 'key') await fs.writeFile(path.join(f.root, 'backups/time-machine/keys/master-v1.key'), Buffer.alloc(32, 7));
    await expect(verifyCoreCatalogPoint(f.options)).rejects.toThrow();
  },
);
it('rejects altered bindings and cancellation', async () => {
  const f = await setup();
  const controller = new AbortController();
  controller.abort();
  await expect(verifyCoreCatalogPoint({ ...f.options, signal: controller.signal })).rejects.toThrow();
  await expect(verifyCoreCatalogPoint({ ...f.options, expectation: { ...f.options.expectation, sourceSha256: 'f'.repeat(64) } })).rejects.toThrow();
});
it('requires canonical arguments and the production root guard', async () => {
  const f = await setup();
  expect(parseCoreCatalogArguments(['--capability']).mode).toBe('capability');
  expect(parseCoreCatalogArguments(['--verify', canonicalCoreJson(f.options.expectation)]).mode).toBe('verify');
  for (const args of [[], ['--verify', '{}'], ['--capability', 'extra'], ['--verify', ' '.repeat(8193)]])
    expect(() => parseCoreCatalogArguments(args)).toThrow();
  if (process.platform !== 'linux' || process.getuid?.() !== 0)
    await expect(runCoreCatalogWorker(['--verify', canonicalCoreJson(f.options.expectation)])).rejects.toThrow();
});

it('authenticates actual retained wallpaper and icons and rejects tampering', async () => {
  const f = await setup('docker', true);
  const result = await verifyCoreCatalogPoint(f.options);
  for (const name of ['wallpaper.orbis', 'icons.orbis']) {
    const file = path.join(f.directory, name);
    const original = await fs.readFile(file);
    expect(result.files[name]).toEqual({ bytes: original.length, sha256: sha(original) });
    const tampered = Buffer.from(original);
    tampered[0] = (tampered[0] ?? 0) ^ 1;
    await fs.writeFile(file, tampered);
    await expect(verifyCoreCatalogPoint(f.options)).rejects.toThrow();
    await fs.writeFile(file, original);
    await fs.unlink(file);
    await expect(verifyCoreCatalogPoint(f.options)).rejects.toThrow();
    await fs.writeFile(file, original, { mode: 0o600 });
  }
});
