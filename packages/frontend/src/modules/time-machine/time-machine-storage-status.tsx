import { useEffect, useRef, useState } from 'react';
import type { TimeMachineStorage } from '@runtipi/common/schemas/time-machine-storage';
import { isTimeMachineStorageLow, readTimeMachineStorage } from './time-machine-storage-api';
import { InlineFeedback } from '@/components/ui/Alert/Alert';
import './time-machine-storage-status.css';

const gigabytes = (bytes: number) => (bytes > 0 && bytes < 10_000_000 ? '<0.01' : (bytes / 1_000_000_000).toFixed(2));

export function TimeMachineStorageStatus({ visible = true }: { visible?: boolean }) {
  const [storage, setStorage] = useState<TimeMachineStorage | null>(null);
  const cache = useRef<{ value: TimeMachineStorage; checkedAt: number } | null>(null);
  useEffect(() => {
    if (!visible) return;
    if (cache.current && Date.now() - cache.current.checkedAt < 30_000) {
      setStorage(cache.current.value);
      return;
    }
    const controller = new AbortController();
    setStorage(null);
    void readTimeMachineStorage(controller.signal).then(
      (value) => {
        if (controller.signal.aborted) return;
        cache.current = { value, checkedAt: Date.now() };
        setStorage(value);
      },
      () => {
        if (!controller.signal.aborted) setStorage(null);
      },
    );
    return () => controller.abort();
  }, [visible]);
  if (!visible || !storage || !isTimeMachineStorageLow(storage)) return null;
  return (
    <InlineFeedback className="tm-storage-warning">
      <div className="tm-storage-warning-copy">
        <strong>You’re running low on space</strong>
        <span>
          {gigabytes(storage.usedBytes)} / {gigabytes(storage.totalBytes)} GB used.
        </span>
        <span>{gigabytes(storage.availableBytes)} GB available.</span>
      </div>
    </InlineFeedback>
  );
}
