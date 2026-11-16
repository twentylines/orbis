import { historicalIconLimits, historicalIconsAssetSchema, historicalIconsPayloadSchema } from '@runtipi/common/schemas/time-machine-icons';
import { previewSha256 } from './preview-sha256';
export type CapturedIcon = { urn: string; blob: Blob };
export type CapturedIconsAsset = typeof historicalIconsAssetSchema.infer;
const fail = () => new Error('Captured application icons are unavailable.');

export async function decodeHistoricalAppIcons(
  bytes: Uint8Array<ArrayBuffer>,
  asset: CapturedIconsAsset,
  signal: AbortSignal,
): Promise<CapturedIcon[]> {
  historicalIconsAssetSchema.assert(asset);
  if (bytes.byteLength !== asset.bytes || bytes.byteLength > historicalIconLimits.bundleBytes) throw fail();
  signal.throwIfAborted();
  if ((await previewSha256(bytes)) !== asset.identity) throw fail();
  const payload = historicalIconsPayloadSchema.assert(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  if (payload.icons.length !== asset.icons.length) throw fail();
  const result: CapturedIcon[] = [];
  for (let index = 0; index < payload.icons.length; index++) {
    signal.throwIfAborted();
    const item = payload.icons[index];
    const expected = asset.icons[index];
    if (!item || !expected || Object.entries(expected).some(([key, value]) => Reflect.get(item, key) !== value)) throw fail();
    const raw = atob(item.data);
    if (raw.length !== item.bytes || btoa(raw) !== item.data) throw fail();
    const image = new Uint8Array(raw.length);
    for (let byte = 0; byte < raw.length; byte++) image[byte] = raw.charCodeAt(byte);
    if ((await previewSha256(image)) !== item.identity) throw fail();
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
