import { useId, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { DepthTravel } from '@/components/recovery-progress/depth-travel';
import './theme-apply.css';
import { scheduleThemeApplyPaint } from './theme-apply-paint';

export function ThemeApplyCover({
  label,
  error,
  generation = 0,
  onPaint,
  onRetry,
  onCancel,
}: {
  label: string;
  error?: string;
  generation?: number;
  onPaint?: (generation: number) => void;
  onRetry: () => void;
  onCancel: () => void;
}) {
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const retry = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const root = document.getElementById('root');
    const previousInert = root?.inert;
    const previousFocus = document.activeElement;
    if (root) root.inert = true;
    panel.current?.focus({ preventScroll: true });
    const containFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && panel.current && !panel.current.contains(event.target)) panel.current.focus({ preventScroll: true });
    };
    document.addEventListener('focusin', containFocus);
    return () => {
      document.removeEventListener('focusin', containFocus);
      if (root) root.inert = previousInert ?? false;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);
  useLayoutEffect(() => scheduleThemeApplyPaint(() => onPaint?.(generation)), [generation, onPaint]);
  useLayoutEffect(() => {
    if (error) retry.current?.focus({ preventScroll: true });
  }, [error]);
  return createPortal(
    <div
      className="theme-apply-cover"
      style={{ position: 'fixed', inset: 0, background: '#000', color: '#fff', zIndex: 2147483646 }}
      ref={panel}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-busy={!error}
      aria-labelledby={`${id}-title`}
      aria-describedby={error ? `${id}-error` : undefined}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && error) {
          event.preventDefault();
          onCancel();
        }
        if (event.key !== 'Tab') return;
        const buttons = panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
        if (!buttons?.length) {
          event.preventDefault();
          panel.current?.focus();
          return;
        }
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
    >
      <DepthTravel active={!error} className="theme-apply-depth" />
      <div className="theme-apply-status">
        <h1 id={`${id}-title`}>{label}</h1>
        {error ? (
          <>
            <p id={`${id}-error`} role="alert">
              {error}
            </p>
            <div className="theme-apply-actions">
              <button ref={retry} type="button" onClick={onRetry}>
                Retry
              </button>
              <button type="button" onClick={onCancel}>
                Cancel
              </button>
            </div>
          </>
        ) : (
          <output aria-live="polite">Please wait…</output>
        )}
      </div>
    </div>,
    document.body,
  );
}
