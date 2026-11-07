'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import clsx from 'clsx';
import type * as React from 'react';
import { Children, createContext, Fragment, isValidElement, useContext, useRef, useState, useLayoutEffect } from 'react';
import { IconX } from '@tabler/icons-react';
import { Button } from '../Button';
import { InlineFeedback, type AlertProps } from '../Alert/Alert';
import { WrapWords } from '@/components/wrap-words/wrap-words';
import { useReducedMotion } from '@/desktop/motion-preferences';
import './Dialog.css';

export type Sizes = 'sm' | 'md' | 'lg' | 'xl';
export type ModalType = 'default' | 'primary' | 'success' | 'info' | 'warning' | 'danger';

type ModalProps = {
  size?: Sizes;
  type?: ModalType;
};

export const DialogOpenContext = createContext(false);
export function updateDialogOpen(controlled: boolean, next: boolean, setInternal: (value: boolean) => void, onChange?: (value: boolean) => void) {
  if (!controlled) setInternal(next);
  onChange?.(next);
}
const Dialog = ({ open: supplied, defaultOpen = false, onOpenChange, children, ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) => {
  const [internal, setInternal] = useState(defaultOpen);
  const open = supplied ?? internal;
  return (
    <DialogOpenContext.Provider value={open}>
      <DialogPrimitive.Root {...props} open={open} onOpenChange={(next) => updateDialogOpen(supplied !== undefined, next, setInternal, onOpenChange)}>
        {children}
      </DialogPrimitive.Root>
    </DialogOpenContext.Provider>
  );
};
export function retainDialogChildren(snapshot: { current: React.ReactNode }, open: boolean, children: React.ReactNode) {
  if (open) snapshot.current = children;
  return snapshot.current;
}
function RetainedDialogContents({ children }: { children: React.ReactNode }) {
  const open = useContext(DialogOpenContext);
  const snapshot = useRef<React.ReactNode>(null);
  useLayoutEffect(() => {
    if (open) retainDialogChildren(snapshot, true, children);
  }, [open, children]);
  return open ? children : retainDialogChildren(snapshot, false, children);
}
const DialogTrigger = DialogPrimitive.Trigger;

const DialogPortal = DialogPrimitive.Portal;
export const DialogVisibilityContext = createContext(true);
const DialogCloseContext = createContext({ disabled: false, inHeader: false, hidden: false });

const DialogCloseButton = () => {
  const { disabled, hidden } = useContext(DialogCloseContext);
  if (hidden) return null;
  return (
    <DialogPrimitive.Close asChild>
      <Button disabled={disabled} className="orbis-dialog-close" size="icon" aria-label="Close dialog" data-testid="modal-close-button">
        <IconX size={20} aria-hidden="true" />
      </Button>
    </DialogPrimitive.Close>
  );
};

function containsDialogHeader(children: React.ReactNode): boolean {
  return Children.toArray(children).some(
    (child) =>
      isValidElement(child) &&
      (child.type === DialogHeader || (child.type === Fragment && containsDialogHeader((child.props as { children?: React.ReactNode }).children))),
  );
}

function observeDialogSize(anchor: HTMLElement | null) {
  const content = anchor?.parentElement;
  if (!content || typeof ResizeObserver === 'undefined' || typeof content.animate !== 'function') return;
  let previousHeight = Number.parseFloat(getComputedStyle(content).height);
  let animation: Animation | undefined;
  const resize = () => {
    if (animation?.playState === 'running') return;
    const style = getComputedStyle(content);
    const height = Number.parseFloat(style.height);
    if (!Number.isFinite(height) || height <= 0 || Math.abs(height - previousHeight) < 0.5) return;
    const start = previousHeight;
    animation?.cancel();
    previousHeight = height;
    if (!Number.isFinite(start) || start <= 0) return;
    if (
      content.dataset.state !== 'open' ||
      document.documentElement.dataset.orbisMotion === 'reduced' ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    )
      return;
    animation = content.animate([{ height: `${start}px` }, { height: `${height}px` }], {
      duration: 180,
      easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)',
    });
  };
  const observer = new ResizeObserver(resize);
  const mutations = new MutationObserver(() => {
    if (animation?.playState === 'running') {
      previousHeight = Number.parseFloat(getComputedStyle(content).height);
      animation.cancel();
    }
    resize();
  });
  observer.observe(content);
  mutations.observe(content, { childList: true, characterData: true, subtree: true });
  return () => {
    observer.disconnect();
    mutations.disconnect();
    animation?.cancel();
  };
}

const DialogOverlay = ({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Overlay>) => (
  <DialogPrimitive.Overlay className={clsx('orbis-dialog-overlay', className)} {...props} />
);

const DialogContent = ({
  className,
  children,
  onOpenAutoFocus,
  onCloseAutoFocus,
  onInteractOutside,
  onFocusCapture,
  restoreFocusTo,
  closeDisabled = false,
  hideClose = false,
  overlayClassName,
  size = 'lg',
  presentation = 'dialog',
  type,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> &
  ModalProps & {
    presentation?: 'dialog' | 'scene';
    closeDisabled?: boolean;
    hideClose?: boolean;
    overlayClassName?: string;
    restoreFocusTo?: React.RefObject<HTMLElement | null>;
  }) => {
  const reduced = useReducedMotion();
  const visible = useContext(DialogVisibilityContext);
  const open = useContext(DialogOpenContext);
  const visibility = useRef(visible);
  visibility.current = visible;
  const opener = useRef<HTMLElement | null>(null);
  const focusFallback = useRef<HTMLElement | null>(null);
  const hasHeader = containsDialogHeader(children);
  if (!visible) return null;
  return (
    <DialogPortal>
      <DialogOverlay data-reduced={Boolean(reduced)} className={overlayClassName} />
      <DialogPrimitive.Content
        className={clsx('modal-content', 'orbis-dialog-content', 'orbis-modal-frame', className)}
        data-size={size}
        data-presentation={presentation}
        data-reduced={Boolean(reduced)}
        {...props}
        inert={!open || props.inert}
        data-focus-surface="parent"
        onFocusCapture={(event) => {
          onFocusCapture?.(event);
          const content = event.currentTarget;
          const target = event.target;
          if (
            event.defaultPrevented ||
            target === content ||
            target.closest('[role="dialog"]') !== content ||
            !target.matches(':focus-visible') ||
            content.scrollHeight <= content.clientHeight
          )
            return;
          const frame = content.getBoundingClientRect();
          const control = target.getBoundingClientRect();
          const padding = getComputedStyle(content);
          const top = frame.top + (Number.parseFloat(padding.scrollPaddingTop) || 0);
          const bottom = frame.bottom - (Number.parseFloat(padding.scrollPaddingBottom) || 0);
          const offset = control.top < top ? control.top - top : control.bottom > bottom ? control.bottom - bottom : 0;
          if (offset) content.scrollBy({ top: offset, behavior: 'instant' });
        }}
        onInteractOutside={(event) => {
          if (event.target instanceof Element && event.target.closest('.orbis-notifications')) event.preventDefault();
          else onInteractOutside?.(event);
        }}
        onOpenAutoFocus={(event) => {
          const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          const menuTriggerId = active?.closest('[role="menu"]')?.getAttribute('aria-labelledby');
          const menuTrigger = menuTriggerId ? document.getElementById(menuTriggerId) : null;
          opener.current = menuTrigger ?? active;
          focusFallback.current = opener.current?.closest<HTMLElement>('[data-dialog-focus-fallback]') ?? null;
          onOpenAutoFocus?.(event);
          if (!event.defaultPrevented) {
            event.preventDefault();
            if (event.target instanceof HTMLElement) event.target.focus({ preventScroll: true });
          }
        }}
        onCloseAutoFocus={(event) => {
          if (!visibility.current) {
            event.preventDefault();
            return;
          }
          onCloseAutoFocus?.(event);
          if (event.defaultPrevented) return;
          const available = (element: HTMLElement | null | undefined) =>
            Boolean(
              element?.isConnected &&
                element !== document.body &&
                !element.matches(':disabled,[aria-disabled="true"]') &&
                element.getClientRects().length,
            );
          const target =
            [opener.current, restoreFocusTo?.current, focusFallback.current].find(available) ??
            [
              ...document.querySelectorAll<HTMLElement>('#desktop-content [role="tab"][aria-selected="true"], .desktop-dock a[aria-current="page"]'),
            ].find(available);
          if (target?.isConnected) {
            event.preventDefault();
            target.focus();
          }
        }}
      >
        <RetainedDialogContents>
          <DialogCloseContext.Provider value={{ disabled: closeDisabled, inHeader: hasHeader, hidden: hideClose }}>
            <div data-testid="modal-status" className={clsx('modal-status', type ? `bg-${type}` : 'd-none')} />
            {children}
            {hasHeader ? null : <DialogCloseButton />}
            <span hidden aria-hidden="true" ref={presentation === 'dialog' ? observeDialogSize : undefined} />
          </DialogCloseContext.Provider>
        </RetainedDialogContents>
      </DialogPrimitive.Content>
    </DialogPortal>
  );
};

const DialogHeader = ({ className, children, actions, ...props }: React.HTMLAttributes<HTMLDivElement> & { actions?: React.ReactNode }) => {
  const { inHeader } = useContext(DialogCloseContext);
  return (
    <div
      data-testid="modal-header"
      data-header-actions={actions ? 'true' : undefined}
      className={clsx('modal-header', 'orbis-dialog-header', className)}
      {...props}
    >
      <div className="orbis-dialog-heading">{children}</div>
      {actions ? (
        <div className="orbis-dialog-header-actions">
          {actions}
          {inHeader ? <DialogCloseButton /> : null}
        </div>
      ) : inHeader ? (
        <DialogCloseButton />
      ) : null}
    </div>
  );
};
DialogHeader.displayName = 'DialogHeader';

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={clsx('modal-footer', className)} {...props} />
);
DialogFooter.displayName = 'DialogFooter';

const DialogTitle = ({ className, children, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) => (
  <DialogPrimitive.Title className={clsx('modal-title', className)} title={typeof children === 'string' ? children : undefined} {...props}>
    {typeof children === 'string' ? <WrapWords text={children} /> : children}
  </DialogPrimitive.Title>
);

const DialogDescription = ({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) => (
  <DialogPrimitive.Description asChild {...props}>
    <div className={clsx('modal-body', className)}>{props.children}</div>
  </DialogPrimitive.Description>
);

const DialogSection = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={clsx('orbis-dialog-section', className)} {...props} />
);

const DialogFeedback = ({ className, ...props }: AlertProps) => <InlineFeedback className={clsx('orbis-dialog-feedback', className)} {...props} />;

export { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription, DialogSection, DialogFeedback };
