import { useLayoutEffect, useRef } from 'react';

function InkBaseline() {
  return <i className="workspace-ink-baseline" aria-hidden="true" />;
}

export function HomeApplicationsHeading({ installed, running }: { installed?: number; running: number }) {
  const heading = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const row = heading.current;
    const title = row?.querySelector('h2');
    const counts = row?.querySelector<HTMLElement>('.workspace-app-counts');
    if (!row || !title || !counts) return;
    const context = document.createElement('canvas').getContext('2d');
    if (!context) return;
    let active = true;
    let capsuleOffset = 0;
    const inkOffsets = new Map<HTMLElement, number>();
    let frame = 0;
    const inkCache = new Map<string, { top: number; bottom: number }>();
    const inkBounds = (element: HTMLElement, text: string) => {
      const baseline = element.querySelector('.workspace-ink-baseline')?.getBoundingClientRect().top;
      if (baseline === undefined) return null;
      const style = getComputedStyle(element);
      const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const ratio = window.devicePixelRatio || 1;
      const cacheKey = `${font}|${ratio}|${text}`;
      const cached = inkCache.get(cacheKey);
      if (cached) return { top: baseline + cached.top, bottom: baseline + cached.bottom };
      context.font = font;
      const metrics = context.measureText(text);
      const bounds = { top: -metrics.actualBoundingBoxAscent, bottom: metrics.actualBoundingBoxDescent };
      inkCache.set(cacheKey, bounds);
      return { top: baseline - metrics.actualBoundingBoxAscent, bottom: baseline + metrics.actualBoundingBoxDescent };
    };
    const align = () => {
      if (!active) return;
      const titleInk = inkBounds(title, 'Applications');
      const values = Array.from(counts.children).filter((element): element is HTMLElement => element instanceof HTMLElement);
      const valueInk = values
        .map((element, index) => inkBounds(element, index === 0 ? `${installed} installed` : `${running} running`))
        .filter((bounds) => bounds !== null);
      if (!titleInk || !valueInk.length) return;
      const box = counts.getBoundingClientRect();
      const titleBox = title.getBoundingClientRect();
      const center = (box.top + box.bottom) / 2;
      const adjustments = values.map((element, index) => {
        const ink = valueInk[index];
        const bounds = element.getBoundingClientRect();
        if (!ink) return 0;
        return (bounds.top + bounds.bottom - ink.top - ink.bottom) / 2;
      });
      const sameRow = box.left >= titleBox.right && box.top < titleBox.bottom;
      capsuleOffset = sameRow ? capsuleOffset + (titleInk.top + titleInk.bottom) / 2 - center : 0;
      values.forEach((element, index) => {
        const offset = adjustments[index] ?? 0;
        inkOffsets.set(element, offset);
        element.style.setProperty('--workspace-count-ink-alignment', `${offset}px`);
      });
      counts.style.setProperty('--workspace-count-alignment', `${capsuleOffset}px`);
    };
    const schedule = () => {
      if (!active) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(align);
    };
    align();
    const observer = new ResizeObserver(schedule);
    observer.observe(row);
    observer.observe(title);
    observer.observe(counts);
    const fontsChanged = () => {
      inkCache.clear();
      schedule();
    };
    void document.fonts.ready.then(fontsChanged);
    document.fonts.addEventListener('loadingdone', fontsChanged);
    return () => {
      active = false;
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.fonts.removeEventListener('loadingdone', fontsChanged);
      for (const element of inkOffsets.keys()) element.style.removeProperty('--workspace-count-ink-alignment');
      counts.style.removeProperty('--workspace-count-alignment');
    };
  }, [installed, running]);

  return (
    <div className="workspace-app-heading-text" ref={heading}>
      <h2 id="workspace-apps-title">
        Applications
        <InkBaseline />
      </h2>
      {installed !== undefined ? (
        <p className="workspace-app-counts">
          <span>
            {installed} installed
            <InkBaseline />
          </span>
          <span>
            {running} running
            <InkBaseline />
          </span>
        </p>
      ) : null}
    </div>
  );
}
