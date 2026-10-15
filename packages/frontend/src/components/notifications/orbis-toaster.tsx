import { useEffect, useRef, type FocusEvent } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion, useIsPresent } from 'framer-motion';
import toast, { resolveValue, useToaster, type Toast } from 'react-hot-toast';
import { IconCheck, IconExclamationMark, IconInfoCircle, IconLoader2, IconX } from '@tabler/icons-react';
import { useDesktopPreferences } from '@/desktop/preferences';
import './orbis-toaster.css';

export function OrbisToaster() {
  const { preferences } = useDesktopPreferences();
  const { toasts, handlers } = useToaster({
    duration: 5000,
    error: { duration: 8000 },
    loading: { duration: Number.POSITIVE_INFINITY },
    removeDelay: 240,
  });
  const reducedMotion = useReducedMotion();
  const tray = useRef<HTMLElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const hasVisibleNotifications = toasts.some((item) => item.visible);
  useEffect(() => {
    if (!hasVisibleNotifications) handlers.endPause();
  }, [hasVisibleNotifications, handlers.endPause]);

  const dismiss = (id: string) => {
    const focused = document.activeElement;
    const visibleIds = new Set(toasts.filter((item) => item.visible).map((item) => item.id));
    const buttons = Array.from(tray.current?.querySelectorAll<HTMLButtonElement>('.orbis-notification-dismiss') ?? []).filter((button) =>
      visibleIds.has(button.closest<HTMLElement>('[data-notification-id]')?.dataset.notificationId ?? ''),
    );
    const current = buttons.indexOf(focused as HTMLButtonElement);
    toast.dismiss(id);
    if (current !== -1) {
      const target =
        buttons[current + 1] ??
        buttons[current - 1] ??
        (previousFocus.current?.isConnected
          ? previousFocus.current
          : document.querySelector<HTMLElement>('.desktop-search-trigger, .desktop-auth input'));
      target?.focus({ preventScroll: true });
    }
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
      data-desktop-mode={preferences.mode}
      data-desktop-preset={preferences.preset}
      onMouseEnter={handlers.startPause}
      onMouseLeave={() => {
        if (!tray.current?.contains(document.activeElement)) handlers.endPause();
      }}
      onFocusCapture={onFocus}
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
  const Icon =
    item.type === 'success' ? IconCheck : item.type === 'error' ? IconExclamationMark : item.type === 'loading' ? IconLoader2 : IconInfoCircle;
  return (
    <motion.div
      layout={reducedMotion ? false : 'position'}
      className="orbis-notification"
      data-notification-type={item.type}
      data-notification-id={item.id}
      data-notification-exiting={!present}
      {...item.ariaProps}
      aria-live={present ? item.ariaProps['aria-live'] : 'off'}
      aria-hidden={present ? undefined : true}
      aria-atomic="true"
      inert={!present}
      initial={reducedMotion ? false : { opacity: 0, x: 24, scale: 0.97 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={reducedMotion ? { opacity: 0 } : { opacity: 0, x: 16, scale: 0.97 }}
      transition={{ duration: reducedMotion ? 0 : 0.22, ease: [0.22, 1, 0.36, 1] }}
    >
      <span className="orbis-notification-icon" aria-hidden="true">
        {item.icon ?? <Icon size={20} stroke={1.9} />}
      </span>
      <div className="orbis-notification-message">{resolveValue(item.message, item)}</div>
      <button
        type="button"
        className="orbis-notification-dismiss"
        disabled={!present}
        aria-label="Dismiss notification"
        onClick={() => onDismiss(item.id)}
      >
        <IconX size={16} stroke={1.8} aria-hidden="true" />
      </button>
    </motion.div>
  );
}
