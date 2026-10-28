import { useReducedMotion } from '@/desktop/motion-preferences';
import { useEffect, useRef, type FocusEvent } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useIsPresent } from 'framer-motion';
import toast, { resolveValue, useToaster, type Toast } from 'react-hot-toast';
import { IconCheck, IconInfoCircle, IconLoader2, IconX } from '@tabler/icons-react';
import { useDesktopPreferences } from '@/desktop/preferences';
import './orbis-toaster.css';

export function OrbisToaster() {
  const { preferences, resolvedMode } = useDesktopPreferences();
  const { toasts, handlers } = useToaster({
    duration: 5000,
    error: { duration: 8000 },
    loading: { duration: Number.POSITIVE_INFINITY },
    removeDelay: 320,
  });
  const reducedMotion = useReducedMotion();
  const tray = useRef<HTMLElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const hasVisibleNotifications = toasts.some((item) => item.visible);
  useEffect(() => {
    if (!hasVisibleNotifications) handlers.endPause();
  }, [hasVisibleNotifications, handlers.endPause]);

  const restoreFocus = (id: string) => {
    const focused = document.activeElement;
    if (!(focused instanceof HTMLElement) || focused.closest<HTMLElement>('[data-notification-id]')?.dataset.notificationId !== id) return;
    const visibleIds = new Set(toasts.filter((item) => item.visible).map((item) => item.id));
    const buttons = Array.from(tray.current?.querySelectorAll<HTMLButtonElement>('.orbis-notification-dismiss') ?? []).filter(
      (button) =>
        visibleIds.has(button.closest<HTMLElement>('[data-notification-id]')?.dataset.notificationId ?? '') &&
        button.closest<HTMLElement>('[data-notification-id]')?.dataset.notificationId !== id,
    );
    const previous = previousFocus.current;
    const target =
      buttons[0] ??
      (previous?.isConnected && !previous.closest('[inert],[hidden]')
        ? previous
        : document.querySelector<HTMLElement>('.desktop-dock-item[aria-current="page"], .desktop-search-trigger, .desktop-auth input, #root'));
    target?.focus({ preventScroll: true });
  };
  const dismiss = (id: string) => {
    restoreFocus(id);
    toast.dismiss(id);
  };
  const onFocus = (event: FocusEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget)) {
      previousFocus.current = event.relatedTarget instanceof HTMLElement ? event.relatedTarget : null;
    }
    handlers.startPause();
  };

  if (typeof document === 'undefined') return null;
  return createPortal(
    <aside
      ref={tray}
      className="orbis-notifications orbis-theme"
      aria-label="Notifications"
      aria-live="off"
      data-desktop-mode={resolvedMode}
      data-desktop-preset={preferences.preset}
      onMouseEnter={handlers.startPause}
      onMouseLeave={() => {
        if (!tray.current?.contains(document.activeElement)) handlers.endPause();
      }}
      onFocusCapture={onFocus}
      onClickCapture={(event) => {
        if (!(event.target instanceof Element)) return;
        const action = event.target.closest('.orbis-notification-action');
        const id = action?.closest<HTMLElement>('[data-notification-id]')?.dataset.notificationId;
        if (id) restoreFocus(id);
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget) && !event.currentTarget.matches(':hover')) handlers.endPause();
      }}
    >
      <AnimatePresence initial={false}>
        {toasts
          .filter((item) => item.visible)
          .map((item) => (
            <NotificationCard key={item.id} item={item} reducedMotion={Boolean(reducedMotion)} onDismiss={dismiss} />
          ))}
      </AnimatePresence>
    </aside>,
    document.body,
  );
}

function NotificationCard({ item, reducedMotion, onDismiss }: { item: Toast; reducedMotion: boolean; onDismiss: (id: string) => void }) {
  const present = useIsPresent();
  const alert = item.type === 'error' || item.ariaProps.role === 'alert';
  const Icon = item.type === 'success' ? IconCheck : item.type === 'loading' ? IconLoader2 : IconInfoCircle;
  return (
    <motion.div
      layout={reducedMotion ? false : 'position'}
      className="orbis-notification"
      data-notification-type={item.type}
      data-notification-alert={alert || undefined}
      data-notification-id={item.id}
      data-notification-exiting={!present}
      {...item.ariaProps}
      aria-live={present ? item.ariaProps['aria-live'] : 'off'}
      aria-atomic="true"
      inert={!present}
      initial={reducedMotion ? false : { opacity: 0, x: '105%', scale: 0.98 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={
        reducedMotion
          ? { opacity: 0, transition: { duration: 0 } }
          : { opacity: 0, x: 0, scale: 0.94, transition: { duration: 0.2, ease: [0.4, 0, 0.2, 1] } }
      }
      transition={{ duration: reducedMotion ? 0 : 0.36, ease: [0.22, 1, 0.36, 1] }}
    >
      <span className="orbis-notification-icon" aria-hidden="true">
        {item.icon ?? <Icon size={20} stroke={1.9} />}
      </span>
      <div className="orbis-notification-message">{resolveValue(item.message, item)}</div>
      <button
        type="button"
        className="orbis-notification-dismiss"
        disabled={!present}
        aria-label={alert ? 'Dismiss alert' : 'Dismiss notification'}
        onClick={() => onDismiss(item.id)}
      >
        <IconX size={16} stroke={1.8} aria-hidden="true" />
      </button>
    </motion.div>
  );
}
