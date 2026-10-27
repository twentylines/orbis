import { useLayoutEffect, useRef, useState } from 'react';
import { useMutation, useMutationState, useQuery } from '@tanstack/react-query';
import { gte, rcompare } from 'semver';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/Dialog';
import { orbisPublishedReleasesOptions } from '@/desktop/orbis-release';
import { prepareDesktopForCoreUpdate, rememberAcceptedCoreUpdate } from '@/desktop/host-update-watch';
import { useAppContext } from '@/context/app-context';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
import { useReviewExpired } from '@/desktop/use-review-expired';
import { downgradeAllowedOnChannel, type OrbisReleaseChannel } from '@runtipi/common/schemas/orbis-release-channel';
import { formatOrbisVersion } from '@/desktop/orbis-version';

export const compatibilityReviewTime = 15 * 60_000;
export function useCompatibilityResult<T>(operation: 'update' | 'downgrade', userId: number, installed: string) {
  const results = useMutationState({
    filters: { mutationKey: ['orbis-compatibility', operation, userId, installed], exact: true },
    select: (mutation) => {
      const variables = mutation.state.variables;
      return {
        status: mutation.state.status,
        submittedAt: mutation.state.submittedAt,
        data: mutation.state.data as T | undefined,
        error: mutation.state.error,
        tag:
          typeof variables === 'string'
            ? variables
            : variables && typeof variables === 'object' && 'tag' in variables && typeof variables.tag === 'string'
              ? variables.tag
              : '',
        forced: Boolean(variables && typeof variables === 'object' && 'force' in variables && variables.force === true),
      };
    },
  });
  const latest = [...results].sort((a, b) => b.submittedAt - a.submittedAt)[0];
  const expired = useReviewExpired(latest ? latest.submittedAt + compatibilityReviewTime : undefined);
  return expired ? undefined : latest;
}

type Review = {
  planId: string;
  currentTag: string;
  targetTag: string;
  snapshotBytes: number;
  appsMustBeStopped: boolean;
  compatibility: string;
  expiresAt: number;
  forced: boolean;
  warnings: string[];
};
type HostRequest = <T>(path: string, body?: object, signal?: AbortSignal) => Promise<T>;

export function OrbisDowngrade({
  installed,
  enabled,
  active,
  request,
  channel,
}: {
  installed: string;
  enabled: boolean;
  active: boolean;
  request: HostRequest;
  channel?: OrbisReleaseChannel;
}) {
  const { user } = useAppContext();
  const lastPlan = useCompatibilityResult<Review>('downgrade', user.id, installed);
  const [open, setOpen] = useState(Boolean(lastPlan));
  const [tag, setTag] = useState(lastPlan?.tag ?? '');
  const [review, setReview] = useState<Review | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const errorMessage = useRef<HTMLParagraphElement>(null);
  const riskMessage = useRef<HTMLDivElement>(null);
  const reviewIntent = useRef(0);
  const reviewButton = useRef<HTMLButtonElement>(null);
  const reviewExpired = useReviewExpired(review?.expiresAt);
  const lastReviewExpired = useReviewExpired(lastPlan?.data?.expiresAt);
  const closeReview = () => {
    reviewIntent.current += 1;
    setReview(null);
  };
  useLayoutEffect(() => {
    if (!active) setReview(null);
    return () => {
      reviewIntent.current += 1;
    };
  }, [active]);
  const releases = useQuery({ ...orbisPublishedReleasesOptions(channel), enabled: open && enabled && active && Boolean(channel) });
  const choices = (releases.data?.releases ?? [])
    .filter(
      (release) =>
        release.imageManifestUrl && channel && downgradeAllowedOnChannel(release.tag, installed, channel) && gte(release.tag, 'v0.1.0-beta.90'),
    )
    .sort((a, b) => rcompare(a.tag, b.tag));
  const selected = choices.some((release) => release.tag === tag) ? tag : (choices[0]?.tag ?? '');
  const plan = useMutation({
    meta: { invalidates: false },
    mutationKey: ['orbis-compatibility', 'downgrade', user.id, installed],
    gcTime: compatibilityReviewTime,
    onMutate: () => ({ intent: ++reviewIntent.current }),
    mutationFn: async ({ tag: target, force = false }: { tag: string; force?: boolean }) => {
      const result = await request<Review>('downgrade/plan', { tag: target, ...(force ? { force: true } : {}) });
      if (
        result.targetTag !== target ||
        result.forced !== force ||
        !Array.isArray(result.warnings) ||
        !result.warnings.every((warning) => typeof warning === 'string')
      )
        throw new Error('The downgrade review could not be verified. Check compatibility again.');
      return result;
    },
    onSuccess: (value, _variables, context) => {
      setConfirmation('');
      if (context?.intent === reviewIntent.current) setReview(value);
    },
    retry: false,
  });
  const apply = useMutation({
    mutationFn: async (value: Review) => {
      await prepareDesktopForCoreUpdate();
      return request<{ jobId: string; state: string }>('downgrade/apply', { planId: value.planId, ...(value.forced ? { force: true } : {}) });
    },
    onSuccess: (result, value) => {
      setReview(null);
      rememberAcceptedCoreUpdate(result.jobId, value.targetTag, 'downgrade');
    },
    retry: false,
  });
  const needsReview = reviewExpired || apply.isError || plan.isError;
  useLayoutEffect(() => {
    if (review && apply.isError) errorMessage.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }, [review, apply.isError]);
  const planning = lastPlan?.status === 'pending';
  const planError = lastPlan?.tag === selected && lastPlan.status === 'error' ? lastPlan.error : null;
  const canForce = planError && !lastPlan?.forced && 'canForce' in planError && planError.canForce === true;
  return (
    <details className="desktop-downgrade" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Downgrade to a previous version</summary>
      {open ? (
        <div className="desktop-downgrade-content">
          <p>Review an earlier release against this server’s data and settings. Runtipi must stay on the same version.</p>
          <p>Releases from beta 90 onward are available. A downgrade removes newer features and security fixes.</p>
          {enabled ? null : <p>The local Orbis host must be healthy and idle before reviewing a downgrade.</p>}
          {enabled && releases.isPending ? <p>Reading previous releases…</p> : null}
          {releases.isError ? <p role="alert">Previous releases could not be loaded. Close and reopen this section to try again.</p> : null}
          {enabled && releases.data && !choices.length ? <p>No earlier supported releases are available.</p> : null}
          {enabled && choices.length ? (
            <div className="desktop-downgrade-controls">
              <div className="desktop-downgrade-field">
                <Select
                  value={selected}
                  onValueChange={(value) => {
                    setTag(value);
                    plan.reset();
                    apply.reset();
                  }}
                  disabled={planning || apply.isPending}
                >
                  <SelectTrigger id="orbis-downgrade-version" label="Version" value={selected}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {choices.map((release) => (
                      <SelectItem key={release.tag} value={release.tag}>
                        {formatOrbisVersion(release.tag)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <button
                ref={reviewButton}
                type="button"
                className="desktop-update-action"
                disabled={!selected || planning || apply.isPending}
                onClick={() => {
                  apply.reset();
                  plan.mutate({ tag: selected });
                }}
              >
                {planning ? 'Checking compatibility…' : 'Review downgrade'}
              </button>
            </div>
          ) : null}
          {releases.data && !releases.data.complete ? <p>Only the available release history is shown.</p> : null}
          {planError ? <p role="alert">{planError.message}</p> : null}
          {!review && lastPlan?.status === 'success' && lastPlan.tag === selected && lastPlan.data ? (
            <button
              type="button"
              className="desktop-update-action secondary"
              disabled={!enabled || planning || apply.isPending || lastReviewExpired}
              onClick={() => {
                setConfirmation('');
                setReview(lastPlan.data ?? null);
              }}
            >
              Open last downgrade review
            </button>
          ) : null}
          {canForce ? (
            <div className="desktop-update-risk">
              <strong>Compatibility check failed</strong>
              <p>You can review a forced downgrade. It can make data unreadable, prevent sign-in, or reset saved settings.</p>
              <button
                type="button"
                className="desktop-update-action is-danger"
                disabled={!enabled || planning || apply.isPending}
                onClick={() => {
                  apply.reset();
                  plan.mutate({ tag: selected, force: true });
                }}
              >
                Review force downgrade
              </button>
            </div>
          ) : null}
          {apply.isError && !review ? <p role="alert">{apply.error.message}</p> : null}
          <Dialog
            open={review !== null}
            onOpenChange={(value) => {
              if (!value && !apply.isPending) closeReview();
            }}
          >
            <DialogContent
              className="desktop-downgrade-dialog"
              restoreFocusTo={reviewButton}
              closeDisabled={apply.isPending}
              onOpenAutoFocus={(event) => {
                if (review?.forced) {
                  event.preventDefault();
                  riskMessage.current?.focus({ preventScroll: true });
                }
              }}
            >
              <DialogHeader>
                <DialogTitle>{review?.forced ? 'Force downgrade Orbis?' : 'Downgrade Orbis?'}</DialogTitle>
                <DialogDescription>
                  {review?.currentTag} → {review?.targetTag}
                </DialogDescription>
              </DialogHeader>
              <div className="modal-body">
                {review?.forced ? (
                  <div className="desktop-update-risk" role="note" aria-label="Force downgrade risks" ref={riskMessage} tabIndex={-1}>
                    <strong>Compatibility checks will be bypassed</strong>
                    <ul>
                      {review.warnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                    <p>
                      A passing health check cannot prove that your data, sign-in, or settings still work. You may need to restore the backup
                      manually.
                    </p>
                  </div>
                ) : (
                  <p>{review?.compatibility}</p>
                )}
                <ol className="desktop-update-process">
                  <li>
                    <strong>Back up</strong>
                    <span>Create and verify a recovery snapshot before switching releases.</span>
                  </li>
                  <li>
                    <strong>Switch release</strong>
                    <span>Install {review?.targetTag} and check server health. Restore the current release if startup fails.</span>
                  </li>
                  <li>
                    <strong>Reconnect</strong>
                    <span>Orbis reconnects when ready. Automatic Orbis updates stay paused until you enable them again.</span>
                  </li>
                </ol>
                {review?.appsMustBeStopped ? (
                  <p role="alert">This release requires applications to be stopped. Finish them before continuing.</p>
                ) : null}
                {review?.forced ? (
                  <label className="desktop-downgrade-confirm">
                    <span>
                      Type <strong>{review.targetTag}</strong> to confirm the risks
                    </span>
                    <input
                      type="text"
                      className="form-control"
                      value={confirmation}
                      onChange={(event) => setConfirmation(event.target.value)}
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      disabled={apply.isPending}
                      onFocus={(event) => {
                        const input = event.currentTarget;
                        requestAnimationFrame(() => {
                          if (document.activeElement === input) input.scrollIntoView({ block: 'nearest', behavior: 'instant' });
                        });
                      }}
                    />
                  </label>
                ) : null}
                {apply.isError ? (
                  <p ref={errorMessage} role="alert">
                    {apply.error.message}
                  </p>
                ) : null}
                {plan.isError ? <p role="alert">{plan.error.message}</p> : null}
                {reviewExpired && !apply.isPending ? <output>This review expired. Check compatibility again before downgrading.</output> : null}
              </div>
              <DialogFooter className="desktop-update-plan-actions">
                <button type="button" className="desktop-update-action secondary" disabled={apply.isPending} onClick={closeReview}>
                  Cancel
                </button>
                <button
                  type="button"
                  className={`desktop-update-action${review?.forced && !needsReview && !planning ? ' is-danger' : ''}`}
                  disabled={
                    !review ||
                    !enabled ||
                    planning ||
                    apply.isPending ||
                    (!needsReview && (review.appsMustBeStopped || (review.forced && confirmation !== review.targetTag)))
                  }
                  onClick={() => {
                    if (!review) return;
                    if (needsReview || review.expiresAt <= Date.now()) {
                      apply.reset();
                      plan.mutate({ tag: review.targetTag, force: review.forced });
                    } else apply.mutate(review);
                  }}
                >
                  {apply.isPending
                    ? 'Starting downgrade…'
                    : planning
                      ? 'Checking compatibility…'
                      : needsReview
                        ? 'Review again'
                        : review?.forced
                          ? 'Force downgrade'
                          : 'Downgrade Orbis'}
                </button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      ) : null}
    </details>
  );
}
