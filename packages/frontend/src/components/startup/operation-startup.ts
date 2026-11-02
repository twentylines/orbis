import { createContext, useCallback, useContext, useLayoutEffect, useState } from 'react';
import {
  clearOperationContinuity,
  readOperationContinuity,
  operationContinuityStorage,
  type MaintenanceOperation,
} from '@/components/recovery-progress/operation-continuity';
export const OperationStartupContext = createContext<MaintenanceOperation | null>(null);
export function useOperationStartup() {
  const inherited = useContext(OperationStartupContext);
  const [operation, setOperation] = useState<MaintenanceOperation | null>(null);
  useLayoutEffect(() => {
    const storage = operationContinuityStorage();
    const marker = storage ? readOperationContinuity(storage) : null;
    if (inherited) setOperation(inherited);
    else if (document.documentElement.hasAttribute('data-orbis-operation-boot') && marker?.phase === 'booting') setOperation(marker.operation);
  }, [inherited]);
  const complete = useCallback(() => {
    const storage = operationContinuityStorage();
    if (storage) clearOperationContinuity(storage);
    document.documentElement.removeAttribute('data-orbis-operation-boot');
    setOperation(null);
  }, []);
  return { operation, complete };
}
