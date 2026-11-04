import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from '@/desktop/motion-preferences';
import {
  advanceOperationContinuity,
  claimOperationReload,
  readOperationContinuity,
  operationDepartureMs,
  operationBootFragment,
  operationContinuityStorage,
  writeOperationContinuity,
  type OperationContinuity,
  type OperationJob,
} from './operation-continuity';
import { loadOperationStatus, operationAllowsDeparture, operationIsSafeTerminal } from './operation-status';

export function useOperationDeparture(job: OperationJob | null | undefined, reconnecting: boolean, beforeReload?: (id: string) => void) {
  const reduced = useReducedMotion();
  const [departure, setDeparture] = useState<{ jobId: string; operation: OperationJob['operation']; savedAt: number } | null>(null);
  const [storageFailed, setStorageFailed] = useState(false);
  const reloaded = useRef(false);
  const inMemory = useRef<OperationContinuity | null>(null);
  const onReload = useRef(beforeReload);
  onReload.current = beforeReload;
  useEffect(() => {
    if (!job || reloaded.current || (job.operation === 'restore' && job.status === 'rolled-back')) return;
    if (job.status === 'running' && !job.needsRecovery) {
      const storage = operationContinuityStorage();
      const previous = (storage ? readOperationContinuity(storage) : null) ?? inMemory.current;
      const next = advanceOperationContinuity(previous, job, false, Date.now());
      inMemory.current = next;
      if (next && next !== previous && (!storage || !writeOperationContinuity(next, storage))) setStorageFailed(true);
      return;
    }
    if (reconnecting) return;
    let current = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const observe = async () => {
      const storage = operationContinuityStorage();
      if (operationIsSafeTerminal(job)) {
        const authority = await loadOperationStatus(true);
        if (!current) return;
        if (!operationAllowsDeparture(authority)) {
          if (authority.supported) retry = setTimeout(() => void observe(), 1500);
          return;
        }
      }
      const previous = (storage ? readOperationContinuity(storage) : null) ?? inMemory.current;
      const next = advanceOperationContinuity(previous, job, false, Date.now());
      inMemory.current = next;
      if (next && next !== previous && (!storage || !writeOperationContinuity(next, storage))) setStorageFailed(true);
      if (current && next?.phase === 'departing' && next.jobId === job.id && next.operation === job.operation && operationIsSafeTerminal(job))
        setDeparture({ jobId: next.jobId, operation: next.operation, savedAt: next.savedAt });
    };
    void observe();
    return () => {
      current = false;
      clearTimeout(retry);
    };
  }, [job, reconnecting]);
  const confirmed = Boolean(
    departure && job?.id === departure.jobId && job.operation === departure.operation && !reconnecting && operationIsSafeTerminal(job),
  );
  useEffect(() => {
    if (!departure || !confirmed || reloaded.current) return;
    let current = true;
    const timer = window.setTimeout(
      async () => {
        const authority = await loadOperationStatus(true);
        if (!current || !operationAllowsDeparture(authority)) return;
        const storage = operationContinuityStorage();
        const claimed = storage && claimOperationReload(departure.jobId, storage);
        if (!claimed) {
          const persisted = storage ? readOperationContinuity(storage) : null;
          if (
            (persisted && (persisted.jobId !== departure.jobId || !['running', 'departing'].includes(persisted.phase))) ||
            inMemory.current?.jobId !== departure.jobId ||
            inMemory.current.phase !== 'departing'
          )
            return;
          inMemory.current = { ...inMemory.current, phase: 'reload', savedAt: Date.now() };
          setStorageFailed(true);
        }
        reloaded.current = true;
        onReload.current?.(departure.jobId);
        window.location.assign(claimed ? '/' : `/${operationBootFragment}`);
      },
      reduced || document.documentElement.dataset.orbisEffects === 'low' ? 0 : Math.max(0, operationDepartureMs - (Date.now() - departure.savedAt)),
    );
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [departure, confirmed, reduced]);
  return { departing: confirmed, storageFailed };
}
