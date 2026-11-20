export function waitForWorkspaceReady(surface: HTMLElement | null, ready: () => void, slow: () => void, timeoutMs = 15000) {
  const guest = Boolean(surface?.classList?.contains('desktop-guest'));
  if (!surface || (!surface.querySelector('.desktop-view-home') && !guest)) {
    ready();
    return () => undefined;
  }
  let stopped = false;
  let fontsReady = false;
  const decoded = new Map<HTMLImageElement, string>();
  const decoding = new Map<HTMLImageElement, string>();
  const document = surface.ownerDocument;
  const events = guest ? document : surface;
  const observer = new MutationObserver(check);
  const timeout = window.setTimeout(() => {
    stop();
    slow();
  }, timeoutMs);
  function stop() {
    stopped = true;
    observer.disconnect();
    window.clearTimeout(timeout);
    events.removeEventListener('load', check, true);
    events.removeEventListener('error', check, true);
  }
  function check() {
    if (stopped || !fontsReady) return;
    // Suspense replaces the pending Guest shell, so observe its document and
    // resolve the current surface rather than holding the removed fallback.
    const home = guest ? document.querySelector('.desktop-guest') : surface?.querySelector('.workspace');
    if (!home || home.getAttribute('data-startup-ready') !== 'true' || home.querySelector('[data-startup-ready="false"]')) return;
    let pending = false;
    const batch: Promise<void>[] = [];
    for (const image of home.querySelectorAll<HTMLImageElement>('img')) {
      if (image.dataset?.startupOptional === 'true') continue;
      const source = image.currentSrc || image.src;
      if (image.complete && decoded.get(image) === source) continue;
      if (image.loading === 'lazy') {
        const { top, bottom } = image.getBoundingClientRect();
        if (top >= innerHeight || bottom <= 0) continue;
      }
      if (image.complete && !image.naturalWidth) continue;
      pending = true;
      if (!image.complete || decoding.get(image) === source) continue;
      decoding.set(image, source);
      const complete = () => {
        if (decoding.get(image) !== source) return;
        decoded.set(image, source);
        decoding.delete(image);
      };
      batch.push(image.decode().then(complete, complete));
    }
    if (batch.length) void Promise.all(batch).then(check);
    if (pending) return;
    stop();
    ready();
  }
  observer.observe(guest ? document.body : surface, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['data-startup-ready', 'src'],
  });
  events.addEventListener('load', check, true);
  events.addEventListener('error', check, true);
  void (document.fonts?.ready ?? Promise.resolve()).then(() => {
    fontsReady = true;
    check();
  });
  return stop;
}
