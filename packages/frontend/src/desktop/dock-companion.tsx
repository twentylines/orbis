import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { prefersReducedMotion } from './motion-setting';

export function DockCompanion({
  visible,
  side,
  retainOnExit = false,
  children,
}: {
  visible: boolean;
  side: 'left' | 'right';
  retainOnExit?: boolean;
  children: ReactNode;
}) {
  const [present, setPresent] = useState(visible);
  const retained = useRef(children);
  if (visible || !retainOnExit) retained.current = children;
  const wrapper = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const motions = useRef<Animation[]>([]);
  const generation = useRef(0);
  const initialized = useRef(false);

  useLayoutEffect(() => {
    if (visible && !present) setPresent(true);
  }, [visible, present]);

  useLayoutEffect(() => {
    const outer = wrapper.current;
    const inner = content.current;
    if (!present || !outer || !inner) return;
    const margin = side === 'right' ? 'marginLeft' : 'marginRight';
    const move = () => {
      const width = inner.getBoundingClientRect().width;
      const current = outer.getBoundingClientRect().width;
      const inset = getComputedStyle(outer)[margin];
      const transform =
        initialized.current && current > 0.5 ? getComputedStyle(inner).transform : side === 'right' ? `translateX(${-width}px)` : 'none';
      if (initialized.current && visible && Math.abs(width - current) < 0.5 && motions.current.every((a) => a.playState !== 'running')) return;
      initialized.current = true;
      const run = ++generation.current;
      for (const animation of motions.current) animation.cancel();
      const targetWidth = visible ? width : 0;
      const targetMargin = visible ? '0px' : '-12px';
      const targetTransform = !visible && side === 'right' ? `translateX(${-width}px)` : 'none';
      outer.style.width = `${targetWidth}px`;
      outer.style[margin] = targetMargin;
      inner.style.transform = targetTransform;
      const finish = () => {
        if (generation.current !== run) return;
        delete outer.dataset.pillMotion;
        if (!visible) {
          initialized.current = false;
          setPresent(false);
        }
      };
      if (prefersReducedMotion()) {
        finish();
        return;
      }
      outer.dataset.pillMotion = visible ? 'splitting' : 'joining';
      const options = { duration: visible ? 580 : 520, easing: 'cubic-bezier(.22, 1, .36, 1)' };
      const sizing = outer.animate(
        [
          { width: `${current}px`, [margin]: inset },
          { width: `${targetWidth}px`, [margin]: targetMargin },
        ],
        options,
      );
      const travel = inner.animate([{ transform }, { transform: targetTransform }], options);
      sizing.id = 'orbis-dock-pill-size';
      travel.id = 'orbis-dock-pill-travel';
      motions.current = [sizing, travel];
      void Promise.all(motions.current.map((animation) => animation.finished)).then(finish, () => undefined);
    };
    move();
    const observer = new ResizeObserver(move);
    observer.observe(inner);
    return () => observer.disconnect();
  }, [present, visible, side]);

  useLayoutEffect(
    () => () => {
      generation.current++;
      for (const animation of motions.current) animation.cancel();
    },
    [],
  );

  return present ? (
    <div ref={wrapper} className="desktop-dock-companion" data-side={side} aria-hidden={!visible || undefined} inert={!visible || undefined}>
      <div ref={content} className="desktop-dock-companion-content">
        {retained.current}
      </div>
    </div>
  ) : null;
}

type Box = { left: number; right: number; top: number; bottom: number; width: number; height: number; radius: number };

const rounded = (box: Box) => {
  const { left: x, top: y, width: w, height: h } = box;
  const r = Math.min(box.radius, w / 2, h / 2);
  return `M${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x + r}Q${x},${y + h} ${x},${y + h - r}V${y + r}Q${x},${y} ${x + r},${y}Z`;
};

function bridge(left: Box, right: Box) {
  const gap = right.left - left.right;
  if (gap >= 12 || gap < -16) return '';
  const middle = (Math.max(left.top, right.top) + Math.min(left.bottom, right.bottom)) / 2;
  const end = Math.min(left.height, right.height) * 0.38;
  const neck = end * Math.min(1, Math.max(0, (12 - gap) / 12));
  const x1 = left.right - 6;
  const x2 = right.left + 6;
  const mid = (x1 + x2) / 2;
  return `M${x1},${middle - end}C${mid},${middle - end} ${mid},${middle - neck} ${mid},${middle - neck}C${mid},${middle - neck} ${mid},${middle - end} ${x2},${middle - end}V${middle + end}C${mid},${middle + end} ${mid},${middle + neck} ${mid},${middle + neck}C${mid},${middle + neck} ${mid},${middle + end} ${x1},${middle + end}Z`;
}

export function DockGlass() {
  const glass = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = glass.current;
    const dock = element?.parentElement;
    if (!element || !dock) return;
    let frame = 0;
    let disposed = false;
    const draw = () => {
      frame = 0;
      const origin = dock.getBoundingClientRect();
      const read = (node: Element): Box => {
        const r = node.getBoundingClientRect();
        const shape = node.querySelector('.orbis-app-tray, .desktop-activity-trigger') ?? node;
        return {
          left: r.left - origin.left,
          right: r.right - origin.left,
          top: r.top - origin.top,
          bottom: r.bottom - origin.top,
          width: r.width,
          height: r.height,
          radius: Number.parseFloat(getComputedStyle(shape).borderTopLeftRadius) || 0,
        };
      };
      const primary = dock.querySelector<HTMLElement>('.desktop-dock-main');
      if (!primary) return;
      const main = read(primary);
      let path = rounded(main);
      for (const inner of dock.querySelectorAll<HTMLElement>('.desktop-dock-companion-content')) {
        const box = read(inner);
        path += rounded(box) + (box.left < main.left ? bridge(box, main) : bridge(main, box));
        const side = inner.parentElement?.dataset.side;
        const covered = side === 'right' ? Math.max(0, main.right - box.left) : Math.max(0, box.right - main.left);
        const controls = inner.querySelector<HTMLElement>('.orbis-app-tray, .desktop-activity-trigger');
        if (controls) controls.style.clipPath = covered > 0 ? (side === 'right' ? `inset(0 0 0 ${covered}px)` : `inset(0 ${covered}px 0 0)`) : 'none';
      }
      element.style.clipPath = `path('${path}')`;
      if (dock.querySelector('[data-pill-motion]')) schedule();
    };
    const schedule = () => {
      if (!frame && !disposed) frame = requestAnimationFrame(draw);
    };
    const sizes = new ResizeObserver(schedule);
    const observe = () => {
      sizes.disconnect();
      sizes.observe(dock);
      for (const node of dock.querySelectorAll('.desktop-dock-main, .desktop-dock-companion, .desktop-dock-companion-content')) sizes.observe(node);
      schedule();
    };
    const changes = new MutationObserver(observe);
    changes.observe(dock, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-pill-motion'] });
    observe();
    draw();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      sizes.disconnect();
      changes.disconnect();
    };
  }, []);
  return <div ref={glass} className="desktop-dock-glass" aria-hidden="true" />;
}
