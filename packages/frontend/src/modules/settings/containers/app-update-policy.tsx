import { createContext, useContext, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Switch } from '@/components/ui/Switch';
import { InlineFeedback } from '@/components/ui/Alert/Alert';
import { useUserContext } from '@/context/user-context';
import { useWindowVisible } from '@/desktop/window-visibility';
import {
  automaticUpdateSettingsOptions,
  hasIndependentUpdateSchedules,
  readAutomaticUpdateSettings,
  saveAutomaticUpdateSettings,
} from '@/desktop/automatic-updates-api';
import { useSettingsSave } from '../pages/settings-save';

type PolicyWrite = Readonly<{ selected: boolean; epoch: object; signal: AbortSignal; version: number }>;
type AppPolicy = { enabled: boolean; disabled: boolean; change: (enabled: boolean, section: 'store' | 'updates') => void; error: string | null };
const AppPolicyContext = createContext<AppPolicy | null>(null);

export function AppUpdatePolicyProvider({ children }: { children: ReactNode }) {
  const visible = useWindowVisible();
  const client = useQueryClient();
  const { sessionAbortSignal, sessionEpoch } = useUserContext();
  const currentEpoch = useRef(sessionEpoch);
  currentEpoch.current = sessionEpoch;
  const editVersion = useRef(0);
  const assertCurrent = (write: PolicyWrite) => {
    write.signal.throwIfAborted();
    if (write.epoch !== currentEpoch.current) throw new DOMException('The settings session changed.', 'AbortError');
  };
  const options = automaticUpdateSettingsOptions();
  const status = useQuery({ ...options, enabled: visible });
  const [draft, setDraft] = useState<{ enabled: boolean; section: 'store' | 'updates'; epoch: object; version: number } | null>(null);
  const activeDraft = draft?.epoch === sessionEpoch ? draft : null;
  const enabled = activeDraft?.enabled ?? status.data?.settings.apps?.enabled ?? false;
  const save = useMutation({
    mutationFn: async (write: PolicyWrite) => {
      assertCurrent(write);
      const latest = await readAutomaticUpdateSettings(write.signal);
      assertCurrent(write);
      const result = await saveAutomaticUpdateSettings(
        { ...latest.settings, apps: { enabled: write.selected } },
        hasIndependentUpdateSchedules(latest) ? { expectedRevision: latest.revision } : {},
        write.signal,
      );
      assertCurrent(write);
      return result;
    },
    onSuccess: (result, write) => {
      if (write.signal.aborted || write.epoch !== currentEpoch.current) return;
      client.setQueryData(options.queryKey, result);
      setDraft((current) => (current?.epoch === write.epoch && current.version === write.version ? null : current));
    },
  });
  const currentSave = save.variables?.epoch === sessionEpoch && !save.variables.signal.aborted;
  const shared = useSettingsSave({
    section: activeDraft?.section ?? 'store',
    dirty: activeDraft !== null && enabled !== (status.data?.settings.apps?.enabled ?? false),
    pending: save.isPending && currentSave,
    prepare: async () => {
      if (!status.data || (enabled && !status.data.available)) return null;
      const write: PolicyWrite = {
        selected: enabled,
        epoch: sessionEpoch,
        signal: sessionAbortSignal,
        version: activeDraft?.version ?? editVersion.current,
      };
      assertCurrent(write);
      return async () => {
        assertCurrent(write);
        await save.mutateAsync(write);
        assertCurrent(write);
      };
    },
  });
  return (
    <AppPolicyContext.Provider
      value={{
        enabled,
        disabled: shared.pending || !status.data || (!status.data.available && !enabled),
        change: (next, section) => {
          setDraft({ enabled: next, section, epoch: sessionEpoch, version: ++editVersion.current });
          save.reset();
        },
        error:
          save.isError && currentSave
            ? 'App update settings could not be saved. Try again.'
            : status.isError
              ? 'App update settings could not be read.'
              : null,
      }}
    >
      {children}
    </AppPolicyContext.Provider>
  );
}

export function AutomaticAppUpdateSwitch({ section = 'updates' }: { section?: 'store' | 'updates' }) {
  const policy = useContext(AppPolicyContext);
  if (!policy) throw new Error('App update controls require their settings provider.');
  return (
    <div className="automatic-app-update-switch">
      <Switch
        label="Update apps automatically"
        checked={policy.enabled}
        disabled={policy.disabled}
        onCheckedChange={(enabled) => policy.change(enabled, section)}
      />
      {policy.error ? <InlineFeedback>{policy.error}</InlineFeedback> : null}
    </div>
  );
}
