export function waitForStartupWallpaper(surface: HTMLElement, ready: () => void, timeoutMs = 1500) {
  let cancelled = false;
  let decoding: HTMLImageElement | null = null;
  let decoded: HTMLImageElement | null = null;
  let observedLayer: HTMLElement | null = null;
  const Observer = surface.ownerDocument?.defaultView?.MutationObserver ?? globalThis.MutationObserver;
  const observer = typeof Observer === 'function' ? new Observer(check) : null;
  const timeout = setTimeout(finish, timeoutMs);
  function check() {
    if (cancelled) return;
    const layer = surface.querySelector<HTMLElement>('.desktop-wallpaper-layer');
    if (!layer || layer.dataset.wallpaperState === 'unavailable') return finish();
    if (observedLayer !== layer) {
      observedLayer = layer;
      observer?.observe(layer, { subtree: true, attributes: true, attributeFilter: ['data-wallpaper-state', 'style', 'src'] });
    }
    if (layer.dataset.wallpaperState === 'loading') return;
    const image = layer.querySelector<HTMLImageElement>('img:last-of-type');
    if (!image) return finish();
    if (!image.complete) return;
    if (!image.naturalWidth) return finish();
    if (decoded !== image) {
      if (decoding === image) return;
      decoding = image;
      void image.decode().then(
        () => {
          decoded = image;
          decoding = null;
          check();
        },
        () => {
          decoding = null;
          if (surface.querySelector('.desktop-wallpaper-layer img:last-of-type') === image) finish();
          else check();
        },
      );
      return;
    }
    if (image.style.opacity !== '1') return;
    finish();
  }
  function finish() {
    if (cancelled) return;
    cancelled = true;
    clearTimeout(timeout);
    observer?.disconnect();
    surface.removeEventListener('load', check, true);
    surface.removeEventListener('error', check, true);
    ready();
  }
  observer?.observe(surface, { subtree: true, childList: true });
  surface.addEventListener('load', check, true);
  surface.addEventListener('error', check, true);
  check();
  return () => {
    cancelled = true;
    clearTimeout(timeout);
    observer?.disconnect();
    surface.removeEventListener('load', check, true);
    surface.removeEventListener('error', check, true);
  };
}
