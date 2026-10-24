import { animateAuthExit } from '@/desktop/session-motion';
import { prefersReducedMotion } from '@/desktop/motion-setting';
import { useEffect, useRef, useState } from 'react';
import { useStartupSession } from './startup-boundary';

export function useSignInBoot() {
  const [signingIn, setSigningIn] = useState(false);
  const [visible, setVisible] = useState(false);
  const shown = useRef(false);
  const active = useRef(true);
  const exit = useRef<ReturnType<typeof animateAuthExit> | null>(null);
  const session = useStartupSession();
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      exit.current?.cancel();
      if (shown.current) void session.finish();
    };
  }, [session]);
  const begin = () => {
    setSigningIn(true);
    shown.current = true;
    setVisible(true);
    session.begin();
    exit.current = animateAuthExit(prefersReducedMotion());
  };
  const finish = async (restoreForm = false) => {
    if (restoreForm) {
      exit.current?.cancel();
      exit.current = null;
      if (shown.current) await session.finish();
    } else {
      await exit.current?.finished;
      const cover = document.querySelector('.orbis-login-surface');
      await Promise.allSettled((cover?.getAnimations() ?? []).map((animation) => animation.finished));
      // Unmount releases the boot scene after navigation; readiness then reveals the new page.
    }
    if (!active.current) return;
    if (restoreForm) {
      shown.current = false;
      setVisible(false);
      setSigningIn(false);
    }
  };
  return { signingIn, visible, begin, finish, isActive: () => active.current };
}
