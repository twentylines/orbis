import { useLayoutEffect, useState } from 'react';
import type { WindowArea } from './window-geometry';

export function useAppWindowArea() {
  const [area, setArea] = useState<WindowArea>({ x: 24, y: 104, width: 1000, height: 600 });
  useLayoutEffect(() => {
    const measure = () => {
      const bar = document.querySelector<HTMLElement>('.desktop-system-bar');
      const dock = document.querySelector<HTMLElement>('.desktop-dock');
      // Layout dimensions exclude the entrance transforms on the system bar and dock.
      const x = bar?.offsetLeft ?? 24;
      const barTop = bar ? Math.max(Number.parseFloat(getComputedStyle(bar).top) || 0, bar.offsetTop - scrollY) : 24;
      const y = Math.round(barTop + (bar?.offsetHeight ?? 64) + 12);
      const dockTop = dock ? innerHeight - (Number.parseFloat(getComputedStyle(dock).bottom) || 20) - dock.offsetHeight : innerHeight - 100;
      const next = { x, y, width: Math.max(1, bar?.offsetWidth ?? innerWidth - x * 2), height: Math.max(1, Math.round(dockTop - y - 12)) };
      setArea((previous) =>
        previous.x === next.x && previous.y === next.y && previous.width === next.width && previous.height === next.height ? previous : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const element of document.querySelectorAll('.desktop-system-bar,.desktop-dock')) observer.observe(element);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);
  return area;
}
