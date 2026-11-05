import { useRestoreDeparture } from '@/components/recovery-progress/use-restore-departure';
import { armAcceptedRestore, clearMatchingRestoreContinuity, operationContinuityStorage } from '@/components/recovery-progress/operation-continuity';
import { readOperationStatus } from '@/components/recovery-progress/operation-status';
import { RecoveryScene } from '@/components/recovery-progress/recovery-scene';
import { measuredPercent, restorePresentation, restoreFailureReason } from '@/components/recovery-progress/restore-presentation';
import { Link } from 'react-router';
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Checkbox } from '@/components/ui/Checkbox/Checkbox';
import { BackupRetentionSettings } from './backup-retention-settings';
import { SettingsHeaderAction, useSettingsHeaderActionAvailable } from '@/modules/settings/pages/settings-save';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select/Select';
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
  importSavedBackup,
  downloadBackup,
  readBackups,
  startExport,
  uploadBackup,
  type BackupCredentials,
} from './backup-api';
import {
  backupPollingInterval,
  canRestore,
  savedBackupEligible,
  formatBackupBytes,
  restoreJobSchema,
  restoreStatusSchema,
  importJobSchema,
  type BackupReview,
  type BackupSnapshot,
  type ExportJob,
  type ImportJob,
  type RestoreJob,
} from './contracts';
import { isAcceptedRestoreReconnect, shouldStopBackupStatusPolling } from './backup-reconnection';
import { restoreAfterReview } from './review-for-restore';
import { acceptRestoreAttempt, beginRestoreAttempt, restoreCanResume, restoreForAttempt, type RestoreAttempt } from './restore-attempt';
import { accountSecurityKey, readAccountSecurity } from '@/desktop/account-security-api';
import { cancelImportBeforeRestore } from './cancel-backup-preparation';
import { BackupRemoveTrigger, BackupRemovalConfirmation, type BackupRemovalTarget } from './backup-removal-confirmation';
import type { BackupRemovalRect } from './backup-removal-position';
import './system-backups-settings.css';

type Action =
  | { kind: 'export' }
  | { kind: 'upload' }
  | { kind: 'review'; job: ImportJob }
  | { kind: 'restore'; job: ImportJob }
  | { kind: 'download' | 'recover-export'; job: ExportJob }
  | { kind: 'cancel-restore' | 'recover-restore' | 'reuse'; job: RestoreJob };
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
  reuse: 'Restore saved backup',
  restore: 'Restore backup',
  download: 'Download encrypted backup',
  'recover-export': 'Recover apps',
  'cancel-restore': 'Stop restore',
  'recover-restore': 'Recover server',
};

const submitLabels: Record<Action['kind'], string> = {
  export: 'Continue',
  upload: 'Restore',
  review: 'Restore',
  reuse: 'Restore',
  restore: 'Restore',
  download: 'Download',
  'recover-export': 'Recover',
  'cancel-restore': 'Stop',
  'recover-restore': 'Recover',
};

export function BackupDownloadReady({
  job,
  disabled,
  onDownload,
}: {
  job: ExportJob;
  disabled: boolean;
  onDownload: (opener: HTMLButtonElement) => void;
}) {
  if (job.status !== 'succeeded') return null;
  return (
    <div className="system-backups-download-ready">
      <p>Save the encrypted backup to your computer.</p>
      <Button type="button" intent="primary" disabled={disabled} onClick={(event) => onDownload(event.currentTarget)}>
        Download
      </Button>
    </div>
  );
}

export function exportForDisplay(snapshot: BackupSnapshot | undefined, accepted: ExportJob | null): ExportJob | null {
  return (accepted && snapshot?.exports.jobs.find((job) => job.id === accepted.id)) || accepted;
}

export function acceptedExportStatusError(error: unknown, job: ExportJob | null | undefined): string | null {
  if (!error || job?.status !== 'running') return null;
  const auth = error instanceof BackupApiError && (error.status === 401 || error.status === 403) ? ` ${error.message}` : '';
  return `Backup started. Waiting for its status.${auth}`;
}

export function BackupMediaOption({ checked, disabled, onChange }: { checked: boolean; disabled: boolean; onChange: (value: boolean) => void }) {
  return (
    <div>
      <Checkbox checked={checked} disabled={disabled} onCheckedChange={onChange} label="Include media libraries" />
      <p>Orbis settings, accounts and managed app data are included. Shared media is excluded unless you select this option.</p>
    </div>
  );
}

export function exportStatusPollingInterval(
  snapshot: BackupSnapshot | undefined,
  visible: boolean,
  accepted: ExportJob | null,
  error?: unknown,
): number | false {
  const awaitingList = accepted && !snapshot?.exports.jobs.some((job) => job.id === accepted.id);
  if (shouldStopBackupStatusPolling(error, snapshot) && !(awaitingList && error instanceof BackupApiError && error.status === 404)) return false;
  if (visible && awaitingList) return 2500;
  return backupPollingInterval(snapshot, visible);
}

export function backupEncryptionPassphrase(values: FormData, kind: 'export' | 'review', useAccountPassword: boolean): string {
  const account = kind === 'export' && useAccountPassword;
  const passphrase = String(values.get(account ? 'password' : 'passphrase') ?? '');
  if (passphrase.length < 8 || !passphrase.trim() || passphrase.length > 1024) {
    throw new Error(
      account
        ? 'Your account password must be between 8 and 1024 characters to encrypt a backup. Choose a separate backup passphrase instead.'
        : 'Use a backup password or passphrase between 8 and 1024 characters.',
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
    uploadFromServer?: boolean;
    restoreProofRequired?: boolean;
    backupProofRequired?: boolean;
  },
) {
  const password = values.get('password');
  const code = values.get('totpCode');
  const needsCredentials =
    (['export', 'download', 'recover-export'].includes(options.kind)
      ? options.backupProofRequired === true
      : options.restoreProofRequired === true) ||
    (options.uploadFromServer === true && options.backupProofRequired === true);
  if (needsCredentials && (typeof password !== 'string' || !password.length || password.length > 1024))
    throw new BackupFormError('password', 'Enter this server’s current account password.');
  if (needsCredentials && (options.totpEnabled || (code !== null && code !== '')) && (typeof code !== 'string' || !/^\d{6}$/.test(code)))
    throw new BackupFormError('totpCode', 'Enter the six-digit authentication code for this account.');
  let passphrase = '';
  if (options.kind === 'export' || options.kind === 'review' || options.kind === 'upload' || options.kind === 'reuse') {
    const keyField = options.kind === 'export' && options.useAccountPassword ? 'password' : 'passphrase';
    if ((options.kind === 'upload' || options.kind === 'review' || options.kind === 'reuse') && needsCredentials) {
      const supplied = values.get('passphrase');
      if (!supplied && typeof password === 'string') values.set('passphrase', password);
    }
    if (typeof values.get(keyField) !== 'string') throw new BackupFormError(keyField, 'Enter the backup key.');
    try {
      passphrase = backupEncryptionPassphrase(values, options.kind === 'export' ? 'export' : 'review', options.useAccountPassword);
    } catch (error) {
      const repeat = error instanceof Error && error.message === 'The backup passphrases did not match. Enter them again.';
      throw new BackupFormError(repeat ? 'repeatPassphrase' : keyField, error instanceof Error ? error.message : 'Check the backup key.');
    }
  }
  if (options.kind === 'upload' && !options.fileValid) throw new BackupFormError('file', 'Choose a complete encrypted Orbis backup file.');
  if (options.kind === 'restore' && !options.restoreValid) throw new BackupFormError('confirmation', 'Verify this backup again before restoring.');
  for (const field of form.querySelectorAll<HTMLInputElement>('input[type="password"], input[name="totpCode"]')) field.value = '';
  return {
    credentials: {
      password: needsCredentials && typeof password === 'string' ? password : '',
      ...(needsCredentials && typeof code === 'string' && code ? { totpCode: code } : {}),
    } satisfies BackupCredentials,
    passphrase,
  };
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
          minLength={8}
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
            minLength={8}
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
            minLength={8}
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
    'volume-restore-support': 'This version of Orbis cannot restore all the app data in this backup.',
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
  allowCreate?: boolean;
  restoreOnly?: boolean;
  recoveryScene?: boolean;
  embedded?: boolean;
  initialImportId?: string;
  onActivityChange?: (active: boolean) => void;
  onDismiss?: () => void;
  recoveryActions?: ReactNode;
};

export function SystemBackupsSettings({
  allowCreate = true,
  restoreOnly = false,
  recoveryScene = false,
  embedded = false,
  initialImportId,
  onActivityChange,
  onDismiss,
  recoveryActions,
}: BackupSettingsProps = {}) {
  const id = useId();
  const reduced = useReducedMotion();
  const hasSettingsHeaderActions = useSettingsHeaderActionAvailable();
  const { user } = useAppContext();
  const accountSecurity = useQuery({
    queryKey: accountSecurityKey(user.id),
    queryFn: ({ signal }) => readAccountSecurity(signal),
    enabled: user.operator,
    retry: false,
  });
  const visible = useWindowVisible();
  const [acceptedExport, setAcceptedExport] = useState<ExportJob | null>(null);
  const status = useQuery({
    queryKey: ['orbis-full-backups', user?.id],
    queryFn: ({ signal }) => readBackups(signal),
    enabled: visible && user?.operator === true,
    retry: false,
    refetchInterval: (query) => {
      const error = query.state.error;
      return exportStatusPollingInterval(query.state.data, visible, acceptedExport, error);
    },
    refetchIntervalInBackground: false,
  });
  const [action, setAction] = useState<Action | null>(() => (restoreOnly && embedded && !initialImportId ? { kind: 'upload' } : null));
  const [restoreSource, setRestoreSource] = useState<'upload' | 'server'>('upload');
  const [savedBackupId, setSavedBackupId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [useAccountPassword, setUseAccountPassword] = useState(true);
  const [includeMedia, setIncludeMedia] = useState(false);
  const [archiveKeyMode, setArchiveKeyMode] = useState<ArchiveKeyMode | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [restoreAttempt, setRestoreAttempt] = useState<RestoreAttempt | null>(null);
  const [, setRestoreSettled] = useState(0);
  const [wizardJob, setWizardJob] = useState<{ kind: 'export' | 'import'; id: string } | null>(null);
  const [wizardPurpose, setWizardPurpose] = useState<Action['kind'] | null>(null);
  const [busy, setBusy] = useState(false);
  const [stoppingPreparation, setStoppingPreparation] = useState(false);
  const [dismissedRestoreId, setDismissedRestoreId] = useState<string | null>(null);
  const [guidedImportCleared, setGuidedImportCleared] = useState(false);
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
  const creationDownloads = useRef(new Set<string>());
  const credentialsForm = useRef<HTMLFormElement | null>(null);
  const filePicker = useRef<HTMLInputElement | null>(null);
  const mounted = useRef(true);
  const running = useRef(false);
  const awaitingRestore = useRef(false);
  const cancelPreparationRequested = useRef(false);
  const preparationWork = useRef<Promise<void> | null>(null);
  const retryArchiveKey = useRef<{ restoreId: string; passphrase: string } | null>(null);
  const formOpenedAt = useRef(Date.now());
  const observedReset = useRef<string | null | undefined>(undefined);
  const seededImport = useRef<string | null>(null);
  const actionOpener = useRef<HTMLElement | null>(null);
  const actionKeyboard = useRef(false);
  const chooseAction = (next: Action) => {
    formOpenedAt.current = Date.now();
    if (next.kind !== 'reuse') retryArchiveKey.current = null;
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
      retryArchiveKey.current = null;
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
  const trackedExport = exportForDisplay(data, acceptedExport);
  useEffect(() => {
    if (acceptedExport && data?.exports.jobs.some((job) => job.id === acceptedExport.id)) setAcceptedExport(null);
  }, [acceptedExport, data]);
  const savedBackups = (data?.exports.jobs ?? []).filter((job) => savedBackupEligible(job)).sort((a, b) => b.createdAt - a.createdAt);
  const selectedSavedBackup = savedBackups.find((job) => job.id === savedBackupId);
  useEffect(() => {
    if (!initialImportId || guidedImportCleared || seededImport.current === initialImportId || action || busy) return;
    const job = data?.imports.jobs.find((entry) => entry.id === initialImportId);
    if (!job || ['uploading', 'reviewing', 'preparing'].includes(job.status)) return;
    if (job.uploadedBytes <= 0) {
      setGuidedImportCleared(true);
      setAction({ kind: 'upload' });
      setWizardPurpose('upload');
      return;
    }
    seededImport.current = initialImportId;
    setArchiveKeyMode(null);
    setAction({ kind: canRestore(job, Date.now()) ? 'restore' : 'review', job });
    setWizardJob({ kind: 'import', id: job.id });
    setWizardPurpose('review');
    if (!embedded) setWizardOpen(true);
  }, [initialImportId, guidedImportCleared, data, action, busy, embedded]);
  const restore = restoreForAttempt(restoreAttempt, data?.restore.job);
  const terminalRestore = Boolean(restore && ['succeeded', 'rolled-back'].includes(restore.status));
  const terminalAuthority = useQuery({
    queryKey: ['orbis-restore-terminal-authority', user.id, terminalRestore ? restore?.id : null],
    queryFn: ({ signal }) => readOperationStatus(signal),
    enabled: visible && terminalRestore,
    retry: false,
    refetchInterval: (query) => (restoreCanResume(restore, query.state.data) ? false : 2000),
    refetchIntervalInBackground: false,
  });
  const restoreSettled = !status.isError && !terminalAuthority.isError && restoreCanResume(restore, terminalAuthority.data);
  const awaitingAcceptedRestore = awaitingRestore.current && !restoreSettled;
  const terminalChecking = terminalRestore && !restoreSettled;
  const guidedImportId = restoreOnly && embedded && !guidedImportCleared ? initialImportId : undefined;
  const visibleImports = guidedImportId ? data?.imports.jobs.filter((job) => job.id === guidedImportId) : data?.imports.jobs;
  const selectedImport = visibleImports?.find((job) => job.id === guidedImportId);
  const activeImport = wizardJob?.kind === 'import' ? data?.imports.jobs.find((job) => job.id === wizardJob.id) : selectedImport;
  const importRunning = activeImport && ['uploading', 'reviewing', 'preparing'].includes(activeImport.status) ? activeImport : undefined;
  const showImportSummary = !guidedImportId || !action || ['uploading', 'reviewing', 'preparing'].includes(selectedImport?.status ?? '');
  const restoreActive = Boolean(restore && (!terminalRestore || restore.needsRecovery));
  useEffect(() => {
    const reset = data?.exports.resetGeneration;
    if (
      !reset ||
      observedReset.current === reset.id ||
      restoreActive ||
      data?.restore.job?.needsRecovery ||
      busy ||
      importRunning ||
      data?.exports.jobs.some((job) => job.status === 'running' || job.needsRecovery || job.restartRequired)
    )
      return;
    observedReset.current = reset.id;
    if (formOpenedAt.current >= reset.createdAt) return;
    abort.current?.abort();
    awaitingRestore.current = false;
    retryArchiveKey.current = null;
    credentialsForm.current?.reset();
    setRestoreAttempt(null);
    setFile(null);
    setUpload(null);
    setWizardJob(null);
    setWizardOpen(false);
    setError(null);
    setNotice(null);
    setGuidedImportCleared(true);
    setAction(embedded && restoreOnly ? { kind: 'upload' } : null);
  }, [data, restoreActive, busy, importRunning, embedded, restoreOnly]);
  const continuity = useRestoreDeparture(restore?.status === 'rolled-back' ? null : restore, status.isError);
  useEffect(() => {
    if (restore && ['ready', 'running', 'recovery-required'].includes(restore.status)) awaitingRestore.current = true;
    if (restoreSettled && awaitingRestore.current) {
      awaitingRestore.current = false;
      setRestoreSettled((value) => value + 1);
    }
  }, [restore, restoreSettled]);
  useEffect(() => {
    onActivityChange?.(busy || stoppingPreparation || Boolean(importRunning) || restoreActive || terminalChecking || awaitingAcceptedRestore);
  }, [busy, stoppingPreparation, importRunning, restoreActive, terminalChecking, awaitingAcceptedRestore, onActivityChange]);
  useEffect(() => {
    if (!error || busy || awaitingAcceptedRestore || !activeImport || !canRestore(activeImport, Date.now())) return;
    if (action?.kind === 'upload' || action?.kind === 'review') {
      setAction({ kind: 'restore', job: activeImport });
      setWizardPurpose('restore');
    }
  }, [error, busy, awaitingAcceptedRestore, activeImport, action?.kind]);
  useEffect(() => () => onActivityChange?.(false), [onActivityChange]);
  const working =
    busy ||
    stoppingPreparation ||
    restoreActive ||
    terminalChecking ||
    awaitingAcceptedRestore ||
    Boolean(trackedExport && (trackedExport.status === 'running' || trackedExport.needsRecovery || trackedExport.restartRequired)) ||
    Boolean(data?.exports.jobs.some((job) => job.status === 'running' || job.needsRecovery || job.restartRequired)) ||
    Boolean(data?.imports.jobs.some((job) => ['uploading', 'reviewing', 'preparing'].includes(job.status)));
  const refresh = () => {
    void status.refetch();
    if (terminalRestore) void terminalAuthority.refetch();
  };
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
      if (mounted.current && !(cancelPreparationRequested.current && controller.signal.aborted))
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
  const submitAction = (action: Action, form: Pick<HTMLFormElement, 'querySelector' | 'querySelectorAll'>, values: FormData) => {
    if (running.current) return;
    if (action.kind === 'reuse' && retryArchiveKey.current?.restoreId === action.job.id) values.set('passphrase', retryArchiveKey.current.passphrase);
    const confirmation = 'replace-server';
    let submission: ReturnType<typeof prepareBackupSubmission>;
    try {
      if (action.kind === 'upload' && restoreSource === 'server' && !selectedSavedBackup)
        throw new BackupFormError('file', 'Choose an available server backup.');
      submission = prepareBackupSubmission(form, values, {
        kind: action.kind,
        totpEnabled: Boolean(user?.totpEnabled),
        useAccountPassword,
        archiveKeyMode,
        fileValid: restoreSource === 'server' ? Boolean(selectedSavedBackup) : Boolean(file && file.size >= 52),
        uploadFromServer: action.kind === 'upload' && restoreSource === 'server',
        restoreProofRequired:
          accountSecurity.data?.requireRestoreAuthentication === true ||
          ((action.kind === 'cancel-restore' || action.kind === 'recover-restore') && action.job.requiresFreshAuthentication === true),
        backupProofRequired: accountSecurity.data?.requireCaptureAuthentication === true,
        restoreValid: action.kind !== 'restore' || (canRestore(action.job, Date.now()) && Boolean(action.job.review)),
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
    const newAttempt = ['upload', 'review', 'restore', 'reuse'].includes(selected.kind) ? beginRestoreAttempt(data?.restore.job) : null;
    if (newAttempt) setRestoreAttempt(newAttempt);
    const work = run(
      async (signal) => {
        const verifyAndRestore = async (job: ImportJob) => {
          let accepted: unknown;
          try {
            accepted = await restoreAfterReview(job.id, passphrase, credentials, signal, backupRequest, () => {
              awaitingRestore.current = true;
            });
          } catch (error) {
            if (error instanceof BackupApiError && error.status >= 400 && error.status < 500) awaitingRestore.current = false;
            throw error;
          }
          const acceptedJob = restoreJobSchema.allows(accepted) ? accepted : restoreStatusSchema.allows(accepted) ? accepted.job : null;
          if (!acceptedJob) {
            awaitingRestore.current = true;
            throw new Error('Restore status could not be confirmed. Refresh status before trying again.');
          }
          if (newAttempt) setRestoreAttempt(acceptRestoreAttempt(newAttempt, acceptedJob));
          retryArchiveKey.current = passphrase ? { restoreId: acceptedJob.id, passphrase } : null;
          if (acceptedJob) {
            try {
              armAcceptedRestore(acceptedJob.id, sessionStorage);
            } catch {
              /* Status polling can establish a started restore. */
            }
          }
          awaitingRestore.current = true;
          setNotice('Restore accepted. Keep this page open while Orbis reconnects and checks completion.');
        };
        if (selected.kind === 'export') {
          const job = await startExport(credentials, passphrase, signal, includeMedia);
          if (job.creationDownloadAvailable) creationDownloads.current.add(job.id);
          if (mounted.current) {
            setAcceptedExport(job);
            setWizardJob({ kind: 'export', id: job.id });
            setIncludeMedia(false);
          }
        } else if (selected.kind === 'upload') {
          let uploadedJob: ImportJob;
          if (restoreSource === 'server') {
            if (!selectedSavedBackup || !savedBackupEligible(selectedSavedBackup)) throw new Error('Choose an available server backup.');
            uploadedJob = await importSavedBackup(selectedSavedBackup.id, credentials, signal);
            if (uploadedJob.status !== 'uploaded') throw new Error('The saved archive could not be imported. Review its status before retrying.');
            if (mounted.current) setWizardJob({ kind: 'import', id: uploadedJob.id });
          } else {
            if (!file || file.size < 52) throw new Error('Choose a complete encrypted Orbis backup file.');
            const job = await createImport(signal);
            if (mounted.current) setWizardJob({ kind: 'import', id: job.id });
            setUpload({ completed: 0, total: file.size, confirmed: false });
            uploadedJob = await uploadBackup(job.id, file, signal, (completed, total) => {
              if (mounted.current) setUpload({ completed, total, confirmed: false });
            });
            if (mounted.current) setUpload({ completed: file.size, total: file.size, confirmed: true });
          }
          await verifyAndRestore(uploadedJob);
        } else if (selected.kind === 'reuse') {
          const reused = await backupRequest(`/restores/${selected.job.id}/reuse`, 'POST', {}, signal);
          if (!importJobSchema.allows(reused) || reused.status !== 'uploaded')
            throw new Error('The saved restore archive is unavailable. Your recovery files have been preserved.');
          setWizardJob({ kind: 'import', id: reused.id });
          await verifyAndRestore(reused);
        } else if (selected.kind === 'review') {
          await verifyAndRestore(selected.job);
        } else if (selected.kind === 'download') {
          downloadCleanup.current?.();
          downloadCleanup.current = downloadBackup(selected.job.id, credentials, (message) => {
            if (mounted.current) setError(message);
          });
          setNotice('Download requested. Your browser shows its progress and confirms when the file has been saved.');
        } else if (selected.kind === 'restore') {
          if (!canRestore(selected.job, Date.now()) || !selected.job.review) throw new Error('Verify this backup again before restoring.');
          awaitingRestore.current = true;
          let accepted: unknown;
          try {
            accepted = await backupRequest(
              '/restores',
              'POST',
              {
                ...(credentials.password ? credentials : {}),
                importId: selected.job.id,
                manifestSha256: selected.job.review.manifestSha256,
                confirmation,
              },
              signal,
            );
          } catch (failure) {
            if (failure instanceof BackupApiError && failure.status >= 400 && failure.status < 500) awaitingRestore.current = false;
            throw failure;
          }
          const acceptedJob = restoreJobSchema.allows(accepted) ? accepted : restoreStatusSchema.allows(accepted) ? accepted.job : null;
          if (!acceptedJob) {
            awaitingRestore.current = true;
            throw new Error('Restore status could not be confirmed. Refresh status before trying again.');
          }
          if (newAttempt) setRestoreAttempt(acceptRestoreAttempt(newAttempt, acceptedJob));
          retryArchiveKey.current = passphrase ? { restoreId: acceptedJob.id, passphrase } : null;
          if (acceptedJob) {
            try {
              armAcceptedRestore(acceptedJob.id, sessionStorage);
            } catch {
              /* Status polling can still establish a started restore. */
            }
          }
          awaitingRestore.current = true;
          setNotice('Restore accepted. Keep this page open while Orbis reconnects and checks completion.');
        } else {
          const path =
            selected.kind === 'recover-export'
              ? `/${selected.job.id}/recover`
              : `/restores/${selected.job.id}/${selected.kind === 'cancel-restore' ? 'cancel' : 'recover'}`;
          await backupRequest(path, 'POST', credentials.password ? credentials : {}, signal);
        }
        if (mounted.current) setAction(null);
      },
      {
        onError: (message) => {
          if (!awaitingRestore.current && newAttempt) setRestoreAttempt(null);
          if (
            selected.kind === 'reuse' &&
            message === 'This saved archive belongs to another account. Sign in with its owner or choose an encrypted backup file.'
          ) {
            retryArchiveKey.current = null;
            setGuidedImportCleared(true);
            setAction({ kind: 'upload' });
            setWizardJob(null);
            setWizardPurpose('upload');
            setUpload(null);
          }
          setError(message);
        },
      },
    );
    if (newAttempt) preparationWork.current = work;
    void work.finally(() => {
      if (preparationWork.current === work) preparationWork.current = null;
    });
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (action) submitAction(action, event.currentTarget, new FormData(event.currentTarget));
  };
  const retrySavedRestore = () => {
    if (!restore || !restoreSettled || working || accountSecurity.isPending || accountSecurity.isError) return;
    const next: Action = { kind: 'reuse', job: restore };
    if (retryArchiveKey.current?.restoreId !== restore.id || accountSecurity.data?.requireRestoreAuthentication) {
      chooseAction(next);
      return;
    }
    const values = new FormData();
    values.set('passphrase', retryArchiveKey.current.passphrase);
    setAction(next);
    setWizardPurpose('reuse');
    if (!embedded) setWizardOpen(true);
    submitAction(next, { querySelectorAll: () => [] as unknown as NodeListOf<HTMLInputElement>, querySelector: () => null }, values);
  };
  const dismissForm = () => {
    if (running.current || stoppingPreparation || restoreActive || awaitingAcceptedRestore || terminalChecking) return;
    retryArchiveKey.current = null;
    credentialsForm.current?.reset();
    setUpload(null);
    setError(null);
    setNotice(null);
    setRestoreAttempt(null);
    if (embedded && onDismiss) {
      onActivityChange?.(false);
      onDismiss();
    } else if (embedded) {
      const retained = action && 'job' in action && ['review', 'restore'].includes(action.kind) ? (action.job as ImportJob) : null;
      setAction(retained ? { kind: canRestore(retained, Date.now()) ? 'restore' : 'review', job: retained } : { kind: 'upload' });
      setWizardJob(retained ? { kind: 'import', id: retained.id } : null);
      setWizardPurpose(retained ? 'review' : 'upload');
    } else {
      setAction(null);
      setFile(null);
      setWizardOpen(false);
    }
  };
  const cancelPreparation = async () => {
    if (cancelPreparationRequested.current || restoreActive || awaitingRestore.current) return;
    cancelPreparationRequested.current = true;
    setStoppingPreparation(true);
    setError(null);
    const importId = wizardJob?.kind === 'import' ? wizardJob.id : action && 'job' in action && action.kind === 'review' ? action.job.id : null;
    abort.current?.abort();
    try {
      await preparationWork.current;
      if (awaitingRestore.current) throw new Error('The restore may have started. Check its status before leaving.');
      const retained = await cancelImportBeforeRestore(importId);
      await status.refetch();
      if (!mounted.current) return;
      setRestoreAttempt(null);
      setUpload(null);
      retryArchiveKey.current = null;
      setNotice(null);
      setError(null);
      credentialsForm.current?.reset();
      if (embedded && onDismiss) {
        onActivityChange?.(false);
        onDismiss();
      } else {
        setAction(
          embedded && retained && retained.uploadedBytes > 0
            ? { kind: canRestore(retained, Date.now()) ? 'restore' : 'review', job: retained }
            : { kind: 'upload' },
        );
        setWizardJob(embedded && retained && retained.uploadedBytes > 0 ? { kind: 'import', id: retained.id } : null);
        setWizardPurpose(embedded && retained && retained.uploadedBytes > 0 ? 'review' : 'upload');
      }
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : 'Backup cancellation could not be confirmed. Check status.');
    } finally {
      cancelPreparationRequested.current = false;
      if (mounted.current) setStoppingPreparation(false);
    }
  };
  const continueAfterRestore = () => {
    if (!restore || !restoreSettled || busy || stoppingPreparation) return;
    retryArchiveKey.current = null;
    const storage = operationContinuityStorage();
    if (storage) clearMatchingRestoreContinuity(restore.id, storage);
    awaitingRestore.current = false;
    setDismissedRestoreId(restore.id);
    setRestoreAttempt(null);
    setAction(null);
    setWizardOpen(false);
    setError(null);
    if (embedded) {
      onActivityChange?.(false);
      if (onDismiss) onDismiss();
      else setAction({ kind: 'upload' });
    }
  };
  const simpleAction = (path: string, method = 'POST') =>
    void run(async (signal) => {
      await backupRequest(path, method, undefined, signal);
    });
  const missing = status.error instanceof BackupApiError && status.error.status === 404;
  const reconnectingAcceptedRestore = status.isError && isAcceptedRestoreReconnect(status.error, restore?.status, awaitingRestore.current);
  const currentExport =
    wizardJob?.kind === 'export'
      ? (data?.exports.jobs.find((job) => job.id === wizardJob.id) ?? (trackedExport?.id === wizardJob.id ? trackedExport : null))
      : null;
  const exportStatusError = status.isError ? acceptedExportStatusError(status.error, currentExport) : null;
  const unavailable = !data || !data.exports.available || !data.imports.available || status.isError;
  const phraseNeeded =
    action?.kind === 'review' || action?.kind === 'upload' || (action?.kind === 'reuse' && retryArchiveKey.current?.restoreId !== action.job.id);
  const needsCredentials =
    Boolean(
      action &&
        (['export', 'download', 'recover-export'].includes(action.kind)
          ? accountSecurity.data?.requireCaptureAuthentication
          : accountSecurity.data?.requireRestoreAuthentication ||
            (action.kind === 'upload' && restoreSource === 'server' && accountSecurity.data?.requireCaptureAuthentication)),
    ) || Boolean((action?.kind === 'cancel-restore' || action?.kind === 'recover-restore') && action.job.requiresFreshAuthentication);
  const accountEncryption = action?.kind === 'export' && useAccountPassword;
  const destructive = action?.kind === 'restore';
  const downloadCreated = (job: ExportJob, opener: HTMLButtonElement) => {
    const keyboard = opener.matches(':focus-visible');
    if (accountSecurity.isPending || accountSecurity.isError) {
      setError('Account security could not be checked. Retry before downloading.');
      return;
    }
    if (!accountSecurity.data?.requireCaptureAuthentication) {
      downloadCleanup.current?.();
      downloadCleanup.current = downloadBackup(job.id, {}, (message) => {
        if (mounted.current) setError(message);
      });
      setNotice('Download requested. Your browser shows its progress and confirms when the file has been saved.');
      return;
    }
    const confirmLaterDownload = () => {
      chooseAction({ kind: 'download', job });
      actionOpener.current = opener;
      actionKeyboard.current = keyboard;
    };
    if (!creationDownloads.current.delete(job.id)) {
      confirmLaterDownload();
      return;
    }
    downloadCleanup.current?.();
    downloadCleanup.current = downloadBackup(job.id, { creationSession: true }, (message) => {
      if (!mounted.current) return;
      confirmLaterDownload();
      setError(message);
    });
    setNotice('Download requested. Your browser shows its progress and confirms when the file has been saved.');
  };
  const renderExportJob = (job: ExportJob, inWizard = false) => (
    <article className="system-backups-job" data-ready={(job.status === 'succeeded' && !job.needsRecovery) || undefined} key={job.id}>
      <h4>{new Date(job.createdAt).toLocaleString()}</h4>
      <p role={job.status === 'failed' || job.status === 'interrupted' ? 'alert' : undefined}>
        {job.status === 'failed'
          ? 'Backup failed. '
          : job.status === 'interrupted'
            ? 'Backup interrupted. '
            : job.status === 'cancelled'
              ? 'Backup cancelled. '
              : ''}
        {job.message}
      </p>
      {job.status === 'running' ? (
        <RecoveryProgress label={`Backup · ${stageLabels[job.stage] ?? 'Checking progress'}`} completed={job.completedBytes} total={job.totalBytes} />
      ) : null}
      {job.restartRequired ? <p role="alert">Apps have recovered. Restart Orbis to finish recovery before making further changes.</p> : null}
      <BackupDownloadReady job={job} disabled={busy || status.isError || !data} onDownload={(opener) => downloadCreated(job, opener)} />
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
          <Button
            intent="danger"
            disabled={working || status.isError}
            onClick={() => chooseAction({ kind: canRestore(job, Date.now()) ? 'restore' : 'review', job })}
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
  const restorePanel =
    restore && dismissedRestoreId !== restore.id ? (
      <article className="system-backups-job" aria-labelledby={`${id}-restore`}>
        <h3 id={`${id}-restore`}>Server restore</h3>
        <output>{restore.message}</output>
        {restoreFailureReason(restore) ? <p>{restoreFailureReason(restore)}</p> : null}
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
          {terminalRestore && restoreSettled ? (
            <Button
              intent="danger"
              disabled={working || unavailable || accountSecurity.isPending || accountSecurity.isError}
              onClick={retrySavedRestore}
            >
              Restore saved backup
            </Button>
          ) : null}
          {terminalRestore ? (
            <Button variant="outline" onClick={restoreSettled ? continueAfterRestore : refresh} disabled={busy || terminalAuthority.isFetching}>
              {restoreSettled ? 'Continue' : 'Check status'}
            </Button>
          ) : null}
        </div>
      </article>
    ) : null;
  const credentialPanel = (
    <>
      {action && (recoveryScene || !(action.kind === 'upload' && ((busy && upload) || restoreActive || awaitingRestore.current))) ? (
        <form className="system-backups-form" ref={credentialsForm} onSubmit={submit} aria-labelledby={`${id}-action`} noValidate>
          <h3 id={`${id}-action`} className={embedded ? undefined : 'visually-hidden'} tabIndex={-1}>
            {action.kind === 'upload' ? 'Choose your backup' : actionLabels[action.kind]}
          </h3>
          {action.kind === 'upload' ? (
            <>
              <SelectionGroup role="group" aria-label="Backup location">
                <Button
                  type="button"
                  variant="outline"
                  aria-pressed={restoreSource === 'upload'}
                  disabled={busy}
                  onClick={() => setRestoreSource('upload')}
                >
                  Upload a file
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  aria-pressed={restoreSource === 'server'}
                  disabled={busy || !savedBackups.length}
                  onClick={() => setRestoreSource('server')}
                >
                  Saved on server
                </Button>
              </SelectionGroup>
              {restoreSource === 'server' ? (
                <Select value={savedBackupId} disabled={busy} onValueChange={setSavedBackupId}>
                  <SelectTrigger id={`${id}-file`} label="Server backup">
                    <SelectValue placeholder="Choose a backup" />
                  </SelectTrigger>
                  <SelectContent>
                    {savedBackups.map((job) => (
                      <SelectItem key={job.id} value={job.id}>
                        {new Date(job.createdAt).toLocaleString()}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
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
              )}
            </>
          ) : null}
          {destructive || action.kind === 'upload' || action.kind === 'review' || action.kind === 'reuse' ? (
            <>
              {destructive && action.job.review ? <Review review={action.job.review} /> : null}
              <p className="system-backups-warning">
                This replaces the server’s configuration, accounts and managed app data. Apps will stop and Orbis will restart. Keep a current backup
                before continuing.
              </p>
            </>
          ) : null}
          {needsCredentials || accountEncryption ? (
            <div className="system-backups-fields">
              <Input
                name="password"
                id={`${id}-password`}
                label={needsCredentials ? 'Current account password' : 'Account password for backup encryption'}
                type="password"
                autoComplete="current-password"
                maxLength={1024}
                required
                disabled={busy}
              />
              {needsCredentials && user?.totpEnabled ? (
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
          ) : null}
          {phraseNeeded ? (
            <Input
              name="passphrase"
              id={`${id}-passphrase`}
              label={needsCredentials ? 'Backup password (if different)' : 'Backup password'}
              type="password"
              autoComplete="off"
              maxLength={1024}
              required={!needsCredentials}
              disabled={busy}
            />
          ) : null}
          {accountSecurity.isError ? (
            <InlineFeedback>
              Account security could not be checked.{' '}
              <Button type="button" variant="outline" onClick={() => void accountSecurity.refetch()}>
                Retry
              </Button>
            </InlineFeedback>
          ) : null}
          {action.kind === 'export' ? (
            <>
              <BackupMediaOption checked={includeMedia} disabled={busy} onChange={setIncludeMedia} />
              <BackupEncryptionFields
                id={id}
                useAccountPassword={useAccountPassword}
                disabled={busy}
                onChange={(value) => {
                  setUseAccountPassword(value);
                  setError(null);
                }}
              />
            </>
          ) : null}
          <div className="system-backups-actions">
            {embedded && action.kind === 'upload' && !onDismiss ? null : (
              <Button
                type="button"
                variant="outline"
                disabled={busy || stoppingPreparation}
                onClick={() => {
                  if (
                    wizardJob?.kind === 'import' &&
                    data?.imports.jobs.some((job) => job.id === wizardJob.id && ['uploading', 'reviewing'].includes(job.status))
                  )
                    void cancelPreparation();
                  else dismissForm();
                }}
              >
                {action.kind === 'cancel-restore' ? 'Back' : 'Cancel'}
              </Button>
            )}
            <Button
              type="submit"
              intent={destructive ? 'danger' : 'primary'}
              disabled={
                busy ||
                unavailable ||
                accountSecurity.isPending ||
                accountSecurity.isError ||
                (['export', 'upload', 'review', 'restore', 'reuse'].includes(action.kind) && working) ||
                (action.kind === 'upload' && restoreSource === 'upload' && !file) ||
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
          {busy && !upload.confirmed && !recoveryScene ? (
            <div className="system-backups-actions">
              <Button type="button" variant="outline" onClick={() => void cancelPreparation()} disabled={stoppingPreparation}>
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
  const sceneRestore = restore ? restorePresentation(restore, status.isError) : undefined;
  const showRestoreScene = Boolean(restoreActive || awaitingAcceptedRestore || continuity.departing || (busy && action?.kind === 'restore'));
  const showImportScene =
    recoveryScene &&
    !showRestoreScene &&
    (stoppingPreparation || (!error && Boolean((busy && action && ['upload', 'review', 'reuse'].includes(action.kind)) || importRunning)));
  const sceneStatus = showRestoreScene
    ? status.error instanceof BackupApiError && status.error.status === 401
      ? 'Sign in to check restore status'
      : (sceneRestore?.status ?? 'Starting restore')
    : stoppingPreparation
      ? 'Stopping backup preparation'
      : upload && busy && !upload.confirmed
        ? 'Uploading encrypted backup'
        : importRunning
          ? (stageLabels[importRunning.stage] ?? 'Checking backup')
          : 'Checking backup';
  const sceneCompleted = upload && busy && !upload.confirmed ? upload.completed : importRunning?.completedBytes;
  const sceneTotal = upload && busy && !upload.confirmed ? upload.total : importRunning?.totalBytes;
  const sceneDetail = showRestoreScene
    ? sceneRestore?.detail
    : sceneCompleted !== undefined && sceneTotal != null
      ? `${formatBackupBytes(sceneCompleted)} of ${formatBackupBytes(sceneTotal)}`
      : undefined;
  const wizardLocked = busy || stoppingPreparation || restoreActive || awaitingAcceptedRestore || terminalChecking;
  const wizardExport =
    wizardJob?.kind === 'export'
      ? (data?.exports.jobs.find((job) => job.id === wizardJob.id) ?? (trackedExport?.id === wizardJob.id ? trackedExport : undefined))
      : undefined;
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
      <RecoveryScene
        open={showRestoreScene || showImportScene}
        title={showRestoreScene ? (sceneRestore?.title ?? 'Restoring') : 'Preparing backup'}
        status={sceneStatus}
        detail={sceneDetail}
        progress={
          showRestoreScene ? sceneRestore?.progress : sceneCompleted !== undefined ? measuredPercent(sceneCompleted, sceneTotal ?? null) : undefined
        }
        active={showRestoreScene ? !status.isError && (sceneRestore?.active ?? true) : showImportScene}
        departing={continuity.departing}
        actions={
          <>
            {showRestoreScene && !busy && restoreAttempt && !restoreAttempt.acceptedId ? (
              <Button onClick={() => window.location.reload()}>Check status</Button>
            ) : null}
            {showRestoreScene && status.isError ? <Button onClick={refresh}>Reconnect</Button> : null}
            {showRestoreScene && status.error instanceof BackupApiError && status.error.status === 401 ? (
              <Link className="btn" to="/login">
                Sign in
              </Link>
            ) : null}
            {showRestoreScene && !status.isError && !continuity.departing && ['succeeded', 'rolled-back'].includes(restore?.status ?? '') ? (
              <Button onClick={() => window.location.assign('/')}>Open server</Button>
            ) : null}
            {showRestoreScene && restore?.canCancel && !status.isError ? (
              <Button disabled={busy} onClick={() => chooseAction({ kind: 'cancel-restore', job: restore })}>
                Cancel
              </Button>
            ) : null}
            {showRestoreScene && restore?.canRecover && !status.isError ? (
              <Button disabled={busy} onClick={() => chooseAction({ kind: 'recover-restore', job: restore })}>
                Recover
              </Button>
            ) : null}
            {showImportScene && !awaitingRestore.current ? (
              <Button disabled={stoppingPreparation || status.isError} onClick={() => void cancelPreparation()}>
                {stoppingPreparation ? 'Stopping…' : 'Cancel'}
              </Button>
            ) : null}
          </>
        }
      />
      <div className="system-backups-overview">
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
              <h2 id={`${id}-title`}>{restoreOnly ? 'Restore a backup' : allowCreate ? 'Full backup & recovery' : 'Older full backups'}</h2>
            )}
            {hasSettingsHeaderActions && !embedded ? (
              <SettingsHeaderAction>
                <Button variant="outline" type="button" onClick={refresh} disabled={status.isFetching || busy}>
                  Refresh
                </Button>
              </SettingsHeaderAction>
            ) : (
              <Button variant="outline" type="button" onClick={refresh} disabled={status.isFetching || busy}>
                Refresh
              </Button>
            )}
          </div>
        )}
        {embedded ? null : (
          <p>
            {restoreOnly
              ? 'Verify the encrypted archive before replacing this server’s configuration and managed app data.'
              : allowCreate
                ? 'Orbis configuration, accounts and managed app data are backed up together in an encrypted file. Shared media is optional. Apps pause while their data is copied to keep it consistent.'
                : 'Download saved full backups or verify an older archive before restoring it. These archives can include managed app data. Restoring one pauses apps and restarts Orbis.'}
          </p>
        )}
        {status.isPending ? <output>Reading backup capabilities…</output> : null}
      </div>
      {status.isError ? (
        <InlineFeedback>
          {exportStatusError ??
            (reconnectingAcceptedRestore
              ? 'Orbis is reconnecting after the accepted restore. The status below shows the last confirmed progress; the new server has not replied yet.'
              : missing
                ? 'This server does not provide the full backup and restore API. Update Orbis, then refresh status.'
                : status.error.message)}
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
          {allowCreate ? (
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
          ) : null}
          <div>
            <h3>Restore a backup</h3>
            <p>
              Choose a saved server backup or upload an archive, then verify it. Restoring replaces this server’s configuration and managed app data.
            </p>
            <Button type="button" variant="outline" disabled={working || unavailable} onClick={() => chooseAction({ kind: 'upload' })}>
              Restore
            </Button>
          </div>
        </div>
      )}
      {restoreOnly ? null : <BackupRetentionSettings key={user?.id} disabled={working || unavailable} />}
      {embedded || restoreOnly ? null : recoveryActions}
      {restoreOnly && data?.exports.jobs.some((job) => job.status === 'running' || job.needsRecovery || job.restartRequired) ? (
        <InlineFeedback>Finish the existing full backup or its app recovery in Settings before starting a restore.</InlineFeedback>
      ) : null}
      {embedded ? credentialPanel : null}
      {guidedImportId && data && !selectedImport && !busy && !restoreActive && !awaitingAcceptedRestore ? (
        <InlineFeedback>
          This received backup is no longer available. Choose another backup to continue.
          <Button
            type="button"
            variant="outline"
            disabled={terminalChecking}
            onClick={() => {
              setGuidedImportCleared(true);
              setAction({ kind: 'upload' });
              setWizardJob(null);
              setWizardPurpose('upload');
              setError(null);
            }}
          >
            Choose another backup
          </Button>
        </InlineFeedback>
      ) : null}
      {!restoreOnly && (data?.exports.jobs.length || trackedExport) ? (
        <div className="system-backups-jobs">
          <h3>Server backups</h3>
          {[
            ...(data?.exports.jobs ?? []),
            ...(trackedExport && !data?.exports.jobs.some((job) => job.id === trackedExport.id) ? [trackedExport] : []),
          ]
            .sort((a, b) => b.createdAt - a.createdAt)
            .map((job) => renderExportJob(job))}
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
            hideClose={
              Boolean(action && action.kind !== 'cancel-restore') ||
              Boolean(restoringInWizard && restore?.canCancel) ||
              Boolean(wizardImport && ['uploading', 'reviewing'].includes(wizardImport.status))
            }
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
                  {exportStatusError ??
                    (reconnectingAcceptedRestore
                      ? 'Orbis is reconnecting after the accepted restore. Waiting for confirmed status.'
                      : status.error.message)}
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
