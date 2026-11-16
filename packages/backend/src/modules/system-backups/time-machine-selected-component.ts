import { createHash } from 'node:crypto';
import fs, { type FileHandle } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import path from 'node:path';
import type { TimeMachineSelectedReceipt } from '@runtipi/common/schemas/time-machine';
import { readTarArchive, type TarEntry } from '@/core/archive/tar-metadata';
import {
  captureRetainedImages,
  retainedImageLimits,
  verifyRetainedImageArchives,
  type RetainedImageDocker,
  type RetainedImageInspection,
  type RetainedImagePlatform,
} from './backup-image-retention';
import { canonicalPublicationJson } from '../host-updates/host-controller-publication';

const fail = () => new Error('The selected app component did not pass read-only verification. Restore is unavailable.');
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const canonical = canonicalPublicationJson;
type Entry = { path: string; type: string; bytes?: number; sha256?: string; target?: string };
/** Verify the selected inventory and pass each immutable image export through retained-image validation. */
export async function verifySelectedComponent(options: { file: string; receipt: TimeMachineSelectedReceipt; staging: string; signal: AbortSignal }) {
  const { file, receipt, staging, signal } = options;
  const source = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = await source.stat();
    const digest = createHash('sha256');
    if (!before.isFile() || before.nlink !== 1 || before.mode & 0o077 || before.uid !== process.getuid?.() || before.size !== receipt.artifact.bytes)
      throw fail();
    for await (const bytes of source.createReadStream({ autoClose: false, signal })) digest.update(bytes);
    const after = await source.stat();
    if (
      digest.digest('hex') !== receipt.artifact.sha256 ||
      ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some((key) => Reflect.get(before, key) !== Reflect.get(after, key))
    )
      throw fail();
  } finally {
    await source.close();
  }
  const entries: Entry[] = [];
  let current: TarEntry | undefined;
  let digest = createHash('sha256');
  let bytes = 0;
  let manifestBytes: Buffer[] = [];
  let manifestSize = 0;
  const images = new Map<string, { file: string; handle: FileHandle }>();
  const verifiedDirectories: string[] = [];
  let manifest: Record<string, unknown> | undefined;
  try {
    await readTarArchive(file, false, signal, {
      strict: true,
      collectEntries: false,
      maxEntries: 250257,
      maxExpandedBytes: receipt.artifact.bytes,
      onEntry: async (rawEntry) => {
        const entry = {
          ...rawEntry,
          type: ({ '-': 'file', d: 'directory', l: 'symlink', h: 'hardlink' } as Record<string, string>)[rawEntry.type] ?? rawEntry.type,
          path: rawEntry.type === 'd' ? rawEntry.path.replace(/\/$/, '') : rawEntry.path,
        };
        if (
          current ||
          entry.path.includes('\\') ||
          Array.from(entry.path).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
          !['file', 'directory', 'symlink', 'hardlink'].includes(entry.type) ||
          !(
            /^(?:resources\/[0-9]{4})(?:\/.+)?$/.test(entry.path) ||
            /^(?:images\/image-[a-f0-9]{64}\.tar)$/.test(entry.path) ||
            entry.path === 'manifest.json'
          ) ||
          entry.path.split('/').some((part) => part === '..' || part === '.') ||
          entries.some((prior) => prior.path === entry.path)
        )
          throw fail();
        if ((/^(?:images\/image-[a-f0-9]{64}\.tar)$/.test(entry.path) || entry.path === 'manifest.json') && entry.type !== 'file') throw fail();
        if (entry.path.startsWith('images/')) {
          if (images.size >= 256) throw fail();
          const destination = path.join(staging, `selected-${path.basename(entry.path)}`);
          images.set(entry.path, { file: destination, handle: await fs.open(destination, 'wx+', 0o600) });
        }
        current = entry;
        digest = createHash('sha256');
        bytes = 0;
      },
      onData: async (chunk) => {
        if (!current) throw fail();
        digest.update(chunk);
        bytes += chunk.length;
        if (current.path === 'manifest.json') {
          manifestSize += chunk.length;
          if (manifestSize > 16 * 1024 ** 2) throw fail();
          manifestBytes.push(Buffer.from(chunk));
        } else if (current.path.startsWith('images/')) {
          const image = images.get(current.path)?.handle;
          if (!image) throw fail();
          let offset = 0;
          while (offset < chunk.length) {
            const result = await image.write(chunk, offset, chunk.length - offset);
            if (!result.bytesWritten) throw fail();
            offset += result.bytesWritten;
          }
        }
      },
      onEntryEnd: async () => {
        if (!current) throw fail();
        const entry: Entry = { path: current.path, type: current.type };
        if (current.type === 'file') {
          if (bytes !== current.size) throw fail();
          entry.bytes = bytes;
          entry.sha256 = digest.digest('hex');
        }
        if (current.linkTarget) entry.target = current.linkTarget;
        if (current.path.startsWith('images/')) {
          const image = images.get(current.path);
          if (!image) throw fail();
          await image.handle.sync();
        }
        entries.push(entry);
        current = undefined;
      },
    });
    const encoded = Buffer.concat(manifestBytes);
    if (hash(encoded) !== receipt.manifest.manifestSha256) throw fail();
    manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(encoded));
    if (
      !manifest ||
      manifest.schema !== 'orbis.selected-app-component.v1' ||
      manifest.pointId !== receipt.pointId ||
      manifest.corePointId !== receipt.corePointId ||
      manifest.planSha256 !== receipt.planSha256 ||
      manifest.capturedAt !== receipt.manifest.capturedAt ||
      canonical(manifest.selection) !== canonical(receipt.manifest.selection) ||
      canonical(manifest.images) !== canonical(receipt.manifest.images) ||
      !Array.isArray(manifest.mounts) ||
      !Array.isArray(manifest.entries)
    )
      throw fail();
    const included = manifest.mounts.map((mount) => {
      if (!mount || typeof mount !== 'object') throw fail();
      return Object.fromEntries(['id', 'appUrn', 'service', 'destination', 'classification', 'type'].map((key) => [key, Reflect.get(mount, key)]));
    });
    if (canonical(included) !== canonical(receipt.manifest.includedStorage)) throw fail();
    const expected = manifest.entries.map((raw: unknown) => {
      if (!raw || typeof raw !== 'object') throw fail();
      const entry = raw as Entry;
      return Object.fromEntries(
        [
          'path',
          'type',
          ...(entry.type === 'file' ? ['bytes', 'sha256'] : []),
          ...(entry.type === 'symlink' || entry.type === 'hardlink' ? ['target'] : []),
        ].map((key) => [key, Reflect.get(raw, key)]),
      );
    });
    if (canonical(entries.filter((entry) => entry.path.startsWith('resources/'))) !== canonical(expected)) throw fail();
    const exports = manifest.imageExports;
    if (
      !Array.isArray(exports) ||
      exports.length !== images.size ||
      exports.length !== receipt.manifest.images.ids.length ||
      receipt.manifest.images.format !== 'orbis.selected-image-exports.v1' ||
      hash(canonical(exports)) !== receipt.manifest.images.sha256 ||
      entries.filter((entry) => !entry.path.startsWith('resources/')).length !== exports.length + 1
    )
      throw fail();
    let total = 0;
    let expanded = 0;
    const ids: string[] = [];
    for (const item of exports) {
      if (
        !item ||
        typeof item !== 'object' ||
        Object.keys(item).sort().join(',') !== 'archive,bytes,imageId,inspection,platform,selected,sha256' ||
        typeof item.imageId !== 'string' ||
        !/^sha256:[a-f0-9]{64}$/.test(item.imageId) ||
        ids.includes(item.imageId) ||
        item.archive !== `image-${item.imageId.slice(7)}.tar` ||
        !item.inspection ||
        !item.selected ||
        !item.platform
      )
        throw fail();
      const archived = entries.find((entry) => entry.path === `images/${item.archive}`);
      const image = images.get(`images/${item.archive}`);
      if (!archived || !image || archived.bytes !== item.bytes || archived.sha256 !== item.sha256) throw fail();
      total += item.bytes;
      ids.push(item.imageId);
      const adapter: RetainedImageDocker = {
        inspect: async (id, operationSignal, platform) => {
          operationSignal.throwIfAborted();
          if (id !== item.imageId) throw fail();
          return (platform ? item.selected : item.inspection) as RetainedImageInspection;
        },
        save: async (id, operationSignal) => {
          operationSignal.throwIfAborted();
          if (id !== item.imageId) throw fail();
          return image.handle.createReadStream({ start: 0, autoClose: false, signal: operationSignal }) as Readable;
        },
        load: async () => {
          throw fail();
        },
        preflightLoad: async () => {
          throw fail();
        },
      };
      const saved = await captureRetainedImages({
        stagingDirectory: staging,
        signal,
        docker: adapter,
        platform: item.platform as RetainedImagePlatform,
        bindings: [{ key: item.imageId, imageId: item.imageId }],
      });
      verifiedDirectories.push(saved.directory);
      expanded += saved.inventory.images.reduce((sum, image) => sum + image.identity.expandedBytes, 0);
      if (expanded > retainedImageLimits.totalExpandedBytes) throw fail();
      if (saved.inventory.images.length !== 1 || saved.inventory.images[0]?.bytes !== item.bytes || saved.inventory.images[0]?.sha256 !== item.sha256)
        throw fail();
      await verifyRetainedImageArchives({
        inventory: saved.inventory,
        signal,
        files: new Map(saved.inventory.images.map((entry) => [`image-capture/images/${entry.archive}`, path.join(saved.directory, entry.archive)])),
      });
    }
    if (total !== receipt.manifest.images.bytes || canonical(ids) !== canonical(receipt.manifest.images.ids)) throw fail();
  } finally {
    manifestBytes = [];
    for (const image of images.values()) {
      await image.handle.close();
      await fs.unlink(image.file);
    }
    for (const directory of verifiedDirectories) await fs.rm(directory, { recursive: true });
  }
  return manifest;
}
