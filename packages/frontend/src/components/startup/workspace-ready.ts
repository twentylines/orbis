export function waitForWorkspaceReady(surface: HTMLElement | null, ready: () => void, slow: () => void, timeoutMs = 15000) {
  if (!surface?.querySelector('.desktop-view-home')) {
    ready();
    return () => undefined;
  }
  let stopped = false;
  let fontsReady = false;
  const decoded = new Map<HTMLImageElement, string>();
  const decoding = new Map<HTMLImageElement, string>();
  const document = surface.ownerDocument;
  const observer = new MutationObserver(check);
  const timeout = window.setTimeout(() => {
    stop();
    slow();
  }, timeoutMs);
  function stop() {
    stopped = true;
    observer.disconnect();
    window.clearTimeout(timeout);
    surface?.removeEventListener('load', check, true);
    surface?.removeEventListener('error', check, true);
  }
  function check() {
    if (stopped || !fontsReady) return;
    const home = surface?.querySelector('.workspace');
    if (!home || home.getAttribute('data-startup-ready') !== 'true' || home.querySelector('[data-startup-ready="false"]')) return;
    for (const image of home.querySelectorAll<HTMLImageElement>('img')) {
      const bounds = image.getBoundingClientRect();
      if (image.loading === 'lazy' && (bounds.top >= innerHeight || bounds.bottom <= 0)) continue;
      if (!image.complete) return;
      if (!image.naturalWidth) continue;
      const source = image.currentSrc || image.src;
      if (decoded.get(image) === source) continue;
      if (decoding.get(image) !== source) {
        decoding.set(image, source);
        void image.decode().then(
          () => {
            decoded.set(image, source);
            decoding.delete(image);
            check();
          },
          () => {
            decoded.set(image, source);
            decoding.delete(image);
            check();
          },
        );
      }
      return;
    }
    stop();
    ready();
  }
  observer.observe(surface, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-startup-ready', 'src'] });
  surface.addEventListener('load', check, true);
  surface.addEventListener('error', check, true);
  void (document.fonts?.ready ?? Promise.resolve()).then(() => {
    fontsReady = true;
    check();
  });
  return stop;
}
