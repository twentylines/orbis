import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { appUpdateScheduleOptions, saveAppUpdateSchedule, type AppUpdateRule } from '@/desktop/automatic-updates-api';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
import './app-update-schedule.css';

export function AppUpdateSchedule({ urn, name }: { urn: string; name: string }) {
  const id = useId();
  const client = useQueryClient();
  const options = appUpdateScheduleOptions(urn);
  const status = useQuery(options);
  const [draft, setDraft] = useState<AppUpdateRule | null>(null);
  const rule: AppUpdateRule = draft ?? status.data?.rule ?? { mode: 'disabled' };
  const save = useMutation({
    mutationFn: (value: AppUpdateRule) => saveAppUpdateSchedule(urn, value),
    onSuccess: (value) => {
      client.setQueryData(options.queryKey, value);
      setDraft(null);
    },
    retry: false,
  });
  const change = (value: AppUpdateRule) => {
    setDraft(value);
    save.reset();
  };
  return (
    <section className="app-update-schedule" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>Automatic updates</h3>
      <p>Choose when {name} can update. Updates can restart this app.</p>
      {status.isPending ? <output>Reading update schedule…</output> : null}
      {status.isError ? (
        <p role="alert">
          The schedule could not be loaded.{' '}
          <button type="button" className="btn btn-secondary" onClick={() => void status.refetch()}>
            Retry
          </button>
        </p>
      ) : null}
      {status.data ? (
        <>
          <Select
            value={rule.mode}
            disabled={save.isPending}
            onValueChange={(mode) => {
              if (mode === 'custom') change({ mode, time: status.data?.shared.time ?? '03:00' });
              else if (mode === 'disabled' || mode === 'global') change({ mode });
            }}
          >
            <SelectTrigger id={`${id}-mode`} label="Update schedule">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="disabled">Disabled</SelectItem>
              <SelectItem value="global" disabled={!status.data.available}>
                Shared schedule
              </SelectItem>
              <SelectItem value="custom" disabled={!status.data.available}>
                Custom time
              </SelectItem>
            </SelectContent>
          </Select>
          {rule.mode === 'disabled' ? (
            <p>This app updates only when you request it.</p>
          ) : (
            <p>
              Daily at {rule.mode === 'custom' ? rule.time : status.data.shared.time} ({status.data.shared.timezone}).
            </p>
          )}
          {rule.mode === 'custom' ? (
            <div className="app-update-time">
              <label htmlFor={`${id}-time`}>Update time</label>
              <input
                className="form-control"
                id={`${id}-time`}
                type="time"
                required
                value={rule.time ?? ''}
                disabled={save.isPending}
                onChange={(event) => change({ mode: 'custom', time: event.target.value })}
              />
            </div>
          ) : null}
          {status.data.reason ? <p>{status.data.reason}</p> : null}
          <div className="app-update-schedule-actions">
            <button
              className="btn btn-primary"
              type="button"
              disabled={
                !draft ||
                (!status.data.available && rule.mode !== 'disabled') ||
                save.isPending ||
                (rule.mode === 'custom' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(rule.time ?? ''))
              }
              onClick={() => save.mutate(rule)}
            >
              {save.isPending ? 'Saving…' : 'Save schedule'}
            </button>
            <output aria-live="polite">{save.isSuccess ? 'Schedule saved.' : ''}</output>
          </div>
          {save.isError ? <p role="alert">{save.error.message}</p> : null}
        </>
      ) : null}
    </section>
  );
}
