const started = new WeakMap<object, Map<string, number>>();

export function formationElapsed(owner: object, now: number, variation = 'session') {
  const variations = started.get(owner) ?? new Map<string, number>();
  const first = variations.get(variation) ?? now;
  variations.set(variation, first);
  started.set(owner, variations);
  return Math.max(0, now - first);
}

export function formationProgress(value?: number) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : undefined;
}

export function formationAmount(progress: number, group: number, count = 16) {
  return Math.max(0, Math.min(1, (progress / 100) * count - group));
}
