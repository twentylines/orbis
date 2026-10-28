'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import clsx from 'clsx';
import type * as React from 'react';
import { Children, createContext, Fragment, isValidElement, useContext, useRef } from 'react';
import { IconX } from '@tabler/icons-react';
import { Button } from '../Button';
import { InlineFeedback, type AlertProps } from '../Alert/Alert';
import { WrapWords } from '@/components/wrap-words/wrap-words';
import './Dialog.css';

export type Sizes = 'sm' | 'md' | 'lg' | 'xl';
export type ModalType = 'default' | 'primary' | 'success' | 'info' | 'warning' | 'danger';

type ModalProps = {
  size?: Sizes;
  type?: ModalType;
};

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;

const DialogPortal = DialogPrimitive.Portal;
const DialogCloseContext = createContext({ disabled: false, inHeader: false });

const DialogCloseButton = () => {
  const { disabled } = useContext(DialogCloseContext);
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
  restoreFocusTo,
  closeDisabled = false,
  size = 'lg',
  type,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> &
  ModalProps & { closeDisabled?: boolean; restoreFocusTo?: React.RefObject<HTMLElement | null> }) => {
  const opener = useRef<HTMLElement | null>(null);
  const focusFallback = useRef<HTMLElement | null>(null);
  const hasHeader = containsDialogHeader(children);
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        className={clsx('modal-content', 'orbis-dialog-content', 'orbis-modal-frame', className)}
        data-size={size}
        {...props}
        data-focus-surface="parent"
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
        <DialogCloseContext.Provider value={{ disabled: closeDisabled, inHeader: hasHeader }}>
          <div data-testid="modal-status" className={clsx('modal-status', type ? `bg-${type}` : 'd-none')} />
          {children}
          {hasHeader ? null : <DialogCloseButton />}
          <span hidden aria-hidden="true" ref={observeDialogSize} />
        </DialogCloseContext.Provider>
      </DialogPrimitive.Content>
    </DialogPortal>
  );
};

const DialogHeader = ({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) => {
  const { inHeader } = useContext(DialogCloseContext);
  return (
    <div data-testid="modal-header" className={clsx('modal-header', 'orbis-dialog-header', className)} {...props}>
      <div className="orbis-dialog-heading">{children}</div>
      {inHeader ? <DialogCloseButton /> : null}
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
