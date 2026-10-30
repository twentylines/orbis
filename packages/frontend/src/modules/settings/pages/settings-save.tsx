import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { InlineFeedback } from '@/components/ui/Alert/Alert';
import { saveSettingsPlan, type SettingsSaveEntry } from '../helpers/settings-save-plan';
import type { SettingsSection } from '../helpers/settings-catalogue';

type SettingsSaveContextValue = {
  register: (id: string, entry: SettingsSaveEntry) => () => void;
  save: () => Promise<void>;
  dirty: boolean;
  pending: boolean;
  activity: boolean;
  error: string | null;
};
const SettingsSaveContext = createContext<SettingsSaveContextValue | null>(null);

export function SettingsSaveProvider({
  children,
  onSection,
  signal,
  backgroundSaving = false,
}: {
  children: ReactNode;
  onSection: (section: SettingsSection) => void;
  signal?: AbortSignal;
  backgroundSaving?: boolean;
}) {
  const entries = useRef(new Map<string, SettingsSaveEntry>());
  const [, refresh] = useState(0);
  const currentSignal = useRef(signal);
  currentSignal.current = signal;
  const [savingState, setSaving] = useState<{ signal?: AbortSignal; pending: boolean }>({ signal, pending: false });
  const [failure, setFailure] = useState<{ signal?: AbortSignal; message: string } | null>(null);
  const saving = savingState.signal === signal && savingState.pending;
  const error = failure && failure.signal === signal ? failure.message : null;
  const dirty = [...entries.current.values()].some((entry) => entry.dirty);
  useEffect(() => {
    if (!dirty && !saving) setFailure(null);
  }, [dirty, saving]);
  const running = useRef<{ signal?: AbortSignal } | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const register = useCallback((id: string, entry: SettingsSaveEntry) => {
    entries.current.set(id, entry);
    refresh((value) => value + 1);
    return () => {
      if (entries.current.get(id) === entry) {
        entries.current.delete(id);
        refresh((value) => value + 1);
      }
    };
  }, []);
  const save = async () => {
    if (signal?.aborted || (running.current && running.current.signal === signal)) return;
    const attempt = { signal };
    running.current = attempt;
    setSaving({ signal, pending: true });
    setFailure(null);
    try {
      const result = await saveSettingsPlan([...entries.current.values()], signal);
      if (!mounted.current || currentSignal.current !== signal || signal?.aborted || result.cancelled) return;
      if (result.failed) {
        setFailure({
          signal,
          message: result.invalid
            ? 'Check the highlighted settings before saving.'
            : result.saved
              ? 'Some settings were saved. Your remaining changes are still here; check the error and try again.'
              : 'The settings could not be saved. Your changes are still here; check the error and try again.',
        });
        onSection(result.failed);
      }
    } finally {
      if (running.current === attempt) {
        running.current = null;
        if (mounted.current && currentSignal.current === signal) setSaving({ signal, pending: false });
      }
    }
  };
  return (
    <SettingsSaveContext.Provider
      value={{
        register,
        save,
        dirty,
        pending: saving || [...entries.current.values()].some((entry) => entry.pending),
        activity: !signal?.aborted && (backgroundSaving || saving || [...entries.current.values()].some((entry) => entry.pending)),
        error,
      }}
    >
      {children}
    </SettingsSaveContext.Provider>
  );
}

export function useSettingsSave(entry: SettingsSaveEntry) {
  const context = useContext(SettingsSaveContext);
  const id = useId();
  const current = useRef(entry);
  current.current = entry;
  const register = context?.register;
  const { dirty, pending, section } = entry;
  useEffect(() => register?.(id, { dirty, pending, section, prepare: () => current.current.prepare() }), [id, register, dirty, pending, section]);
  return { shared: Boolean(context), pending: context?.pending ?? false, save: context?.save };
}

export function SettingsSaveButton() {
  const context = useContext(SettingsSaveContext);
  if (!context) return null;
  return (
    <Button type="button" intent="primary" disabled={!context.dirty || context.pending} loading={context.pending} onClick={() => void context.save()}>
      Save
    </Button>
  );
}

export function SettingsSavingIndicator({ pending }: { pending: boolean }) {
  return (
    <output className="settings-save-activity" aria-live="polite" aria-atomic="true">
      <span data-saving={pending} aria-hidden="true">
        Saving changes…
      </span>
      <span className="visually-hidden">{pending ? 'Saving changes…' : ''}</span>
    </output>
  );
}

export function SettingsSaveActivity() {
  const context = useContext(SettingsSaveContext);
  return context ? <SettingsSavingIndicator pending={context.activity} /> : null;
}

export function SettingsSaveFeedback() {
  const context = useContext(SettingsSaveContext);
  return context?.error ? <InlineFeedback className="settings-save-feedback">{context.error}</InlineFeedback> : null;
}

export function SettingsDirtyIndicator({ dirty }: { dirty: boolean }) {
  return (
    <output className="settings-header-status" aria-live="polite" aria-atomic="true">
      <span className="settings-header-status-label" data-dirty={dirty} aria-hidden="true">
        <span className="settings-header-status-full">Unsaved changes</span>
        <span className="settings-header-status-short">Unsaved</span>
      </span>
      <span className="visually-hidden">{dirty ? 'Unsaved changes' : ''}</span>
    </output>
  );
}

export function SettingsSaveStatus() {
  const context = useContext(SettingsSaveContext);
  return context ? <SettingsDirtyIndicator dirty={context.dirty} /> : null;
}
