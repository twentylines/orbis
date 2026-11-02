import { useMemo } from 'react';
import type { RestoreJob } from '@/modules/system-backups/contracts';
import { useOperationDeparture } from './use-operation-departure';
export function useRestoreDeparture(job: RestoreJob | null | undefined, reconnecting: boolean) {
  const id = job?.id;
  const status = job?.status;
  const needsRecovery = job?.needsRecovery ?? false;
  const operation = useMemo(() => (id && status ? { id, operation: 'restore' as const, status, needsRecovery } : null), [id, status, needsRecovery]);
  return useOperationDeparture(operation, reconnecting);
}
