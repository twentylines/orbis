import { useReducedMotion } from '@/desktop/motion-preferences';
import { useWindowVisible, WindowVisibilityContext } from '@/desktop/window-visibility';
import { motion } from 'framer-motion';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

type StoreView = 'discover' | 'apps';

export function StoreViewTransition({ active, discover, apps }: { active: StoreView; discover: ReactNode; apps: ReactNode }) {
  const reduced = useReducedMotion();
  const visible = useWindowVisible();
  const host = useRef<HTMLDivElement>(null);
  const panels = useRef<Partial<Record<StoreView, HTMLDivElement | null>>>({});
  const previous = useRef(active);
  const positions = useRef<Record<StoreView, number>>({ discover: 0, apps: 0 });
  const [size, setSize] = useState<{ height: number; animate: boolean } | null>(null);
  const measured = useRef(false);
  const lastFocus = useRef<HTMLElement | null>(null);
  const restoring = useRef(false);

  useLayoutEffect(() => {
    const element = panels.current[active];
    if (!element || !visible) return;
    const measure = () => {
      const height = element.getBoundingClientRect().height;
      const animate = measured.current;
      measured.current = true;
      setSize((current) => (current?.height === height ? current : { height, animate }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [active, visible]);

  useLayoutEffect(() => {
    const element = host.current;
    if (!element || !visible) return;
    const scrollRoot = () => {
      const pane = element.closest<HTMLElement>('.store-catalogue-pane');
      return pane && getComputedStyle(pane).overflowY === 'auto' ? pane : document.scrollingElement;
    };
    const scroller = scrollRoot();
    if (!scroller) return;
    let finish: ReturnType<typeof setTimeout> | undefined;
    if (previous.current !== active) {
      positions.current[previous.current] = scroller.scrollTop;
      previous.current = active;
      const focused = document.activeElement;
      const hiddenFocus = focused instanceof HTMLElement && focused.closest('[data-store-view-panel][inert]');
      if (hiddenFocus || (focused === document.body && lastFocus.current?.closest('[data-store-view-panel][inert]'))) {
        element.closest('.orbis-store')?.querySelector<HTMLButtonElement>(`[data-store-view="${active}"]`)?.focus({ preventScroll: true });
      }
      const wanted = positions.current[active];
      restoring.current = true;
      scroller.scrollTop = wanted;
      finish = setTimeout(
        () => {
          if (restoring.current) {
            const current = scrollRoot();
            if (current) current.scrollTop = wanted;
          }
          restoring.current = false;
        },
        reduced ? 0 : 320,
      );
    }
    const remember = () => {
      const current = scrollRoot();
      if (!restoring.current && current) positions.current[active] = current.scrollTop;
    };
    const userScroll = () => {
      restoring.current = false;
    };
    const keyScroll = (event: KeyboardEvent) => {
      if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(event.key)) userScroll();
    };
    document.addEventListener('scroll', remember, { capture: true, passive: true });
    document.addEventListener('wheel', userScroll, { passive: true });
    document.addEventListener('touchmove', userScroll, { passive: true });
    document.addEventListener('pointerdown', userScroll, { passive: true });
    document.addEventListener('keydown', keyScroll);
    return () => {
      if (finish) clearTimeout(finish);
      restoring.current = false;
      document.removeEventListener('scroll', remember, true);
      document.removeEventListener('wheel', userScroll);
      document.removeEventListener('touchmove', userScroll);
      document.removeEventListener('pointerdown', userScroll);
      document.removeEventListener('keydown', keyScroll);
    };
  }, [active, reduced, visible]);

  const transition = { duration: reduced || !size?.animate ? 0 : 0.28, ease: [0.22, 1, 0.36, 1] as const };
  return (
    <motion.div
      ref={host}
      onFocusCapture={(event) => {
        if (event.target instanceof HTMLElement) lastFocus.current = event.target;
      }}
      className="orbis-store-view-transition"
      initial={false}
      animate={size ? { height: size.height } : {}}
      transition={transition}
    >
      {(['discover', 'apps'] as const).map((view) => {
        const selected = active === view;
        return (
          <motion.div
            key={view}
            ref={(element) => {
              panels.current[view] = element;
            }}
            className="orbis-store-view-panel"
            data-store-view-panel={view}
            aria-hidden={!selected || undefined}
            inert={!selected}
            initial={false}
            animate={{
              opacity: selected ? 1 : 0,
              y: reduced ? 0 : selected ? 0 : -4,
              visibility: 'visible',
              transitionEnd: { visibility: selected ? 'visible' : 'hidden' },
            }}
            transition={{ duration: reduced ? 0 : 0.28, ease: [0.22, 1, 0.36, 1] }}
            style={{
              position: selected ? 'relative' : 'absolute',
              inset: selected ? undefined : '0 0 auto',
              pointerEvents: selected ? undefined : 'none',
            }}
          >
            <WindowVisibilityContext.Provider value={visible && selected}>{view === 'discover' ? discover : apps}</WindowVisibilityContext.Provider>
          </motion.div>
        );
      })}
    </motion.div>
  );
}
