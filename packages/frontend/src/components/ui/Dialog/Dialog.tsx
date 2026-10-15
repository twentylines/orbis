'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import clsx from 'clsx';
import type * as React from 'react';
import { useRef } from 'react';
import './Dialog.css';

export type Sizes = 'sm' | 'md' | 'lg' | 'xl';
export type ModalType = 'default' | 'primary' | 'success' | 'info' | 'warning' | 'danger';

type ModalProps = {
  size?: Sizes;
  type?: ModalType;
};

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;

const DialogPortal = ({ children, ...props }: DialogPrimitive.DialogPortalProps & ModalProps) => (
  <DialogPrimitive.Portal {...props}>
    <div className="modal modal-sm d-block dimmed-background">
      <div className={clsx(`modal-dialog modal-dialog-centered modal-${props.size || 'lg'}`, 'zoom-in')}>
        <div className="orbis-modal-frame">
          <div
            data-testid="modal-status"
            className={clsx('modal-status', {
              [`bg-${props.type}`]: Boolean(props.type),
              'd-none': !props.type,
            })}
          />
          {children}
        </div>
      </div>
    </div>
  </DialogPrimitive.Portal>
);
DialogPortal.displayName = DialogPrimitive.Portal.displayName;

const DialogOverlay = ({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Overlay>) => (
  <DialogPrimitive.Overlay className={clsx('', className)} {...props} />
);

const DialogContent = ({
  className,
  children,
  onOpenAutoFocus,
  onCloseAutoFocus,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & ModalProps) => {
  const opener = useRef<HTMLElement | null>(null);
  return (
    <DialogPortal type={props.type} size={props.size}>
      <DialogOverlay />
      <DialogPrimitive.Content
        className={clsx('modal-content', className)}
        {...props}
        onOpenAutoFocus={(event) => {
          opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          onOpenAutoFocus?.(event);
        }}
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event);
          if (!event.defaultPrevented && opener.current?.isConnected) {
            event.preventDefault();
            opener.current.focus();
          }
        }}
      >
        {children}
        <DialogPrimitive.Close className="btn-close" aria-label="Close dialog">
          <span data-testid="modal-close-button" className="btn-close" aria-hidden="true" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPortal>
  );
};

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div data-testid="modal-header" className={clsx('modal-header', className)} {...props} />
);
DialogHeader.displayName = 'DialogHeader';

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={clsx('modal-footer', className)} {...props} />
);
DialogFooter.displayName = 'DialogFooter';

const DialogTitle = ({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) => (
  <DialogPrimitive.Title className={clsx('modal-title', className)} {...props} />
);

const DialogDescription = ({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) => (
  <DialogPrimitive.Description asChild {...props}>
    <div className={clsx('modal-body', className)}>{props.children}</div>
  </DialogPrimitive.Description>
);

export { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription };
