import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { prefersReducedMotion } from './motion-setting';
import { dockMotionDuration, sectionMotionEasing } from './section-motion-geometry';

const shapeEvent = 'orbis-dock-shape';

export function DockCompanion({
  visible,
  side,
  retainOnExit = false,
  duration = dockMotionDuration,
  children,
}: {
  visible: boolean;
  side: 'left' | 'right';
  retainOnExit?: boolean;
  duration?: number;
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
      const width = Number.parseFloat(getComputedStyle(inner).width);
      const current = Number.parseFloat(getComputedStyle(outer).width);
      const primary = outer.closest('.desktop-dock')?.querySelector('.desktop-dock-main');
      const mainHeight = primary ? Number.parseFloat(getComputedStyle(primary).height) : 78;
      const controls = inner.querySelector<HTMLElement>('.orbis-app-tray, .desktop-activity-trigger');
      const controlStyle = controls ? getComputedStyle(controls) : null;
      const padding = controlStyle
        ? ['padding-top', 'padding-bottom', 'border-top-width', 'border-bottom-width'].reduce(
            (total, property) => total + (Number.parseFloat(controlStyle.getPropertyValue(property)) || 0),
            0,
          )
        : 0;
      const contentHeight = controls
        ? Math.max(...[...controls.children].map((child) => Number.parseFloat(getComputedStyle(child).height) || 0), 0) + padding
        : mainHeight;
      const height = Math.max(mainHeight, contentHeight, Number.parseFloat(controlStyle?.minHeight ?? '') || 0);
      const currentHeight = initialized.current ? Number.parseFloat(getComputedStyle(inner).height) : mainHeight;
      const targetHeight = visible ? height : mainHeight;
      const inset = getComputedStyle(outer)[margin];
      const transform =
        initialized.current && current > 0.5 ? getComputedStyle(inner).transform : side === 'right' ? `translateX(${-width}px)` : 'none';
      const targetWidth = visible ? width : 0;
      const targetMargin = visible ? '0px' : '-12px';
      if (
        initialized.current &&
        Math.abs(targetWidth - Number.parseFloat(outer.style.width)) < 0.5 &&
        Math.abs(targetHeight - Number.parseFloat(inner.style.height)) < 0.1 &&
        outer.style[margin] === targetMargin
      )
        return;
      if (!initialized.current) {
        if (controls) controls.style.clipPath = side === 'right' ? `inset(0 0 0 ${width}px)` : `inset(0 ${width}px 0 0)`;
      }
      initialized.current = true;
      const run = ++generation.current;
      for (const animation of motions.current) animation.cancel();
      const targetTransform = !visible && side === 'right' ? `translateX(${-width}px)` : 'none';
      outer.style.width = `${targetWidth}px`;
      outer.style.height = `${targetHeight}px`;
      inner.style.height = `${targetHeight}px`;
      outer.style[margin] = targetMargin;
      inner.style.transform = targetTransform;
      const finish = () => {
        if (generation.current !== run) return;
        delete outer.dataset.pillMotion;
        outer.closest('.desktop-dock')?.dispatchEvent(new Event(shapeEvent));
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
      const options = { duration, easing: sectionMotionEasing };
      const sizing = outer.animate(
        [
          { width: `${current}px`, height: `${currentHeight}px`, [margin]: inset },
          { width: `${targetWidth}px`, height: `${targetHeight}px`, [margin]: targetMargin },
        ],
        options,
      );
      const travel = inner.animate(
        [
          { transform, height: `${currentHeight}px` },
          { transform: targetTransform, height: `${targetHeight}px` },
        ],
        options,
      );
      sizing.id = 'orbis-dock-pill-size';
      travel.id = 'orbis-dock-pill-travel';
      motions.current = [sizing, travel];
      const started = document.timeline.currentTime;
      if (started !== null) for (const animation of motions.current) animation.startTime = started;
      outer.closest('.desktop-dock')?.dispatchEvent(new Event(shapeEvent));
      void Promise.all(motions.current.map((animation) => animation.finished)).then(finish, () => undefined);
    };
    move();
    let resizeFrame = 0;
    const observer = new ResizeObserver(() => {
      if (!resizeFrame)
        resizeFrame = requestAnimationFrame(() => {
          resizeFrame = 0;
          move();
        });
    });
    observer.observe(inner);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(resizeFrame);
    };
  }, [present, visible, side, duration]);

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
      const style = getComputedStyle(dock);
      const scaleX = origin.width / Number.parseFloat(style.width) || 1;
      const scaleY = origin.height / Number.parseFloat(style.height) || 1;
      const local = (value: number, scale: number) => Math.round((value / scale) * 1000) / 1000;
      const read = (node: Element): Box => {
        const r = node.getBoundingClientRect();
        const shape = node.querySelector('.orbis-app-tray, .desktop-activity-trigger') ?? node;
        return {
          left: local(r.left - origin.left, scaleX),
          right: local(r.right - origin.left, scaleX),
          top: local(r.top - origin.top, scaleY),
          bottom: local(r.bottom - origin.top, scaleY),
          width: local(r.width, scaleX),
          height: local(r.height, scaleY),
          radius: Number.parseFloat(getComputedStyle(shape).borderTopLeftRadius) || 0,
        };
      };
      const primary = dock.querySelector<HTMLElement>('.desktop-dock-main');
      if (!primary) return;
      const main = read(primary);
      let path = rounded(main);
      for (const inner of dock.querySelectorAll<HTMLElement>('.desktop-dock-companion-content')) {
        const box = read(inner);
        const side = inner.parentElement?.dataset.side;
        path += rounded(box) + (side === 'left' ? bridge(box, main) : '');
        const covered = side === 'right' ? Math.max(0, main.right - box.left) : Math.max(0, box.right - main.left);
        const controls = inner.querySelector<HTMLElement>('.orbis-app-tray, .desktop-activity-trigger');
        if (controls) {
          const clip = covered > 0.01 ? (side === 'right' ? `inset(0 0 0 ${covered}px)` : `inset(0 ${covered}px 0 0)`) : 'none';
          if (controls.style.clipPath !== clip) controls.style.clipPath = clip;
        }
      }
      if (element.dataset.shape !== path) {
        element.style.clipPath = `path('${path}')`;
        element.dataset.shape = path;
      }
      if (dock.querySelector('[data-pill-motion]')) schedule();
    };
    const schedule = () => {
      if (!frame && !disposed) frame = requestAnimationFrame(draw);
    };
    const redraw = () => {
      cancelAnimationFrame(frame);
      draw();
    };
    dock.addEventListener(shapeEvent, redraw);
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
      dock.removeEventListener(shapeEvent, redraw);
    };
  }, []);
  return <div ref={glass} className="desktop-dock-glass" aria-hidden="true" />;
}
