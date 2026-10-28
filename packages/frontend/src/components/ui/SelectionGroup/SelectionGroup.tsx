import { useLayoutEffect, useState, type HTMLAttributes } from 'react';
import { motion } from 'framer-motion';
import clsx from 'clsx';
import { useReducedMotion } from '@/desktop/motion-preferences';
import { selectionBounds } from './selection-bounds';
import './selection-group.css';

const activeSelector = ':scope > button:is([aria-pressed="true"],[aria-selected="true"],[data-state="active"],[data-selection-active="true"])';

export function SelectionGroup({ as = 'div', className, children, ...props }: HTMLAttributes<HTMLElement> & { as?: 'div' | 'fieldset' }) {
  const [element, attach] = useState<HTMLElement | null>(null);
  const [selection, setSelection] = useState<ReturnType<typeof selectionBounds>>(null);
  const reduced = useReducedMotion();
  useLayoutEffect(() => {
    if (!element) return;
    const measure = () => {
      const active = Array.from(element.querySelectorAll<HTMLElement>(activeSelector)).find((button) => {
        const rect = button.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      const style = getComputedStyle(element);
      const pixels = (value: string) => Number.parseFloat(value) || 0;
      const borderX = pixels(style.borderLeftWidth);
      const borderY = pixels(style.borderTopWidth);
      const width =
        pixels(style.width) +
        (style.boxSizing === 'border-box' ? 0 : pixels(style.paddingLeft) + pixels(style.paddingRight) + borderX + pixels(style.borderRightWidth));
      const height =
        pixels(style.height) +
        (style.boxSizing === 'border-box' ? 0 : pixels(style.paddingTop) + pixels(style.paddingBottom) + borderY + pixels(style.borderBottomWidth));
      const next = active
        ? selectionBounds(element.getBoundingClientRect(), active.getBoundingClientRect(), {
            width,
            height,
            borderX,
            borderY,
            scrollX: element.scrollLeft,
            scrollY: element.scrollTop,
          })
        : null;
      setSelection((previous) => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next));
    };
    const resize = new ResizeObserver(measure);
    const observe = () => {
      resize.disconnect();
      resize.observe(element);
      for (const button of element.querySelectorAll(':scope > button')) resize.observe(button);
      measure();
    };
    observe();
    const changes = new MutationObserver(observe);
    changes.observe(element, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-selected', 'aria-pressed', 'data-state', 'data-selection-active', 'disabled'],
    });
    return () => {
      resize.disconnect();
      changes.disconnect();
    };
  }, [element]);
  const contents = (
    <>
      {selection ? (
        <span className="orbis-selection-layer" aria-hidden="true">
          <motion.span
            className="orbis-selection-background"
            initial={false}
            animate={selection}
            transition={reduced ? { duration: 0 } : { type: 'spring', stiffness: 460, damping: 35, mass: 0.8 }}
          />
        </span>
      ) : null}
      {children}
    </>
  );
  const attributes = {
    ...props,
    className: clsx('orbis-selection-group', className),
    'data-selection-ready': selection ? 'true' : undefined,
    ref: attach,
  };
  return as === 'fieldset' ? <fieldset {...attributes}>{contents}</fieldset> : <div {...attributes}>{contents}</div>;
}
