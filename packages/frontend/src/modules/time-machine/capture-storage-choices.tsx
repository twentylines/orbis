import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { TimeMachineCaptureReview, TimeMachineCaptureSelection } from '@runtipi/common/schemas/time-machine';
import { getInstalledAppsOptions } from '@/api-client/@tanstack/react-query.gen';
import { Checkbox } from '@/components/ui/Checkbox/Checkbox';
import { Button } from '@/components/ui/Button';
import { InlineFeedback } from '@/components/ui/Alert/Alert';
import { reviewTimeMachineCapture } from './time-machine-api';
import './capture-storage-choices.css';

export type CaptureChoices = { ready: boolean; selection?: TimeMachineCaptureSelection };
type Installed = { urn: string; name: string };
export function captureChoices(
  review: TimeMachineCaptureReview | undefined,
  apps: readonly string[],
  mounts: ReadonlySet<string>,
  reading: boolean,
): CaptureChoices {
  if (apps.length === 0) return { ready: true };
  if (!review || reading || review.apps.length !== apps.length || review.apps.some((app) => !apps.includes(app.urn))) return { ready: false };
  const selected = review.apps.map((app) => ({
    urn: app.urn,
    mountIds: app.mounts.filter((mount) => mounts.has(mount.id)).map((mount) => mount.id),
  }));
  if (selected.some((app) => app.mountIds.length === 0)) return { ready: false };
  return { ready: true, selection: { version: 1, reviewId: review.reviewId, reviewSha256: review.reviewSha256, apps: selected } };
}

export function CaptureStorageChoicesView({
  installed,
  selected,
  review,
  mounts,
  reading,
  error,
  disabled,
  onApp,
  onMount,
  onRetry,
  emptyText = 'No Docker apps are available to include.',
}: {
  installed: readonly Installed[];
  selected: readonly string[];
  review?: TimeMachineCaptureReview;
  mounts: ReadonlySet<string>;
  reading: boolean;
  error?: string;
  disabled: boolean;
  onApp: (urn: string, checked: boolean) => void;
  onMount: (id: string, checked: boolean) => void;
  onRetry: () => void;
  emptyText?: string;
}) {
  return (
    <section className="tm-capture-choices" aria-label="Capture contents">
      <div>
        <h3>Orbis snapshot</h3>
        <p>Includes the Orbis database, settings, appearance and captured Orbis version.</p>
      </div>
      <fieldset disabled={disabled}>
        <legend>Docker apps and data</legend>
        <p>Optional. Choose an app, then choose each storage mount to include. Omitted apps keep running.</p>
        {installed.length ? (
          installed.map((app) => (
            <div className="tm-capture-app" key={app.urn}>
              <Checkbox label={app.name} checked={selected.includes(app.urn)} onCheckedChange={(checked) => onApp(app.urn, checked)} />
              {selected.includes(app.urn) ? (
                <div className="tm-capture-app-storage">
                  {reading ? <output>Reading this app’s storage…</output> : null}
                  {!reading &&
                    review?.apps
                      .find((item) => item.urn === app.urn)
                      ?.mounts.map((mount) => (
                        <div className="tm-capture-mount" key={mount.id}>
                          <Checkbox
                            label={
                              <span>
                                <span className="tm-capture-mount-name">
                                  {mount.service}: {mount.destination}
                                </span>
                                <span className="tm-capture-mount-kind">
                                  {mount.classification === 'app-data'
                                    ? 'App data'
                                    : mount.classification === 'media'
                                      ? 'Media files'
                                      : 'External storage'}
                                </span>
                              </span>
                            }
                            checked={mounts.has(mount.id)}
                            onCheckedChange={(checked) => onMount(mount.id, checked)}
                          />
                          <p className="tm-capture-path">{mount.source}</p>
                        </div>
                      ))}
                  {!reading && review?.apps.find((item) => item.urn === app.urn)?.mounts.length === 0 ? (
                    <p>This app has no supported storage mounts.</p>
                  ) : null}
                </div>
              ) : null}
            </div>
          ))
        ) : (
          <output>{emptyText}</output>
        )}
        {selected.length > 0 ? (
          <p>Only checked storage is copied. Media and external drives stay excluded until you check their own storage row.</p>
        ) : (
          <p>This capture includes Orbis only.</p>
        )}
      </fieldset>
      {error ? (
        <InlineFeedback>
          <p>{error}</p>
          <Button type="button" variant="outline" onClick={onRetry} disabled={disabled}>
            Read storage again
          </Button>
        </InlineFeedback>
      ) : null}
      {selected.length > 0 ? <p>Selected app data can be captured and exported. Restoring these combined captures is not available yet.</p> : null}
      {review && selected.length > 0 && !reading ? (
        <section className="tm-capture-review" aria-label="Included content review">
          <h3>Included in this capture</h3>
          <ul>
            <li>Orbis snapshot</li>
            {review.apps.flatMap((app) =>
              app.mounts
                .filter((mount) => mounts.has(mount.id))
                .map((mount) => (
                  <li key={mount.id}>
                    {installed.find((item) => item.urn === app.urn)?.name ?? app.urn}: {mount.service} {mount.destination}
                    {mount.classification === 'media' ? ' (media)' : mount.classification === 'external' ? ' (external storage)' : ''}
                  </li>
                )),
            )}
          </ul>
          {review.apps.some((app) => !app.mounts.some((mount) => mounts.has(mount.id))) ? (
            <output>Choose at least one storage mount for every selected app.</output>
          ) : null}
        </section>
      ) : null}
    </section>
  );
}

export function CaptureStorageChoices({
  ownerId,
  disabled,
  onChange,
}: {
  ownerId: number;
  disabled: boolean;
  onChange: (value: CaptureChoices) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [mounts, setMounts] = useState<Set<string>>(new Set());
  const installed = useQuery({ ...getInstalledAppsOptions(), staleTime: 0, retry: false });
  const apps = useMemo(
    () =>
      installed.data?.installed
        .filter((entry) => !['missing', 'installing', 'uninstalling'].includes(entry.app.status))
        .map((entry) => ({ urn: entry.info.urn, name: entry.info.name })) ?? [],
    [installed.data],
  );
  const review = useQuery({
    queryKey: ['time-machine-capture-storage-review', ownerId, selected],
    queryFn: ({ signal }) => reviewTimeMachineCapture(selected, signal),
    enabled: selected.length > 0,
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: false,
    refetchOnMount: 'always',
  });
  useEffect(() => {
    onChange(captureChoices(review.data, selected, mounts, review.isFetching || review.isError));
  }, [review.data, selected, mounts, review.isFetching, review.isError, onChange]);
  const onApp = (urn: string, checked: boolean) => {
    setMounts(new Set());
    setSelected((current) => (checked ? [...current, urn] : current.filter((item) => item !== urn)).sort());
    onChange({ ready: !checked && selected.length === 1 });
  };
  return (
    <CaptureStorageChoicesView
      installed={apps}
      selected={selected}
      review={review.data}
      mounts={mounts}
      emptyText={
        installed.isPending
          ? 'Reading installed apps…'
          : installed.isError
            ? 'App choices are unavailable.'
            : 'No Docker apps are available to include.'
      }
      reading={review.isFetching}
      disabled={disabled || installed.isPending}
      error={
        installed.isError
          ? 'The installed app list could not be read. Orbis-only capture remains available.'
          : review.isError
            ? review.error instanceof Error
              ? review.error.message
              : 'App storage could not be read.'
            : undefined
      }
      onApp={onApp}
      onMount={(id, checked) =>
        setMounts((current) => {
          const next = new Set(current);
          if (checked) next.add(id);
          else next.delete(id);
          return next;
        })
      }
      onRetry={() => {
        setMounts(new Set());
        void installed.refetch();
        if (selected.length) void review.refetch();
      }}
    />
  );
}
