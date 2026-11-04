export type DownloadProgress = {
  schema: 'orbis.download-progress.v1';
  phase: 'downloading' | 'extracting' | 'complete';
  currentBytes: number;
  totalBytes: number | null;
  totalKnown: boolean;
  alreadyCached: boolean;
  layersComplete: number;
  layersTotal: number;
  updatedAt: number;
};

export function readDownloadProgress(value: unknown): DownloadProgress | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const item = value as Record<string, unknown>;
  const count = (number: unknown): number is number => typeof number === 'number' && Number.isSafeInteger(number) && number >= 0;
  if (
    item.schema !== 'orbis.download-progress.v1' ||
    typeof item.phase !== 'string' ||
    !['downloading', 'extracting', 'complete'].includes(item.phase) ||
    !count(item.currentBytes) ||
    !(item.totalBytes === null || count(item.totalBytes)) ||
    typeof item.totalKnown !== 'boolean' ||
    item.totalKnown !== (item.totalBytes !== null) ||
    (typeof item.totalBytes === 'number' && item.currentBytes > item.totalBytes) ||
    typeof item.alreadyCached !== 'boolean' ||
    (item.alreadyCached && (item.phase !== 'complete' || item.currentBytes !== 0 || item.totalBytes !== 0)) ||
    !count(item.layersComplete) ||
    !count(item.layersTotal) ||
    item.layersComplete > item.layersTotal ||
    typeof item.updatedAt !== 'number' ||
    !Number.isFinite(item.updatedAt) ||
    item.updatedAt <= 0
  )
    return;
  return item as DownloadProgress;
}
