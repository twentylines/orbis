import { timeMachineStorageSchema, type TimeMachineStorage } from '@runtipi/common/schemas/time-machine-storage';

// Warn below 5 GiB of actual filesystem availability; capture needs vary by server.
export const timeMachineLowStorageBytes = 5 * 1024 ** 3;
export const isTimeMachineStorageLow = (value: TimeMachineStorage) => value.availableBytes < timeMachineLowStorageBytes;

export async function readTimeMachineStorage(signal: AbortSignal): Promise<TimeMachineStorage> {
  const response = await fetch('/api/system-backups/time-machine/storage', {
    credentials: 'same-origin',
    cache: 'no-store',
    signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
  });
  if (!response.ok || !response.body) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error('Storage status is unavailable');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) throw new Error('Storage status is too large');
      text += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const value: unknown = JSON.parse(text + decoder.decode());
  if (!timeMachineStorageSchema.allows(value)) throw new Error('Storage status is invalid');
  return value;
}
