import { animateAuthExit } from '@/desktop/session-motion';
import { prefersReducedMotion } from '@/desktop/motion-setting';
import { useEffect, useRef, useState } from 'react';
import { useStartupSession } from './startup-boundary';

export function useSignInBoot() {
  const [signingIn, setSigningIn] = useState(false);
  const [visible, setVisible] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const shown = useRef(false);
  const active = useRef(true);
  const exit = useRef<ReturnType<typeof animateAuthExit> | null>(null);
  const session = useStartupSession();
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      window.clearTimeout(timer.current);
      exit.current?.cancel();
      if (shown.current) void session.finish();
    };
  }, [session]);
  const begin = () => {
    window.clearTimeout(timer.current);
    setSigningIn(true);
    timer.current = window.setTimeout(() => {
      shown.current = true;
      setVisible(true);
      session.begin();
      exit.current = animateAuthExit(prefersReducedMotion());
    }, 300);
  };
  const finish = async (restoreForm = false) => {
    window.clearTimeout(timer.current);
    if (shown.current) await session.finish();
    if (!active.current) return;
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
