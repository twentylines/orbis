import { useId, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Switch } from '@/components/ui/Switch';
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
import { useSettingsSave } from '../pages/settings-save';

type SystemLifetime = Readonly<{ epoch: object; signal: AbortSignal; version: number }>;
type SystemWrite = SystemLifetime & { settings: { enabled: boolean; schedule?: { time: string }; expectedRevision?: number } };
type SystemDraft = { enabled: boolean | null; time: string | null | undefined; epoch: object; version: number };

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
  const activeDraft = draft?.epoch === sessionEpoch ? draft : null;
  const timeDraft = activeDraft?.time;
  const save = useMutation({
    mutationFn: async (write: SystemWrite) => {
      assertCurrent(write);
      const result = await saveSystemUpdateSchedule(write.settings, write.signal);
      assertCurrent(write);
      return result;
    },
    onSuccess: (value, write) => {
      if (write.signal.aborted || write.epoch !== currentEpoch.current) return;
      client.setQueryData(options.queryKey, value);
      setDraft((current) => (current?.epoch === write.epoch && current.version === write.version ? null : current));
    },
  });
  const currentSave = save.variables?.epoch === sessionEpoch && !save.variables.signal.aborted;
  const saving = save.isPending && currentSave;
  const value = activeDraft?.enabled ?? status.data?.settings.enabled;
  const independent = hasIndependentUpdateSchedules(status.data);
  const savedTime = status.data?.settings.schedule?.time ?? null;
  const time = useTimeField({
    value: timeDraft === undefined ? savedTime : timeDraft,
    format: preferences.appearance.timeFormat,
    onFormatChange: (timeFormat) => updateAppearance({ timeFormat }),
    onChange: (next) => {
      setDraft({ enabled: activeDraft?.enabled ?? null, time: next, epoch: sessionEpoch, version: ++editVersion.current });
      save.reset();
    },
  });
  const dirty =
    (activeDraft?.enabled != null && activeDraft.enabled !== status.data?.settings.enabled) || (timeDraft !== undefined && time.value !== savedTime);
  const prepare = async () => {
    const validTime = value || timeDraft !== undefined ? time.finish() : Boolean(time.value);
    if (value === undefined || !status.data?.available || !independent || (value && !validTime) || (timeDraft !== undefined && !validTime))
      return null;
    const write = {
      enabled: value,
      selectedTime: time.value,
      epoch: sessionEpoch,
      signal: sessionAbortSignal,
      version: activeDraft?.version ?? editVersion.current,
    };
    assertCurrent(write);
    return async () => {
      assertCurrent(write);
      const latest = await readSystemUpdateSchedule(write.signal);
      assertCurrent(write);
      if (!hasIndependentUpdateSchedules(latest)) throw new Error('Update Orbis to configure a system update schedule.');
      await save.mutateAsync({
        epoch: write.epoch,
        signal: write.signal,
        version: write.version,
        settings: {
          enabled: write.enabled,
          ...(write.selectedTime ? { schedule: { time: write.selectedTime } } : {}),
          expectedRevision: latest.revision,
        },
      });
      assertCurrent(write);
    };
  };
  const sharedSave = useSettingsSave({
    section: 'updates',
    dirty,
    pending: saving,
    prepare,
  });
  return (
    <section id="setting-system-updates" className="automatic-updates-system" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>System packages</h3>
      {status.isPending ? <output>Reading system update settings…</output> : null}
      {status.isError ? (
        <p role="alert">
          System update settings could not be read.{' '}
          <button type="button" className="btn btn-outline-primary ms-2" onClick={() => void status.refetch()}>
            Try again
          </button>
        </p>
      ) : null}
      {value !== undefined ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (sharedSave.shared) return void sharedSave.save?.();
            void prepare()
              .then((commit) => commit?.())
              .catch(() => undefined);
          }}
        >
          <fieldset className="settings-save-fields" disabled={sharedSave.pending || !independent}>
            <TimeField control={time} label="System update time" id="setting-system-update-time" disabled={saving || !status.data?.available} />
            <Switch
              label="Update system packages automatically"
              checked={value}
              disabled={saving || !status.data?.available || (!value && !time.value)}
              onCheckedChange={(enabled) => {
                setDraft({ enabled, time: timeDraft, epoch: sessionEpoch, version: ++editVersion.current });
                save.reset();
              }}
            />
            {!savedTime && !time.value ? <p>Choose a time before enabling automatic system updates.</p> : null}
            {independent ? null : <p role="note">Update Orbis to configure a separate system update schedule.</p>}
            {status.data?.pauseReason ? <p>{status.data.pauseReason}</p> : null}
            {status.data?.lastAttempt ? <p>Last system check: {status.data.lastAttempt.message ?? status.data.lastAttempt.state}</p> : null}
            {status.data?.available === false ? <p role="alert">{status.data.reason}</p> : null}
            {save.isError && currentSave ? (
              <p role="alert">{save.error instanceof Error ? save.error.message : 'System update settings could not be saved.'}</p>
            ) : null}
            {sharedSave.shared ? null : (
              <button
                className="automatic-updates-save"
                type="submit"
                disabled={!dirty || saving || !status.data?.available || Boolean(value && !time.value)}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            )}
          </fieldset>
        </form>
      ) : null}
    </section>
  );
}
