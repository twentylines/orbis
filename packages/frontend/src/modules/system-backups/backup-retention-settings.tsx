import { useEffect, useId, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/Button';
import { InlineFeedback } from '@/components/ui/Alert/Alert';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select/Select';
import { useAppContext } from '@/context/app-context';
import { useWindowVisible } from '@/desktop/window-visibility';
import { useSettingsSave } from '@/modules/settings/pages/settings-save';
import { readBackupRetention, saveBackupRetention } from './backup-api';

const periods = new Map([
  [24, '24 hours'],
  [72, '3 days'],
  [168, '7 days'],
  [720, '30 days'],
  [2160, '90 days'],
  [8760, '1 year'],
]);
export function BackupRetentionSettings({ disabled = false }: { disabled?: boolean }) {
  const id = useId();
  const { user } = useAppContext();
  const visible = useWindowVisible();
  const client = useQueryClient();
  const queryKey = ['orbis-backup-retention', user?.id];
  const status = useQuery({
    queryKey,
    queryFn: ({ signal }) => readBackupRetention(signal),
    enabled: visible && user?.operator === true,
    retry: false,
  });
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    if (user?.operator !== true) return;
    const controller = new AbortController();
    lifetime.current = controller;
    return () => {
      controller.abort();
      if (lifetime.current === controller) lifetime.current = null;
    };
  }, [user?.operator]);
  const [draft, setDraft] = useState<number | null>(null);
  const hours = draft ?? status.data?.retentionHours ?? 24;
  const save = useMutation({
    mutationFn: async (write: { hours: number; revision: number; signal: AbortSignal }) => {
      write.signal.throwIfAborted();
      return saveBackupRetention(write.hours, write.revision, write.signal);
    },
    onSuccess: (result, write) => {
      if (write.signal.aborted) return;
      client.setQueryData(queryKey, result);
      setDraft((value) => (value === write.hours ? null : value));
      void client.invalidateQueries({ queryKey: ['orbis-full-backups', user?.id] });
    },
  });
  const dirty = Boolean(status.data && hours !== status.data.retentionHours);
  const prepare = async () => {
    if (!status.data || disabled || user?.operator !== true || !lifetime.current || lifetime.current.signal.aborted) return null;
    const write = { hours, revision: status.data.revision, signal: lifetime.current.signal };
    return async () => {
      await save.mutateAsync(write);
    };
  };
  const shared = useSettingsSave({ section: 'backups', dirty, pending: save.isPending, prepare });
  const choices = new Map(periods);
  if (!choices.has(hours)) choices.set(hours, `${hours} hours`);
  return (
    <div className="system-backups-retention">
      <Select
        value={String(hours)}
        disabled={disabled || user?.operator !== true || !status.data || save.isPending || shared.pending}
        onValueChange={(value) => {
          setDraft(Number(value));
          save.reset();
        }}
      >
        <SelectTrigger id={`${id}-retention`} label="Keep server backups for" aria-describedby={`${id}-help`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {[...choices]
            .sort(([a], [b]) => a - b)
            .map(([value, label]) => (
              <SelectItem key={value} value={String(value)}>
                {label}
              </SelectItem>
            ))}
        </SelectContent>
      </Select>
      <p id={`${id}-help`}>Existing backups keep at least their current expiry date. Downloaded files stay on your computer.</p>
      {shared.shared ? null : (
        <Button
          type="button"
          intent="primary"
          disabled={!dirty || disabled || save.isPending}
          loading={save.isPending}
          onClick={() => {
            void prepare()
              .then((commit) => commit?.())
              .catch(() => undefined);
          }}
        >
          Save
        </Button>
      )}
      {status.isError || save.isError ? (
        <InlineFeedback>
          {save.isError ? 'Backup retention could not be saved. Refresh the setting before trying again.' : 'Backup retention could not be read.'}
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              save.reset();
              void status.refetch();
            }}
          >
            Refresh
          </Button>
        </InlineFeedback>
      ) : null}
    </div>
  );
}
