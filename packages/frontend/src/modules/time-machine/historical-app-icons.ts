import { useEffect, useRef, useState } from 'react';
import { timeMachineIdSchema, type TimeMachinePoint } from '@runtipi/common/schemas/time-machine';
import { historicalIconLimits, historicalIconsAssetSchema, historicalIconsPayloadSchema } from '@runtipi/common/schemas/time-machine-icons';
const fail = () => new Error('Captured application icons are unavailable.');
const digest = async (bytes: Uint8Array<ArrayBuffer>) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.buffer)), (byte) => byte.toString(16).padStart(2, '0')).join('');
export async function readHistoricalAppIcons(point: TimeMachinePoint, signal: AbortSignal): Promise<Array<{ urn: string; blob: Blob }>> {
  const asset = point.metadata?.preview.available ? point.metadata.preview.appIcons : undefined;
  if (!asset) return [];
  if (point.status !== 'sealed' || !timeMachineIdSchema.allows(point.id)) throw fail();
  historicalIconsAssetSchema.assert(asset);
  signal.throwIfAborted();
  const response = await fetch(`/api/system-backups/time-machine/points/${point.id}/icons/${asset.identity}`, {
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  });
  if (!response.ok || !response.body || response.headers.get('content-type')?.split(';')[0] !== 'application/json') throw fail();
  const length = response.headers.get('content-length');
  if (length !== null && Number(length) !== asset.bytes) throw fail();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let count = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      count += value.byteLength;
      if (count > asset.bytes || count > historicalIconLimits.bundleBytes) throw fail();
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (count !== asset.bytes) throw fail();
  const bytes = new Uint8Array(count);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  if ((await digest(bytes)) !== asset.identity) throw fail();
  const payload = historicalIconsPayloadSchema.assert(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  if (payload.icons.length !== asset.icons.length) throw fail();
  const result: Array<{ urn: string; blob: Blob }> = [];
  for (let index = 0; index < payload.icons.length; index++) {
    signal.throwIfAborted();
    const item = payload.icons[index];
    const expected = asset.icons[index];
    if (!item || !expected || Object.entries(expected).some(([key, value]) => Reflect.get(item, key) !== value)) throw fail();
    const raw = atob(item.data);
    if (raw.length !== item.bytes || btoa(raw) !== item.data) throw fail();
    const image = Uint8Array.from(raw, (character) => character.charCodeAt(0));
    if ((await digest(image)) !== item.identity) throw fail();
    const header = String.fromCharCode(...image.subarray(0, 12));
    const raster =
      item.mime === 'image/png'
        ? header.startsWith('\x89PNG\r\n\x1a\n')
        : item.mime === 'image/jpeg'
          ? image[0] === 255 && image[1] === 216 && image[2] === 255
          : header.startsWith('RIFF') && header.slice(8) === 'WEBP';
    if (!raster) throw fail();
    result.push({ urn: item.urn, blob: new Blob([image.buffer], { type: item.mime }) });
  }
  signal.throwIfAborted();
  return result;
}
export function useHistoricalAppIcons(point: TimeMachinePoint) {
  const current = useRef(point);
  current.current = point;
  const identity = point.metadata?.preview.available ? point.metadata.preview.appIcons?.identity : undefined;
  const binding = `${point.id}/${identity ?? ''}`;
  const [saved, setSaved] = useState<{ binding: string; urls: Record<string, string> } | null>(null);
  useEffect(() => {
    if (!identity) return;
    const abort = new AbortController();
    const urls: Record<string, string> = {};
    void readHistoricalAppIcons(current.current, abort.signal)
      .then((icons) => {
        if (abort.signal.aborted) return;
        for (const icon of icons) urls[icon.urn] = URL.createObjectURL(icon.blob);
        setSaved({ binding, urls });
      })
      .catch(() => undefined);
    return () => {
      abort.abort();
      for (const url of Object.values(urls)) URL.revokeObjectURL(url);
    };
  }, [binding, identity]);
  return saved?.binding === binding ? saved.urls : {};
}
