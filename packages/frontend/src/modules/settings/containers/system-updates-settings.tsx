import { useId, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useWindowVisible } from '@/desktop/window-visibility';
import {
  saveSystemUpdateSchedule,
  readSystemUpdateSchedule,
  systemUpdateScheduleOptions,
  hasIndependentUpdateSchedules,
} from '@/desktop/automatic-updates-api';
import { TimeField, useTimeField } from '@/components/ui/TimeField/TimeField';
import { useUserContext } from '@/context/user-context';
import { useDesktopPreferences } from '@/desktop/preferences';
import { useDebouncedPreferenceSave } from '../hooks/use-debounced-preference-save';
import { InlineFeedback } from '@/components/ui/Alert/Alert';
import { AutosavedSettingSwitch } from '../components/autosaved-setting-switch';
import { systemSettingsScope, useSystemUpdateToggle } from '../hooks/use-update-setting-toggles';

type SystemLifetime = Readonly<{ epoch: object; signal: AbortSignal; version: number }>;
type SystemWrite = SystemLifetime & { time: string };
type SystemDraft = { time: string | null; epoch: object; version: number };

export function SystemUpdatesSettings() {
  const id = useId();
  const visible = useWindowVisible();
  const { preferences, updateAppearance } = useDesktopPreferences();
  const client = useQueryClient();
  const { sessionEpoch, sessionAbortSignal } = useUserContext();
  const currentEpoch = useRef(sessionEpoch);
  currentEpoch.current = sessionEpoch;
  const editVersion = useRef(0);
  const assertCurrent = (write: SystemLifetime) => {
    write.signal.throwIfAborted();
    if (write.epoch !== currentEpoch.current) throw new DOMException('The settings session changed.', 'AbortError');
  };
  const options = systemUpdateScheduleOptions();
  const status = useQuery({ ...options, enabled: visible });
  const [draft, setDraft] = useState<SystemDraft | null>(null);
  const [requested, setRequested] = useState<SystemWrite | null>(null);
  const activeDraft = draft?.epoch === sessionEpoch ? draft : null;
  const timeDraft = activeDraft?.time;
  const toggle = useSystemUpdateToggle(status.data, visible);
  const save = useMutation({
    scope: { id: systemSettingsScope },
    networkMode: 'always',
    retry: false,
    mutationFn: async (write: SystemWrite) => {
      assertCurrent(write);
      const latest = await readSystemUpdateSchedule(write.signal);
      assertCurrent(write);
      if (!hasIndependentUpdateSchedules(latest)) throw new Error('Update Orbis to configure a system update schedule.');
      const result = await saveSystemUpdateSchedule(
        { enabled: latest.settings.enabled, schedule: { time: write.time }, expectedRevision: latest.revision },
        write.signal,
      );
      assertCurrent(write);
      return result;
    },
    onSuccess: (value, write) => {
      if (write.signal.aborted || write.epoch !== currentEpoch.current) return;
      client.setQueryData(options.queryKey, value);
      setDraft((current) => (current?.epoch === write.epoch && current.version === write.version ? null : current));
      setRequested((current) => (current === write ? null : current));
    },
  });
  const independent = hasIndependentUpdateSchedules(status.data);
  const savedTime = status.data?.settings.schedule?.time ?? null;
  const time = useTimeField({
    value: timeDraft === undefined ? savedTime : timeDraft,
    format: preferences.appearance.timeFormat,
    onFormatChange: (timeFormat) => updateAppearance({ timeFormat }),
    onChange: (next) => {
      setDraft({ time: next, epoch: sessionEpoch, version: ++editVersion.current });
    },
  });
  const ready = Boolean(status.data?.available && independent);
  const write = requested?.epoch === sessionEpoch && requested.time === time.value ? requested : null;
  const autosave = useDebouncedPreferenceSave(
    write ? String(write.version) : null,
    async () => {
      if (write) await save.mutateAsync(write);
    },
    { delay: 0, ready, signal: sessionAbortSignal, unsaved: activeDraft !== null && time.value !== savedTime },
  );
  const commitTime = (next: string) => {
    if (next === savedTime) {
      setDraft(null);
      setRequested(null);
      return;
    }
    if (requested?.time === next && requested.epoch === sessionEpoch) return;
    setRequested({ time: next, epoch: sessionEpoch, signal: sessionAbortSignal, version: editVersion.current });
  };
  return (
    <section id="setting-system-updates" className="automatic-updates-settings automatic-updates-system" aria-labelledby={`${id}-title`}>
      <header>
        <h2 id={`${id}-title`}>System packages</h2>
      </header>
      {status.isPending ? <output>Reading system update settings…</output> : null}
      {status.isError ? (
        <p role="alert">
          System update settings could not be read.{' '}
          <button type="button" className="btn btn-outline-primary ms-2" onClick={() => void status.refetch()}>
            Try again
          </button>
        </p>
      ) : null}
      {status.data ? (
        <fieldset className="settings-save-fields" disabled={!independent}>
          <TimeField
            control={time}
            label="System update time"
            id="setting-system-update-time"
            disabled={autosave.pending || !ready}
            onCommit={commitTime}
          />
          <AutosavedSettingSwitch label="Update system packages automatically" toggle={toggle} />
          {savedTime ? null : <p>Set an update time before enabling automatic system updates.</p>}
          {independent ? null : <p role="note">Update Orbis to configure a separate system update schedule.</p>}
          {status.data?.pauseReason ? <p>{status.data.pauseReason}</p> : null}
          {status.data?.lastAttempt ? <p>Last system check: {status.data.lastAttempt.message ?? status.data.lastAttempt.state}</p> : null}
          {status.data?.available === false ? <p role="alert">{status.data.reason}</p> : null}
          {autosave.error ? (
            <InlineFeedback>
              {autosave.error}{' '}
              <button type="button" className="btn btn-outline-primary" onClick={autosave.retry}>
                Retry
              </button>
            </InlineFeedback>
          ) : null}
        </fieldset>
      ) : null}
    </section>
  );
}
