import { IconShield } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { applyControllerHandoff, ControllerHandoffError, type ControllerHandoff, reviewControllerHandoff } from '../controller-handoff';

export function SentinelControllerHandoff({ active, portalUrl }: { active: boolean; portalUrl: string }) {
  const [stage, setStage] = useState<'idle' | 'reviewing' | 'review' | 'entering' | 'uncertain'>('idle');
  const [plan, setPlan] = useState<ControllerHandoff | null>(null);
  const [message, setMessage] = useState('');
  const operation = useRef<AbortController | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const pending = stage === 'reviewing' || stage === 'entering';

  useEffect(() => {
    const clear = () => {
      operation.current?.abort();
      operation.current = null;
      setPlan(null);
      setStage((current) => (active && current === 'entering' ? 'uncertain' : 'idle'));
      setMessage('');
    };
    clear();
    window.addEventListener('pagehide', clear);
    return () => {
      window.removeEventListener('pagehide', clear);
      operation.current?.abort();
      operation.current = null;
    };
  }, [active]);

  const review = async () => {
    if (!active || operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setMessage('');
    setStage('reviewing');
    try {
      const next = await reviewControllerHandoff(portalUrl, controller.signal);
      if (controller.signal.aborted) return;
      setPlan(next);
      setStage('review');
    } catch (error) {
      if (controller.signal.aborted) return;
      setMessage(error instanceof ControllerHandoffError ? error.message : 'Recovery readiness could not be verified. Try again shortly.');
      setStage('idle');
    } finally {
      if (operation.current === controller) operation.current = null;
    }
  };

  const enter = async () => {
    if (!active || operation.current || !plan || stage !== 'review' || plan.portalUrl !== portalUrl) return;
    if (plan.expiresAtMs <= Date.now()) {
      setMessage('The recovery review expired. Review it again before continuing.');
      setPlan(null);
      setStage('idle');
      return;
    }
    const controller = new AbortController();
    operation.current = controller;
    setStage('entering');
    setMessage('');
    try {
      const accepted = await applyControllerHandoff(plan, controller.signal);
      if (controller.signal.aborted) return;
      if (['accepted', 'stopping', 'held'].includes(accepted.state)) {
        window.location.assign(accepted.portalUrl);
      } else {
        setStage('uncertain');
      }
    } catch {
      if (!controller.signal.aborted) setStage('uncertain');
    } finally {
      if (operation.current === controller) operation.current = null;
    }
  };

  return (
    <>
      <Button
        ref={trigger}
        type="button"
        variant="outline"
        disabled={!active || pending}
        loading={stage === 'reviewing'}
        onClick={() => void review()}
      >
        {stage === 'reviewing' ? null : <IconShield size={18} aria-hidden="true" />}
        {stage === 'reviewing' ? 'Reviewing recovery…' : 'Enter recovery'}
      </Button>
      {message ? <p role="alert">{message}</p> : null}
      <Dialog
        open={stage === 'review' || stage === 'entering' || stage === 'uncertain'}
        onOpenChange={(open) => {
          if (!open && stage !== 'entering') {
            setStage('idle');
            setPlan(null);
          }
        }}
      >
        <DialogContent closeDisabled={stage === 'entering'} restoreFocusTo={trigger}>
          <DialogHeader>
            <DialogTitle>{stage === 'uncertain' ? 'Check recovery in Sentinel' : 'Enter recovery?'}</DialogTitle>
            <DialogDescription>
              {stage === 'uncertain'
                ? 'The handoff may have started. Open Sentinel to check its status before trying again.'
                : 'Orbis will pause while Sentinel keeps recovery available. Your apps and the server will stay running.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            {stage === 'uncertain' ? (
              <Button asChild intent="primary">
                <a href={portalUrl}>Open Sentinel</a>
              </Button>
            ) : (
              <>
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending}
                  onClick={() => {
                    setStage('idle');
                    setPlan(null);
                  }}
                >
                  Cancel
                </Button>
                <Button type="button" intent="primary" disabled={pending} onClick={() => void enter()}>
                  {stage === 'entering' ? 'Opening recovery…' : 'Continue to Sentinel'}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
