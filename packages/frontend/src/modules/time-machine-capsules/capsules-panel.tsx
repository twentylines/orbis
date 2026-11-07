import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { IconTrash } from '@tabler/icons-react';
import type { CapsuleJob } from '@runtipi/common/schemas/time-machine-capsule';
import type { TimeMachinePoint } from '@runtipi/common/schemas/time-machine';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { InlineFeedback } from '@/components/ui/Alert/Alert';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/Dialog';
import { RecoveryProgress } from '@/components/recovery-progress/recovery-progress';
import { useAppContext } from '@/context/app-context';
import { downloadBackup } from '@/modules/system-backups/backup-api';
import { formatBackupBytes } from '@/modules/system-backups/contracts';
import { BackupEncryptionFields, backupEncryptionPassphrase } from '@/modules/system-backups/backup-encryption-fields';
import { capsuleAction, capsuleRequest, readCapsules, uploadCapsule } from './capsule-api';
import './capsules-panel.css';

type Action = { kind: 'export'; point: TimeMachinePoint } | { kind: 'upload' } | { kind: 'download' | 'review' | 'remove'; job: CapsuleJob };
const statusCopy: Record<CapsuleJob['status'], string> = {
  running: 'Preparing',
  ready: 'Ready to download',
  'awaiting-upload': 'Waiting for file',
  uploaded: 'Ready to verify',
  verifying: 'Verifying',
  verified: 'Verified archive',
  failed: 'Needs review',
  cancelled: 'Cancelled',
};
export function TimeMachineFileToolbar({
  selected,
  disabled,
  onDownload,
  onImport,
  onFiles,
}: {
  selected?: { status: TimeMachinePoint['status']; metadata: { version: number } | null };
  disabled: boolean;
  onDownload: (opener: HTMLButtonElement) => void;
  onImport: (opener: HTMLButtonElement) => void;
  onFiles: (opener: HTMLButtonElement) => void;
}) {
  const downloadable = selected?.status === 'sealed' && [2, 3].includes(selected.metadata?.version ?? 0);
  return (
    <fieldset className="capsules-toolbar">
      <legend className="visually-hidden">Capture files</legend>
      <Button variant="outline" disabled={disabled || !downloadable} onClick={(event) => onDownload(event.currentTarget)}>
        Download selected point
      </Button>
      <Button variant="outline" disabled={disabled} onClick={(event) => onImport(event.currentTarget)}>
        Import
      </Button>
      <Button variant="outline" onClick={(event) => onFiles(event.currentTarget)}>
        Files
      </Button>
    </fieldset>
  );
}

export function CapsuleTransferList({
  jobs,
  busy,
  onAction,
}: {
  jobs: readonly CapsuleJob[];
  busy: boolean;
  onAction: (action: Action, opener: HTMLButtonElement) => void;
}) {
  return (
    <div className="capsules-list">
      {jobs.map((job) => (
        <article key={job.id}>
          <div>
            <h3>{job.kind === 'export' ? 'Download file' : 'Imported file'}</h3>
            <p>{new Date(job.createdAt).toLocaleString()}</p>
            <output>{statusCopy[job.status]}</output>
            {job.kind === 'import' && job.status === 'verified' ? (
              <p>Verification does not add this file to the timeline. File restoration is unavailable.</p>
            ) : null}
            {job.bytes ? <p>{formatBackupBytes(job.bytes)}</p> : null}
            {['running', 'verifying'].includes(job.status) ? (
              <RecoveryProgress label={statusCopy[job.status]} completed={job.completedBytes} total={job.totalBytes} />
            ) : null}
          </div>
          <div className="capsules-actions">
            {job.kind === 'export' && job.status === 'ready' ? (
              <Button intent="primary" disabled={busy} onClick={(event) => onAction({ kind: 'download', job }, event.currentTarget)}>
                Download
              </Button>
            ) : null}
            {job.kind === 'import' && ['uploaded', 'failed'].includes(job.status) && job.bytes > 0 ? (
              <Button variant="outline" disabled={busy} onClick={(event) => onAction({ kind: 'review', job }, event.currentTarget)}>
                Verify
              </Button>
            ) : null}
            <Button variant="outline" disabled={busy} onClick={(event) => onAction({ kind: 'remove', job }, event.currentTarget)}>
              {['running', 'verifying'].includes(job.status) ? null : <IconTrash className="orbis-remove-icon" size={18} aria-hidden="true" />}
              {['running', 'verifying'].includes(job.status) ? 'Cancel' : 'Remove'}
            </Button>
          </div>
        </article>
      ))}
    </div>
  );
}

export function TimeMachineCapsules({
  visible,
  points,
  pointsError,
  selected,
  blocked = false,
  onRefreshPoints,
}: {
  visible: boolean;
  points: readonly TimeMachinePoint[] | null;
  pointsError: boolean;
  selected?: TimeMachinePoint;
  blocked?: boolean;
  onRefreshPoints: () => Promise<boolean>;
}) {
  const { user } = useAppContext();
  const id = useId();
  const [action, setAction] = useState<Action | null>(null);
  const [filesOpen, setFilesOpen] = useState(false);
  const actionOpener = useRef<HTMLElement | null>(null);
  const filesOpener = useRef<HTMLElement | null>(null);
  const refreshButton = useRef<HTMLButtonElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [accountPassword, setAccountPassword] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const download = useRef<(() => void) | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const jobs = useQuery({
    queryKey: ['time-machine-capsules', user.id],
    queryFn: ({ signal }) => readCapsules(signal),
    enabled: visible && user.operator,
    refetchIntervalInBackground: false,
    refetchInterval: (query) => (visible && query.state.data?.jobs.some((job) => ['running', 'verifying'].includes(job.status)) ? 2000 : false),
    retry: false,
  });
  const sealed = points?.filter((point) => point.status === 'sealed' && [2, 3].includes(point.metadata?.version ?? 0)) ?? [];
  useEffect(
    () => () => {
      abort.current?.abort();
      download.current?.();
    },
    [],
  );
  const openFiles = (trigger: HTMLButtonElement) => {
    filesOpener.current = trigger;
    setFilesOpen(true);
  };
  const open = (value: Action, trigger: HTMLButtonElement) => {
    actionOpener.current = trigger;
    form.current?.reset();
    setError(null);
    setNotice(null);
    setAccountPassword(true);
    setFile(null);
    setAction(value);
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || blocked || pointsError || jobs.isError || !action) return;
    const values = new FormData(event.currentTarget);
    const password = String(values.get('password') ?? '');
    const code = String(values.get('totpCode') ?? '');
    if (!password || password.length > 1024 || (user.totpEnabled && !/^\d{6}$/.test(code)) || (code && !/^\d{6}$/.test(code))) {
      setError('Enter your current password and authentication code if enabled.');
      return;
    }
    const credentials = { password, ...(code ? { totpCode: code } : {}) };
    let passphrase = '';
    try {
      if (action.kind === 'export') passphrase = backupEncryptionPassphrase(values, 'export', accountPassword);
      if (action.kind === 'review') {
        passphrase = String(values.get('passphrase') ?? '');
        if (passphrase.length < 8 || !passphrase.trim() || passphrase.length > 1024)
          throw new Error('Enter the archive passphrase or the original account password used to encrypt it.');
      }
      if (action.kind === 'upload' && !file) throw new Error('Choose an encrypted capture file.');
      if (action.kind === 'export' && !sealed.some((item) => item.id === action.point.id)) throw new Error('Choose a sealed Time Machine capture.');
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Check the archive key.');
      return;
    }
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setError(null);
    form.current?.reset();
    try {
      if (action.kind === 'export') await capsuleAction(`/points/${action.point.id}/export`, { ...credentials, passphrase }, controller.signal);
      else if (action.kind === 'upload') {
        const job = await capsuleAction('/imports', credentials, controller.signal);
        await uploadCapsule(job.id, file as File, controller.signal);
      } else if (action.kind === 'review') await capsuleAction(`/imports/${action.job.id}/review`, { ...credentials, passphrase }, controller.signal);
      else if (action.kind === 'download') {
        download.current?.();
        download.current = downloadBackup(action.job.id, credentials, setError, 'capture');
      } else await capsuleRequest(`/${action.job.id}/remove`, 'POST', credentials, controller.signal);
      setAction(null);
      if (action.kind !== 'download') {
        if (!filesOpen) filesOpener.current = actionOpener.current;
        setFilesOpen(true);
      }
      setNotice(
        action.kind === 'download'
          ? 'Download requested. Check your browser downloads.'
          : action.kind === 'export'
            ? 'Download preparation accepted. Follow its status in Files.'
            : null,
      );
      await jobs.refetch();
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'The capture request was not confirmed.');
    } finally {
      setBusy(false);
      abort.current = null;
    }
  };
  return (
    <>
      <TimeMachineFileToolbar
        selected={selected}
        disabled={busy || blocked || pointsError || jobs.isError}
        onDownload={(trigger) => {
          if (selected) open({ kind: 'export', point: selected }, trigger);
        }}
        onImport={(trigger) => open({ kind: 'upload' }, trigger)}
        onFiles={openFiles}
      />
      <Dialog
        open={filesOpen}
        onOpenChange={(open) => {
          if (!busy) setFilesOpen(open);
        }}
      >
        <DialogContent
          size="lg"
          className="capsules-files-dialog"
          closeDisabled={busy}
          onKeyDown={(event) => event.stopPropagation()}
          onCloseAutoFocus={(event) => {
            if (filesOpener.current?.isConnected) {
              event.preventDefault();
              filesOpener.current.focus({ preventScroll: true });
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>Capture files</DialogTitle>
          </DialogHeader>
          <DialogDescription className="capsules-files-description">
            Prepared downloads and imported files are kept here. Imported files do not appear in the timeline.
          </DialogDescription>
          <section className="capsules-panel" aria-label="Capture file transfers">
            <header>
              <p>Files are listed by request time. The server does not identify their original timeline point.</p>
              <Button
                ref={refreshButton}
                variant="outline"
                disabled={busy || jobs.isFetching}
                onClick={() => {
                  void jobs.refetch();
                  void onRefreshPoints();
                }}
              >
                Refresh
              </Button>
            </header>
            {pointsError ? <InlineFeedback>Saved points could not be loaded. Refresh to try again.</InlineFeedback> : null}
            {jobs.isError ? <InlineFeedback>{jobs.error.message}</InlineFeedback> : null}
            {jobs.isPending ? <output>Reading capture files…</output> : null}
            {notice ? <output aria-live="polite">{notice}</output> : null}
            {error && !action ? <InlineFeedback>{error}</InlineFeedback> : null}
            {jobs.data?.jobs.length === 0 ? <p>No capture files yet. Choose Download selected point or Import in Time Machine.</p> : null}
            <CapsuleTransferList jobs={jobs.data?.jobs ?? []} busy={busy || blocked} onAction={open} />
          </section>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(action)}
        onOpenChange={(open) => {
          if (!open && !busy) {
            form.current?.reset();
            setAction(null);
            setError(null);
          }
        }}
      >
        <DialogContent
          size="sm"
          className="capsules-dialog"
          closeDisabled={busy}
          onKeyDown={(event) => event.stopPropagation()}
          onCloseAutoFocus={(event) => {
            const previous = actionOpener.current;
            const target = filesOpen
              ? previous?.isConnected && previous.closest('.capsules-files-dialog')
                ? previous
                : refreshButton.current
              : previous;
            if (target?.isConnected) {
              event.preventDefault();
              target.focus({ preventScroll: true });
            }
          }}
          onEscapeKeyDown={(event) => {
            if (busy) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (busy) event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {action?.kind === 'export'
                ? 'Prepare download'
                : action?.kind === 'upload'
                  ? 'Import capture file'
                  : action?.kind === 'review'
                    ? 'Verify capture'
                    : action?.kind === 'download'
                      ? 'Download capture'
                      : 'Remove archive?'}
            </DialogTitle>
            <DialogDescription
              className={['remove', 'export', 'upload'].includes(action?.kind ?? '') ? 'capsules-files-description' : 'visually-hidden'}
            >
              {action?.kind === 'remove'
                ? 'Remove only this server’s archive copy. Installed apps and Time Machine points are kept.'
                : action?.kind === 'export'
                  ? 'Prepare an encrypted file for this selected point, then download it from Files.'
                  : action?.kind === 'upload'
                    ? 'Upload an encrypted capture to Files for verification. This does not add a timeline point.'
                    : 'Confirm with your current account password.'}
            </DialogDescription>
          </DialogHeader>
          <form ref={form} onSubmit={submit} className="capsules-form">
            {action?.kind === 'export' ? (
              <p className="capsules-selected-point">
                <strong>{action.point.metadata?.label || 'Selected point'}</strong>
                <span>{new Date(action.point.createdAt).toLocaleString()}</span>
              </p>
            ) : null}
            {action?.kind === 'upload' ? (
              <>
                <input
                  ref={picker}
                  type="file"
                  accept=".orbis-tm,application/octet-stream"
                  hidden
                  tabIndex={-1}
                  onChange={(event) => setFile(event.currentTarget.files?.[0] ?? null)}
                />
                <div className="capsules-file">
                  <Button type="button" variant="outline" disabled={busy} onClick={() => picker.current?.click()}>
                    Choose file
                  </Button>
                  <span title={file?.name}>{file?.name ?? 'No file chosen'}</span>
                </div>
              </>
            ) : null}
            <Input
              label="Current account password"
              name="password"
              type="password"
              autoComplete="current-password"
              maxLength={1024}
              disabled={busy}
            />
            {user.totpEnabled ? (
              <Input label="Authentication code" name="totpCode" inputMode="numeric" autoComplete="one-time-code" maxLength={6} disabled={busy} />
            ) : null}
            {action?.kind === 'export' ? (
              <BackupEncryptionFields id={id} useAccountPassword={accountPassword} disabled={busy} onChange={setAccountPassword} />
            ) : null}
            {action?.kind === 'review' ? (
              <Input
                label="Archive passphrase or original account password"
                name="passphrase"
                type="password"
                autoComplete="off"
                minLength={8}
                maxLength={1024}
                disabled={busy}
              />
            ) : null}
            {error ? <InlineFeedback>{error}</InlineFeedback> : null}
            <DialogFooter className="capsules-actions">
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  form.current?.reset();
                  setAction(null);
                  setError(null);
                }}
              >
                Cancel
              </Button>
              <Button type="submit" intent={action?.kind === 'remove' ? 'danger' : 'primary'} disabled={busy} aria-busy={busy}>
                {action?.kind === 'remove' ? <IconTrash size={18} aria-hidden="true" /> : null}
                {action?.kind === 'export'
                  ? 'Prepare'
                  : action?.kind === 'upload'
                    ? 'Upload'
                    : action?.kind === 'review'
                      ? 'Verify'
                      : action?.kind === 'download'
                        ? 'Download'
                        : 'Remove'}
              </Button>
            </DialogFooter>
            {busy && action?.kind === 'upload' ? (
              <Button type="button" variant="outline" onClick={() => abort.current?.abort()}>
                Cancel
              </Button>
            ) : null}
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
