import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/Button';
import { InlineFeedback } from '@/components/ui/Alert/Alert';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select/Select';
import { useAppContext } from '@/context/app-context';
import { useUserContext } from '@/context/user-context';
import { useWindowVisible } from '@/desktop/window-visibility';
import { useDebouncedPreferenceSave } from '@/modules/settings/hooks/use-debounced-preference-save';
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
  const { sessionAbortSignal } = useUserContext();
  const visible = useWindowVisible();
  const client = useQueryClient();
  const queryKey = ['orbis-backup-retention', user?.id];
  const status = useQuery({
    queryKey,
    queryFn: ({ signal }) => readBackupRetention(AbortSignal.any([signal, sessionAbortSignal])),
    enabled: visible && user?.operator === true,
    retry: false,
  });
  const [draft, setDraft] = useState<{ hours: number; signal: AbortSignal } | null>(null);
  const activeDraft = draft?.signal === sessionAbortSignal ? draft : null;
  const hours = activeDraft?.hours ?? status.data?.retentionHours ?? 24;
  const save = useMutation({
    scope: { id: 'backup-retention' },
    networkMode: 'always',
    retry: false,
    mutationFn: async (write: NonNullable<typeof activeDraft>) => {
      write.signal.throwIfAborted();
      const latest = await readBackupRetention(write.signal);
      write.signal.throwIfAborted();
      return saveBackupRetention(write.hours, latest.revision, write.signal);
    },
    onSuccess: (result, write) => {
      if (write.signal.aborted) return;
      client.setQueryData(queryKey, result);
      setDraft((value) => (value === write ? null : value));
      void client.invalidateQueries({ queryKey: ['orbis-full-backups', user?.id] });
    },
  });
  const autosave = useDebouncedPreferenceSave(
    activeDraft ? String(activeDraft.hours) : null,
    async () => {
      if (activeDraft) await save.mutateAsync(activeDraft);
    },
    { delay: 0, ready: Boolean(status.data && !disabled && user?.operator === true), signal: sessionAbortSignal },
  );
  const choices = new Map(periods);
  if (!choices.has(hours)) choices.set(hours, `${hours} hours`);
  return (
    <div className="system-backups-retention">
      <Select
        value={String(hours)}
        disabled={disabled || user?.operator !== true || !status.data || autosave.pending}
        onValueChange={(value) => {
          const hours = Number(value);
          if (hours === status.data?.retentionHours) {
            setDraft(null);
          } else {
            setDraft({ hours, signal: sessionAbortSignal });
          }
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
      {status.isError || autosave.error ? (
        <InlineFeedback>
          {autosave.error ?? 'Backup retention could not be read.'}
          <Button type="button" variant="outline" onClick={autosave.error ? autosave.retry : () => void status.refetch()}>
            Retry
          </Button>
        </InlineFeedback>
      ) : null}
    </div>
  );
}
