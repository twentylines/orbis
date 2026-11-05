import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { imageDimensionsFromData } from 'image-dimensions';
import type { ThemePackState } from '@runtipi/common/schemas/theme-pack';
import type { ThemeSettingsDocument } from '@runtipi/common/schemas/theme-settings';
import { validateThemeAsset, validateStoredThemeState } from '../theme-packs/theme-packs.service';
import { validateStoredThemeSettings } from '../theme-settings/theme-settings.service';
import { backupCipherOverhead, decryptBackup, encryptBackupStream } from './backup-crypto';
import { validateSettingsPreferencePatch } from './settings-backup-preferences';

type Kind = 'wallpapers' | 'themes';
type Asset = { id: string; data: Buffer };
const magic = Buffer.from('ORBISSA1');
const headerLimit = 256 * 1024;
const maxPlain = headerLimit + 12 + 24 * 4 * 1024 ** 2 + 32 * 1024 ** 2;
const fail = () => new Error('The settings backup contents could not be verified. No settings were restored.');
const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
const same = (a: Awaited<ReturnType<typeof fs.stat>>, b: Awaited<ReturnType<typeof fs.stat>>) =>
  (['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeMs', 'ctimeMs'] as const).every((key) => a[key] === b[key]);
const identity = (a: Awaited<ReturnType<typeof fs.stat>>, b: Awaited<ReturnType<typeof fs.stat>>) => a.dev === b.dev && a.ino === b.ino;
const hashId = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id);

function validate(kind: Kind, desktop: unknown, state: unknown, themeSettings: unknown, assets: Asset[]) {
  if (kind !== 'wallpapers' && kind !== 'themes') throw fail();
  const patch = validateSettingsPreferencePatch(kind, desktop);
  if (!Array.isArray(assets) || assets.length > (kind === 'wallpapers' ? 1 : 24)) throw fail();
  const ids = new Set<string>();
  for (const asset of assets) {
    if (!exact(asset, ['id', 'data']) || !hashId(asset.id) || !Buffer.isBuffer(asset.data) || ids.has(asset.id) || sha(asset.data) !== asset.id)
      throw fail();
    ids.add(asset.id);
  }
  if (kind === 'wallpapers') {
    if (state !== undefined || themeSettings !== undefined) throw fail();
    const selected = patch.appearance?.wallpaperImage;
    if ((selected ? 1 : 0) !== assets.length || (selected && assets[0]?.id !== selected)) throw fail();
    if (assets[0]) {
      const data = assets[0].data;
      let image: ReturnType<typeof imageDimensionsFromData>;
      try {
        image = imageDimensionsFromData(data);
      } catch {
        throw fail();
      }
      if (
        !data.length ||
        data.length > 32 * 1024 ** 2 ||
        !image ||
        !['png', 'jpeg', 'webp'].includes(image.type) ||
        ![image.width, image.height].every((n) => Number.isInteger(n) && n > 0 && n <= 16384) ||
        image.width * image.height > 64_000_000
      )
        throw fail();
    }
    return { version: 1 as const, desktop: patch, assets };
  }
  const registry = validateStoredThemeState(state);
  const settings = validateStoredThemeSettings(themeSettings);
  const expected = new Set<string>();
  for (const record of registry.installed.flatMap((item) => [item, ...(item.previous ? [item.previous] : [])])) {
    const asset = assets.find((item) => item.id === record.manifest.wallpaper);
    if (!asset) throw fail();
    validateThemeAsset(record.manifest, asset.data);
    expected.add(asset.id);
  }
  if (expected.size !== assets.length) throw fail();
  return { version: 1 as const, desktop: patch, state: registry, themeSettings: settings, assets };
}

async function privateDirectory(directory: string) {
  if (!path.isAbsolute(directory) || path.resolve(directory) !== directory) throw fail();
  const stat = await fs.lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.mode & 0o077 ||
    (process.getuid && stat.uid !== process.getuid()) ||
    (await fs.realpath(directory)) !== directory
  )
    throw fail();
  return stat;
}

export async function writeSettingsAssetPart(options: {
  kind: Kind;
  desktop: unknown;
  state?: ThemePackState;
  themeSettings?: ThemeSettingsDocument;
  assets: Asset[];
  destination: string;
  passphrase: string;
  signal: AbortSignal;
  progress?: (completed: number, total: number) => void;
}) {
  options.signal.throwIfAborted();
  validate(options.kind, options.desktop, options.state, options.themeSettings, options.assets);
  const payload = validate(
    options.kind,
    options.desktop,
    options.state,
    options.themeSettings,
    options.assets.map(({ id, data }) => ({ id, data: Buffer.from(data) })),
  );
  const metadata = Buffer.from(
    JSON.stringify({
      version: 1,
      kind: options.kind,
      desktop: payload.desktop,
      ...(options.kind === 'themes' ? { state: payload.state, themeSettings: payload.themeSettings } : {}),
      assets: payload.assets.map(({ id, data }) => ({ id, bytes: data.length })),
    }),
  );
  if (metadata.length > headerLimit) throw fail();
  const prefix = Buffer.alloc(12);
  magic.copy(prefix);
  prefix.writeUInt32BE(metadata.length, 8);
  await privateDirectory(path.dirname(options.destination));
  if (!path.isAbsolute(options.destination) || path.resolve(options.destination) !== options.destination) throw fail();
  const size = prefix.length + metadata.length + payload.assets.reduce((sum, asset) => sum + asset.data.length, 0);
  const result = await encryptBackupStream({
    source: Readable.from([prefix, metadata, ...payload.assets.map((asset) => asset.data)]),
    plaintextBytes: size,
    destination: options.destination,
    passphrase: options.passphrase,
    signal: options.signal,
    onProgress: options.progress,
  });
  return { kind: options.kind, id: null, file: options.destination, bytes: result.bytes, sha256: result.sha256 };
}

export async function readSettingsAssetPart(options: {
  kind: Kind;
  file: string;
  bytes: number;
  sha256: string;
  passphrase: string;
  directory: string;
  signal: AbortSignal;
}) {
  options.signal.throwIfAborted();
  if (
    !Number.isSafeInteger(options.bytes) ||
    options.bytes < backupCipherOverhead + 12 ||
    options.bytes > maxPlain + backupCipherOverhead ||
    !hashId(options.sha256)
  )
    throw fail();
  await privateDirectory(options.directory);
  const directory = path.join(options.directory, `.settings-assets-${randomUUID()}`);
  await fs.mkdir(directory, { mode: 0o700 });
  const owned = await fs.lstat(directory);
  let source: Awaited<ReturnType<typeof fs.open>> | undefined;
  const created = new Map<string, Awaited<ReturnType<typeof fs.stat>>>();
  const stillOwned = async () => {
    try {
      const current = await privateDirectory(directory);
      return identity(owned, current) && owned.uid === current.uid && owned.mode === current.mode;
    } catch {
      return false;
    }
  };
  try {
    source = await fs.open(options.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await source.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size !== options.bytes ||
      before.mode & 0o077 ||
      (process.getuid && before.uid !== process.getuid())
    )
      throw fail();
    if (!(await stillOwned())) throw fail();
    const encrypted = path.join(directory, 'encrypted');
    const out = await fs.open(encrypted, 'wx', 0o600);
    created.set('encrypted', await out.stat());
    const hash = createHash('sha256');
    try {
      let position = 0;
      while (position < before.size) {
        options.signal.throwIfAborted();
        const chunk = Buffer.alloc(Math.min(64 * 1024, before.size - position));
        const { bytesRead } = await source.read(chunk, 0, chunk.length, position);
        if (!bytesRead) throw fail();
        hash.update(chunk.subarray(0, bytesRead));
        let written = 0;
        while (written < bytesRead) {
          const result = await out.write(chunk, written, bytesRead - written);
          if (!result.bytesWritten) throw fail();
          written += result.bytesWritten;
        }
        position += bytesRead;
      }
      await out.sync();
    } finally {
      await out.close();
    }
    if (hash.digest('hex') !== options.sha256 || !same(before, await source.stat()) || !same(before, await fs.lstat(options.file))) throw fail();
    await source.close();
    source = undefined;
    if (!(await stillOwned())) throw fail();
    const plain = path.join(directory, 'authenticated');
    await decryptBackup({ source: encrypted, destination: plain, passphrase: options.passphrase, signal: options.signal });
    if (!(await stillOwned())) throw fail();
    const plainStat = await fs.lstat(plain);
    created.set('authenticated', plainStat);
    const input = await fs.open(plain, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!same(plainStat, await input.stat())) {
      await input.close();
      throw fail();
    }
    try {
      const stat = await input.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.size !== options.bytes - backupCipherOverhead ||
        stat.mode & 0o077 ||
        (process.getuid && stat.uid !== process.getuid())
      )
        throw fail();
      let position = 0;
      const read = async (length: number) => {
        const data = Buffer.alloc(length);
        let offset = 0;
        while (offset < length) {
          options.signal.throwIfAborted();
          const result = await input.read(data, offset, length - offset, position);
          if (!result.bytesRead) throw fail();
          offset += result.bytesRead;
          position += result.bytesRead;
        }
        return data;
      };
      const prefix = await read(12);
      const length = prefix.readUInt32BE(8);
      if (!prefix.subarray(0, 8).equals(magic) || !length || length > headerLimit) throw fail();
      const encoded = await read(length);
      const header: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(encoded));
      if (
        !Buffer.from(JSON.stringify(header)).equals(encoded) ||
        !exact(
          header,
          options.kind === 'themes' ? ['version', 'kind', 'desktop', 'state', 'themeSettings', 'assets'] : ['version', 'kind', 'desktop', 'assets'],
        ) ||
        header.version !== 1 ||
        header.kind !== options.kind ||
        !Array.isArray(header.assets) ||
        header.assets.length > (options.kind === 'themes' ? 24 : 1)
      )
        throw fail();
      const assets: Asset[] = [];
      for (const entry of header.assets) {
        if (
          !exact(entry, ['id', 'bytes']) ||
          !hashId(entry.id) ||
          typeof entry.bytes !== 'number' ||
          !Number.isSafeInteger(entry.bytes) ||
          entry.bytes < 1 ||
          entry.bytes > (options.kind === 'themes' ? 4 * 1024 ** 2 : 32 * 1024 ** 2) ||
          position + entry.bytes > stat.size
        )
          throw fail();
        assets.push({ id: entry.id, data: await read(entry.bytes) });
      }
      if (position !== stat.size || !same(stat, await input.stat()) || !same(stat, await fs.lstat(plain))) throw fail();
      return validate(options.kind, header.desktop, header.state, header.themeSettings, assets);
    } finally {
      await input.close();
    }
  } finally {
    await source?.close();
    for (const [name, original] of created) {
      if (!(await stillOwned())) break;
      const target = path.join(directory, name);
      const current = await fs.lstat(target).catch(() => undefined);
      if (
        current?.isFile() &&
        !current.isSymbolicLink() &&
        current.nlink === 1 &&
        identity(original, current) &&
        current.uid === original.uid &&
        current.mode === original.mode
      )
        await fs.unlink(target);
    }
    if (await stillOwned())
      await fs.rmdir(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') throw error;
      });
  }
}
