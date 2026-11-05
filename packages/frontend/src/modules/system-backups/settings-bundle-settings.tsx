import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  defaultSettingsBackupSelection,
  settingsBackupSelectionSchema,
  type SettingsBackupJob,
  type SettingsBackupSelection,
} from '@runtipi/common/schemas/settings-backup';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox/Checkbox';
import { Input } from '@/components/ui/Input';
import { useAppContext } from '@/context/app-context';
import { useWindowVisible } from '@/desktop/window-visibility';
import { preferenceStorageKey } from '@/desktop/appearance-cache';
import { themePackCacheKey } from '@/modules/theme-packs/theme-pack-cache';
import type { SettingsBackupRestoreJob } from '@runtipi/common/schemas/settings-backup-import';
import { readTimeMachinePoints } from '@/modules/time-machine/time-machine-api';
import { downloadBackup } from './backup-api';
import {
  createSettingsBundle,
  createSettingsImport,
  readSettingsExports,
  readSettingsImports,
  readSettingsRestore,
  restoreSettingsImport,
  reviewSettingsImport,
  rollbackSettingsRestore,
  settingsBundleRequest,
  uploadSettingsImport,
} from './settings-bundle-api';
import './system-backups-settings.css';
import './settings-bundle-settings.css';

const labels = { settings: 'Settings', dashboard: 'Dashboard', wallpapers: 'Wallpapers', themes: 'Themes' } as const;
export function settingsRestoreCanReload(job: SettingsBackupRestoreJob | null | undefined, observed: string | null, completed: string | null) {
  return Boolean(job && job.status === 'succeeded' && !job.needsRecovery && observed === job.id && completed !== job.id);
}
export function pendingAcceptedExport(accepted: SettingsBackupJob | null, jobs: SettingsBackupJob[]) {
  return accepted && !jobs.some((job) => job.id === accepted.id) ? accepted : null;
}
type Action =
  | { kind: 'create' | 'upload' }
  | { kind: 'download' | 'remove' | 'review' | 'restore' | 'rollback' | 'resume-upload' | 'remove-import'; id: string };
const bytes = (value: number) =>
  value < 1024
    ? `${value} B`
    : value < 1024 ** 2
      ? `${(value / 1024).toFixed(1)} KB`
      : value < 1024 ** 3
        ? `${(value / 1024 ** 2).toFixed(1)} MB`
        : `${(value / 1024 ** 3).toFixed(1)} GB`;
function Progress({ done, total }: { done: number; total: number | null }) {
  return (
    <div className="settings-bundle-progress">
      <span>
        {bytes(done)}
        {total !== null ? ` of ${bytes(total)}` : ' processed'}
      </span>
      {total !== null && total > 0 ? <progress value={done} max={total} aria-label="Bytes processed" /> : null}
    </div>
  );
}
function Choices({
  selection,
  available,
  onChange,
}: {
  selection: SettingsBackupSelection;
  available?: SettingsBackupSelection;
  onChange: (next: SettingsBackupSelection) => void;
}) {
  return (
    <div className="settings-bundle-choices">
      {(Object.keys(labels) as (keyof typeof labels)[])
        .filter((key) => !available || available[key])
        .map((key) => (
          <Checkbox
            key={key}
            label={labels[key]}
            checked={selection[key]}
            onCheckedChange={(checked) => onChange({ ...selection, [key]: checked })}
          />
        ))}
    </div>
  );
}
export function SettingsBundleSettings() {
  const { user } = useAppContext();
  return <SettingsBundleWorkspace key={user?.id} />;
}
function SettingsBundleWorkspace() {
  const { user } = useAppContext();
  const visible = useWindowVisible();
  const key = ['orbis-settings-bundles', user?.id];
  const [selection, setSelection] = useState(defaultSettingsBackupSelection);
  const [restoreSelection, setRestoreSelection] = useState<SettingsBackupSelection | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null);
  const [accepted, setAccepted] = useState<SettingsBackupJob | null>(null);
  const [acceptedRestore, setAcceptedRestore] = useState<SettingsBackupRestoreJob | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const requestAbort = useRef<AbortController | null>(null);
  const sectionHeading = useRef<HTMLHeadingElement | null>(null);
  const formHeading = useRef<HTMLHeadingElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const completedRestore = useRef<string | null>(null);
  const observedRestore = useRef<string | null>(null);
  const frameCleanup = useRef<(() => void) | null>(null);
  const exportsQuery = useQuery({
    queryKey: [...key, 'exports'],
    queryFn: ({ signal }) => readSettingsExports(signal),
    enabled: visible && user?.operator === true,
    retry: false,
    refetchInterval: (query) =>
      visible &&
      (accepted?.status === 'queued' ||
        accepted?.status === 'running' ||
        query.state.data?.jobs.some((job) => job.status === 'queued' || job.status === 'running'))
        ? 1500
        : false,
  });
  const importsQuery = useQuery({
    queryKey: [...key, 'imports'],
    queryFn: ({ signal }) => readSettingsImports(signal),
    enabled: visible && user?.operator === true,
    retry: false,
    refetchInterval: (query) =>
      visible && query.state.data?.jobs.some((job) => job.status === 'uploading' || job.status === 'reviewing') ? 1500 : false,
  });
  const restoreQuery = useQuery({
    queryKey: [...key, 'restore'],
    queryFn: ({ signal }) => readSettingsRestore(signal),
    enabled: visible && user?.operator === true,
    retry: false,
    refetchInterval: (query) => (visible && (acceptedRestore?.status === 'running' || query.state.data?.job?.status === 'running') ? 1500 : false),
  });
  const exportsFresh = !!exportsQuery.data && !exportsQuery.isError;
  const importsFresh = !!importsQuery.data && !importsQuery.isError;
  const restoreFresh = !!restoreQuery.data && !restoreQuery.isError;
  const points = useQuery({
    queryKey: ['time-machine-points', user?.id],
    queryFn: ({ signal }) => readTimeMachinePoints(signal),
    enabled: visible && user?.operator === true,
    retry: false,
  });
  const expiry =
    importsQuery.data?.jobs.reduce<number | null>(
      (earliest, job) =>
        job.review && job.review.expiresAt > now && (earliest === null || job.review.expiresAt < earliest) ? job.review.expiresAt : earliest,
      null,
    ) ?? null;
  useEffect(() => {
    if (!visible || expiry === null) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, expiry - Date.now()) + 1);
    return () => window.clearTimeout(timer);
  }, [visible, expiry]);
  useEffect(() => {
    if (visible) setNow(Date.now());
  }, [visible]);
  useEffect(() => {
    if (action) formHeading.current?.focus();
  }, [action]);
  useEffect(
    () => () => {
      requestAbort.current?.abort();
      frameCleanup.current?.();
    },
    [],
  );
  const authoritativeRestore = restoreQuery.data?.job;
  const restore = acceptedRestore && authoritativeRestore?.id !== acceptedRestore.id ? acceptedRestore : authoritativeRestore;
  const restoreHeld = !restoreFresh || restore?.status === 'running' || restore?.needsRecovery === true;
  useEffect(() => {
    if (restore?.status === 'running' || restore?.needsRecovery) observedRestore.current = restore.id;
    if (!restoreFresh || !restore || !settingsRestoreCanReload(restore, observedRestore.current, completedRestore.current)) return;
    completedRestore.current = restore.id;
    for (const name of [preferenceStorageKey, themePackCacheKey]) {
      try {
        localStorage.removeItem(name);
      } catch {
        /* Server state remains authoritative. */
      }
    }
    window.location.replace('/dashboard');
  }, [restore, restoreFresh]);
  const jobs = exportsQuery.data?.jobs ?? [];
  useEffect(() => {
    if (accepted && !pendingAcceptedExport(accepted, jobs)) setAccepted(null);
  }, [accepted, jobs]);
  useEffect(() => {
    if (
      acceptedRestore &&
      authoritativeRestore?.id === acceptedRestore.id &&
      (authoritativeRestore.status !== 'running' || authoritativeRestore.needsRecovery)
    )
      setAcceptedRestore(null);
  }, [acceptedRestore, authoritativeRestore]);
  const shownJobs = accepted && !jobs.some((job) => job.id === accepted.id) ? [accepted, ...jobs] : jobs;
  const imports = importsQuery.data?.jobs ?? [];
  const reviewed = action?.kind === 'restore' ? imports.find((job) => job.id === action.id)?.review : undefined;
  const open = (next: Action) => {
    if (busyRef.current) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setError('');
    setAction(next);
    if (next.kind === 'restore') {
      const review = imports.find((job) => job.id === next.id)?.review;
      setRestoreSelection(review ? { ...review.available, timeMachine: [...review.available.timeMachine] } : null);
    }
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!action || busyRef.current || user?.operator !== true) return;
    const canAct =
      action.kind === 'create' || action.kind === 'download' || action.kind === 'remove'
        ? exportsFresh
        : action.kind === 'restore'
          ? importsFresh && restoreFresh && !acceptedRestore && restore?.status !== 'running' && !restore?.needsRecovery
          : action.kind === 'rollback'
            ? restoreFresh
            : importsFresh;
    if (!canAct) {
      setError('Refresh status before continuing.');
      return;
    }
    const form = event.currentTarget;
    const data = new FormData(form);
    const password = String(data.get('password') ?? '');
    const totpCode = String(data.get('totpCode') ?? '').trim();
    const passphrase = String(data.get('passphrase') ?? '');
    const credentials = { password, ...(totpCode ? { totpCode } : {}) };
    const file = data.get('file');
    if (action.kind === 'create' && passphrase !== String(data.get('confirmPassphrase') ?? '')) {
      setError('Backup keys do not match.');
      return;
    }
    if (['create', 'review', 'restore'].includes(action.kind) && (!passphrase.trim() || passphrase.length < 8 || passphrase.length > 1024)) {
      setError('Use a backup key between 8 and 1024 characters.');
      return;
    }
    if ((action.kind === 'upload' || action.kind === 'resume-upload') && (!(file instanceof File) || !file.size)) {
      setError('Choose a backup file.');
      return;
    }
    form.reset();
    busyRef.current = true;
    setBusy(true);
    setError('');
    const controller = new AbortController();
    requestAbort.current = controller;
    try {
      if (action.kind === 'create') {
        if (!settingsBackupSelectionSchema.allows(selection)) throw new Error('Choose at least one item.');
        setAccepted(await createSettingsBundle(credentials, passphrase, selection, controller.signal));
      }
      if (action.kind === 'download') {
        frameCleanup.current?.();
        frameCleanup.current = downloadBackup(action.id, credentials, setError, 'settings');
      }
      if (action.kind === 'remove') await settingsBundleRequest(`/${action.id}/remove`, 'POST', credentials, controller.signal);
      if (action.kind === 'remove-import') await settingsBundleRequest(`/imports/${action.id}/remove`, 'POST', credentials, controller.signal);
      if (action.kind === 'upload' || action.kind === 'resume-upload') {
        if (!(file instanceof File) || !file.size) throw new Error('Choose a backup file.');
        const id = 'id' in action ? action.id : (await createSettingsImport(credentials, controller.signal)).id;
        await uploadSettingsImport(id, file, (done, total) => setUploadProgress({ done, total }), controller.signal);
      }
      if (action.kind === 'review') await reviewSettingsImport(action.id, credentials, passphrase, controller.signal);
      if (action.kind === 'restore') {
        if (!reviewed || reviewed.expiresAt <= Date.now() || !restoreSelection || !settingsBackupSelectionSchema.allows(restoreSelection))
          throw new Error('Review the backup again and choose at least one item.');
        const accepted = await restoreSettingsImport(
          action.id,
          credentials,
          passphrase,
          { version: 1, reviewId: reviewed.reviewId, archiveSha256: reviewed.archiveSha256, contents: restoreSelection },
          controller.signal,
        );
        observedRestore.current = accepted.id;
        setAcceptedRestore(accepted);
      }
      if (action.kind === 'rollback') setAcceptedRestore(await rollbackSettingsRestore(action.id, credentials, controller.signal));
      setAction(null);
      setUploadProgress(null);
      requestAnimationFrame(() => (opener.current?.isConnected ? opener.current : sectionHeading.current)?.focus());
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The request did not finish. Refresh status before retrying.');
    } finally {
      requestAbort.current = null;
      busyRef.current = false;
      setBusy(false);
      void exportsQuery.refetch();
      void importsQuery.refetch();
      void restoreQuery.refetch();
    }
  };
  const sealed = points.data?.points.filter((point) => point.status === 'sealed' && point.metadata?.version === 2) ?? [];
  const passphraseNeeded = action?.kind === 'create' || action?.kind === 'review' || action?.kind === 'restore';
  return (
    <section className="system-backups-settings settings-bundle-settings">
      <div className="system-backups-overview">
        <h2 ref={sectionHeading} tabIndex={-1}>
          Backup &amp; Restore
        </h2>
        <p>
          Choose your settings and saved Time Machine captures. This backup doesn’t take a new copy of your apps or media. Imported captures appear in
          Time Machine; you choose separately when to restore their contents.
        </p>
        <Choices selection={selection} onChange={setSelection} />
        {sealed.length ? (
          <fieldset>
            <legend>Saved Time Machine captures</legend>
            {sealed.map((point) => (
              <Checkbox
                key={point.id}
                label={new Date(point.createdAt).toLocaleString()}
                checked={selection.timeMachine.includes(point.id)}
                onCheckedChange={(checked) =>
                  setSelection((current) => ({
                    ...current,
                    timeMachine: checked ? [...current.timeMachine, point.id] : current.timeMachine.filter((id) => id !== point.id),
                  }))
                }
              />
            ))}
          </fieldset>
        ) : (
          <p>{points.isError ? 'Saved captures could not be loaded.' : 'No saved captures selected.'}</p>
        )}
        <div className="system-backups-actions">
          <Button
            type="button"
            intent="primary"
            disabled={busy || restoreHeld || user?.operator !== true || !exportsFresh || !settingsBackupSelectionSchema.allows(selection)}
            onClick={() => open({ kind: 'create' })}
          >
            Create backup
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy || restoreHeld || !importsFresh || !importsQuery.data?.available}
            onClick={() => open({ kind: 'upload' })}
          >
            Open backup
          </Button>
        </div>
      </div>
      {(
        [
          ['Export', exportsQuery],
          ['Import', importsQuery],
          ['Restore', restoreQuery],
        ] as const
      ).map(([label, query]) =>
        query.isPending || query.isError ? (
          <div key={label}>
            {query.isPending ? <output>Loading {label.toLowerCase()} status…</output> : null}
            {query.isError ? (
              <p role="alert">
                {label} status could not be loaded.{' '}
                <Button type="button" variant="outline" onClick={() => void query.refetch()}>
                  Refresh
                </Button>
              </p>
            ) : null}
          </div>
        ) : null,
      )}
      {shownJobs.map((job) => (
        <article className="system-backups-job" key={job.id}>
          <h3>{new Date(job.createdAt).toLocaleString()}</h3>
          <p>{job.status === 'ready' ? 'Ready to download' : `Backup ${job.status}`}</p>
          <Progress done={job.completedBytes} total={job.totalBytes} />
          <div className="system-backups-actions">
            {job.status === 'ready' ? (
              <Button type="button" intent="primary" disabled={busy || !exportsFresh} onClick={() => open({ kind: 'download', id: job.id })}>
                Download
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              disabled={busy || !exportsFresh || job.status === 'running' || job.status === 'queued'}
              onClick={() => open({ kind: 'remove', id: job.id })}
            >
              Remove
            </Button>
          </div>
        </article>
      ))}
      {imports.map((job) => (
        <article className="system-backups-job" key={job.id}>
          <h3>Opened backup · {new Date(job.createdAt).toLocaleString()}</h3>
          <p>{job.message || job.status}</p>
          <Progress done={job.completedBytes} total={job.totalBytes} />
          {job.review ? (
            <>
              <p>
                Backup from {new Date(job.review.createdAt).toLocaleString()} · Orbis {job.review.orbisVersion}
              </p>
              <ul>
                {job.review.contents.map((item) => (
                  <li key={`${item.kind}-${item.id}`}>
                    {item.kind === 'time-machine'
                      ? `Time Machine capture ${item.capturedAt ? new Date(item.capturedAt).toLocaleString() : ''}`
                      : labels[item.kind]}{' '}
                    · {bytes(item.bytes)} · {item.items} items
                  </li>
                ))}
              </ul>
              <p>
                {job.review.expiresAt <= now
                  ? 'Review expired. Open it again to restore.'
                  : `Review expires ${new Date(job.review.expiresAt).toLocaleString()}`}
              </p>
            </>
          ) : null}
          <div className="system-backups-actions">
            {job.status === 'awaiting-upload' ? (
              <Button type="button" disabled={busy || restoreHeld || !importsFresh} onClick={() => open({ kind: 'resume-upload', id: job.id })}>
                Choose file
              </Button>
            ) : null}
            {job.status === 'uploaded' || (job.status === 'reviewed' && job.review && job.review.expiresAt <= now) ? (
              <Button type="button" disabled={busy || restoreHeld || !importsFresh} onClick={() => open({ kind: 'review', id: job.id })}>
                Review contents
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              disabled={busy || restoreHeld || !importsFresh || job.status === 'uploading' || job.status === 'reviewing'}
              onClick={() => open({ kind: 'remove-import', id: job.id })}
            >
              Remove upload
            </Button>
            {job.review && job.review.expiresAt > now ? (
              <Button
                type="button"
                intent="primary"
                disabled={busy || !importsFresh || !restoreFresh || !!acceptedRestore || restore?.status === 'running' || !!restore?.needsRecovery}
                onClick={() => open({ kind: 'restore', id: job.id })}
              >
                Choose what to restore
              </Button>
            ) : null}
          </div>
        </article>
      ))}
      {restore ? (
        <article className="system-backups-job">
          <h3>
            {
              {
                running: 'Restoring selected items',
                succeeded: 'Settings restored',
                'rolled-back': 'Restore undone',
                'recovery-required': 'Restore needs attention',
              }[restore.status]
            }
          </h3>
          <p>
            {restore.status === 'running'
              ? 'Restoring selected items. Keep this page open to follow progress.'
              : restore.needsRecovery
                ? 'Undo this interrupted restore before starting another backup or restore.'
                : 'Restore finished.'}
          </p>
          {restore.canRollback ? (
            <Button type="button" disabled={busy || !restoreFresh} onClick={() => open({ kind: 'rollback', id: restore.id })}>
              Roll back
            </Button>
          ) : null}
        </article>
      ) : null}
      {action ? (
        <form className="system-backups-form settings-bundle-form" onSubmit={(event) => void submit(event)}>
          <h3 ref={formHeading} tabIndex={-1}>
            {
              {
                create: 'Create backup',
                upload: 'Open backup',
                download: 'Download backup',
                remove: 'Remove backup',
                review: 'Review contents',
                restore: 'Restore selected items',
                rollback: 'Roll back restore',
                'resume-upload': 'Continue upload',
                'remove-import': 'Remove uploaded backup',
              }[action.kind]
            }
          </h3>
          {action.kind === 'restore' && reviewed && restoreSelection ? (
            <>
              <p>Choose from the verified contents. Selected items will replace their current versions.</p>
              <Choices selection={restoreSelection} available={reviewed.available} onChange={setRestoreSelection} />
              {reviewed.contents.map((item) => {
                if (item.kind !== 'time-machine' || item.id === null) return null;
                const pointId = item.id;
                return (
                  <Checkbox
                    key={item.id}
                    label={`Time Machine capture ${item.capturedAt ? new Date(item.capturedAt).toLocaleString() : ''} · ${bytes(item.bytes)}`}
                    checked={restoreSelection.timeMachine.includes(pointId)}
                    onCheckedChange={(checked) =>
                      setRestoreSelection({
                        ...restoreSelection,
                        timeMachine: checked
                          ? [...restoreSelection.timeMachine, pointId]
                          : restoreSelection.timeMachine.filter((id) => id !== pointId),
                      })
                    }
                  />
                );
              })}
            </>
          ) : null}
          {action.kind === 'upload' || action.kind === 'resume-upload' ? (
            <Input label="Backup file" name="file" type="file" accept=".orbis-settings" required />
          ) : null}
          <Input label="Account password" name="password" type="password" autoComplete="current-password" maxLength={1024} disabled={busy} required />
          <Input
            label={user?.totpEnabled ? 'Authentication code' : 'Authentication code, if enabled'}
            name="totpCode"
            autoComplete="one-time-code"
            inputMode="numeric"
            pattern="[0-9]{6}"
            minLength={6}
            maxLength={6}
            disabled={busy}
            required={user?.totpEnabled === true}
          />
          {passphraseNeeded ? (
            <Input
              label={action.kind === 'create' ? 'New backup key' : 'Backup key'}
              name="passphrase"
              type="password"
              autoComplete="off"
              minLength={8}
              maxLength={1024}
              required
            />
          ) : null}
          {action.kind === 'create' ? (
            <Input label="Confirm backup key" name="confirmPassphrase" type="password" autoComplete="off" minLength={8} maxLength={1024} required />
          ) : null}
          {action.kind === 'create' ? <p>Keep the backup key somewhere safe. You will need it to open this file.</p> : null}
          {uploadProgress ? <Progress done={uploadProgress.done} total={uploadProgress.total} /> : null}
          {error ? <p role="alert">{error}</p> : null}
          <div className="system-backups-actions">
            <Button
              type="submit"
              intent="primary"
              disabled={
                busy ||
                (action.kind === 'create' || action.kind === 'download' || action.kind === 'remove'
                  ? !exportsFresh
                  : action.kind === 'restore'
                    ? !importsFresh || !restoreFresh || !!acceptedRestore || restore?.status === 'running' || !!restore?.needsRecovery
                    : action.kind === 'rollback'
                      ? !restoreFresh
                      : !importsFresh) ||
                (action.kind === 'restore' &&
                  (!reviewed || reviewed.expiresAt <= now || !restoreSelection || !settingsBackupSelectionSchema.allows(restoreSelection)))
              }
              loading={busy}
            >
              {
                {
                  create: 'Create',
                  upload: 'Upload',
                  download: 'Download',
                  remove: 'Remove',
                  review: 'Review',
                  restore: 'Restore',
                  rollback: 'Roll back',
                  'resume-upload': 'Upload',
                  'remove-import': 'Remove',
                }[action.kind]
              }
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setAction(null);
                setError('');
                requestAnimationFrame(() => (opener.current?.isConnected ? opener.current : sectionHeading.current)?.focus());
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : error ? (
        <p role="alert">{error}</p>
      ) : null}
    </section>
  );
}
