import { useLayoutEffect, useRef, useState } from 'react';
import { useMutation, useMutationState, useQuery } from '@tanstack/react-query';
import { gte, lt, rcompare, valid } from 'semver';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/Dialog';
import { orbisPublishedReleasesOptions } from '@/desktop/orbis-release';
import { prepareDesktopForCoreUpdate, rememberAcceptedCoreUpdate } from '@/desktop/host-update-watch';
import { useAppContext } from '@/context/app-context';

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
  return results.filter((result) => result.submittedAt > Date.now() - compatibilityReviewTime).sort((a, b) => b.submittedAt - a.submittedAt)[0];
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

export function OrbisDowngrade({ installed, enabled, request }: { installed: string; enabled: boolean; request: HostRequest }) {
  const { user } = useAppContext();
  const lastPlan = useCompatibilityResult<Review>('downgrade', user.id, installed);
  const [open, setOpen] = useState(Boolean(lastPlan));
  const [tag, setTag] = useState(lastPlan?.tag ?? '');
  const [review, setReview] = useState<Review | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const errorMessage = useRef<HTMLParagraphElement>(null);
  const riskMessage = useRef<HTMLDivElement>(null);
  const releases = useQuery({ ...orbisPublishedReleasesOptions(), enabled: open && enabled });
  const choices = (releases.data?.releases ?? [])
    .filter(
      (release) =>
        release.imageManifestUrl && valid(release.tag) && valid(installed) && lt(release.tag, installed) && gte(release.tag, 'v0.1.0-beta.90'),
    )
    .sort((a, b) => rcompare(a.tag, b.tag));
  const selected = choices.some((release) => release.tag === tag) ? tag : (choices[0]?.tag ?? '');
  const plan = useMutation({
    mutationKey: ['orbis-compatibility', 'downgrade', user.id, installed],
    gcTime: compatibilityReviewTime,
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
    onSuccess: (value) => {
      setConfirmation('');
      setReview(value);
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
                <label htmlFor="orbis-downgrade-version">Version</label>
                <select
                  className="form-select"
                  id="orbis-downgrade-version"
                  value={selected}
                  onChange={(event) => {
                    setTag(event.target.value);
                    plan.reset();
                    apply.reset();
                  }}
                  disabled={planning || apply.isPending}
                >
                  {choices.map((release) => (
                    <option key={release.tag} value={release.tag}>
                      {release.tag}
                    </option>
                  ))}
                </select>
              </div>
              <button
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
              disabled={!enabled || planning || apply.isPending || lastPlan.data.expiresAt <= Date.now()}
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
              if (!value && !apply.isPending) setReview(null);
            }}
          >
            <DialogContent
              className="desktop-downgrade-dialog"
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
              </div>
              <DialogFooter className="desktop-update-plan-actions">
                <button type="button" className="desktop-update-action secondary" disabled={apply.isPending} onClick={() => setReview(null)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className={`desktop-update-action${review?.forced ? ' is-danger' : ''}`}
                  disabled={
                    !review ||
                    !enabled ||
                    apply.isPending ||
                    review.expiresAt <= Date.now() ||
                    review.appsMustBeStopped ||
                    (review.forced && confirmation !== review.targetTag)
                  }
                  onClick={() => {
                    if (review) apply.mutate(review);
                  }}
                >
                  {apply.isPending ? 'Starting downgrade…' : review?.forced ? 'Force downgrade' : 'Downgrade Orbis'}
                </button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      ) : null}
    </details>
  );
}
