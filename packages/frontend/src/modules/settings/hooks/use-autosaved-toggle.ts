import { useUserContext } from '@/context/user-context';
import { useMutation, useMutationState, useQueryClient } from '@tanstack/react-query';

const toggleKey = ['setting-toggle'] as const;
type ToggleWrite = { checked: boolean; signal: AbortSignal };
export type SettingToggle = {
  id: string;
  checked: boolean;
  pending: boolean;
  saved: boolean;
  disabled: boolean;
  error: string | null;
  setChecked: (checked: boolean) => void;
  retry?: () => void;
};

export function useAutosavedToggle({
  id,
  scope,
  saved,
  disabled,
  readError,
  canSet,
  save,
}: {
  id: string;
  scope: string;
  saved: boolean;
  disabled?: boolean;
  readError?: string;
  canSet?: (checked: boolean) => boolean;
  save: (checked: boolean, signal: AbortSignal) => Promise<void>;
}): SettingToggle {
  const { sessionAbortSignal } = useUserContext();
  const client = useQueryClient();
  const mutationKey = [...toggleKey, id];
  const writes = useMutationState({
    filters: { mutationKey, exact: true },
    select: ({ state }) => ({
      values: state.variables as ToggleWrite | undefined,
      status: state.status,
      error: state.error?.message,
    }),
  });
  const latest = writes.filter(({ values }) => values?.signal === sessionAbortSignal).at(-1);
  const pending = latest?.status === 'pending';
  const checked = pending ? (latest?.values?.checked ?? saved) : saved;
  const error = latest?.status === 'error' ? (latest.error ?? 'This setting could not be saved. Try again.') : (readError ?? null);
  const mutation = useMutation({
    mutationKey,
    scope: { id: scope },
    networkMode: 'always',
    retry: false,
    mutationFn: async ({ checked, signal }: ToggleWrite) => {
      signal.throwIfAborted();
      await save(checked, signal);
      signal.throwIfAborted();
    },
  });
  const apply = (next: boolean) => {
    if (disabled || sessionAbortSignal.aborted || (canSet && !canSet(next))) return;
    const queued = client
      .getMutationCache()
      .findAll({ mutationKey, exact: true, status: 'pending' })
      .map(({ state }) => state.variables as ToggleWrite | undefined)
      .filter((write) => write?.signal === sessionAbortSignal)
      .at(-1);
    if (queued?.checked === next) return;
    mutation.mutate({ checked: next, signal: sessionAbortSignal });
  };
  const failedChoice = latest?.status === 'error' ? latest.values?.checked : undefined;
  return {
    id,
    checked,
    pending,
    saved: latest?.status === 'success',
    disabled: Boolean(disabled || (canSet && !canSet(!checked))),
    error,
    setChecked: apply,
    retry: failedChoice === undefined ? undefined : () => apply(failedChoice),
  };
}

export function useSettingsToggleSaving() {
  const { sessionAbortSignal } = useUserContext();
  const pending = useMutationState({
    filters: { mutationKey: toggleKey, status: 'pending' },
    select: ({ state }) => (state.variables as ToggleWrite | undefined)?.signal,
  });
  return pending.includes(sessionAbortSignal);
}
