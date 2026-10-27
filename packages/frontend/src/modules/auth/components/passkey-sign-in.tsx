import { Button } from '@/components/ui/Button';
import { IconFingerprint } from '@tabler/icons-react';
import { createPortal } from 'react-dom';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import './passkey-sign-in.css';

type Props = {
  active: boolean;
  available: boolean;
  loading: boolean;
  reason?: string;
  onPasskey: () => void;
  warmPasskey: () => void;
};

type Position = { left: number; top: number; width: number; maxHeight: number };

export function PasskeySignIn({ active, available, loading, reason, onPasskey, warmPasskey }: Props) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const tooltip = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | undefined>(undefined);
  const pointerDown = useRef(false);
  const pointerType = useRef('');
  const anchorHovered = useRef(false);
  const cursor = useRef<{ x: number; y: number } | null>(null);
  const moveFrame = useRef(0);
  const focused = useRef(false);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<Position | null>(null);
  const unavailable = !available;
  const visible = active && unavailable && !loading && open;

  const clearCloseTimer = useCallback(() => {
    if (closeTimer.current !== undefined) window.clearTimeout(closeTimer.current);
    closeTimer.current = undefined;
  }, []);
  const closeIfOutside = () => {
    if (!anchorHovered.current && !focused.current) setOpen(false);
  };
  const scheduleClose = () => {
    clearCloseTimer();
    closeTimer.current = window.setTimeout(closeIfOutside, 100);
  };
  const openTooltip = () => {
    clearCloseTimer();
    setOpen(true);
  };
  const reposition = useCallback(() => {
    const anchor = button.current;
    if (!anchor) return;
    const bounds = anchor.getBoundingClientRect();
    const point = cursor.current;
    const width = Math.max(1, Math.min(368, window.innerWidth - 24));
    const left = Math.max(12, Math.min(point ? point.x + 14 : bounds.left, window.innerWidth - width - 12));
    const tooltipHeight = Math.min(240, tooltip.current?.scrollHeight ?? 72);
    let top = point ? point.y + 18 : bounds.bottom + 8;
    if (top + tooltipHeight > window.innerHeight - 12) top = Math.max(12, (point ? point.y : bounds.top) - tooltipHeight - 12);
    const maxHeight = Math.max(64, Math.min(240, window.innerHeight - top - 12));
    setPosition({ left, top, width, maxHeight });
  }, []);

  useLayoutEffect(() => {
    if (!visible) return;
    reposition();
    const anchor = button.current;
    if (!anchor) return;
    const card = anchor.closest('.card');
    const observer = new ResizeObserver(reposition);
    observer.observe(anchor);
    if (card) observer.observe(card);
    if (tooltip.current) observer.observe(tooltip.current);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [visible, reposition]);

  useEffect(() => {
    if (!visible) return;
    const onOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && (button.current?.contains(target) || tooltip.current?.contains(target))) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onOutsidePointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onOutsidePointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [visible]);

  useEffect(
    () => () => {
      clearCloseTimer();
      cancelAnimationFrame(moveFrame.current);
    },
    [clearCloseTimer],
  );

  useEffect(() => {
    if (active && !available && !loading) return;
    setOpen(false);
    clearCloseTimer();
    pointerDown.current = false;
    anchorHovered.current = false;
    cursor.current = null;
    focused.current = false;
  }, [active, available, loading, clearCloseTimer]);

  const explanation = reason ?? 'Passkey sign-in is unavailable. You can still use your password.';
  const bubble =
    unavailable && typeof document !== 'undefined'
      ? createPortal(
          <div
            id={id}
            ref={tooltip}
            role="tooltip"
            aria-hidden={!visible}
            data-open={visible}
            className="desktop-passkey-tooltip"
            style={position ?? undefined}
          >
            {explanation}
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      <Button
        ref={button}
        type="button"
        disabled={loading}
        aria-disabled={!available || loading}
        aria-expanded={visible}
        aria-describedby={visible ? id : undefined}
        onClick={(event) => {
          if (unavailable) {
            setOpen((wasOpen) => (event.detail > 0 && pointerType.current !== 'touch' ? true : !wasOpen));
            return;
          }
          onPasskey();
        }}
        onPointerDown={(event) => {
          focused.current = false;
          cursor.current = { x: event.clientX, y: event.clientY };
          pointerType.current = event.pointerType;
          pointerDown.current = true;
        }}
        onPointerUp={() => {
          pointerDown.current = false;
        }}
        onPointerCancel={() => {
          pointerDown.current = false;
        }}
        onPointerEnter={(event) => {
          warmPasskey();
          if (event.pointerType === 'touch') return;
          anchorHovered.current = true;
          cursor.current = { x: event.clientX, y: event.clientY };
          openTooltip();
        }}
        onPointerMove={(event) => {
          if (event.pointerType === 'touch') return;
          cursor.current = { x: event.clientX, y: event.clientY };
          if (!visible || moveFrame.current) return;
          moveFrame.current = requestAnimationFrame(() => {
            moveFrame.current = 0;
            reposition();
          });
        }}
        onPointerLeave={(event) => {
          if (event.pointerType === 'touch') return;
          anchorHovered.current = false;
          closeIfOutside();
        }}
        onFocus={(event) => {
          warmPasskey();
          focused.current = event.currentTarget.matches(':focus-visible');
          if (focused.current && !pointerDown.current) {
            cursor.current = null;
            openTooltip();
          }
        }}
        onBlur={() => {
          focused.current = false;
          scheduleClose();
        }}
        className={`w-100 desktop-passkey-sign-in${unavailable ? ' desktop-passkey-sign-in-unavailable' : ''}`}
      >
        <IconFingerprint size={20} aria-hidden="true" />
        Sign in with a passkey
      </Button>
      {bubble}
    </>
  );
}
