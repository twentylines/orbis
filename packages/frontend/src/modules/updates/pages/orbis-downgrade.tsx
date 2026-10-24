import { useLayoutEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { gte, lt, rcompare, valid } from 'semver';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/Dialog';
import { orbisPublishedReleasesOptions } from '@/desktop/orbis-release';
import { prepareDesktopForCoreUpdate, rememberAcceptedCoreUpdate } from '@/desktop/host-update-watch';

type Review = {
  planId: string;
  currentTag: string;
  targetTag: string;
  snapshotBytes: number;
  appsMustBeStopped: boolean;
  compatibility: string;
  expiresAt: number;
};
type HostRequest = <T>(path: string, body?: object, signal?: AbortSignal) => Promise<T>;

export function OrbisDowngrade({ installed, enabled, request }: { installed: string; enabled: boolean; request: HostRequest }) {
  const [open, setOpen] = useState(false);
  const [tag, setTag] = useState('');
  const [review, setReview] = useState<Review | null>(null);
  const errorMessage = useRef<HTMLParagraphElement>(null);
  const releases = useQuery({ ...orbisPublishedReleasesOptions(), enabled: open && enabled });
  const choices = (releases.data?.releases ?? [])
    .filter(
      (release) =>
        release.imageManifestUrl && valid(release.tag) && valid(installed) && lt(release.tag, installed) && gte(release.tag, 'v0.1.0-beta.90'),
    )
    .sort((a, b) => rcompare(a.tag, b.tag));
  const selected = choices.some((release) => release.tag === tag) ? tag : (choices[0]?.tag ?? '');
  const plan = useMutation({
    mutationFn: (target: string) => request<Review>('downgrade/plan', { tag: target }),
    onSuccess: (value) => setReview(value),
    retry: false,
  });
  const apply = useMutation({
    mutationFn: async (value: Review) => {
      await prepareDesktopForCoreUpdate();
      return request<{ jobId: string; state: string }>('downgrade/apply', { planId: value.planId });
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
  return (
    <details className="desktop-downgrade" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Previous Orbis versions</summary>
      {open ? (
        <div className="desktop-downgrade-content">
          <p>Downgrade Orbis while keeping your apps and current data. The Runtipi version, database schema and saved settings must be compatible.</p>
          <p>Supported from beta 90 onward. Earlier releases may restore bugs or security weaknesses fixed in newer versions.</p>
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
                  disabled={plan.isPending || apply.isPending}
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
                disabled={!selected || plan.isPending || apply.isPending}
                onClick={() => {
                  apply.reset();
                  plan.mutate(selected);
                }}
              >
                {plan.isPending ? 'Checking compatibility…' : 'Review downgrade'}
              </button>
            </div>
          ) : null}
          {releases.data && !releases.data.complete ? <p>Only the available release history is shown.</p> : null}
          {plan.isError ? <p role="alert">{plan.error.message}</p> : null}
          {apply.isError && !review ? <p role="alert">{apply.error.message}</p> : null}
          <Dialog
            open={review !== null}
            onOpenChange={(value) => {
              if (!value && !apply.isPending) setReview(null);
            }}
          >
            <DialogContent className="desktop-downgrade-dialog">
              <DialogHeader>
                <DialogTitle>Downgrade Orbis?</DialogTitle>
                <DialogDescription>
                  {review?.currentTag} → {review?.targetTag}
                </DialogDescription>
              </DialogHeader>
              <div className="modal-body">
                <p>{review?.compatibility}</p>
                <p>
                  A verified backup is created before switching. If the earlier release fails its health check, Orbis restores the current release
                  automatically.
                </p>
                <p>Newer features and security fixes will be unavailable until you update again. Automatic Orbis updates will be paused.</p>
                {review?.appsMustBeStopped ? (
                  <p role="alert">This release requires applications to be stopped. Finish them before continuing.</p>
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
                  className="desktop-update-action"
                  disabled={!review || !enabled || apply.isPending || review.expiresAt <= Date.now() || review.appsMustBeStopped}
                  onClick={() => {
                    if (review) apply.mutate(review);
                  }}
                >
                  {apply.isPending ? 'Starting downgrade…' : 'Downgrade Orbis'}
                </button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      ) : null}
    </details>
  );
}
