import { useLayoutEffect, useRef } from 'react';
import { prefersReducedMotion } from './motion-setting';
import { sectionMotionEasing, sectionMotionTiming } from './section-motion-geometry';

type Pose = { left: number; top: number; width: number; height: number };
const frameFor = (pose: Pose) => ({ left: `${pose.left}px`, top: `${pose.top}px`, width: `${pose.width}px`, height: `${pose.height}px` });
const samePose = (a: Pose | null, b: Pose) => a && (Object.keys(b) as (keyof Pose)[]).every((key) => Math.abs(a[key] - b[key]) < 0.1);
const boundPose = (pose: Pose, width: number, height: number): Pose => {
  const size = { width: Math.min(pose.width, width), height: Math.min(pose.height, height) };
  return { ...size, left: Math.max(0, Math.min(pose.left, width - size.width)), top: Math.max(0, Math.min(pose.top, height - size.height)) };
};

export function DockSelection({ path, reduced }: { path?: string; reduced: boolean }) {
  const layer = useRef<HTMLSpanElement>(null);
  const indicator = useRef<HTMLSpanElement>(null);
  const measure = useRef<(animate: boolean) => void>(() => undefined);
  const reduce = useRef(reduced);
  reduce.current = reduced;

  useLayoutEffect(() => {
    const clip = layer.current;
    const element = indicator.current;
    const main = clip?.parentElement;
    if (!clip || !element || !main) return;
    let target: Pose | null = null;
    let motion: Animation | null = null;
    let origin: Pose | null = null;
    let frame = 0;
    const update = (animate: boolean) => {
      const selected = main.querySelector<HTMLElement>('.desktop-dock-item.is-active');
      clip.hidden = !selected;
      if (!selected) {
        motion?.cancel();
        target = null;
        origin = null;
        return;
      }
      const bounds = clip.getBoundingClientRect();
      const style = getComputedStyle(clip);
      const width = Number.parseFloat(style.width);
      const height = Number.parseFloat(style.height);
      if (!(width > 0 && height > 0)) return;
      const scaleX = bounds.width / width || 1;
      const scaleY = bounds.height / height || 1;
      const local = (rect: DOMRect): Pose => ({
        left: (rect.left - bounds.left) / scaleX,
        top: (rect.top - bounds.top) / scaleY,
        width: rect.width / scaleX,
        height: rect.height / scaleY,
      });
      const next = boundPose(local(selected.getBoundingClientRect()), width, height);
      const instant = reduce.current || prefersReducedMotion();
      if (samePose(target, next) && !instant) return;
      const from = target ? boundPose(local(element.getBoundingClientRect()), width, height) : null;
      for (const key of Object.keys(next) as (keyof Pose)[]) element.style[key] = `${next[key]}px`;
      target = next;
      if (!animate && !instant && motion?.playState === 'running' && origin && motion.effect instanceof KeyframeEffect) {
        const resizedOrigin = boundPose(
          { left: origin.left * width, top: origin.top * height, width: origin.width * width, height: origin.height * height },
          width,
          height,
        );
        motion.effect.setKeyframes([frameFor(resizedOrigin), frameFor(next)]);
        return;
      }
      motion?.cancel();
      origin = null;
      if (!animate || !from || instant || samePose(from, next)) return;
      origin = { left: from.left / width, top: from.top / height, width: from.width / width, height: from.height / height };
      motion = element.animate([frameFor(from), frameFor(next)], { duration: sectionMotionTiming.surface, easing: sectionMotionEasing });
      motion.id = 'orbis-dock-selection';
    };
    measure.current = update;
    update(false);
    const sizes = new ResizeObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        update(false);
      });
    });
    sizes.observe(main);
    for (const link of main.querySelectorAll('.desktop-dock-item')) sizes.observe(link);
    return () => {
      measure.current = () => undefined;
      cancelAnimationFrame(frame);
      motion?.cancel();
      sizes.disconnect();
    };
  }, []);

  useLayoutEffect(() => {
    measure.current(Boolean(path) && !reduced);
  }, [path, reduced]);

  return (
    <span ref={layer} className="desktop-dock-selection-layer" aria-hidden="true">
      <span ref={indicator} className="desktop-dock-selection" />
    </span>
  );
}
