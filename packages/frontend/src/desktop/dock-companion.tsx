import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { prefersReducedMotion } from './motion-setting';
import { dockMotionDuration, sectionMotionEasing } from './section-motion-geometry';
import { canJoinDockPills, dockCircleSplitBridge } from './dock-motion-geometry';
import { advanceDockFold, dockSideWidth, foldDockBox, foldDockClip } from './dock-scroll-state';

export function replayStartupChrome(root: HTMLElement, reduced: boolean) {
  if (reduced) return;
  for (const [selector, name] of [
    ['.desktop-system-bar', 'orbis-chrome-enter'],
    ['.desktop-dock', 'orbis-dock-enter'],
  ] as const) {
    const element = root.querySelector<HTMLElement>(selector);
    if (!element || typeof element.getAnimations !== 'function') continue;
    const animation = element.getAnimations().find((item) => 'animationName' in item && item.animationName === name);
    if (!animation) continue;
    animation.currentTime = 0;
    animation.play();
  }
}

export function useDockStartupReveal(root: React.RefObject<HTMLElement | null>, enabled: boolean) {
  useLayoutEffect(() => {
    if (!enabled) return;
    const reveal = () => {
      if (root.current) replayStartupChrome(root.current, prefersReducedMotion() || document.documentElement.dataset.orbisEffects === 'low');
    };
    window.addEventListener('orbis-startup-reveal', reveal);
    return () => window.removeEventListener('orbis-startup-reveal', reveal);
  }, [enabled, root]);
}

const shapeEvent = 'orbis-dock-shape';

export function DockCompanion({
  visible,
  side,
  retainOnExit = false,
  fluidWidth = false,
  expandedWidth,
  motionStart,
  duration = dockMotionDuration,
  children,
}: {
  visible: boolean;
  side: 'left' | 'right';
  retainOnExit?: boolean;
  fluidWidth?: boolean;
  expandedWidth?: string;
  motionStart?: number | null;
  duration?: number;
  children: ReactNode;
}) {
  const [present, setPresent] = useState(visible);
  const retained = useRef(children);
  const retainedWidth = useRef(expandedWidth);
  if (visible || !retainOnExit) {
    retained.current = children;
    retainedWidth.current = expandedWidth;
  }
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
      const rail = fluidWidth ? outer.closest<HTMLElement>('.desktop-activity-rail') : null;
      const count = Math.max(1, Number(rail?.dataset.activityCount) || 1);
      const width = rail
        ? Math.max(64, ((rail.parentElement?.offsetWidth ?? rail.offsetWidth) - (count - 1) * 12) / count)
        : Number.parseFloat(getComputedStyle(inner).width);
      const current = Number.parseFloat(getComputedStyle(outer).width);
      const primary = outer.closest('.desktop-dock')?.querySelector('.desktop-dock-main');
      const mainHeight = primary ? Number.parseFloat(getComputedStyle(primary).height) : 78;
      const controls = inner.querySelector<HTMLElement>('.orbis-app-tray, .desktop-activity-rail, .desktop-activity-trigger');
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
        if (controls && !fluidWidth) controls.style.clipPath = side === 'right' ? `inset(0 0 0 ${width}px)` : `inset(0 ${width}px 0 0)`;
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
          { transform, height: `${currentHeight}px`, ...(fluidWidth ? { width: `${current}px` } : {}) },
          { transform: targetTransform, height: `${targetHeight}px`, ...(fluidWidth ? { width: `${targetWidth}px` } : {}) },
        ],
        options,
      );
      sizing.id = 'orbis-dock-pill-size';
      travel.id = 'orbis-dock-pill-travel';
      motions.current = [sizing, travel];
      const now = document.timeline.currentTime;
      const started = typeof now === 'number' && motionStart != null && now - motionStart < duration ? motionStart : now;
      if (started !== null) for (const animation of motions.current) animation.startTime = started;
      if (outer.closest('.desktop-dock')?.hasAttribute('data-pointer-held')) for (const animation of motions.current) animation.pause();
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
  }, [present, visible, side, duration, fluidWidth, motionStart]);

  useLayoutEffect(
    () => () => {
      generation.current++;
      for (const animation of motions.current) animation.cancel();
    },
    [],
  );

  return present ? (
    <div ref={wrapper} className="desktop-dock-companion" data-side={side} aria-hidden={!visible || undefined} inert={!visible || undefined}>
      <div ref={content} className="desktop-dock-companion-content" style={{ width: retainedWidth.current }}>
        {retained.current}
      </div>
    </div>
  ) : null;
}

type Box = { left: number; right: number; top: number; bottom: number; width: number; height: number; radius: number };

const compactHeight = 56;
const pillGap = 12;

function setDockStyle(element: HTMLElement, property: string, value: string) {
  if (element.style.getPropertyValue(property) !== value) element.style.setProperty(property, value);
}

const rounded = (box: Box) => {
  const { left: x, top: y, width: w, height: h } = box;
  const r = Math.min(box.radius, w / 2, h / 2);
  return `M${x + r},${y}H${x + w - r}A${r},${r} 0 0 1 ${x + w},${y + r}V${y + h - r}A${r},${r} 0 0 1 ${x + w - r},${y + h}H${x + r}A${r},${r} 0 0 1 ${x},${y + h - r}V${y + r}A${r},${r} 0 0 1 ${x + r},${y}Z`;
};

function bridge(left: Box, right: Box, moving: boolean) {
  const gap = right.left - left.right;
  if (!canJoinDockPills(gap, moving)) return '';
  const middle = (Math.max(left.top, right.top) + Math.min(left.bottom, right.bottom)) / 2;
  const end = Math.min(left.height, right.height) * 0.38;
  const neck = end * Math.min(1, Math.max(0, (12 - gap) / 12));
  const x1 = left.right - 6;
  const x2 = right.left + 6;
  const mid = (x1 + x2) / 2;
  return `M${x1},${middle - end}C${mid},${middle - end} ${mid},${middle - neck} ${mid},${middle - neck}C${mid},${middle - neck} ${mid},${middle - end} ${x2},${middle - end}V${middle + end}C${mid},${middle + end} ${mid},${middle + neck} ${mid},${middle + neck}C${mid},${middle + neck} ${mid},${middle + end} ${x1},${middle + end}Z`;
}

export function DockGlass({ collapsed = false, reduced = false }: { collapsed?: boolean; reduced?: boolean }) {
  const glass = useRef<HTMLDivElement>(null);
  const fold = useRef({ value: 0, velocity: 0, target: 0, updated: 0 });
  const redrawFold = useRef<() => void>(() => undefined);
  const reduce = useRef(reduced);
  reduce.current = reduced;
  useLayoutEffect(() => {
    const state = fold.current;
    const now = performance.now();
    Object.assign(state, advanceDockFold(state.value, state.velocity, state.target, (now - state.updated) / 1000, reduced));
    state.target = collapsed ? 1 : 0;
    if (reduced) Object.assign(state, { value: state.target, velocity: 0 });
    state.updated = now;
    redrawFold.current();
  }, [collapsed, reduced]);
  useLayoutEffect(() => {
    const element = glass.current;
    const dock = element?.parentElement;
    if (!element || !dock) return;
    setDockStyle(dock, '--orbis-dock-compact-size', `${compactHeight}px`);
    let frame = 0;
    let disposed = false;
    const pillMotions = () =>
      dock.getAnimations({ subtree: true }).filter((animation) => ['orbis-dock-pill-size', 'orbis-dock-pill-travel'].includes(animation.id));
    const holdTargets = (event: PointerEvent) => {
      if (event.button !== 0) return;
      dock.setAttribute('data-pointer-held', '');
      for (const animation of pillMotions()) if (animation.playState === 'running') animation.pause();
    };
    const releaseTargets = () => {
      if (!dock.hasAttribute('data-pointer-held')) return;
      dock.removeAttribute('data-pointer-held');
      for (const animation of pillMotions()) if (animation.playState === 'paused') animation.play();
      schedule();
    };
    dock.addEventListener('pointerdown', holdTargets, true);
    window.addEventListener('pointerup', releaseTargets, true);
    window.addEventListener('pointercancel', releaseTargets, true);
    window.addEventListener('blur', releaseTargets);
    const draw = () => {
      frame = 0;
      const state = fold.current;
      const now = performance.now();
      Object.assign(
        state,
        advanceDockFold(state.value, state.velocity, state.target, (now - state.updated) / 1000, reduce.current || prefersReducedMotion()),
      );
      state.updated = now;
      const folding = state.value !== state.target || state.velocity !== 0;
      if (!folding) state.value = state.target;
      const progress = state.value;
      dock.toggleAttribute('data-scroll-revealing', state.target === 0 && progress > 0);
      dock.toggleAttribute('data-scroll-folding', progress > 0);
      dock.toggleAttribute('data-scroll-compact-labels', progress > 0.38);
      setDockStyle(dock, '--orbis-dock-fold', String(progress));
      const primary = dock.querySelector<HTMLElement>('.desktop-dock-main');
      if (!primary) return;
      const tray = dock.querySelector<HTMLElement>('.orbis-app-tray');
      const activity = dock.querySelector<HTMLElement>('.desktop-activity-rail');
      const traySize = tray?.parentElement?.offsetWidth ?? 0;
      const scrollTopSpacer = dock.querySelector<HTMLElement>('.desktop-dock-top-space');
      const scrollTopButton = dock.querySelector<HTMLElement>('.desktop-dock-scroll-top');
      const scrollTopSpace = scrollTopSpacer ? Number.parseFloat(getComputedStyle(scrollTopSpacer).width) || 0 : 0;
      const splitTravel = scrollTopSpace / (compactHeight + pillGap);
      setDockStyle(dock, '--orbis-dock-top-offset', `${scrollTopSpace}px`);
      setDockStyle(dock, '--orbis-dock-top-travel', String(splitTravel));
      const sideBySide = scrollTopSpacer && getComputedStyle(scrollTopSpacer).position === 'static';
      const primaryWidth = primary.offsetWidth;
      const style = getComputedStyle(dock);
      const inset = Number.parseFloat(style.getPropertyValue('--desktop-inset')) || 24;
      const available = dock.ownerDocument.documentElement.clientWidth - inset * 2;
      const activityFont = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const activitySpace = Math.min(400 * Math.max(1, activityFont / 16), Math.max(64, available - primaryWidth - traySize - pillGap * 2));
      setDockStyle(dock, '--orbis-activity-space', `${activitySpace}px`);
      setDockStyle(dock, '--orbis-dock-nav-margin', `${((compactHeight - primaryWidth) * progress) / 2}px`);
      const compactTrayWidth = dockSideWidth(tray?.querySelectorAll('.app-tray-item').length ?? 0, 48, 6, 8, available * 0.32);
      const activityCount = Number(activity?.dataset.activityCount) || 0;
      const compactPillWidth = 88 + activityFont * 4.75;
      const compactRailWidth = dockSideWidth(
        activityCount,
        compactPillWidth,
        pillGap,
        0,
        available - compactHeight - compactTrayWidth - scrollTopSpace - pillGap * 2,
      );
      for (const [control, compactWidth] of [
        [tray, compactTrayWidth],
        [activity, compactRailWidth],
      ] as const) {
        const inner = control?.parentElement;
        const wrapper = inner?.parentElement;
        if (!control || !inner || !wrapper) continue;
        const base = Number.parseFloat(getComputedStyle(inner).width) || 0;
        const width = base + (compactWidth - base) * progress;
        const visible = Math.min(1, wrapper.offsetWidth / Math.max(1, base));
        const baseHeight = Number.parseFloat(getComputedStyle(inner).height) || primary.offsetHeight;
        const height = baseHeight + (compactHeight - baseHeight) * progress;
        setDockStyle(wrapper, '--orbis-dock-side-width', progress ? `${width}px` : '');
        setDockStyle(wrapper, '--orbis-dock-side-height', progress ? `${height}px` : '');
        setDockStyle(wrapper, '--orbis-dock-side-margin', `${(width - base) * visible}px`);
        if (control === activity) {
          const expandedPillWidth = Math.max(64, (base - (activityCount - 1) * pillGap) / Math.max(1, activityCount));
          const width = expandedPillWidth + (compactPillWidth - expandedPillWidth) * progress;
          setDockStyle(wrapper, '--orbis-dock-activity-pill-width', `${width}px`);
        }
      }
      const origin = dock.getBoundingClientRect();
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
      const originalMain = read(primary);
      const center = originalMain.left + (originalMain.width - (sideBySide ? 0 : scrollTopSpace)) / 2;
      setDockStyle(dock, '--orbis-dock-nav-center', `${center}px`);
      const shape = foldDockBox(
        originalMain,
        {
          left: center - compactHeight / 2,
          top: origin.height / scaleY - compactHeight,
          width: compactHeight,
          height: compactHeight,
          radius: compactHeight / 2,
        },
        progress,
      );
      const main = { ...shape, right: shape.left + shape.width, bottom: shape.top + shape.height };
      primary.style.clipPath = progress > 0 ? foldDockClip(originalMain, main) : '';
      const moving = !progress && Boolean(dock.querySelector('[data-pill-motion]'));
      let path = rounded(main);
      if (progress > 0 && splitTravel > 0 && scrollTopButton) {
        const topButton = read(scrollTopButton);
        path += rounded(topButton);
        path += dockCircleSplitBridge(main.right, topButton.left, (topButton.top + topButton.bottom) / 2, compactHeight / 2);
      }
      if (tray?.getClientRects().length) {
        const box = read(tray);
        const covered = Math.max(0, main.right - box.left);
        tray.style.clipPath = covered > 0.01 ? `inset(0 0 0 ${covered}px)` : '';
        if (box.width && box.height) path += rounded(box);
      }
      if (activity?.getClientRects().length) {
        const rail = read(activity);
        const covered = Math.max(0, rail.right - main.left);
        activity.style.clipPath = covered > 0.01 ? `inset(0 ${covered}px 0 0)` : '';
        const shapes: Box[] = [];
        for (const trigger of activity.querySelectorAll('.desktop-activity-trigger')) {
          const box = read(trigger);
          box.left = Math.max(box.left, rail.left);
          box.right = Math.min(box.right, rail.right);
          box.top = Math.max(box.top, rail.top);
          box.bottom = Math.min(box.bottom, rail.bottom);
          box.width = Math.max(0, box.right - box.left);
          box.height = Math.max(0, box.bottom - box.top);
          if (box.width && box.height) shapes.push(box);
        }
        shapes.sort((a, b) => a.left - b.left);
        for (const [index, box] of shapes.entries()) path += rounded(box) + bridge(box, shapes[index + 1] ?? main, moving);
      }
      if (element.dataset.shape !== path) {
        element.style.clipPath = `path('${path}')`;
        element.dataset.shape = path;
      }
      // Clip controls separately. Clipping their common ancestor creates a
      // backdrop root and prevents the glass sibling from blurring the page.
      if (folding || (!dock.hasAttribute('data-pointer-held') && dock.querySelector('[data-pill-motion]'))) schedule();
    };
    const schedule = () => {
      if (!frame && !disposed) frame = requestAnimationFrame(draw);
    };
    const redraw = () => {
      cancelAnimationFrame(frame);
      draw();
    };
    redrawFold.current = redraw;
    dock.addEventListener(shapeEvent, redraw);
    window.addEventListener('resize', redraw);
    dock.addEventListener('scroll', schedule, true);
    const sizes = new ResizeObserver(schedule);
    const observe = () => {
      sizes.disconnect();
      sizes.observe(dock);
      for (const node of dock.querySelectorAll(
        '.desktop-dock-main, .desktop-dock-companion, .desktop-dock-companion-content, .desktop-dock-top-space',
      ))
        sizes.observe(node);
      schedule();
    };
    const changes = new MutationObserver((records) => {
      if (records.some(({ attributeName }) => attributeName === 'data-scroll-top')) redraw();
      if (records.some(({ attributeName }) => attributeName !== 'data-scroll-top')) observe();
    });
    changes.observe(dock, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-pill-motion', 'data-scroll-top'] });
    observe();
    draw();
    return () => {
      disposed = true;
      redrawFold.current = () => undefined;
      dock.style.removeProperty('--orbis-dock-fold');
      dock.style.removeProperty('--orbis-dock-compact-size');
      dock.style.removeProperty('--orbis-dock-top-offset');
      dock.style.removeProperty('--orbis-dock-top-travel');
      dock.style.removeProperty('--orbis-dock-nav-center');
      dock.style.removeProperty('--orbis-dock-nav-margin');
      for (const node of dock.querySelectorAll<HTMLElement>('.desktop-dock-main, .orbis-app-tray, .desktop-activity-rail'))
        node.style.removeProperty('clip-path');
      for (const wrapper of dock.querySelectorAll<HTMLElement>(':scope > .desktop-dock-companion')) {
        for (const property of ['width', 'height', 'margin']) wrapper.style.removeProperty(`--orbis-dock-side-${property}`);
        wrapper.style.removeProperty('--orbis-dock-activity-pill-width');
      }
      dock.removeAttribute('data-scroll-revealing');
      dock.removeAttribute('data-scroll-folding');
      dock.removeAttribute('data-scroll-compact-labels');
      cancelAnimationFrame(frame);
      sizes.disconnect();
      changes.disconnect();
      releaseTargets();
      dock.removeEventListener('pointerdown', holdTargets, true);
      window.removeEventListener('pointerup', releaseTargets, true);
      window.removeEventListener('pointercancel', releaseTargets, true);
      window.removeEventListener('blur', releaseTargets);
      dock.removeEventListener(shapeEvent, redraw);
      window.removeEventListener('resize', redraw);
      dock.removeEventListener('scroll', schedule, true);
    };
  }, []);
  return <div ref={glass} className="desktop-dock-glass" aria-hidden="true" />;
}
