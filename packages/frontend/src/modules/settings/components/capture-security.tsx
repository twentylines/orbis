import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconHistory } from '@tabler/icons-react';
import { useAppContext } from '@/context/app-context';
import { useUserContext } from '@/context/user-context';
import { Switch } from '@/components/ui/Switch';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { InlineFeedback } from '@/components/ui/Alert/Alert';
import { accountSecurityKey, readAccountSecurity, saveAccountSecurity } from '@/desktop/account-security-api';
import { useSettingsPreferenceActivity } from '../pages/settings-save';

type PolicyPatch = { capture?: boolean; restore?: boolean };

export function CaptureSecurity() {
  const { user } = useAppContext();
  return <CaptureSecuritySession key={user.id} ownerId={user.id} operator={user.operator} totpEnabled={user.totpEnabled} />;
}
function CaptureSecuritySession({ ownerId, operator, totpEnabled }: { ownerId: number; operator: boolean; totpEnabled: boolean }) {
  const { sessionAbortSignal } = useUserContext();
  const queryClient = useQueryClient();
  const policy = useQuery({
    queryKey: accountSecurityKey(ownerId),
    queryFn: ({ signal }) => readAccountSecurity(AbortSignal.any([signal, sessionAbortSignal])),
    enabled: operator,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const [draft, setDraft] = useState<boolean | null>(null);
  const [restoreDraft, setRestoreDraft] = useState<boolean | null>(null);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const enabled = draft ?? policy.data?.requireCaptureAuthentication ?? false;
  const restoreEnabled = restoreDraft ?? policy.data?.requireRestoreAuthentication ?? false;
  const relaxCapture = policy.data?.requireCaptureAuthentication === true && draft === false;
  const relaxRestore = policy.data?.requireRestoreAuthentication === true && restoreDraft === false;
  const relaxing = relaxCapture || relaxRestore;
  const enableCapture = policy.data?.requireCaptureAuthentication === false && draft === true;
  const enableRestore = policy.data !== undefined && !policy.data.requireRestoreAuthentication && restoreDraft === true;
  const valid = !relaxing || Boolean(password && password.length <= 1024 && (!totpEnabled || /^\d{6}$/.test(code)));
  const write = async (patch: PolicyPatch, confirm = false) => {
    if (!policy.data || savingRef.current || sessionAbortSignal.aborted || (confirm && (!relaxing || !valid))) return;
    savingRef.current = true;
    setSaving(true);
    setError('');
    const credentials = confirm ? { password, ...(totpEnabled ? { totpCode: code } : {}) } : {};
    if (confirm) {
      setPassword('');
      setCode('');
    }
    try {
      const latest = confirm ? policy.data : await readAccountSecurity(sessionAbortSignal);
      sessionAbortSignal.throwIfAborted();
      const result = await saveAccountSecurity(
        {
          expectedRevision: latest.revision,
          requireCaptureAuthentication: patch.capture ?? latest.requireCaptureAuthentication,
          requireRestoreAuthentication: patch.restore ?? latest.requireRestoreAuthentication ?? false,
        },
        credentials,
        sessionAbortSignal,
      );
      sessionAbortSignal.throwIfAborted();
      queryClient.setQueryData(accountSecurityKey(ownerId), result);
      if (patch.capture !== undefined) setDraft(null);
      if (patch.restore !== undefined) setRestoreDraft(null);
      setSaved(true);
    } catch (reason) {
      if (!sessionAbortSignal.aborted) setError(reason instanceof Error ? reason.message : 'The security setting could not be saved.');
    } finally {
      savingRef.current = false;
      if (!sessionAbortSignal.aborted) setSaving(false);
    }
  };
  useSettingsPreferenceActivity(saving, saved, Boolean(error || relaxing));
  const change = (field: 'capture' | 'restore', next: boolean) => {
    const baseline = field === 'capture' ? policy.data?.requireCaptureAuthentication : Boolean(policy.data?.requireRestoreAuthentication);
    const setField = field === 'capture' ? setDraft : setRestoreDraft;
    setField(next === baseline ? null : next);
    setError('');
    if (next && next !== baseline) void write({ [field]: true });
    if (next && baseline && (field === 'capture' ? !relaxRestore : !relaxCapture)) {
      setPassword('');
      setCode('');
    }
  };
  if (!operator) return null;
  return (
    <section id="setting-capture-authentication" className="settings-security-capture">
      <div className="settings-security-heading">
        <IconHistory aria-hidden="true" />
        <h2>Backup security</h2>
      </div>
      <Switch
        label="Require authentication for backup actions"
        checked={enabled}
        onCheckedChange={(value) => change('capture', value)}
        disabled={saving || policy.isPending || policy.isError}
      />
      <p className="text-muted">
        For backup creation, downloads, saved backup imports, app recovery, and Time Machine capture or removal. Enter your password and
        authentication code when enabled.
      </p>
      <Switch
        label="Require authentication for backup restores"
        checked={restoreEnabled}
        onCheckedChange={(value) => change('restore', value)}
        disabled={saving || policy.isPending || policy.isError}
      />
      <p className="text-muted">
        When enabled, starting, stopping or recovering an uploaded-backup restore requires your current account password and authentication code if
        configured.
      </p>
      {relaxing ? (
        <>
          <Input
            type="password"
            label="Current account password"
            autoComplete="current-password"
            maxLength={1024}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={saving}
          />
          {totpEnabled ? (
            <Input
              label="Authentication code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              disabled={saving}
            />
          ) : null}
        </>
      ) : null}
      {policy.isError ? (
        <InlineFeedback>
          <p>Backup security could not be loaded.</p>
          <Button type="button" variant="outline" onClick={() => void policy.refetch()}>
            Retry
          </Button>
        </InlineFeedback>
      ) : null}
      {error ? (
        <InlineFeedback>
          {error}{' '}
          {enableCapture || enableRestore ? (
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() =>
                void write({
                  ...(enableCapture ? { capture: true } : {}),
                  ...(enableRestore ? { restore: true } : {}),
                })
              }
            >
              Retry
            </Button>
          ) : (
            <Button type="button" variant="outline" disabled={saving} onClick={() => void policy.refetch()}>
              Refresh policy
            </Button>
          )}
        </InlineFeedback>
      ) : null}
      {relaxing ? (
        <Button
          type="button"
          disabled={saving || !valid}
          onClick={() =>
            void write(
              {
                ...(relaxCapture ? { capture: false } : {}),
                ...(relaxRestore ? { restore: false } : {}),
              },
              true,
            )
          }
        >
          Confirm change
        </Button>
      ) : null}
    </section>
  );
}
