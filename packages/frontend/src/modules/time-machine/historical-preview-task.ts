import { decodeHistoricalAppIcons, type CapturedIcon, type CapturedIconsAsset } from './historical-icon-decoder';
import { previewSha256 } from './preview-sha256';
export type HistoricalPreviewTask =
  | { mode: 'icons'; bytes: Uint8Array<ArrayBuffer>; asset: CapturedIconsAsset }
  | { mode: 'digest'; bytes: Uint8Array<ArrayBuffer> };
const fail = () => new Error('The captured preview could not be verified.');
const validIcons = (value: unknown): value is CapturedIcon[] =>
  Array.isArray(value) && value.length <= 512 && value.every((icon) => icon && typeof icon.urn === 'string' && icon.blob instanceof Blob);

async function direct(task: HistoricalPreviewTask, signal: AbortSignal) {
  signal.throwIfAborted();
  const result = task.mode === 'icons' ? await decodeHistoricalAppIcons(task.bytes, task.asset, signal) : await previewSha256(task.bytes);
  signal.throwIfAborted();
  return result;
}

export type PreviewWorkerFactory = () => Worker | undefined;
const browserWorker: PreviewWorkerFactory = () => {
  if (typeof window === 'undefined' || typeof window.Worker !== 'function') return undefined;
  return new Worker(new URL('./historical-preview.worker.ts', import.meta.url), { type: 'module', name: 'Orbis captured previews' });
};
export async function runHistoricalPreviewTask(
  task: HistoricalPreviewTask,
  signal: AbortSignal,
  factory: PreviewWorkerFactory = browserWorker,
): Promise<CapturedIcon[] | string> {
  signal.throwIfAborted();
  let worker: Worker | undefined;
  try {
    worker = factory();
  } catch {
    return direct(task, signal);
  }
  if (!worker) return direct(task, signal);
  const activeWorker = worker;
  return new Promise((resolve, reject) => {
    let ended = false;
    let transferred = false;
    const originalBytes = task.bytes.byteLength;
    const cleanup = () => {
      if (ended) return;
      ended = true;
      clearTimeout(timeout);
      signal.removeEventListener('abort', cancelled);
      activeWorker.onmessage = null;
      activeWorker.onerror = null;
      activeWorker.onmessageerror = null;
      activeWorker.terminate();
    };
    const cancelled = () => {
      cleanup();
      reject(signal.reason ?? new DOMException('Preview cancelled.', 'AbortError'));
    };
    const invalid = () => {
      cleanup();
      reject(fail());
    };
    const unavailable = () => {
      if (ended) return;
      // Startup can be blocked by CSP or an unavailable module; retain ownership until ready.
      if (transferred || task.bytes.byteLength !== originalBytes) return invalid();
      cleanup();
      void direct(task, signal).then(resolve, reject);
    };
    const timeout = setTimeout(unavailable, 30_000);
    activeWorker.onmessage = ({ data }: MessageEvent<unknown>) => {
      if (ended) return;
      if (signal.aborted) return cancelled();
      if (!transferred) {
        if (!data || typeof data !== 'object' || Reflect.get(data, 'ready') !== true) return invalid();
        try {
          activeWorker.postMessage(task, [task.bytes.buffer]);
          transferred = true;
        } catch {
          unavailable();
        }
        return;
      }
      if (!data || typeof data !== 'object' || Reflect.get(data, 'ok') !== true) return invalid();
      const value = Reflect.get(data, 'value');
      if (task.mode === 'icons' ? !validIcons(value) : typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) return invalid();
      cleanup();
      resolve(value);
    };
    activeWorker.onerror = (event) => {
      event.preventDefault();
      unavailable();
    };
    activeWorker.onmessageerror = unavailable;
    signal.addEventListener('abort', cancelled, { once: true });
    if (signal.aborted) return cancelled();
  });
}
export async function decodeCapturedIcons(bytes: Uint8Array<ArrayBuffer>, asset: CapturedIconsAsset, signal: AbortSignal): Promise<CapturedIcon[]> {
  const result = await runHistoricalPreviewTask({ mode: 'icons', bytes, asset }, signal);
  if (!validIcons(result)) throw fail();
  return result;
}
export async function digestCapturedPreview(bytes: Uint8Array<ArrayBuffer>, signal: AbortSignal): Promise<string> {
  // The wallpaper caller still needs its bytes after the worker transfer.
  const result = await runHistoricalPreviewTask({ mode: 'digest', bytes: bytes.slice() }, signal);
  if (typeof result !== 'string') throw fail();
  return result;
}
