import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from '@/desktop/motion-preferences';
import {
  advanceOperationContinuity,
  claimOperationReload,
  readOperationContinuity,
  operationDepartureMs,
  operationContinuityStorage,
  writeOperationContinuity,
  type OperationJob,
} from './operation-continuity';
import { loadOperationStatus, operationAllowsDeparture } from './operation-status';

export function useOperationDeparture(job: OperationJob | null | undefined, reconnecting: boolean, beforeReload?: (id: string) => void) {
  const reduced = useReducedMotion();
  const [departure, setDeparture] = useState<{ jobId: string; savedAt: number } | null>(null);
  const [storageFailed, setStorageFailed] = useState(false);
  const reloaded = useRef(false);
  const onReload = useRef(beforeReload);
  onReload.current = beforeReload;
  useEffect(() => {
    if (!job || reloaded.current || reconnecting || (job.operation === 'restore' && job.status === 'rolled-back')) return;
    let current = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const observe = async () => {
      const storage = operationContinuityStorage();
      if (!storage) {
        setStorageFailed(true);
        return;
      }
      if (['succeeded', 'rolled-back'].includes(job.status)) {
        const authority = await loadOperationStatus(true);
        if (!current) return;
        if (!operationAllowsDeparture(authority)) {
          if (authority.supported) retry = setTimeout(() => void observe(), 1500);
          return;
        }
      }
      const previous = readOperationContinuity(storage);
      const next = advanceOperationContinuity(previous, job, false, Date.now());
      if (next && next !== previous && !writeOperationContinuity(next, storage)) {
        setStorageFailed(true);
        return;
      }
      if (
        current &&
        next?.phase === 'departing' &&
        next.jobId === job.id &&
        next.operation === job.operation &&
        !job.needsRecovery &&
        ['succeeded', 'rolled-back'].includes(job.status)
      )
        setDeparture({ jobId: next.jobId, savedAt: next.savedAt });
    };
    void observe();
    return () => {
      current = false;
      clearTimeout(retry);
    };
  }, [job, reconnecting]);
  const confirmed = Boolean(
    departure &&
      job?.id === departure.jobId &&
      !job.needsRecovery &&
      !reconnecting &&
      !(job.operation === 'restore' && job.status === 'rolled-back') &&
      ['succeeded', 'rolled-back'].includes(job.status),
  );
  useEffect(() => {
    if (!departure || !confirmed || reloaded.current) return;
    let current = true;
    const timer = window.setTimeout(
      async () => {
        const authority = await loadOperationStatus(true);
        if (!current || !operationAllowsDeparture(authority)) return;
        const storage = operationContinuityStorage();
        if (!storage || !claimOperationReload(departure.jobId, storage)) {
          setStorageFailed(true);
          return;
        }
        reloaded.current = true;
        onReload.current?.(departure.jobId);
        window.location.assign('/');
      },
      reduced || document.documentElement.dataset.orbisEffects === 'low' ? 0 : Math.max(0, operationDepartureMs - (Date.now() - departure.savedAt)),
    );
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [departure, confirmed, reduced]);
  return { departing: confirmed && !storageFailed, storageFailed };
}
