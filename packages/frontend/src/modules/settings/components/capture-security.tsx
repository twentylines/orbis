import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconHistory } from '@tabler/icons-react';
import { useAppContext } from '@/context/app-context';
import { useUserContext } from '@/context/user-context';
import { Switch } from '@/components/ui/Switch';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { InlineFeedback } from '@/components/ui/Alert/Alert';
import { accountSecurityKey, readAccountSecurity, saveAccountSecurity } from '@/desktop/account-security-api';
import { useSettingsSave } from '../pages/settings-save';

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
  const [error, setError] = useState('');
  const enabled = draft ?? policy.data?.requireCaptureAuthentication ?? false;
  const restoreEnabled = restoreDraft ?? policy.data?.requireRestoreAuthentication ?? false;
  const dirty = Boolean(
    policy.data && (enabled !== policy.data.requireCaptureAuthentication || restoreEnabled !== Boolean(policy.data.requireRestoreAuthentication)),
  );
  const relaxing = Boolean((policy.data?.requireCaptureAuthentication && !enabled) || (policy.data?.requireRestoreAuthentication && !restoreEnabled));
  const valid = !relaxing || Boolean(password && password.length <= 1024 && (!totpEnabled || /^\d{6}$/.test(code)));
  const save = async () => {
    if (!policy.data || !valid) throw new Error('Confirm your current password before turning authentication off.');
    setSaving(true);
    setError('');
    const credentials = relaxing ? { password, ...(totpEnabled ? { totpCode: code } : {}) } : {};
    setPassword('');
    setCode('');
    try {
      const saved = await saveAccountSecurity(
        { expectedRevision: policy.data.revision, requireCaptureAuthentication: enabled, requireRestoreAuthentication: restoreEnabled },
        credentials,
        sessionAbortSignal,
      );
      queryClient.setQueryData(accountSecurityKey(ownerId), saved);
      setDraft(null);
      setRestoreDraft(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The security setting could not be saved.');
      throw reason;
    } finally {
      setSaving(false);
    }
  };
  const shared = useSettingsSave({ section: 'security', dirty, pending: saving, prepare: async () => (valid && policy.data ? save : null) });
  if (!operator) return null;
  return (
    <section id="setting-capture-authentication" className="settings-security-capture">
      <div className="settings-security-heading">
        <IconHistory aria-hidden="true" />
        <h2>Backup security</h2>
      </div>
      <Switch
        label="Require authentication for captures"
        checked={enabled}
        onCheckedChange={setDraft}
        disabled={saving || policy.isPending || policy.isError}
      />
      <p className="text-muted">
        For this account’s manual Time Machine captures. When enabled, enter your password and authentication code if configured.
      </p>
      <Switch
        label="Require authentication for backup restores"
        checked={restoreEnabled}
        onCheckedChange={setRestoreDraft}
        disabled={saving || policy.isPending || policy.isError}
      />
      <p className="text-muted">
        When enabled, restoring an uploaded backup requires your current account password and authentication code if configured.
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
          <p>Capture security could not be loaded.</p>
          <Button type="button" variant="outline" onClick={() => void policy.refetch()}>
            Retry
          </Button>
        </InlineFeedback>
      ) : null}
      {error ? <InlineFeedback>{error}</InlineFeedback> : null}
      {!shared.shared && dirty ? (
        <Button type="button" disabled={saving || !valid} onClick={() => void save().catch(() => undefined)}>
          Save
        </Button>
      ) : null}
    </section>
  );
}
