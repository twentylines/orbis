import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { IconLoader2 } from '@tabler/icons-react';
import { RouteHeaderStatus } from '@/desktop/route-header-status';
import { WindowVisibilityContext } from '@/desktop/window-visibility';
import { useReducedMotion } from '@/desktop/motion-preferences';
import './settings-save-status.css';
type PreferenceActivity = { pending: boolean; saved: boolean; unsaved: boolean; signal?: AbortSignal };
type SettingsSaveContextValue = {
  register: (id: string, activity: PreferenceActivity) => () => void;
  headerTarget: HTMLElement | null;
  setHeaderTarget: (target: HTMLElement | null) => void;
  signal?: AbortSignal;
  pending: boolean;
  saved: boolean;
  unsaved: boolean;
};
const SettingsSaveContext = createContext<SettingsSaveContextValue | null>(null);

export function SettingsSaveProvider({
  children,
  signal,
  backgroundSaving = false,
}: {
  children: ReactNode;
  signal?: AbortSignal;
  backgroundSaving?: boolean;
}) {
  const entries = useRef(new Map<string, PreferenceActivity>());
  const [headerTarget, setHeaderTarget] = useState<HTMLElement | null>(null);
  const [, refresh] = useState(0);
  const register = useCallback((id: string, activity: PreferenceActivity) => {
    entries.current.set(id, activity);
    refresh((value) => value + 1);
    return () => {
      if (entries.current.get(id) === activity) {
        entries.current.delete(id);
        refresh((value) => value + 1);
      }
    };
  }, []);
  const active = signal?.aborted ? [] : [...entries.current.values()].filter((entry) => entry.signal === signal);
  return (
    <SettingsSaveContext.Provider
      value={{
        register,
        headerTarget,
        setHeaderTarget,
        signal,
        pending: !signal?.aborted && (backgroundSaving || active.some((entry) => entry.pending)),
        saved: active.some((entry) => entry.saved),
        unsaved: active.some((entry) => entry.unsaved),
      }}
    >
      {children}
    </SettingsSaveContext.Provider>
  );
}

export function SettingsSaveActions() {
  const context = useContext(SettingsSaveContext);
  return <div className="settings-save-secondary-actions" ref={context?.setHeaderTarget} />;
}

export function settingsHeaderActionPortal(children: ReactNode, target: HTMLElement | null, visible: boolean) {
  return target && visible ? createPortal(children, target) : null;
}

export function SettingsHeaderAction({ children }: { children: ReactNode }) {
  const context = useContext(SettingsSaveContext);
  const visible = useContext(WindowVisibilityContext);
  return settingsHeaderActionPortal(children, context?.headerTarget ?? null, visible);
}

export function useSettingsHeaderActionAvailable() {
  return useContext(SettingsSaveContext) !== null;
}

export function useSettingsPreferenceActivity(pending: boolean, saved: boolean, unsaved = false) {
  const context = useContext(SettingsSaveContext);
  const id = useId();
  const register = context?.register;
  const signal = context?.signal;
  useEffect(() => register?.(id, { pending, saved, unsaved, signal }), [id, register, pending, saved, unsaved, signal]);
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
  return context ? <SettingsSavingIndicator pending={context.pending} /> : null;
}

export function SettingsDirtyIndicator({
  dirty,
  pending = false,
  loading = false,
  saved = false,
}: {
  dirty: boolean;
  pending?: boolean;
  loading?: boolean;
  saved?: boolean;
}) {
  const reduced = useReducedMotion();
  const message = loading ? 'Loading…' : pending ? 'Saving…' : dirty ? 'Unsaved changes' : saved ? 'Saved' : '';
  return (
    <output className="settings-system-status" aria-live="polite" aria-atomic="true">
      <span className="visually-hidden">{message}</span>
      <span className="settings-status-reserve" aria-hidden="true">
        Unsaved changes
      </span>
      <AnimatePresence initial={false}>
        {message ? (
          <motion.span
            key="settings-status-bubble"
            className="settings-system-status-bubble"
            aria-hidden="true"
            initial={reduced ? false : { opacity: 0, scale: 0.88, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: reduced ? 1 : 0.86, y: reduced ? 0 : -3 }}
            transition={reduced ? { duration: 0 } : { type: 'spring', stiffness: 430, damping: 31, mass: 0.7 }}
          >
            {pending || loading ? <IconLoader2 className="settings-status-spinner" size={16} /> : null}
            <span>{message}</span>
          </motion.span>
        ) : null}
      </AnimatePresence>
    </output>
  );
}

export function SettingsSaveStatus() {
  const context = useContext(SettingsSaveContext);
  const visible = useContext(WindowVisibilityContext);
  return context ? (
    <RouteHeaderStatus>
      <SettingsDirtyIndicator dirty={visible && context.unsaved} pending={visible && context.pending} saved={visible && context.saved} />
    </RouteHeaderStatus>
  ) : null;
}
