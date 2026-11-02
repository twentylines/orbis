import { motion } from 'framer-motion';
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

export function SetupStage({
  children,
  stageRef,
  stepElement,
  reduced,
}: {
  children: ReactNode;
  stageRef: RefObject<HTMLDivElement | null>;
  stepElement: HTMLElement | null;
  reduced: boolean;
}) {
  const [size, setSize] = useState<{ height: number; animate: boolean } | null>(null);
  const measured = useRef(false);
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage || !stepElement) return;
    const style = getComputedStyle(stage);
    const padding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
    const update = (contentHeight: number) => {
      const height = contentHeight + padding;
      const animate = measured.current;
      measured.current = true;
      setSize((current) => (current?.height === height ? current : { height, animate }));
    };
    const initialHeight = stepElement.offsetHeight;
    update(initialHeight);
    let frame: number | undefined;
    let nextHeight = initialHeight;
    const observer = new ResizeObserver((entries) => {
      const entry = entries.find(({ target }) => target === stepElement);
      if (!entry) return;
      nextHeight = entry.borderBoxSize?.[0]?.blockSize ?? stepElement.offsetHeight;
      if (frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        update(nextHeight);
      });
    });
    observer.observe(stepElement);
    return () => {
      observer.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [stageRef, stepElement]);
  return (
    <motion.div
      ref={stageRef}
      id="setup-choices"
      className="orbis-setup-stage"
      initial={false}
      animate={size ? { height: size.height } : {}}
      transition={{ duration: reduced || !size?.animate ? 0 : 0.24, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  );
}
