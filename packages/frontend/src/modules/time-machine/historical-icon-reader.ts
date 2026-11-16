import { timeMachineIdSchema, type TimeMachinePoint } from '@runtipi/common/schemas/time-machine';
import { historicalIconLimits, historicalIconsAssetSchema } from '@runtipi/common/schemas/time-machine-icons';
import { decodeCapturedIcons } from './historical-preview-task';
const fail = () => new Error('Captured application icons are unavailable.');
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
  return decodeCapturedIcons(bytes, asset, signal);
}
