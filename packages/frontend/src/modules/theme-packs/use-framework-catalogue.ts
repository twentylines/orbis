import { useCallback, useEffect, useRef, useState } from 'react';
import { readFrameworkCatalogue, type FrameworkCatalogueResponse } from './framework-catalogue';

export function useFrameworkCatalogue(active: boolean) {
  const [data, setData] = useState<FrameworkCatalogueResponse | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const sequence = useRef(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision deliberately restarts the request after Refresh.
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      const id = ++sequence.current;
      try {
        const result = await readFrameworkCatalogue(controller.signal);
        if (!controller.signal.aborted && id === sequence.current) {
          setData((previous) => (result.status === 'unavailable' && previous?.catalogue ? { ...previous, status: 'stale' } : result));
          setError('');
        }
      } catch (failure) {
        if (!controller.signal.aborted && id === sequence.current)
          setError(
            failure instanceof Error && ['Theme discovery requires an operator account.', 'Unsupported theme catalogue.'].includes(failure.message)
              ? failure.message
              : 'Theme catalogue could not be loaded.',
          );
      } finally {
        pending = false;
      }
    };
    void load();
    const timer = window.setInterval(load, 5 * 60_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [active, revision]);
  return { data, error, refresh };
}
