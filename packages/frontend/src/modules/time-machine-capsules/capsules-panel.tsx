import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { IconTrash } from '@tabler/icons-react';
import type { CapsuleJob } from '@runtipi/common/schemas/time-machine-capsule';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { InlineFeedback } from '@/components/ui/Alert/Alert';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/Dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select/Select';
import { RecoveryProgress } from '@/components/recovery-progress/recovery-progress';
import { useAppContext } from '@/context/app-context';
import { downloadBackup } from '@/modules/system-backups/backup-api';
import { formatBackupBytes } from '@/modules/system-backups/contracts';
import { BackupEncryptionFields, backupEncryptionPassphrase } from '@/modules/system-backups/system-backups-settings';
import { readTimeMachinePoints } from '@/modules/time-machine/time-machine-api';
import { capsuleAction, capsuleRequest, readCapsules, uploadCapsule } from './capsule-api';
import './capsules-panel.css';

type Action = { kind: 'export' } | { kind: 'upload' } | { kind: 'download' | 'review' | 'remove'; job: CapsuleJob };
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
export function TimeMachineCapsules({ visible = true }: { visible?: boolean }) {
  const { user } = useAppContext();
  const id = useId();
  const [action, setAction] = useState<Action | null>(null);
  const [point, setPoint] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [accountPassword, setAccountPassword] = useState(false);
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
    enabled: visible,
    refetchInterval: (query) => (visible && query.state.data?.jobs.some((job) => ['running', 'verifying'].includes(job.status)) ? 2000 : false),
    retry: false,
  });
  const points = useQuery({
    queryKey: ['capsule-sealed-points', user.id],
    queryFn: ({ signal }) => readTimeMachinePoints(signal),
    enabled: visible,
    staleTime: 30_000,
    refetchInterval: false,
    retry: false,
  });
  const sealed = points.data?.points.filter((point) => point.status === 'sealed' && point.metadata?.version === 2) ?? [];
  useEffect(
    () => () => {
      abort.current?.abort();
      download.current?.();
    },
    [],
  );
  const open = (value: Action) => {
    form.current?.reset();
    setError(null);
    setNotice(null);
    setAccountPassword(false);
    setFile(null);
    setAction(value);
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !action) return;
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
      if (action.kind === 'export' && !sealed.some((item) => item.id === point)) throw new Error('Choose a sealed Time Machine capture.');
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
      if (action.kind === 'export') await capsuleAction(`/points/${point}/export`, { ...credentials, passphrase }, controller.signal);
      else if (action.kind === 'upload') {
        const job = await capsuleAction('/imports', credentials, controller.signal);
        await uploadCapsule(job.id, file as File, controller.signal);
      } else if (action.kind === 'review') await capsuleAction(`/imports/${action.job.id}/review`, { ...credentials, passphrase }, controller.signal);
      else if (action.kind === 'download') {
        download.current?.();
        download.current = downloadBackup(action.job.id, credentials, setError, 'capture');
      } else await capsuleRequest(`/${action.job.id}/remove`, 'POST', credentials, controller.signal);
      setAction(null);
      setNotice(action.kind === 'download' ? 'Download requested. Check your browser downloads.' : null);
      await jobs.refetch();
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'The capture request was not confirmed.');
    } finally {
      setBusy(false);
      abort.current = null;
    }
  };
  if (!sealed.length && !jobs.data?.jobs.length && !jobs.isError && !points.isError) return null;
  return (
    <section className="capsules-panel" aria-labelledby={`${id}-title`}>
      <header>
        <h3 id={`${id}-title`}>Download captures</h3>
        <Button
          variant="outline"
          disabled={busy || jobs.isFetching}
          onClick={() => {
            void jobs.refetch();
            void points.refetch();
          }}
        >
          Refresh
        </Button>
      </header>
      <p>Save encrypted copies of your captures to your computer.</p>
      <div className="capsules-actions">
        <Button variant="outline" disabled={busy || !sealed.length || jobs.isError} onClick={() => open({ kind: 'export' })}>
          Save capture
        </Button>
      </div>
      {points.isError ? <InlineFeedback>Saved captures could not be loaded. Select Refresh to try again.</InlineFeedback> : null}
      {!sealed.length && !points.isPending && !points.isError ? <p>Create a Time Machine capture before saving one to your computer.</p> : null}
      {jobs.isError ? <InlineFeedback>{jobs.error.message}</InlineFeedback> : null}
      {notice ? <output aria-live="polite">{notice}</output> : null}
      <div className="capsules-list">
        {jobs.data?.jobs.map((job) => (
          <article key={job.id}>
            <div>
              <h3>{job.kind === 'export' ? 'Saved capture' : 'Uploaded capture'}</h3>
              <p>{new Date(job.createdAt).toLocaleString()}</p>
              <output>{statusCopy[job.status]}</output>
              {job.bytes ? <p>{formatBackupBytes(job.bytes)}</p> : null}
              {['running', 'verifying'].includes(job.status) ? (
                <RecoveryProgress label={statusCopy[job.status]} completed={job.completedBytes} total={job.totalBytes} />
              ) : null}
            </div>
            <div className="capsules-actions">
              {job.kind === 'export' && job.status === 'ready' ? (
                <Button intent="primary" disabled={busy} onClick={() => open({ kind: 'download', job })}>
                  Download
                </Button>
              ) : null}
              {job.kind === 'import' && ['uploaded', 'failed'].includes(job.status) && job.bytes > 0 ? (
                <Button variant="outline" disabled={busy} onClick={() => open({ kind: 'review', job })}>
                  Verify
                </Button>
              ) : null}
              <Button variant="outline" intent="danger" disabled={busy} onClick={() => open({ kind: 'remove', job })}>
                {['running', 'verifying'].includes(job.status) ? null : <IconTrash size={18} aria-hidden="true" />}
                {['running', 'verifying'].includes(job.status) ? 'Cancel' : 'Remove'}
              </Button>
            </div>
          </article>
        ))}
      </div>
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
                ? 'Save capture'
                : action?.kind === 'upload'
                  ? 'Upload capture'
                  : action?.kind === 'review'
                    ? 'Verify capture'
                    : action?.kind === 'download'
                      ? 'Download capture'
                      : 'Remove archive?'}
            </DialogTitle>
            <DialogDescription className={action?.kind === 'remove' ? undefined : 'visually-hidden'}>
              {action?.kind === 'remove'
                ? 'Remove only this server’s archive copy. Installed apps and Time Machine points are kept.'
                : 'Confirm with your current account password.'}
            </DialogDescription>
          </DialogHeader>
          <form ref={form} onSubmit={submit} className="capsules-form">
            {action?.kind === 'export' ? (
              <Select value={point} onValueChange={setPoint} disabled={busy}>
                <SelectTrigger label="Saved capture">
                  <SelectValue placeholder="Choose a capture" />
                </SelectTrigger>
                <SelectContent>
                  {sealed.map((point) => (
                    <SelectItem key={point.id} value={point.id}>
                      {new Date(point.createdAt).toLocaleString()}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
              <Button type="button" variant="outline" disabled={busy} onClick={() => setAction(null)}>
                Cancel
              </Button>
              <Button type="submit" intent={action?.kind === 'remove' ? 'danger' : 'primary'} disabled={busy} aria-busy={busy}>
                {action?.kind === 'remove' ? <IconTrash size={18} aria-hidden="true" /> : null}
                {action?.kind === 'export'
                  ? 'Save'
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
      {error && !action ? <InlineFeedback>{error}</InlineFeedback> : null}
    </section>
  );
}
