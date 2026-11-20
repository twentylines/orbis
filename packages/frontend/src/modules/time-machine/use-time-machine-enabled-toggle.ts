import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppContext } from '@/context/app-context';
import { useUserContext } from '@/context/user-context';
import { useWindowVisible } from '@/desktop/window-visibility';
import { useAutosavedToggle } from '@/modules/settings/hooks/use-autosaved-toggle';
import { readTimeMachinePreferences } from './time-machine-api';
import { saveTimeMachineEnabled, timeMachinePreferencesQueryKey } from './time-machine-preferences-query';
import type { useTimeMachine } from './use-time-machine';

export function useTimeMachineEnabledToggle(enabled: boolean, machine?: ReturnType<typeof useTimeMachine>) {
  const { user } = useAppContext();
  const { sessionAbortSignal } = useUserContext();
  const visible = useWindowVisible();
  const client = useQueryClient();
  const queryKey = timeMachinePreferencesQueryKey(user.id);
  const allowed = enabled && visible && user.operator === true;
  const read = useQuery({
    queryKey,
    enabled: allowed && !machine,
    queryFn: ({ signal }) => readTimeMachinePreferences(AbortSignal.any([signal, sessionAbortSignal])),
    retry: false,
  });
  const snapshotPreferences = machine?.snapshot?.preferences;
  const current = snapshotPreferences && snapshotPreferences.revision >= (read.data?.revision ?? -1) ? snapshotPreferences : read.data;
  const toggle = useAutosavedToggle({
    id: 'time-machine',
    scope: 'time-machine-preferences',
    saved: current?.enabled ?? false,
    disabled: !allowed || !current || (machine ? !machine.canMutate || machine.busy : read.isError),
    readError: !machine && read.isError ? 'Time Machine preferences could not be read.' : undefined,
    save: async (checked, session) => {
      const persist = async (signal: AbortSignal) => {
        const latest = await readTimeMachinePreferences(signal);
        const confirmed = latest.enabled === checked ? latest : await saveTimeMachineEnabled(latest, checked, signal);
        if (confirmed.enabled !== checked) throw new Error('The server did not save the Time Machine setting.');
        await client.cancelQueries({ queryKey, exact: true });
        signal.throwIfAborted();
        client.setQueryData(queryKey, confirmed);
      };
      if (!machine) {
        await persist(session);
        return;
      }
      let failure: unknown;
      const accepted = await machine.perform(async (signal) => {
        try {
          await persist(AbortSignal.any([session, signal]));
        } catch (error) {
          failure = error;
          throw error;
        }
      }, '');
      if (!accepted) {
        if (failure instanceof Error) throw failure;
        throw new Error('Time Machine settings were not confirmed. Refresh before trying again.');
      }
    },
  });
  return { ...toggle, confirmedEnabled: current?.enabled };
}
