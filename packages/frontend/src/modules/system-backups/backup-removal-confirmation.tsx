import { useLayoutEffect, useRef, useState, type MouseEventHandler, type RefObject } from 'react';
import { IconTrash } from '@tabler/icons-react';
import { Button } from '@/components/ui/Button';
import { InlineFeedback } from '@/components/ui/Alert/Alert';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { placeBackupRemoval, restoreBackupRemovalFocus, type BackupRemovalRect } from './backup-removal-position';
import './backup-removal-confirmation.css';

export type BackupRemovalTarget = { kind: 'export' | 'import'; id: string };
export function BackupRemoveTrigger({ disabled, onClick }: { disabled: boolean; onClick: MouseEventHandler<HTMLButtonElement> }) {
  return (
    <Button type="button" variant="outline" disabled={disabled} onClick={onClick} data-backup-removal-trigger>
      <IconTrash size={18} className="backup-removal-trash" aria-hidden="true" />
      Remove
    </Button>
  );
}
export function backupRemovalContents({
  kind,
  busy,
  disabled,
  error,
  onCancel,
  onRemove,
  cancelRef,
}: {
  kind: BackupRemovalTarget['kind'];
  busy: boolean;
  disabled: boolean;
  error: string | null;
  onCancel: () => void;
  onRemove: () => void;
  cancelRef?: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>{kind === 'export' ? 'Remove server backup copy?' : 'Remove uploaded backup?'}</DialogTitle>
      </DialogHeader>
      <DialogDescription className="backup-removal-copy">
        This permanently deletes the server’s stored archive and its review. Files already saved on your device are unaffected.
      </DialogDescription>
      {error ? <InlineFeedback className="backup-removal-error">{error}</InlineFeedback> : null}
      <DialogFooter className="backup-removal-actions">
        <Button ref={cancelRef} type="button" variant="outline" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" variant="outline" intent="danger" disabled={busy || disabled} aria-busy={busy} onClick={onRemove}>
          <IconTrash size={18} className="backup-removal-trash" aria-hidden="true" />
          Remove
        </Button>
      </DialogFooter>
    </>
  );
}
export function BackupRemovalConfirmation({
  target,
  anchor,
  anchorRect,
  fallback,
  deleted,
  busy,
  disabled,
  error,
  onCancel,
  onRemove,
}: {
  target: BackupRemovalTarget | null;
  anchor: RefObject<HTMLElement | null>;
  anchorRect: BackupRemovalRect | null;
  fallback: RefObject<HTMLElement | null>;
  deleted: RefObject<boolean>;
  busy: boolean;
  disabled: boolean;
  error: string | null;
  onCancel: () => void;
  onRemove: () => void;
}) {
  const retained = useRef<BackupRemovalTarget | null>(null);
  const [panel, setPanel] = useState<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<ReturnType<typeof placeBackupRemoval> | null>(null);
  const cancel = useRef<HTMLButtonElement | null>(null);
  const outside = useRef<HTMLElement | null>(null);
  const focused = useRef<BackupRemovalTarget | null>(null);
  const current = target ?? retained.current;
  useLayoutEffect(() => {
    if (target) {
      retained.current = target;
      outside.current = null;
    }
  }, [target]);
  useLayoutEffect(() => {
    if (!target || !panel) return;
    let frame: number | null = null;
    const update = () => {
      const viewport = window.visualViewport;
      const bounds = {
        left: viewport?.offsetLeft ?? 0,
        top: viewport?.offsetTop ?? 0,
        right: (viewport?.offsetLeft ?? 0) + (viewport?.width ?? window.innerWidth),
        bottom: (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight),
      };
      const container = anchor.current?.closest('.desktop-window-content')?.getBoundingClientRect();
      if (container) {
        bounds.left = Math.max(bounds.left, container.left);
        bounds.top = Math.max(bounds.top, container.top);
        bounds.right = Math.min(bounds.right, container.right);
        bounds.bottom = Math.min(bounds.bottom, container.bottom);
      }
      const bar = document.querySelector('.desktop-system-bar')?.getBoundingClientRect();
      const dock = document.querySelector('.desktop-dock')?.getBoundingClientRect();
      if (bar?.height) bounds.top = Math.max(bounds.top, bar.bottom);
      if (dock?.height) bounds.bottom = Math.min(bounds.bottom, dock.top);
      const rect = anchor.current?.isConnected ? anchor.current.getBoundingClientRect() : anchorRect;
      if (!rect) return;
      const next = placeBackupRemoval(rect, { width: 320, height: Math.max(panel.scrollHeight, panel.getBoundingClientRect().height) }, bounds);
      setPosition((previous) =>
        previous && Object.keys(next).every((key) => previous[key as keyof typeof next] === next[key as keyof typeof next]) ? previous : next,
      );
    };
    const schedule = () => {
      if (frame === null)
        frame = requestAnimationFrame(() => {
          frame = null;
          update();
        });
    };
    update();
    const observer = new ResizeObserver(schedule);
    observer.observe(panel);
    for (const child of panel.children) if (child instanceof HTMLElement) observer.observe(child);
    if (anchor.current?.isConnected) observer.observe(anchor.current);
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    window.visualViewport?.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('scroll', schedule);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      window.visualViewport?.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('scroll', schedule);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [target, panel, anchor, anchorRect]);
  useLayoutEffect(() => {
    if (target && panel && position && focused.current !== target) {
      cancel.current?.focus({ preventScroll: true });
      focused.current = target;
    }
    if (!target) focused.current = null;
  }, [target, panel, position]);
  return (
    <Dialog
      modal={false}
      open={Boolean(target)}
      onOpenChange={(open) => {
        if (!open && !busy) onCancel();
      }}
    >
      <DialogContent
        ref={setPanel}
        size="sm"
        className="backup-removal-dialog"
        closeDisabled={busy}
        data-placement={position?.side}
        style={position ? { left: position.left, top: position.top, width: position.width, maxHeight: position.maxHeight } : { visibility: 'hidden' }}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreBackupRemovalFocus([outside.current, deleted.current ? null : anchor.current, fallback.current]);
        }}
        onFocusCapture={(event) => {
          const control = event.target;
          const content = event.currentTarget;
          if (!(control instanceof HTMLElement)) return;
          const box = control.getBoundingClientRect();
          const frame = content.getBoundingClientRect();
          if (box.top < frame.top + 12) content.scrollTop -= frame.top + 12 - box.top;
          else if (box.bottom > frame.bottom - 12) content.scrollTop += box.bottom - frame.bottom + 12;
        }}
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (busy) {
            event.preventDefault();
            return;
          }
          const node = event.detail.originalEvent.target;
          outside.current = node instanceof Element ? node.closest<HTMLElement>('button,a[href],input,select,textarea,[tabindex]') : null;
        }}
      >
        {backupRemovalContents({ kind: current?.kind ?? 'export', busy, disabled, error, onCancel, onRemove, cancelRef: cancel })}
      </DialogContent>
    </Dialog>
  );
}
