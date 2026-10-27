import { prefersReducedMotion } from '@/desktop/motion-setting';
import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { Link } from 'react-router';
import { IconAlertCircle, IconArrowLeft } from '@tabler/icons-react';
import './auth-stages.css';

export type AuthStage = 'credentials' | 'authenticator' | 'passkey' | 'recovery';

export function AuthStages({ stage, children }: { stage: AuthStage; children: Record<AuthStage, ReactNode> }) {
  const frame = useRef<HTMLDivElement>(null);
  const previous = useRef<AuthStage>(stage);
  const running = useRef<Animation[]>([]);
  const interrupted = useRef(new Map<AuthStage, { opacity: string; transform: string }>());
  useLayoutEffect(() => {
    const element = frame.current;
    if (!element) return;
    const incoming = element.querySelector<HTMLElement>(`[data-auth-stage="${stage}"]`);
    if (!incoming) return;
    const outgoing = element.querySelector<HTMLElement>(`[data-auth-stage="${previous.current}"]`);
    const changed = previous.current !== stage;
    previous.current = stage;
    let disposed = false;
    let focusFrame = 0;
    const motion = !prefersReducedMotion() && typeof element.animate === 'function';
    let targetHeight = -1;
    const resize = () => {
      const from = element.getBoundingClientRect().height;
      const to = incoming.getBoundingClientRect().height;
      if (Math.abs(targetHeight - to) < 0.5) return;
      targetHeight = to;
      for (const animation of element.getAnimations()) animation.cancel();
      element.style.height = `${to}px`;
      if (motion && Math.abs(from - to) > 0.5) {
        const animation = element.animate([{ height: `${from}px` }, { height: `${to}px` }], {
          duration: 340,
          easing: 'cubic-bezier(.22, .8, .24, 1)',
        });
        animation.id = 'orbis-auth-stage-size';
      }
    };
    resize();
    let entering: Animation | undefined;
    if (changed && motion) {
      if (outgoing) {
        const leaving = outgoing.animate(
          [
            {
              ...(interrupted.current.get(outgoing.dataset.authStage as AuthStage) ?? { opacity: 1, transform: 'translateY(0)' }),
              visibility: 'visible',
            },
            { opacity: 0, transform: 'translateY(-6px)', visibility: 'visible' },
          ],
          { duration: 140, easing: 'cubic-bezier(.4, 0, .6, 1)' },
        );
        leaving.id = 'orbis-auth-stage-out';
        running.current.push(leaving);
      }
      entering = incoming.animate(
        [interrupted.current.get(stage) ?? { opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'translateY(0)' }],
        { duration: 300, easing: 'cubic-bezier(.22, .8, .24, 1)' },
      );
      entering.id = 'orbis-auth-stage-in';
      running.current.push(entering);
    }
    if (changed) {
      void (entering?.finished ?? Promise.resolve())
        .catch(() => undefined)
        .then(() => {
          if (disposed) return;
          focusFrame = requestAnimationFrame(() => {
            if (!document.hasFocus() || incoming.contains(document.activeElement)) return;
            incoming.querySelector<HTMLElement>('[data-auth-focus], input:not(:disabled), button:not(:disabled)')?.focus({ preventScroll: true });
          });
        });
    }
    const observer = new ResizeObserver(resize);
    observer.observe(incoming);
    return () => {
      disposed = true;
      observer.disconnect();
      cancelAnimationFrame(focusFrame);
      interrupted.current.clear();
      for (const panel of element.querySelectorAll<HTMLElement>('[data-auth-stage]')) {
        if (panel.getAnimations().some((animation) => animation.playState === 'running')) {
          const style = getComputedStyle(panel);
          interrupted.current.set(panel.dataset.authStage as AuthStage, { opacity: style.opacity, transform: style.transform });
        }
      }
      element.style.height = `${element.getBoundingClientRect().height}px`;
      for (const animation of running.current) animation.cancel();
      running.current = [];
      for (const animation of element.getAnimations()) animation.cancel();
    };
  }, [stage]);

  return (
    <div className="desktop-auth-stages">
      <div className="desktop-auth-stage-frame" ref={frame}>
        {(['credentials', 'authenticator', 'passkey', 'recovery'] as const).map((name) => (
          <div
            key={name}
            className="desktop-auth-stage"
            data-auth-stage={name}
            data-active={stage === name}
            aria-hidden={stage !== name}
            inert={stage !== name}
          >
            {children[name]}
          </div>
        ))}
      </div>
    </div>
  );
}

export function AuthError({ message, id }: { message?: string; id: string }) {
  if (!message) return null;
  return (
    <div className="desktop-auth-feedback" role="alert" id={id}>
      <IconAlertCircle size={20} aria-hidden="true" />
      <p>{message}</p>
    </div>
  );
}

export function AuthBack({ onBack, to }: { onBack: () => void; to?: never } | { to: string; onBack?: never }) {
  const contents = (
    <>
      <IconArrowLeft size={18} aria-hidden="true" /> Back to sign in
    </>
  );
  return (
    <div className="desktop-auth-back">
      {to ? (
        <Button asChild variant="ghost">
          <Link to={to}>{contents}</Link>
        </Button>
      ) : (
        <Button type="button" variant="ghost" onClick={onBack}>
          {contents}
        </Button>
      )}
    </div>
  );
}
