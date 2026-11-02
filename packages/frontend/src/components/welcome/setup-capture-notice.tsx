import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useAppContext } from '@/context/app-context';
import { useDesktopPreferences } from '@/desktop/preferences';
import { useUserContext } from '@/context/user-context';
import { Button } from '@/components/ui/Button';
import { InlineFeedback } from '@/components/ui/Alert/Alert';
import { readOnboardingCapture, TimeMachineApiError } from '@/modules/time-machine/time-machine-api';
import { acknowledgeSetupCapture, readSetupCapture, reconcileSetupCapture, setupCaptureStorage, priorUnconfirmedSetupCapture } from './setup-capture';
import './setup-capture-notice.css';

export function SetupCaptureNotice() {
  const { user } = useAppContext();
  return <SetupCaptureNoticeSession key={user.id} ownerId={user.id} operator={user.operator} />;
}

function SetupCaptureNoticeSession({ ownerId, operator }: { ownerId: number; operator: boolean }) {
  const { sessionAbortSignal } = useUserContext();
  const { onboardingGeneration } = useDesktopPreferences();
  const currentStorage = useMemo(() => setupCaptureStorage(onboardingGeneration), [onboardingGeneration]);
  const [prior] = useState(() => {
    try {
      return priorUnconfirmedSetupCapture(ownerId, onboardingGeneration);
    } catch {
      return null;
    }
  });
  const storage = prior?.storage ?? currentStorage;
  const queryClient = useQueryClient();
  const [receiptError] = useState(() => {
    try {
      readSetupCapture(ownerId, storage);
      return '';
    } catch {
      return 'The setup capture receipt could not be verified. Review Time Machine in Settings.';
    }
  });
  const [receipt, setReceipt] = useState(() => {
    try {
      return readSetupCapture(ownerId, storage);
    } catch {
      return null;
    }
  });
  const [retrying, setRetrying] = useState(false);
  const notice = useQuery<{ message: string }>({ queryKey: ['setup-capture-notice', ownerId], enabled: false });
  const key = ['setup-capture-status', ownerId, receipt?.attemptId];
  const status = useQuery({
    queryKey: key,
    enabled: operator && Boolean(receipt),
    queryFn: ({ signal }) => readOnboardingCapture(receipt?.attemptId ?? '', AbortSignal.any([signal, sessionAbortSignal])),
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: (query) => (query.state.data?.status === 'capturing' ? 2500 : false),
  });
  useEffect(() => {
    if (!prior || !receipt || receipt.phase === 'accepted' || (status.data?.status !== 'capturing' && status.data?.status !== 'sealed')) return;
    void reconcileSetupCapture(ownerId, receipt, false, sessionAbortSignal, storage).then(
      () => setReceipt({ ...receipt, phase: 'accepted' }),
      () => undefined,
    );
  }, [prior, receipt, status.data?.status, ownerId, sessionAbortSignal, storage]);
  useEffect(() => {
    if (
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
  }, [prior, receipt, status.error, ownerId, storage]);
  const terminal = status.data?.status === 'failed' || status.data?.status === 'interrupted';
  useEffect(() => {
    if (!terminal || !receipt || receipt.phase === 'failed') return;
    try {
      setReceipt(acknowledgeSetupCapture(ownerId, receipt, 'failed', storage));
    } catch {
      /* Keep the server point and existing receipt. */
    }
  }, [receipt, terminal, ownerId, storage]);
  const retry = async () => {
    if (!receipt || retrying) return;
    setRetrying(true);
    try {
      const point = await reconcileSetupCapture(ownerId, receipt, true, AbortSignal.any([sessionAbortSignal, AbortSignal.timeout(30_000)]), storage);
      queryClient.setQueryData(key, point);
      queryClient.setQueryData(['setup-capture-notice', ownerId], { message: '' });
      setReceipt({ ...receipt, phase: 'accepted' });
    } catch (reason) {
      queryClient.setQueryData(['setup-capture-notice', ownerId], {
        message: reason instanceof TimeMachineApiError ? reason.message : 'The setup capture is not confirmed. Retry checks this same attempt.',
      });
      await status.refetch();
    } finally {
      setRetrying(false);
    }
  };
  if (status.data?.status === 'capturing' || status.data?.status === 'sealed') return null;
  if (!terminal && !status.isError && !notice.data?.message && !receiptError) return null;
  const notCreated = status.error instanceof TimeMachineApiError && status.error.code === 'point-not-found' && receipt?.phase === 'pending';
  return (
    <InlineFeedback className="orbis-setup-capture-notice" variant="warning">
      <p>
        {terminal
          ? 'The setup capture failed. You can try again in Time Machine.'
          : notCreated
            ? 'No setup capture was created. You can capture later in Time Machine.'
            : receiptError || notice.data?.message || 'The setup capture is not confirmed. Your workspace is ready to use.'}
      </p>
      <div>
        {!terminal && receipt ? (
          <Button type="button" variant="outline" disabled={retrying || status.isFetching} onClick={() => void retry()}>
            Retry
          </Button>
        ) : null}
        <Link to="/settings?tab=time-machine" className="btn btn-outline-primary">
          Time Machine
        </Link>
      </div>
    </InlineFeedback>
  );
}
