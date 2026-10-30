import { useEffect, useId, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { useReducedMotion } from '@/desktop/motion-preferences';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/Button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogSection,
  DialogFeedback,
} from '@/components/ui/Dialog/Dialog';
import { InlineFeedback } from '@/components/ui/Alert/Alert';
import { useAppContext } from '@/context/app-context';
import { useWindowVisible } from '@/desktop/window-visibility';
import { prepareDesktopForCoreUpdate, rememberAcceptedCoreUpdate } from '@/desktop/host-update-watch';
import { validCoreUpdate } from '@/desktop/core-update-state';
import { formatOrbisVersion } from '@/desktop/orbis-version';
import {
  applyStableChannelInstall,
  enrollOrbisReleaseChannel,
  orbisReleaseChannelsOptions,
  planStableChannelInstall,
  releaseChannelErrorMessage,
  refreshReleaseChannelRelatedQueries,
  ReleaseChannelRequestError,
  type StableChannelPlan,
} from '@/desktop/release-channels';
import './release-channel-settings.css';

type DialogMode = 'nightly' | 'stable' | null;

function isStablePlan(value: StableChannelPlan): boolean {
  return (
    typeof value.planId === 'string' &&
    value.planId.length > 0 &&
    typeof value.currentTag === 'string' &&
    typeof value.targetTag === 'string' &&
    typeof value.targetDigest === 'string' &&
    value.targetDigest.length > 0 &&
    Number.isSafeInteger(value.snapshotBytes) &&
    value.snapshotBytes >= 0 &&
    typeof value.appsMustBeStopped === 'boolean' &&
    typeof value.compatibility === 'string' &&
    Number.isFinite(value.expiresAt) &&
    typeof value.forced === 'boolean' &&
    Array.isArray(value.warnings) &&
    value.warnings.every((warning) => typeof warning === 'string') &&
    value.returnToStable === true &&
    (value.operation === 'update' || value.operation === 'downgrade')
  );
}

function errorText(error: unknown, fallback: string): string {
  if (error instanceof Error && safeLocalErrors.has(error.message)) return error.message;
  return releaseChannelErrorMessage(error, fallback);
}

const safeLocalErrors = new Set([
  'The stable installation plan could not be verified. Refresh release channels and try again.',
  'The stable installation was not accepted by the host.',
]);

export function ReleaseChannelSettings() {
  const id = useId();
  const reducedMotion = useReducedMotion();
  const selectionMotion = reducedMotion ? { duration: 0 } : { type: 'spring' as const, stiffness: 460, damping: 28, mass: 0.7 };
  const mounted = useRef(false);
  const visible = useWindowVisible();
  const { user } = useAppContext();
  const queryClient = useQueryClient();
  const status = useQuery({ ...orbisReleaseChannelsOptions(), enabled: visible });
  const [dialog, setDialog] = useState<DialogMode>(null);
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<StableChannelPlan | null>(null);
  const [planError, setPlanError] = useState('');
  const [canForce, setCanForce] = useState(false);
  const [error, setError] = useState('');
  const [accepted, setAccepted] = useState(false);
  const operator = user?.operator === true;
  const current = status.isError ? undefined : status.data?.current;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const closeDialog = (open: boolean) => {
    if (open || busy) return;
    setDialog(null);
    setPlan(null);
    setPlanError('');
    setCanForce(false);
    setError('');
    setAccepted(false);
  };

  const beginStableReview = async (force = false) => {
    setBusy(true);
    setPlanError('');
    setCanForce(false);
    try {
      const result = await planStableChannelInstall(force);
      if (!isStablePlan(result) || result.forced !== force || result.expiresAt <= Date.now()) {
        throw new Error('The stable installation plan could not be verified. Refresh release channels and try again.');
      }
      if (!mounted.current) return;
      setPlan(result);
      setAccepted(false);
    } catch (cause) {
      if (!mounted.current) return;
      setCanForce(cause instanceof ReleaseChannelRequestError && cause.canForce && !force);
      setPlanError(errorText(cause, 'Stable installation compatibility could not be checked.'));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const chooseChannel = async (channel: 'stable' | 'nightly') => {
    if (!operator || !status.data || busy) return;
    if (channel === current && !(channel === 'stable' && status.data.requiresStableInstall)) return;
    setError('');
    setPlanError('');
    setCanForce(false);
    if (channel === 'nightly') {
      setPlan(null);
      setAccepted(false);
      setDialog('nightly');
      return;
    }
    if (status.data.current === 'stable' && !status.data.requiresStableInstall) return;
    if (status.data.requiresStableInstall) {
      setPlan(null);
      setPlanError('');
      setCanForce(false);
      setAccepted(false);
      setDialog('stable');
      await beginStableReview();
      return;
    }
    setBusy(true);
    try {
      const updated = await enrollOrbisReleaseChannel('stable', status.data.revision);
      if (!mounted.current) return;
      queryClient.setQueryData(orbisReleaseChannelsOptions().queryKey, updated);
      await refreshReleaseChannelRelatedQueries(queryClient);
    } catch (cause) {
      if (mounted.current) setError(errorText(cause, 'Stable channel could not be selected.'));
      void queryClient.invalidateQueries({ queryKey: orbisReleaseChannelsOptions().queryKey });
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const enrollNightly = async () => {
    if (!status.data || !operator || busy) return;
    setBusy(true);
    setError('');
    try {
      const updated = await enrollOrbisReleaseChannel('nightly', status.data.revision, true);
      queryClient.setQueryData(orbisReleaseChannelsOptions().queryKey, updated);
      await refreshReleaseChannelRelatedQueries(queryClient);
      if (mounted.current) setDialog(null);
    } catch (cause) {
      if (mounted.current) setError(errorText(cause, 'Nightly channel could not be selected.'));
      void queryClient.invalidateQueries({ queryKey: orbisReleaseChannelsOptions().queryKey });
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const applyStable = async () => {
    if (!plan || !accepted || !operator || busy) return;
    if (plan.expiresAt <= Date.now()) {
      setPlan(null);
      setAccepted(false);
      setPlanError('This review expired. Check compatibility again before continuing.');
      return;
    }
    setBusy(true);
    setError('');
    const currentPlan = plan;
    try {
      await prepareDesktopForCoreUpdate();
      const result = await applyStableChannelInstall(currentPlan.planId, currentPlan.forced);
      if (
        !result ||
        typeof result.jobId !== 'string' ||
        !validCoreUpdate(result.jobId, currentPlan.targetTag) ||
        !['queued', 'running'].includes(result.state)
      ) {
        throw new Error('The stable installation was not accepted by the host.');
      }
      rememberAcceptedCoreUpdate(result.jobId, currentPlan.targetTag, currentPlan.operation);
      if (!mounted.current) return;
      setPlan(null);
      setDialog(null);
      setAccepted(false);
      await refreshReleaseChannelRelatedQueries(queryClient);
    } catch (cause) {
      if (mounted.current) setError(errorText(cause, 'The reviewed stable installation could not be started.'));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const stableAvailable = status.data?.channels.find((channel: { id: string; available: boolean }) => channel.id === 'stable')?.available === true;
  const nightlyAvailable = status.data?.channels.find((channel: { id: string; available: boolean }) => channel.id === 'nightly')?.available === true;

  return (
    <section className="release-channel-settings" aria-labelledby={`${id}-title`}>
      <div className="release-channel-row">
        <div className="release-channel-heading">
          <h2 id={`${id}-title`}>Release channel</h2>
        </div>
        {status.data && !status.isError ? (
          <fieldset className="release-channel-switch" aria-labelledby={`${id}-title`} aria-busy={busy} data-channel={current}>
            <button
              type="button"
              aria-pressed={current === 'stable'}
              onClick={() => void chooseChannel('stable')}
              disabled={!operator || !stableAvailable || busy}
            >
              {current === 'stable' ? (
                <motion.span
                  className="release-channel-selection"
                  layout="position"
                  layoutId={`${id}-selection`}
                  transition={selectionMotion}
                  initial={false}
                  aria-hidden="true"
                />
              ) : null}
              Stable
            </button>
            <button
              type="button"
              aria-pressed={current === 'nightly'}
              onClick={() => void chooseChannel('nightly')}
              disabled={!operator || !nightlyAvailable || busy}
            >
              {current === 'nightly' ? (
                <motion.span
                  className="release-channel-selection"
                  layout="position"
                  layoutId={`${id}-selection`}
                  transition={selectionMotion}
                  initial={false}
                  aria-hidden="true"
                />
              ) : null}
              Nightly
            </button>
          </fieldset>
        ) : null}
      </div>
      <div className="release-channel-state" aria-live="polite">
        {status.isPending ? <output>Reading release channels…</output> : null}
        {status.isError ? (
          <InlineFeedback>
            <p>{releaseChannelErrorMessage(status.error, 'Release channel status could not be read. Check the server connection and try again.')}</p>
            <Button variant="outline" onClick={() => void status.refetch()}>
              Try again
            </Button>
          </InlineFeedback>
        ) : null}
        {status.data ? (
          <>
            {busy && !dialog ? <output className="release-channel-note">Changing release channel…</output> : null}
            {operator ? null : <p className="release-channel-note">An operator account is required to change the release channel.</p>}
            {error && !dialog ? <InlineFeedback className="release-channel-page-feedback">{error}</InlineFeedback> : null}
          </>
        ) : null}
      </div>

      <Dialog open={dialog === 'nightly'} onOpenChange={closeDialog}>
        <DialogContent size="md" className="release-channel-dialog" aria-describedby={`${id}-nightly-description`}>
          <DialogHeader>
            <DialogTitle>Choose Nightly?</DialogTitle>
          </DialogHeader>
          <DialogDescription id={`${id}-nightly-description`}>
            Nightly can contain bugs and unfinished features. Returning to Stable requires a compatible Stable installation.
          </DialogDescription>
          {error ? <DialogFeedback>{error}</DialogFeedback> : null}
          <DialogFooter className="release-channel-dialog-actions">
            <Button variant="outline" onClick={() => closeDialog(false)} disabled={busy}>
              Keep Stable
            </Button>
            <Button intent="primary" onClick={() => void enrollNightly()} loading={busy}>
              Choose Nightly
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === 'stable'} onOpenChange={closeDialog}>
        <DialogContent size="md" className="release-channel-dialog" aria-describedby={`${id}-stable-description`}>
          <DialogHeader>
            <DialogTitle>Stable installation plan</DialogTitle>
          </DialogHeader>
          <DialogDescription id={`${id}-stable-description`}>
            Stable requires installing a reviewed release. Check the plan and confirm before Orbis starts the installation.
          </DialogDescription>
          {busy && !plan ? (
            <DialogSection>
              <p>Checking the stable installation plan…</p>
            </DialogSection>
          ) : null}
          {plan ? (
            <DialogSection className="release-channel-plan">
              {plan.forced ? (
                <DialogFeedback>
                  This forced installation can make current data unreadable or leave the server unusable. Continue only with a recovery backup and an
                  accepted risk.
                </DialogFeedback>
              ) : null}
              <dl>
                <div>
                  <dt>Current version</dt>
                  <dd>{formatOrbisVersion(plan.currentTag)}</dd>
                </div>
                <div>
                  <dt>Target version</dt>
                  <dd>{formatOrbisVersion(plan.targetTag)}</dd>
                </div>
                <div>
                  <dt>Action</dt>
                  <dd>{plan.operation === 'downgrade' ? 'Install an earlier release' : 'Install a release'}</dd>
                </div>
                <div>
                  <dt>Compatibility</dt>
                  <dd>{plan.compatibility}</dd>
                </div>
                <div>
                  <dt>Snapshot size</dt>
                  <dd>{Number.isFinite(plan.snapshotBytes) ? `${(plan.snapshotBytes / 1024 / 1024).toFixed(1)} MB` : 'Unavailable'}</dd>
                </div>
                <div>
                  <dt>Applications</dt>
                  <dd>{plan.appsMustBeStopped ? 'Must be stopped during installation' : 'Can remain running'}</dd>
                </div>
              </dl>
              {plan.warnings.length ? (
                <div className="release-channel-warnings" role="note">
                  <strong>Warnings</strong>
                  <ul>
                    {plan.warnings.map((warning, index) => (
                      <li key={`${index}-${warning}`}>{warning}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <label className="release-channel-acknowledge">
                <input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} />
                <span>I have reviewed this installation plan.</span>
              </label>
            </DialogSection>
          ) : null}
          {planError ? (
            <DialogFeedback>
              <p>{planError}</p>
              {canForce ? (
                <p>
                  Force can continue without the normal compatibility approval and may leave this server unusable. Only continue if you have reviewed
                  and accepted that risk.
                </p>
              ) : null}
            </DialogFeedback>
          ) : null}
          {error ? <DialogFeedback>{error}</DialogFeedback> : null}
          <DialogFooter className="release-channel-dialog-actions">
            <Button variant="outline" onClick={() => closeDialog(false)} disabled={busy}>
              Cancel
            </Button>
            {canForce && !plan ? (
              <Button intent="danger" onClick={() => void beginStableReview(true)} loading={busy}>
                {busy ? 'Initialising…' : 'Force install'}
              </Button>
            ) : null}
            {plan ? (
              <Button intent={plan.forced ? 'danger' : 'primary'} onClick={() => void applyStable()} disabled={!accepted || busy} loading={busy}>
                {busy ? 'Initialising…' : plan.operation === 'downgrade' ? (plan.forced ? 'Force downgrade' : 'Downgrade') : 'Install'}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
