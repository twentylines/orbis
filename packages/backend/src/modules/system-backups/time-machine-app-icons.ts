import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { imageDimensionsFromData } from 'image-dimensions';
import {
  historicalIconLimits,
  historicalIconSchema,
  historicalIconsPayloadSchema,
  type HistoricalIcon,
  type HistoricalIconsAsset,
} from '@runtipi/common/schemas/time-machine-icons';
import type { LocalBackupSnapshot } from './system-backups.service';
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const fail = () => new Error('Captured application icons could not be verified.');
export type CapturedAppIcons = { data: Buffer; identity: string; icons: HistoricalIcon[] };
function icon(data: Buffer, urn: string, source: HistoricalIcon['source']) {
  if (!data.length || data.length > historicalIconLimits.imageBytes) throw fail();
  const size = imageDimensionsFromData(data);
  const mime = size && ({ png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' } as const)[size.type as 'png' | 'jpeg' | 'webp'];
  if (!size || !mime) throw fail();
  return historicalIconSchema.assert({ urn, source, bytes: data.length, identity: sha(data), width: size.width, height: size.height, mime });
}
async function copiedIcon(snapshot: LocalBackupSnapshot, name: string) {
  const entries = snapshot.files.filter((file) => file.name === name);
  if (!entries.length) return null;
  const entry = entries[0];
  if (entries.length !== 1 || !entry) throw fail();
  const filename = path.join(snapshot.content, name);
  if (
    (await fs.realpath(snapshot.content)) !== path.resolve(snapshot.content) ||
    (await fs.realpath(path.dirname(filename))) !== path.dirname(filename)
  )
    throw fail();
  const file = await fs.open(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size !== entry.bytes ||
      before.size > historicalIconLimits.imageBytes ||
      (process.getuid && before.uid !== process.getuid())
    )
      throw fail();
    const data = await file.readFile();
    const after = await file.stat();
    if (
      data.length !== before.size ||
      ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'mode', 'nlink', 'uid'].some((key) => Reflect.get(before, key) !== Reflect.get(after, key))
    )
      throw fail();
    return data;
  } finally {
    await file.close();
  }
}
export async function snapshotAppIcons(snapshot: LocalBackupSnapshot, signal: AbortSignal): Promise<CapturedAppIcons | null> {
  if (snapshot.apps.length > historicalIconLimits.icons || new Set(snapshot.apps.map((app) => app.urn)).size !== snapshot.apps.length) throw fail();
  const items: Array<HistoricalIcon & { data: string }> = [];
  let bytes = 0;
  for (const app of snapshot.apps) {
    signal.throwIfAborted();
    if (!/^[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+$/.test(app.urn) || app.urn.length > 180) throw fail();
    const [name, store] = app.urn.split(':');
    const installed = `data/apps/${store}/${name}/metadata/logo.jpg`;
    const repository = `data/repos/${store}/apps/${name}/metadata/logo.jpg`;
    const selected = snapshot.files.some((file) => file.name === installed) ? installed : repository;
    try {
      const data = await copiedIcon(snapshot, selected);
      if (!data) continue;
      const descriptor = icon(data, app.urn, selected === installed ? 'captured-installed' : 'captured-repository');
      if (bytes + data.length > historicalIconLimits.totalImageBytes) continue;
      bytes += data.length;
      items.push({ ...descriptor, data: data.toString('base64') });
    } catch {
      signal.throwIfAborted();
    }
  }
  if (!items.length) return null;
  const data = Buffer.from(JSON.stringify(historicalIconsPayloadSchema.assert({ version: 1, icons: items })));
  if (data.length > historicalIconLimits.bundleBytes) throw fail();
  return { data, identity: sha(data), icons: items.map(({ data: _data, ...item }) => item) };
}
export function verifyAppIcons(data: Buffer, expected: Pick<HistoricalIconsAsset, 'identity' | 'bytes' | 'icons'>) {
  if (data.length > historicalIconLimits.bundleBytes || data.length !== expected.bytes || sha(data) !== expected.identity) throw fail();
  const payload = historicalIconsPayloadSchema.assert(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)));
  const descriptors = payload.icons.map(({ data, ...item }) => {
    const image = Buffer.from(data, 'base64');
    if (image.toString('base64') !== data) throw fail();
    const checked = icon(image, item.urn, item.source);
    if (Object.entries(checked).some(([key, value]) => Reflect.get(item, key) !== value)) throw fail();
    return item;
  });
  if (
    descriptors.length !== expected.icons.length ||
    descriptors.some((item, index) => {
      const expectedIcon = expected.icons[index];
      return !expectedIcon || Object.entries(item).some(([key, value]) => Reflect.get(expectedIcon, key) !== value);
    })
  )
    throw fail();
  return payload;
}
