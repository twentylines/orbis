'use client';

import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area';
import clsx from 'clsx';
import type * as React from 'react';
import { useLayoutEffect, useRef } from 'react';
import styles from './ScrollArea.module.css';

const ScrollBar = ({ className, orientation = 'vertical', ...props }: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) => (
  <ScrollAreaPrimitive.ScrollAreaScrollbar
    orientation={orientation}
    className={clsx(
      styles.scrollbar,
      { [styles.scrollbarVertical as string]: orientation === 'vertical', [styles.scrollbarHorizontal as string]: orientation === 'horizontal' },
      className,
    )}
    {...props}
  >
    <ScrollAreaPrimitive.ScrollAreaThumb className={clsx('position-relative rounded-pill bg-muted', orientation === 'vertical' && 'flex-grow-1')} />
  </ScrollAreaPrimitive.ScrollAreaScrollbar>
);

const ScrollArea = ({ className, children, maxheight, ...props }: React.ComponentProps<typeof ScrollAreaPrimitive.Root> & { maxheight: number }) => {
  const viewport = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    let frame: number | null = null;
    const revealFocus = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        const active = document.activeElement;
        if (active instanceof HTMLElement && element.contains(active)) {
          active.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
        }
      });
    };
    element.addEventListener('focusin', revealFocus);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(revealFocus);
    observer?.observe(element);
    if (element.firstElementChild) observer?.observe(element.firstElementChild);
    return () => {
      element.removeEventListener('focusin', revealFocus);
      observer?.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, []);
  return (
    <ScrollAreaPrimitive.Root className={clsx('position-relative overflow-hidden', className)} {...props}>
      <ScrollAreaPrimitive.Viewport ref={viewport} style={{ maxHeight: maxheight }} className={clsx(styles.viewport, 'w-100')}>
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
};

export { ScrollArea, ScrollBar };
