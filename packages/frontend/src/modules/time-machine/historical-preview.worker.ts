import { decodeHistoricalAppIcons } from './historical-icon-decoder';
import { previewSha256 } from './preview-sha256';
import type { HistoricalPreviewTask } from './historical-preview-task';
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<HistoricalPreviewTask>) => void) | null;
  postMessage: (value: unknown) => void;
};
scope.onmessage = ({ data }) => {
  void (async () => {
    try {
      if (!data || !(data.bytes instanceof Uint8Array) || !['icons', 'digest'].includes(data.mode)) throw new Error('Invalid preview task.');
      const value =
        data.mode === 'icons'
          ? await decodeHistoricalAppIcons(data.bytes, data.asset, new AbortController().signal)
          : await previewSha256(data.bytes);
      scope.postMessage({ ok: true, value });
    } catch {
      scope.postMessage({ ok: false });
    }
  })();
};
scope.postMessage({ ready: true });
