import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Checkbox } from '@/components/ui/Checkbox/Checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { RecoveryProgress } from '@/components/recovery-progress/recovery-progress';
import { Alert, InlineFeedback } from '@/components/ui/Alert/Alert';
import { useAppContext } from '@/context/app-context';
import { useWindowVisible } from '@/desktop/window-visibility';
import { useReducedMotion } from '@/desktop/motion-preferences';
import {
  BackupApiError,
  backupRequest,
  createImport,
  downloadBackup,
  readBackups,
  startExport,
  uploadBackup,
  type BackupCredentials,
} from './backup-api';
import {
  backupPollingInterval,
  canRestore,
  formatBackupBytes,
  type BackupReview,
  type ExportJob,
  type ImportJob,
  type RestoreJob,
} from './contracts';
import { isAcceptedRestoreReconnect, shouldStopBackupStatusPolling } from './backup-reconnection';
import './system-backups-settings.css';

type Action =
  | { kind: 'export' }
  | { kind: 'upload' }
  | { kind: 'review'; job: ImportJob }
  | { kind: 'restore'; job: ImportJob }
  | { kind: 'download' | 'recover-export'; job: ExportJob }
  | { kind: 'cancel-restore' | 'recover-restore'; job: RestoreJob };
const stageLabels: Record<string, string> = {
  preparing: 'Preparing',
  inventory: 'Checking files',
  quiescing: 'Pausing apps',
  database: 'Processing database',
  copying: 'Copying app data',
  archiving: 'Creating archive',
  encrypting: 'Encrypting archive',
  resuming: 'Restarting apps',
  complete: 'Complete',
  upload: 'Uploading',
  opening: 'Opening archive',
  inspecting: 'Checking files',
  checking: 'Checking requirements',
  files: 'Preparing app data',
  sealing: 'Verifying prepared data',
  prepared: 'Ready to restore',
};
const actionLabels = {
  export: 'Create encrypted backup',
  upload: 'Upload encrypted backup',
  review: 'Verify backup',
  restore: 'Replace this server',
  download: 'Download encrypted backup',
  'recover-export': 'Recover apps',
  'cancel-restore': 'Cancel restore and recover',
  'recover-restore': 'Recover server',
};

const submitLabels: Record<Action['kind'], string> = {
  export: 'Continue',
  upload: 'Continue',
  review: 'Continue',
  restore: 'Restore',
  download: 'Download',
  'recover-export': 'Recover',
  'cancel-restore': 'Cancel',
  'recover-restore': 'Recover',
};

export function backupEncryptionPassphrase(values: FormData, kind: 'export' | 'review', useAccountPassword: boolean): string {
  const account = kind === 'export' && useAccountPassword;
  const passphrase = String(values.get(account ? 'password' : 'passphrase') ?? '');
  if (passphrase.trim().length < 12 || passphrase.length > 1024) {
    throw new Error(
      account
        ? 'Your account password must be between 12 and 1024 characters to encrypt a backup. Choose a separate backup passphrase instead.'
        : 'Use a backup password or passphrase between 12 and 1024 characters.',
    );
  }
  if (kind === 'export' && !account && passphrase !== String(values.get('repeatPassphrase') ?? '')) {
    throw new Error('The backup passphrases did not match. Enter them again.');
  }
  return passphrase;
}

export function BackupEncryptionFields({
  useAccountPassword,
  disabled,
  onChange,
  id,
}: {
  useAccountPassword: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
  id: string;
}) {
  return (
    <div className="system-backups-encryption">
      <Checkbox checked={useAccountPassword} disabled={disabled} onCheckedChange={onChange} label="Use my account password to encrypt this backup" />
      <p>
        {useAccountPassword
          ? 'Open this backup with the account password you use today. Changing your account password later won’t change this backup.'
          : 'Keep this passphrase with your recovery records. It cannot be recovered if lost.'}
      </p>
      {useAccountPassword ? null : (
        <div className="system-backups-fields">
          <Input
            name="passphrase"
            id={`${id}-passphrase`}
            label="New backup passphrase"
            type="password"
            autoComplete="off"
            minLength={12}
            maxLength={1024}
            required
            disabled={disabled}
          />
          <Input
            name="repeatPassphrase"
            id={`${id}-repeatPassphrase`}
            label="Repeat backup passphrase"
            type="password"
            autoComplete="off"
            minLength={12}
            maxLength={1024}
            required
            disabled={disabled}
          />
        </div>
      )}
    </div>
  );
}

function Review({ review }: { review: BackupReview }) {
  const reasons = {
    'runtipi-version': 'Runtipi version differs',
    'newer-orbis': 'Backup needs a newer Orbis version',
    'unknown-orbis-version': 'Orbis version could not be compared',
  };
  return (
    <div className="system-backups-review">
      <dl>
        <div>
          <dt>Created</dt>
          <dd>{new Date(review.createdAt).toLocaleString()}</dd>
        </div>
        <div>
          <dt>Versions</dt>
          <dd>
            Orbis {review.orbisVersion} · Runtipi {review.runtipiVersion}
          </dd>
        </div>
        <div>
          <dt>Contents</dt>
          <dd>
            {review.appCount} apps · {review.fileCount.toLocaleString()} files · {formatBackupBytes(review.expandedBytes)}
          </dd>
        </div>
        <div>
          <dt>Architecture</dt>
          <dd>
            {review.architecture}
            {review.compatibility.architectureChanged ? ' · differs from this server' : ''}
          </dd>
        </div>
        <div>
          <dt>Database</dt>
          <dd>
            {review.databaseValidation === 'validated' ? 'Verified' : 'Awaiting verification'}
            {review.databaseRecords !== undefined ? ` · ${review.databaseRecords.toLocaleString()} records` : ''}
          </dd>
        </div>
      </dl>
      {review.compatibility.blockers.map((reason) => (
        <p role="alert" key={reason}>
          {reasons[reason]}
        </p>
      ))}
      {review.hostIdentityPolicy === 'preserve-destination' ? (
        <Alert className="system-backups-review-disclosure" role="note" variant="info">
          Network access and cluster membership stay with this server. Review settings sync after restoring accounts.
        </Alert>
      ) : null}
      <p>
        External bind mounts and host-specific settings need separate review. This archive does not include data outside Orbis’s managed backup roots.
      </p>
      <details>
        <summary>Manifest checksum</summary>
        <code>{review.manifestSha256}</code>
      </details>
    </div>
  );
}

type BackupSettingsProps = {
  restoreOnly?: boolean;
  embedded?: boolean;
  initialImportId?: string;
  onActivityChange?: (active: boolean) => void;
  recoveryActions?: ReactNode;
};

export function SystemBackupsSettings({
  restoreOnly = false,
  embedded = false,
  initialImportId,
  onActivityChange,
  recoveryActions,
}: BackupSettingsProps = {}) {
  const id = useId();
  const reduced = useReducedMotion();
  const { user } = useAppContext();
  const visible = useWindowVisible();
  const status = useQuery({
    queryKey: ['orbis-full-backups', user?.id],
    queryFn: ({ signal }) => readBackups(signal),
    enabled: visible && user?.operator === true,
    retry: false,
    refetchInterval: (query) => {
      const error = query.state.error;
      return shouldStopBackupStatusPolling(error, query.state.data) ? false : backupPollingInterval(query.state.data, visible);
    },
    refetchIntervalInBackground: false,
  });
  const [action, setAction] = useState<Action | null>(() => (restoreOnly && embedded && !initialImportId ? { kind: 'upload' } : null));
  const [file, setFile] = useState<File | null>(null);
  const [useAccountPassword, setUseAccountPassword] = useState(true);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardJob, setWizardJob] = useState<{ kind: 'export' | 'import'; id: string } | null>(null);
  const [wizardPurpose, setWizardPurpose] = useState<Action['kind'] | null>(null);
  const [busy, setBusy] = useState(false);
  const [removal, setRemoval] = useState<{ kind: 'export' | 'import'; id: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [upload, setUpload] = useState<{ completed: number; total: number; confirmed: boolean } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const downloadCleanup = useRef<(() => void) | null>(null);
  const credentialsForm = useRef<HTMLFormElement | null>(null);
  const filePicker = useRef<HTMLInputElement | null>(null);
  const mounted = useRef(true);
  const running = useRef(false);
  const awaitingRestore = useRef(false);
  const seededImport = useRef<string | null>(null);
  const actionOpener = useRef<HTMLElement | null>(null);
  const actionKeyboard = useRef(false);
  const chooseAction = (next: Action) => {
    actionOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    actionKeyboard.current = actionOpener.current?.matches(':focus-visible') ?? false;
    credentialsForm.current?.reset();
    setError(null);
    setNotice(null);
    setUpload(null);
    setUseAccountPassword(true);
    setWizardJob(
      'job' in next && ['review', 'restore', 'download', 'recover-export'].includes(next.kind)
        ? { kind: next.kind === 'download' || next.kind === 'recover-export' ? 'export' : 'import', id: next.job.id }
        : null,
    );
    setWizardPurpose(next.kind);
    if (!embedded) setWizardOpen(true);
    setAction(next);
    setRemoval(null);
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      abort.current?.abort();
      downloadCleanup.current?.();
    };
  }, []);
  useEffect(() => {
    if (action) {
      const keyboard = actionOpener.current
        ? actionKeyboard.current
        : document.activeElement instanceof HTMLElement && document.activeElement.matches(':focus-visible');
      credentialsForm.current?.querySelector<HTMLElement>(keyboard ? 'input:not([type=hidden]):not([type=file])' : 'h3')?.focus();
    } else if ((embedded || !wizardOpen) && actionOpener.current?.isConnected) actionOpener.current.focus();
  }, [action, embedded, wizardOpen]);
  const data = status.data;
  useEffect(() => {
    if (!initialImportId || seededImport.current === initialImportId || action || busy) return;
    const job = data?.imports.jobs.find((entry) => entry.id === initialImportId);
    if (!job || job.uploadedBytes <= 0 || ['uploading', 'reviewing', 'preparing'].includes(job.status)) return;
    seededImport.current = initialImportId;
    setAction({ kind: 'review', job });
    setWizardJob({ kind: 'import', id: job.id });
    setWizardPurpose('review');
    if (!embedded) setWizardOpen(true);
  }, [initialImportId, data, action, busy, embedded]);
  const restore = data?.restore.job;
  const guidedImportId = restoreOnly && embedded ? initialImportId : undefined;
  const visibleImports = guidedImportId ? data?.imports.jobs.filter((job) => job.id === guidedImportId) : data?.imports.jobs;
  const selectedImport = visibleImports?.find((job) => job.id === guidedImportId);
  const showImportSummary = !guidedImportId || !action || ['uploading', 'reviewing', 'preparing'].includes(selectedImport?.status ?? '');
  const restoreActive = Boolean(restore && !['succeeded', 'rolled-back'].includes(restore.status));
  useEffect(() => {
    if (restore && ['ready', 'running', 'recovery-required'].includes(restore.status)) awaitingRestore.current = true;
    if (!awaitingRestore.current || !restore || !['succeeded', 'rolled-back'].includes(restore.status) || restore.needsRecovery || status.isError)
      return;
    const timer = setTimeout(() => window.location.reload(), 1200);
    return () => clearTimeout(timer);
  }, [restore, status.isError]);
  useEffect(() => {
    onActivityChange?.(busy || restoreActive || awaitingRestore.current);
  }, [busy, restoreActive, onActivityChange]);
  useEffect(() => () => onActivityChange?.(false), [onActivityChange]);
  const working =
    busy ||
    restoreActive ||
    awaitingRestore.current ||
    Boolean(data?.exports.jobs.some((job) => job.status === 'running' || job.needsRecovery || job.restartRequired)) ||
    Boolean(data?.imports.jobs.some((job) => ['uploading', 'reviewing', 'preparing'].includes(job.status)));
  const refresh = () => void status.refetch();
  const run = async (work: (signal: AbortSignal) => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    const controller = new AbortController();
    abort.current = controller;
    try {
      await work(controller.signal);
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : 'The backup action failed. Refresh status before retrying.');
    } finally {
      if (mounted.current) {
        setBusy(false);
        refresh();
      }
      abort.current = null;
      running.current = false;
    }
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const password = String(values.get('password') ?? '');
    const totpCode = String(values.get('totpCode') ?? '');
    const confirmation = String(values.get('confirmation') ?? '');
    const credentials: BackupCredentials = { password, ...(totpCode ? { totpCode } : {}) };
    form.reset();
    if (!action) return;
    let passphrase = '';
    try {
      if (action.kind === 'export' || action.kind === 'review') passphrase = backupEncryptionPassphrase(values, action.kind, useAccountPassword);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Check the backup password or passphrase.');
      return;
    }
    const selected = action;
    void run(async (signal) => {
      if (selected.kind === 'export') {
        const job = await startExport(credentials, passphrase, signal);
        if (mounted.current) setWizardJob({ kind: 'export', id: job.id });
      } else if (selected.kind === 'upload') {
        if (!file || file.size < 52) throw new Error('Choose a complete encrypted Orbis backup file.');
        const job = await createImport(credentials, signal);
        if (mounted.current) setWizardJob({ kind: 'import', id: job.id });
        setUpload({ completed: 0, total: file.size, confirmed: false });
        await uploadBackup(job.id, file, signal, (completed, total) => {
          if (mounted.current) setUpload({ completed, total, confirmed: false });
        });
        if (mounted.current) {
          setUpload({ completed: file.size, total: file.size, confirmed: true });
          setFile(null);
          setNotice('Upload complete. Verify the archive before restoring.');
        }
      } else if (selected.kind === 'download') {
        downloadCleanup.current?.();
        downloadCleanup.current = downloadBackup(selected.job.id, credentials, (message) => {
          if (mounted.current) setError(message);
        });
        setNotice('Download requested. Your browser shows its progress and confirms when the file has been saved.');
      } else if (selected.kind === 'restore') {
        if (confirmation !== 'replace-server' || !canRestore(selected.job, Date.now()) || !selected.job.review)
          throw new Error('Verify this backup again and confirm replacement before restoring.');
        await backupRequest(
          '/restores',
          'POST',
          { ...credentials, importId: selected.job.id, manifestSha256: selected.job.review.manifestSha256, confirmation },
          signal,
        );
        awaitingRestore.current = true;
        setNotice('Restore accepted. Keep this page open while Orbis reconnects and checks completion.');
      } else {
        const path =
          selected.kind === 'review'
            ? `/imports/${selected.job.id}/review`
            : selected.kind === 'recover-export'
              ? `/${selected.job.id}/recover`
              : `/restores/${selected.job.id}/${selected.kind === 'cancel-restore' ? 'cancel' : 'recover'}`;
        await backupRequest(path, 'POST', selected.kind === 'review' ? { ...credentials, passphrase } : credentials, signal);
      }
      if (mounted.current) setAction(null);
    });
  };
  const simpleAction = (path: string, method = 'POST') =>
    void run(async (signal) => {
      await backupRequest(path, method, undefined, signal);
    });
  const missing = status.error instanceof BackupApiError && status.error.status === 404;
  const reconnectingAcceptedRestore = status.isError && isAcceptedRestoreReconnect(status.error, restore?.status, awaitingRestore.current);
  const unavailable = !data || !data.exports.available || !data.imports.available || status.isError;
  const phraseNeeded = action?.kind === 'review';
  const destructive = action?.kind === 'restore';
  const renderExportJob = (job: ExportJob, inWizard = false) => (
    <article className="system-backups-job" key={job.id}>
      <h4>{new Date(job.createdAt).toLocaleString()}</h4>
      <p>{job.message}</p>
      {job.status === 'running' || job.status === 'succeeded' ? (
        <RecoveryProgress
          label={job.status === 'succeeded' ? 'Backup ready' : `Backup · ${stageLabels[job.stage] ?? 'Checking progress'}`}
          completed={job.completedBytes}
          total={job.totalBytes}
          settled={job.status === 'succeeded'}
        />
      ) : null}
      {job.restartRequired ? <p role="alert">Apps have recovered. Restart Orbis to finish recovery before making further changes.</p> : null}
      <div className="system-backups-actions">
        {job.status === 'running' ? (
          <Button variant="outline" disabled={busy || status.isError} onClick={() => simpleAction(`/${job.id}/cancel`)}>
            Cancel backup
          </Button>
        ) : null}
        {job.needsRecovery && job.status !== 'running' ? (
          <Button variant="outline" disabled={busy || status.isError} onClick={() => chooseAction({ kind: 'recover-export', job })}>
            Recover
          </Button>
        ) : null}
        {job.status === 'succeeded' ? (
          <Button variant="outline" disabled={busy || status.isError} onClick={() => chooseAction({ kind: 'download', job })}>
            Download
          </Button>
        ) : null}
        {!inWizard && job.status !== 'running' && !job.needsRecovery ? (
          <Button
            variant="outline"
            disabled={busy || status.isError}
            onClick={() => {
              setAction(null);
              setRemoval({ kind: 'export', id: job.id });
            }}
          >
            Remove
          </Button>
        ) : null}
      </div>
    </article>
  );
  const renderImportJob = (job: ImportJob, inWizard = false) => (
    <article className="system-backups-job" key={job.id}>
      <h4>{new Date(job.createdAt).toLocaleString()}</h4>
      <p>{job.message}</p>
      {['uploading', 'reviewing', 'preparing'].includes(job.status) ? (
        <RecoveryProgress
          label={`Verification · ${stageLabels[job.stage] ?? 'Checking progress'}`}
          completed={job.completedBytes}
          total={job.totalBytes}
        />
      ) : null}
      {job.review ? <Review review={job.review} /> : null}
      {job.reviewExpiresAt ? <p>Review expires {new Date(job.reviewExpiresAt).toLocaleTimeString()}. Verify again if it expires.</p> : null}
      <div className="system-backups-actions">
        {job.uploadedBytes > 0 && !['uploading', 'reviewing', 'preparing'].includes(job.status) ? (
          <Button variant="outline" disabled={working || status.isError} onClick={() => chooseAction({ kind: 'review', job })}>
            Verify
          </Button>
        ) : null}
        {job.review ? (
          <Button
            intent="danger"
            variant="outline"
            disabled={working || status.isError || !canRestore(job, Date.now())}
            onClick={() => chooseAction({ kind: 'restore', job })}
          >
            Restore
          </Button>
        ) : null}
        {['uploading', 'reviewing'].includes(job.status) ? (
          <Button variant="outline" disabled={busy || status.isError} onClick={() => simpleAction(`/imports/${job.id}/cancel`)}>
            Cancel
          </Button>
        ) : null}
        {inWizard || ['uploading', 'reviewing', 'preparing'].includes(job.status) ? null : (
          <Button
            variant="outline"
            disabled={busy || restoreActive || status.isError}
            onClick={() => {
              setAction(null);
              setRemoval({ kind: 'import', id: job.id });
            }}
          >
            Remove
          </Button>
        )}
      </div>
    </article>
  );
  const restorePanel = restore ? (
    <article className="system-backups-job" aria-labelledby={`${id}-restore`}>
      <h3 id={`${id}-restore`}>Server restore</h3>
      <output>{restore.message}</output>
      {restore.preparation ? (
        <RecoveryProgress
          label={`Preparation · ${stageLabels[restore.preparation.stage] ?? 'Checking progress'}`}
          completed={restore.preparation.stage === 'database' ? restore.preparation.records : restore.preparation.completedBytes}
          total={restore.preparation.stage === 'database' ? restore.preparation.totalRecords : restore.preparation.totalBytes}
          unit={restore.preparation.stage === 'database' ? 'records' : 'bytes'}
        />
      ) : null}
      {!restore.preparation && ['ready', 'running'].includes(restore.status) ? <RecoveryProgress label="Restoring this server" /> : null}
      {restore.status === 'succeeded' ? <RecoveryProgress label="Restore complete" completed={0} total={null} settled /> : null}
      {restore.progressUnavailable ? <p>Detailed progress is unavailable. Recovery controls use the server’s verified restore state.</p> : null}
      {restore.status === 'running' || restore.status === 'ready' ? (
        <p>Orbis may disconnect while replacing its configuration and app data. Status is checked automatically when the connection returns.</p>
      ) : null}
      <div className="system-backups-actions">
        {restore.canCancel ? (
          <Button variant="outline" disabled={busy || status.isError} onClick={() => chooseAction({ kind: 'cancel-restore', job: restore })}>
            Cancel
          </Button>
        ) : null}
        {restore.canRecover ? (
          <Button variant="outline" disabled={busy || status.isError} onClick={() => chooseAction({ kind: 'recover-restore', job: restore })}>
            Recover
          </Button>
        ) : null}
        {['succeeded', 'rolled-back'].includes(restore.status) ? (
          <Button variant="outline" onClick={() => window.location.reload()}>
            Reload
          </Button>
        ) : null}
      </div>
    </article>
  ) : null;
  const credentialPanel = (
    <>
      {action && !(action.kind === 'upload' && ((busy && upload) || restoreActive || awaitingRestore.current)) ? (
        <form className="system-backups-form" ref={credentialsForm} onSubmit={submit} aria-labelledby={`${id}-action`} noValidate>
          <h3 id={`${id}-action`} className={embedded ? undefined : 'visually-hidden'} tabIndex={-1}>
            {action.kind === 'upload' ? 'Choose your backup' : actionLabels[action.kind]}
          </h3>
          {action.kind === 'upload' ? (
            <>
              <input
                ref={filePicker}
                type="file"
                aria-label="Encrypted Orbis backup"
                className="visually-hidden"
                tabIndex={-1}
                accept=".orbis,application/octet-stream"
                disabled={busy}
                onChange={(event) => {
                  setFile(event.currentTarget.files?.[0] ?? null);
                  setUpload(null);
                  event.currentTarget.value = '';
                }}
              />
              <div className="system-backups-file-picker">
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  aria-describedby={`${id}-filename`}
                  onClick={() => filePicker.current?.click()}
                >
                  Choose file
                </Button>
                <span id={`${id}-filename`} className="system-backups-file" aria-live="polite">
                  {file ? (
                    <>
                      {file.name}
                      <small>{formatBackupBytes(file.size)}</small>
                    </>
                  ) : (
                    'No file chosen'
                  )}
                </span>
              </div>
            </>
          ) : null}
          {destructive && action.job.review ? (
            <>
              <Review review={action.job.review} />
              <p className="system-backups-warning">
                This replaces the server’s configuration, accounts and managed app data. Apps will stop and Orbis will restart. Keep a current backup
                before continuing.
              </p>
              <label className="system-backups-confirm">
                <input type="checkbox" name="confirmation" value="replace-server" required disabled={busy} />
                <span>I have reviewed this backup and want to replace this server.</span>
              </label>
            </>
          ) : null}
          <div className="system-backups-fields">
            <Input
              name="password"
              id={`${id}-password`}
              label="Current account password"
              type="password"
              autoComplete="current-password"
              maxLength={1024}
              required
              disabled={busy}
            />
            {user?.totpEnabled ? (
              <Input
                name="totpCode"
                id={`${id}-totpCode`}
                label="Authentication code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                minLength={6}
                maxLength={6}
                required
                disabled={busy}
              />
            ) : null}
            {phraseNeeded ? (
              <Input
                name="passphrase"
                id={`${id}-passphrase`}
                label="Original account password or backup passphrase"
                type="password"
                autoComplete="off"
                minLength={12}
                maxLength={1024}
                required
                disabled={busy}
              />
            ) : null}
          </div>
          {action.kind === 'export' ? (
            <BackupEncryptionFields
              id={id}
              useAccountPassword={useAccountPassword}
              disabled={busy}
              onChange={(value) => {
                setUseAccountPassword(value);
                setError(null);
              }}
            />
          ) : null}
          {phraseNeeded ? <p>Use the original server account password chosen for this backup, or its separate backup passphrase.</p> : null}
          <div className="system-backups-actions">
            {embedded && action.kind === 'upload' ? null : (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  credentialsForm.current?.reset();
                  if (!embedded && !restoreActive && !awaitingRestore.current) setWizardOpen(false);
                  setAction(null);
                  setFile(null);
                  setError(null);
                }}
              >
                Cancel
              </Button>
            )}
            <Button
              type="submit"
              intent={destructive ? 'danger' : 'primary'}
              disabled={
                busy ||
                unavailable ||
                (['export', 'upload', 'review', 'restore'].includes(action.kind) && working) ||
                (action.kind === 'upload' && !file) ||
                (destructive && !canRestore(action.job, Date.now()))
              }
            >
              {busy ? 'Working…' : submitLabels[action.kind]}
            </Button>
          </div>
        </form>
      ) : null}
      {upload ? (
        <div className="system-backups-upload-progress">
          <RecoveryProgress
            label={upload.confirmed ? 'Upload complete' : 'Uploading encrypted backup'}
            completed={upload.completed}
            total={upload.total}
            settled={upload.confirmed}
          />
          {busy && !upload.confirmed ? (
            <div className="system-backups-actions">
              <Button type="button" variant="outline" onClick={() => abort.current?.abort()}>
                Cancel
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {error ? <InlineFeedback>{error}</InlineFeedback> : null}
      {notice ? <output aria-live="polite">{notice}</output> : null}
    </>
  );
  const wizardLocked = busy || restoreActive || awaitingRestore.current;
  const wizardExport = wizardJob?.kind === 'export' ? data?.exports.jobs.find((job) => job.id === wizardJob.id) : undefined;
  const wizardImport = wizardJob?.kind === 'import' ? data?.imports.jobs.find((job) => job.id === wizardJob.id) : undefined;
  const restoringInWizard =
    restoreActive ||
    awaitingRestore.current ||
    wizardPurpose === 'restore' ||
    wizardPurpose === 'cancel-restore' ||
    wizardPurpose === 'recover-restore';
  const closeWizard = () => {
    if (wizardLocked) return;
    credentialsForm.current?.reset();
    setAction(null);
    setFile(null);
    setUpload(null);
    setError(null);
    setNotice(null);
    setWizardOpen(false);
  };
  return (
    <section className="system-backups-settings" data-embedded={embedded} data-reduced={Boolean(reduced)} aria-labelledby={`${id}-title`}>
      {guidedImportId && !status.isError ? (
        <h3 id={`${id}-title`} className="visually-hidden">
          Encrypted backup
        </h3>
      ) : (
        <div className="system-backups-heading">
          {embedded ? (
            <h3 id={`${id}-title`} className={guidedImportId ? 'visually-hidden' : undefined}>
              Encrypted backup
            </h3>
          ) : (
            <h2 id={`${id}-title`}>{restoreOnly ? 'Restore a backup' : 'Full backup & recovery'}</h2>
          )}
          <Button variant="outline" type="button" onClick={refresh} disabled={status.isFetching || busy}>
            Refresh
          </Button>
        </div>
      )}
      {embedded ? null : (
        <p>
          {restoreOnly
            ? 'Verify the encrypted archive before replacing this server’s configuration and managed app data.'
            : 'Orbis configuration, accounts and managed app data are backed up together in an encrypted file. Apps pause while their data is copied to keep it consistent.'}
        </p>
      )}
      {status.isPending ? <output>Reading backup capabilities…</output> : null}
      {status.isError ? (
        <InlineFeedback>
          {reconnectingAcceptedRestore
            ? 'Orbis is reconnecting after the accepted restore. The status below shows the last confirmed progress; the new server has not replied yet.'
            : missing
              ? 'This server does not provide the full backup and restore API. Update Orbis, then refresh status.'
              : status.error.message}
          {restoreActive && !reconnectingAcceptedRestore ? ' Reconnecting; the last confirmed restore status remains below.' : ''}
          {status.error instanceof BackupApiError && status.error.status === 401 ? (
            <Button type="button" variant="outline" onClick={() => window.location.reload()}>
              Sign in again
            </Button>
          ) : null}
        </InlineFeedback>
      ) : null}
      {data && (!data.exports.available || !data.imports.available) ? (
        <InlineFeedback>Backup storage needs operator review. Existing status remains available; new operations are disabled.</InlineFeedback>
      ) : null}
      {embedded || !wizardOpen ? restorePanel : null}
      {restoreOnly ? (
        action || guidedImportId ? null : (
          <div className="system-backups-actions">
            <Button type="button" variant="outline" disabled={working || unavailable} onClick={() => chooseAction({ kind: 'upload' })}>
              Restore
            </Button>
          </div>
        )
      ) : (
        <div className="system-backups-choices">
          <div>
            <h3>Create a backup</h3>
            <p>
              Encrypt with your account password or a separate backup passphrase. Server copies expire after {data?.exports.retentionHours ?? 24}{' '}
              hours.
            </p>
            <Button type="button" variant="outline" disabled={working || unavailable} onClick={() => chooseAction({ kind: 'export' })}>
              Create
            </Button>
          </div>
          <div>
            <h3>Restore a backup</h3>
            <p>Upload and verify the archive first. Restoring replaces this server’s configuration and managed app data.</p>
            <Button type="button" variant="outline" disabled={working || unavailable} onClick={() => chooseAction({ kind: 'upload' })}>
              Restore
            </Button>
          </div>
        </div>
      )}
      {embedded || restoreOnly ? null : recoveryActions}
      {restoreOnly && data?.exports.jobs.some((job) => job.status === 'running' || job.needsRecovery || job.restartRequired) ? (
        <InlineFeedback>Finish the existing full backup or its app recovery in Settings before starting a restore.</InlineFeedback>
      ) : null}
      {removal ? (
        <div className="system-backups-form">
          <h3>{removal.kind === 'export' ? 'Remove server backup copy?' : 'Remove uploaded backup?'}</h3>
          <p>This permanently deletes the server’s stored archive and its review. Files already saved on your device are unaffected.</p>
          <div className="system-backups-actions">
            <Button
              type="button"
              intent="danger"
              disabled={busy || status.isError || restoreActive}
              onClick={() =>
                void run(async (signal) => {
                  await backupRequest(`${removal.kind === 'import' ? '/imports' : ''}/${removal.id}`, 'DELETE', undefined, signal);
                  if (mounted.current) setRemoval(null);
                })
              }
            >
              Remove
            </Button>
            <Button type="button" variant="outline" disabled={busy} onClick={() => setRemoval(null)}>
              Keep
            </Button>
          </div>
        </div>
      ) : null}
      {embedded ? credentialPanel : null}
      {!restoreOnly && data?.exports.jobs.length ? (
        <div className="system-backups-jobs">
          <h3>Server backups</h3>
          {[...data.exports.jobs].sort((a, b) => b.createdAt - a.createdAt).map((job) => renderExportJob(job))}
        </div>
      ) : null}
      {showImportSummary && visibleImports?.length ? (
        <div className="system-backups-jobs">
          <h3>{guidedImportId ? 'Backup details' : 'Uploaded backups'}</h3>
          {[...visibleImports].sort((a, b) => b.createdAt - a.createdAt).map((job) => renderImportJob(job))}
        </div>
      ) : null}
      {embedded ? null : (
        <Dialog
          open={wizardOpen}
          onOpenChange={(open) => {
            if (!open) closeWizard();
          }}
        >
          <DialogContent
            size="md"
            className="system-backups-window"
            closeDisabled={wizardLocked}
            aria-describedby={undefined}
            onEscapeKeyDown={(event) => {
              if (wizardLocked) event.preventDefault();
            }}
            onInteractOutside={(event) => event.preventDefault()}
            onOpenAutoFocus={(event) => {
              if (actionKeyboard.current) {
                const field = credentialsForm.current?.querySelector<HTMLInputElement>('input:not([type=hidden]):not([type=file])');
                if (field) {
                  event.preventDefault();
                  field.focus();
                }
              }
            }}
          >
            <DialogHeader>
              <DialogTitle>
                {wizardPurpose === 'upload' ? 'Restore a backup' : wizardPurpose ? actionLabels[wizardPurpose] : 'Backup & recovery'}
              </DialogTitle>
            </DialogHeader>
            <div className="modal-body system-backups-window-body" data-reduced={Boolean(reduced)}>
              {status.isError ? (
                <InlineFeedback>
                  {reconnectingAcceptedRestore
                    ? 'Orbis is reconnecting after the accepted restore. Waiting for confirmed status.'
                    : status.error.message}
                </InlineFeedback>
              ) : null}
              {credentialPanel}
              {action ? null : restoringInWizard ? (
                restorePanel
              ) : wizardExport ? (
                renderExportJob(wizardExport, true)
              ) : wizardImport ? (
                renderImportJob(wizardImport, true)
              ) : wizardJob ? (
                <RecoveryProgress label="Reading backup status" />
              ) : null}
            </div>
          </DialogContent>
        </Dialog>
      )}
    </section>
  );
}
