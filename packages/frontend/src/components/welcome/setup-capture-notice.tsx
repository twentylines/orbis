import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAppContext } from '@/context/app-context';
import { useDesktopPreferences } from '@/desktop/preferences';
import { useUserContext } from '@/context/user-context';
import { readOnboardingCapture, TimeMachineApiError } from '@/modules/time-machine/time-machine-api';
import { readManualProtection } from '@/modules/time-machine-capsules/protection-choice';
import { timeMachinePreferencesQueryKey } from '@/modules/time-machine/time-machine-preferences-query';
import { acknowledgeSetupCapture, readSetupCapture, reconcileSetupCapture, setupCaptureStorage, priorUnconfirmedSetupCapture } from './setup-capture';
import { recordSetupFailureTask } from './setup-capture-task';

export function SetupCaptureNotice() {
  const { user } = useAppContext();
  const { onboardingGeneration } = useDesktopPreferences();
  return (
    <SetupCaptureNoticeSession
      key={`${user.id}:${onboardingGeneration ?? 'initial'}`}
      ownerId={user.id}
      operator={user.operator}
      onboardingGeneration={onboardingGeneration}
    />
  );
}

function SetupCaptureNoticeSession({
  ownerId,
  operator,
  onboardingGeneration,
}: {
  ownerId: number;
  operator: boolean;
  onboardingGeneration: string | null;
}) {
  const { sessionAbortSignal } = useUserContext();
  const currentStorage = useMemo(() => setupCaptureStorage(onboardingGeneration), [onboardingGeneration]);
  const [prior] = useState(() => {
    try {
      return priorUnconfirmedSetupCapture(ownerId, onboardingGeneration);
    } catch {
      return null;
    }
  });
  const storage = prior?.storage ?? currentStorage;
  const [receipt, setReceipt] = useState(() => {
    try {
      return readSetupCapture(ownerId, storage);
    } catch {
      return null;
    }
  });
  const protection = useQuery({
    queryKey: timeMachinePreferencesQueryKey(ownerId),
    queryFn: ({ signal }) => readManualProtection(AbortSignal.any([signal, sessionAbortSignal])),
    enabled: operator,
    retry: false,
  });
  const captureEnabled = operator && !protection.isFetching && !protection.isError && protection.data?.enabled === true;
  const key = ['setup-capture-status', ownerId, receipt?.attemptId];
  const status = useQuery({
    queryKey: key,
    enabled: captureEnabled && Boolean(receipt),
    queryFn: ({ signal }) => readOnboardingCapture(receipt?.attemptId ?? '', AbortSignal.any([signal, sessionAbortSignal])),
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: (query) => (query.state.data?.status === 'capturing' ? 2500 : false),
  });
  useEffect(() => {
    if (
      !captureEnabled ||
      !prior ||
      !receipt ||
      receipt.phase === 'accepted' ||
      (status.data?.status !== 'capturing' && status.data?.status !== 'sealed')
    )
      return;
    void reconcileSetupCapture(ownerId, receipt, false, sessionAbortSignal, storage).then(
      () => setReceipt({ ...receipt, phase: 'accepted' }),
      () => undefined,
    );
  }, [captureEnabled, prior, receipt, status.data?.status, ownerId, sessionAbortSignal, storage]);
  useEffect(() => {
    if (
      !captureEnabled ||
      !prior ||
      !receipt ||
      receipt.phase !== 'pending' ||
      !(status.error instanceof TimeMachineApiError) ||
      status.error.code !== 'point-not-found'
    )
      return;
    try {
      setReceipt(acknowledgeSetupCapture(ownerId, receipt, 'failed', storage));
    } catch {
      // Keep the unconfirmed receipt if browser storage is unavailable.
    }
  }, [captureEnabled, prior, receipt, status.error, ownerId, storage]);
  const terminal = status.data?.status === 'failed' || status.data?.status === 'interrupted';
  useEffect(() => {
    if (!captureEnabled || !terminal || !receipt) return;
    recordSetupFailureTask(ownerId, receipt.attemptId, 'capture-failed');
    if (receipt.phase === 'failed') return;
    try {
      setReceipt(acknowledgeSetupCapture(ownerId, receipt, 'failed', storage));
    } catch {
      /* Keep the server point and existing receipt. */
    }
  }, [captureEnabled, receipt, terminal, ownerId, storage]);
  return null;
}
