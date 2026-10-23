import { animateAuthExit, animateStartupExit } from '@/desktop/session-motion';
import { prefersReducedMotion } from '@/desktop/motion-setting';
import { useEffect, useRef, useState } from 'react';

export function useSignInBoot() {
  const [signingIn, setSigningIn] = useState(false);
  const [visible, setVisible] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const shown = useRef(false);
  const shownAt = useRef(0);
  const active = useRef(true);
  const exit = useRef<ReturnType<typeof animateAuthExit> | null>(null);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      window.clearTimeout(timer.current);
      exit.current?.cancel();
    };
  }, []);
  const begin = () => {
    window.clearTimeout(timer.current);
    setSigningIn(true);
    timer.current = window.setTimeout(() => {
      shown.current = true;
      shownAt.current = performance.now();
      setVisible(true);
      exit.current = animateAuthExit(prefersReducedMotion());
    }, 300);
  };
  const finish = async (restoreForm = false) => {
    window.clearTimeout(timer.current);
    if (shown.current) {
      const entryRemaining = Math.max(0, 440 - (performance.now() - shownAt.current));
      if (entryRemaining && !prefersReducedMotion()) await new Promise((resolve) => window.setTimeout(resolve, entryRemaining));
      if (!active.current) return;
      await animateStartupExit(document.querySelector('.orbis-login-surface'), prefersReducedMotion()).finished;
    }
    if (restoreForm) {
      exit.current?.cancel();
      exit.current = null;
      shown.current = false;
      setVisible(false);
      setSigningIn(false);
    }
  };
  return { signingIn, visible, begin, finish, isActive: () => active.current };
}
