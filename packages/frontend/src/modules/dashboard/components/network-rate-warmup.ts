import { useEffect, useState } from 'react';

export type NetworkCounters = {
  interface: string;
  historyId?: string;
  receivedBytes: number | null;
  transmittedBytes: number | null;
  rxBytesPerSecond: number | null;
  txBytesPerSecond: number | null;
};
export type NetworkWarmup = { identity: string | null; eligible: boolean; deadline: number | null };

export function networkWarmup(previous: NetworkWarmup | null, identity: string | null, eligible: boolean, now: number): NetworkWarmup {
  if (!eligible || identity === null)
    return previous && !previous.eligible && previous.identity === identity ? previous : { identity, eligible: false, deadline: null };
  if (previous?.eligible && previous.identity === identity) return previous;
  return { identity, eligible: true, deadline: now + 30_000 };
}

export function canMeasureNetwork(row: NetworkCounters | null | undefined) {
  return (
    !!row &&
    row.rxBytesPerSecond === null &&
    row.txBytesPerSecond === null &&
    typeof row.receivedBytes === 'number' &&
    Number.isFinite(row.receivedBytes) &&
    row.receivedBytes >= 0 &&
    typeof row.transmittedBytes === 'number' &&
    Number.isFinite(row.transmittedBytes) &&
    row.transmittedBytes >= 0
  );
}

export function useNetworkWarmup(row: NetworkCounters | null | undefined, visible: boolean) {
  const identity = row ? `${row.interface}:${row.historyId ?? ''}` : null;
  const eligible = visible && canMeasureNetwork(row);
  const [warmup, setWarmup] = useState(() => networkWarmup(null, identity, eligible, Date.now()));
  const [expiredDeadline, setExpiredDeadline] = useState<number | null>(null);
  const current = networkWarmup(warmup, identity, eligible, Date.now());
  if (current !== warmup) setWarmup(current);
  useEffect(() => {
    if (!current.eligible || current.deadline === null) return;
    const deadline = current.deadline;
    const timer = setTimeout(() => setExpiredDeadline(deadline), Math.max(0, deadline - Date.now()));
    return () => clearTimeout(timer);
  }, [current]);
  return current.eligible && current.deadline !== null && expiredDeadline !== current.deadline && Date.now() < current.deadline;
}
