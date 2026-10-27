import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Switch } from '@/components/ui/Switch';
import { useWindowVisible } from '@/desktop/window-visibility';
import { saveSystemUpdateSchedule, systemUpdateScheduleOptions } from '@/desktop/automatic-updates-api';

export function SystemUpdatesSettings() {
  const id = useId();
  const visible = useWindowVisible();
  const client = useQueryClient();
  const options = systemUpdateScheduleOptions();
  const status = useQuery({ ...options, enabled: visible });
  const [draft, setDraft] = useState<boolean | null>(null);
  const save = useMutation({
    mutationFn: saveSystemUpdateSchedule,
    onSuccess: (value) => {
      client.setQueryData(options.queryKey, value);
      setDraft(null);
    },
  });
  const value = draft ?? status.data?.settings.enabled;
  return (
    <section className="automatic-updates-system" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>System packages</h3>
      <p>
        Updates Ubuntu 24.04 packages at the saved daily time, without upgrading Ubuntu’s release. Services may restart; server restarts stay manual.
      </p>
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
            if (draft !== null) save.mutate({ enabled: value });
          }}
        >
          <Switch
            label="Update system packages automatically"
            checked={value}
            disabled={save.isPending || !status.data?.available}
            onCheckedChange={(enabled) => {
              setDraft(enabled);
              save.reset();
            }}
          />
          {status.data?.pauseReason ? <p>{status.data.pauseReason}</p> : null}
          {status.data?.lastAttempt ? <p>Last system check: {status.data.lastAttempt.message ?? status.data.lastAttempt.state}</p> : null}
          {status.data?.available === false ? <p role="alert">{status.data.reason}</p> : null}
          {save.isError ? (
            <p role="alert">{save.error instanceof Error ? save.error.message : 'System update settings could not be saved.'}</p>
          ) : null}
          {save.isSuccess ? <output>System update settings saved.</output> : null}
          <button
            className="automatic-updates-save"
            type="submit"
            disabled={draft === null || draft === status.data?.settings.enabled || save.isPending || !status.data?.available}
          >
            {save.isPending ? 'Saving…' : 'Save system update settings'}
          </button>
        </form>
      ) : null}
    </section>
  );
}
