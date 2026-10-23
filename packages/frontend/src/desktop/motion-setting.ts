export function prefersReducedMotion() {
  if (typeof document !== 'undefined' && document.documentElement.dataset.orbisMotion === 'reduced') return true;
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}
