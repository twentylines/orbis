import { useContext, type ReactNode } from 'react';
import { DialogOpenContext } from '@/components/ui/Dialog/Dialog';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/Dialog';
import { useReducedMotion, useReducedTransparency } from '@/desktop/motion-preferences';
import { useWindowVisible } from '@/desktop/window-visibility';
import { RecoveryProgressBar } from './recovery-progress';
import { DepthTravel } from './depth-travel';
import './recovery-scene.css';

function RecoverySpace({
  active,
  departing,
  variant,
}: {
  active: boolean;
  departing: boolean;
  variant: 'restore' | 'update' | 'downgrade' | 'onboarding';
}) {
  const open = useContext(DialogOpenContext);
  return <DepthTravel active={active} departing={departing} distance={open ? 1 : 0} variant={variant} className="recovery-scene-space" />;
}

export function RecoveryScene({
  open = true,
  title,
  status,
  detail,
  progress,
  active,
  departing = false,
  variant = 'restore',
  indicator = 'progress',
  sharedBackdrop = false,
  footer,
  actions,
}: {
  open?: boolean;
  title: string;
  status?: string;
  detail?: string;
  progress?: number;
  active: boolean;
  departing?: boolean;
  variant?: 'restore' | 'update' | 'downgrade' | 'onboarding';
  indicator?: 'progress' | 'restart';
  sharedBackdrop?: boolean;
  footer?: ReactNode;
  actions?: ReactNode;
}) {
  const visible = useWindowVisible();
  const solid = useReducedTransparency();
  const reduced = useReducedMotion();
  return (
    <Dialog open={open} onOpenChange={() => undefined}>
      <DialogContent
        presentation="scene"
        className="recovery-scene"
        overlayClassName={sharedBackdrop ? 'recovery-scene-shared-overlay' : undefined}
        data-shared-backdrop={sharedBackdrop || undefined}
        data-solid={solid || undefined}
        data-visible={visible}
        data-reduced={Boolean(reduced)}
        data-variant={variant}
        data-departing={departing || undefined}
        data-footer={Boolean(footer) || undefined}
        closeDisabled
        hideClose
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        {sharedBackdrop ? null : <RecoverySpace active={visible && (active || departing)} departing={departing} variant={variant} />}
        <div className="recovery-scene-content">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="visually-hidden">Recovery status</DialogDescription>
          {status ? <output aria-live="polite">{status}</output> : null}
          {detail ? <p>{detail}</p> : null}
          {indicator === 'restart' && progress === undefined ? (
            <div className="recovery-restart-glint" role="progressbar" aria-label={status ?? title}>
              <i />
            </div>
          ) : (
            <RecoveryProgressBar label={`${status ?? title} progress`} percentage={progress} />
          )}
          {actions ? <div className="recovery-scene-actions">{actions}</div> : null}
        </div>
        {footer ? <p className="recovery-scene-footer">{footer}</p> : null}
      </DialogContent>
    </Dialog>
  );
}
