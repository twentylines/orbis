import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Checkbox } from '@/components/ui/Checkbox/Checkbox';
import { SelectionGroup } from '@/components/ui/SelectionGroup/SelectionGroup';
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
import { BackupRemoveTrigger, BackupRemovalConfirmation, type BackupRemovalTarget } from './backup-removal-confirmation';
import type { BackupRemovalRect } from './backup-removal-position';
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

export function BackupDownloadReady({ job, disabled, onDownload }: { job: ExportJob; disabled: boolean; onDownload: () => void }) {
  if (job.status !== 'succeeded') return null;
  return (
    <div className="system-backups-download-ready">
      <p>Save the encrypted backup to your computer.</p>
      <Button type="button" intent="primary" disabled={disabled} onClick={onDownload}>
        Download
      </Button>
    </div>
  );
}

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

type ArchiveKeyMode = 'account-password' | 'passphrase';
type BackupField = 'password' | 'totpCode' | 'passphrase' | 'repeatPassphrase' | 'keyMode' | 'confirmation' | 'file';
export class BackupFormError extends Error {
  constructor(
    public readonly field: BackupField,
    message: string,
  ) {
    super(message);
  }
}
export function prepareBackupSubmission(
  form: Pick<HTMLFormElement, 'querySelectorAll'>,
  values: FormData,
  options: {
    kind: Action['kind'];
    totpEnabled: boolean;
    useAccountPassword: boolean;
    archiveKeyMode: ArchiveKeyMode | null;
    fileValid: boolean;
    restoreValid: boolean;
  },
) {
  const password = values.get('password');
  const code = values.get('totpCode');
  if (typeof password !== 'string' || !password.length || password.length > 1024)
    throw new BackupFormError('password', 'Enter this server’s current account password.');
  if ((options.totpEnabled || (code !== null && code !== '')) && (typeof code !== 'string' || !/^\d{6}$/.test(code)))
    throw new BackupFormError('totpCode', 'Enter the six-digit authentication code for this account.');
  let passphrase = '';
  if (options.kind === 'review' && !options.archiveKeyMode) throw new BackupFormError('keyMode', 'Choose how this backup was encrypted.');
  if (options.kind === 'export' || options.kind === 'review') {
    const keyField = options.kind === 'export' && options.useAccountPassword ? 'password' : 'passphrase';
    if (typeof values.get(keyField) !== 'string') throw new BackupFormError(keyField, 'Enter the backup key.');
    try {
      passphrase = backupEncryptionPassphrase(values, options.kind, options.useAccountPassword);
    } catch (error) {
      const repeat = error instanceof Error && error.message === 'The backup passphrases did not match. Enter them again.';
      throw new BackupFormError(repeat ? 'repeatPassphrase' : keyField, error instanceof Error ? error.message : 'Check the backup key.');
    }
  }
  if (options.kind === 'upload' && !options.fileValid) throw new BackupFormError('file', 'Choose a complete encrypted Orbis backup file.');
  if (options.kind === 'restore' && !options.restoreValid)
    throw new BackupFormError('confirmation', 'Verify this backup again and confirm replacement before restoring.');
  for (const field of form.querySelectorAll<HTMLInputElement>('input[type="password"], input[name="totpCode"]')) field.value = '';
  return { credentials: { password, ...(typeof code === 'string' && code ? { totpCode: code } : {}) } satisfies BackupCredentials, passphrase };
}

export function BackupArchiveKeyFields({
  mode,
  disabled,
  onChange,
  id,
}: {
  mode: ArchiveKeyMode | null;
  disabled: boolean;
  onChange: (mode: ArchiveKeyMode) => void;
  id: string;
}) {
  return (
    <div className="system-backups-archive-key">
      <p id={`${id}-key-label`}>How was this backup encrypted?</p>
      <SelectionGroup role="group" aria-labelledby={`${id}-key-label`}>
        <Button
          id={`${id}-keyMode`}
          type="button"
          variant="outline"
          aria-pressed={mode === 'account-password'}
          disabled={disabled}
          onClick={() => onChange('account-password')}
        >
          Account password
        </Button>
        <Button type="button" variant="outline" aria-pressed={mode === 'passphrase'} disabled={disabled} onClick={() => onChange('passphrase')}>
          Separate passphrase
        </Button>
      </SelectionGroup>
      {mode ? (
        <Input
          name="passphrase"
          id={`${id}-passphrase`}
          label={mode === 'account-password' ? 'Original account password' : 'Backup passphrase'}
          type="password"
          autoComplete="off"
          minLength={12}
          maxLength={1024}
          required
          disabled={disabled}
        />
      ) : null}
      <p>
        {mode === 'account-password'
          ? 'Use the account password from when this backup was created.'
          : mode === 'passphrase'
            ? 'Use the separate passphrase chosen when this backup was created.'
            : 'Existing backups do not record this choice. Choose the key you used when creating it.'}
      </p>
    </div>
  );
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
  const [archiveKeyMode, setArchiveKeyMode] = useState<ArchiveKeyMode | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardJob, setWizardJob] = useState<{ kind: 'export' | 'import'; id: string } | null>(null);
  const [wizardPurpose, setWizardPurpose] = useState<Action['kind'] | null>(null);
  const [busy, setBusy] = useState(false);
  const [removal, setRemoval] = useState<BackupRemovalTarget | null>(null);
  const [removalError, setRemovalError] = useState<string | null>(null);
  const [removalAnchorRect, setRemovalAnchorRect] = useState<BackupRemovalRect | null>(null);
  const removalAnchor = useRef<HTMLElement | null>(null);
  const removalFallback = useRef<HTMLElement | null>(null);
  const removalDeleted = useRef(false);
  const removalActive = useRef(false);
  const section = useRef<HTMLElement | null>(null);
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
    setArchiveKeyMode(null);
    setWizardJob(
      'job' in next && ['review', 'restore', 'download', 'recover-export'].includes(next.kind)
        ? { kind: next.kind === 'download' || next.kind === 'recover-export' ? 'export' : 'import', id: next.job.id }
        : null,
    );
    setWizardPurpose(next.kind);
    if (!embedded) setWizardOpen(true);
    setAction(next);
    removalActive.current = false;
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
    } else if (!removalActive.current && (embedded || !wizardOpen) && actionOpener.current?.isConnected) actionOpener.current.focus();
  }, [action, embedded, wizardOpen]);
  const data = status.data;
  useEffect(() => {
    if (!initialImportId || seededImport.current === initialImportId || action || busy) return;
    const job = data?.imports.jobs.find((entry) => entry.id === initialImportId);
    if (!job || job.uploadedBytes <= 0 || ['uploading', 'reviewing', 'preparing'].includes(job.status)) return;
    seededImport.current = initialImportId;
    setArchiveKeyMode(null);
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
  const run = async (work: (signal: AbortSignal) => Promise<void>, options?: { onError?: (message: string) => void; refresh?: boolean }) => {
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
      if (mounted.current)
        (options?.onError ?? setError)(failure instanceof Error ? failure.message : 'The backup action failed. Refresh status before retrying.');
    } finally {
      if (mounted.current) {
        setBusy(false);
        if (options?.refresh !== false) refresh();
      }
      abort.current = null;
      running.current = false;
    }
  };
  const openRemoval = (target: BackupRemovalTarget, opener: HTMLButtonElement) => {
    const triggers = [...(section.current?.querySelectorAll<HTMLButtonElement>('[data-backup-removal-trigger]') ?? [])];
    const index = triggers.indexOf(opener);
    removalAnchor.current = opener;
    removalFallback.current = triggers[index + 1] ?? triggers[index - 1] ?? section.current;
    removalDeleted.current = false;
    removalActive.current = true;
    setRemovalAnchorRect(opener.getBoundingClientRect());
    setRemovalError(null);
    setAction(null);
    setRemoval(target);
  };
  const closeRemoval = () => {
    if (running.current) return;
    removalActive.current = false;
    setRemoval(null);
    setRemovalError(null);
  };
  const confirmRemoval = () => {
    if (!removal || running.current || status.isError || restoreActive) return;
    const selected = removal;
    setRemovalError(null);
    void run(
      async (signal) => {
        await backupRequest(`${selected.kind === 'import' ? '/imports' : ''}/${selected.id}`, 'DELETE', undefined, signal);
        removalDeleted.current = true;
        await status.refetch();
        if (mounted.current) {
          removalActive.current = false;
          setRemoval(null);
          setRemovalError(null);
        }
      },
      { onError: setRemovalError, refresh: false },
    );
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!action || running.current) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    const confirmation = String(values.get('confirmation') ?? '');
    let submission: ReturnType<typeof prepareBackupSubmission>;
    try {
      submission = prepareBackupSubmission(form, values, {
        kind: action.kind,
        totpEnabled: Boolean(user?.totpEnabled),
        useAccountPassword,
        archiveKeyMode,
        fileValid: Boolean(file && file.size >= 52),
        restoreValid:
          action.kind !== 'restore' || (confirmation === 'replace-server' && canRestore(action.job, Date.now()) && Boolean(action.job.review)),
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Check the backup password or passphrase.');
      if (reason instanceof BackupFormError) {
        const target =
          reason.field === 'keyMode' || reason.field === 'file'
            ? form.querySelector<HTMLElement>(`[id="${id}-${reason.field}"]`)
            : form.querySelector<HTMLElement>(`[name="${reason.field}"]`);
        target?.focus();
      }
      return;
    }
    const { credentials, passphrase } = submission;
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
        const uploadedJob = await uploadBackup(job.id, file, signal, (completed, total) => {
          if (mounted.current) setUpload({ completed, total, confirmed: false });
        });
        if (mounted.current) {
          setUpload({ completed: file.size, total: file.size, confirmed: true });
          setFile(null);
          setArchiveKeyMode(null);
          setAction({ kind: 'review', job: uploadedJob });
          setWizardPurpose('review');
          setNotice('Upload complete. Enter the archive key to continue.');
        }
        return;
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
    <article className="system-backups-job" data-ready={(job.status === 'succeeded' && !job.needsRecovery) || undefined} key={job.id}>
      <h4>{new Date(job.createdAt).toLocaleString()}</h4>
      <p>{job.message}</p>
      {job.status === 'running' ? (
        <RecoveryProgress label={`Backup · ${stageLabels[job.stage] ?? 'Checking progress'}`} completed={job.completedBytes} total={job.totalBytes} />
      ) : null}
      {job.restartRequired ? <p role="alert">Apps have recovered. Restart Orbis to finish recovery before making further changes.</p> : null}
      <BackupDownloadReady job={job} disabled={busy || status.isError} onDownload={() => chooseAction({ kind: 'download', job })} />
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
        {!inWizard && job.status !== 'running' && !job.needsRecovery ? (
          <BackupRemoveTrigger
            disabled={busy || status.isError}
            onClick={(event) => openRemoval({ kind: 'export', id: job.id }, event.currentTarget)}
          />
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
          <BackupRemoveTrigger
            disabled={busy || restoreActive || status.isError}
            onClick={(event) => openRemoval({ kind: 'import', id: job.id }, event.currentTarget)}
          />
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
                  id={`${id}-file`}
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
          {phraseNeeded ? <p>Confirm with this server’s current account password. The archive key is entered separately.</p> : null}
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
          </div>
          {phraseNeeded ? (
            <BackupArchiveKeyFields
              id={id}
              mode={archiveKeyMode}
              disabled={busy}
              onChange={(mode) => {
                const field = credentialsForm.current?.querySelector<HTMLInputElement>('input[name="passphrase"]');
                if (field) field.value = '';
                setArchiveKeyMode(mode);
                setError(null);
              }}
            />
          ) : null}
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
    <section
      ref={section}
      tabIndex={-1}
      className="system-backups-settings"
      data-embedded={embedded}
      data-reduced={Boolean(reduced)}
      aria-labelledby={`${id}-title`}
    >
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
      <BackupRemovalConfirmation
        target={removal}
        anchor={removalAnchor}
        anchorRect={removalAnchorRect}
        fallback={removalFallback}
        deleted={removalDeleted}
        busy={busy}
        disabled={status.isError || restoreActive}
        error={removalError}
        onCancel={closeRemoval}
        onRemove={confirmRemoval}
      />
    </section>
  );
}
