import { useId, useLayoutEffect, useRef, useState } from 'react';
import './pane-scroll-progress.css';

export function PaneScrollProgress({ label, enabled = true }: { label: string; enabled?: boolean }) {
  const id = useId();
  const anchor = useRef<HTMLDivElement>(null);
  const [metrics, setMetrics] = useState({ height: 0, offset: 0, percent: 0 });
  const [controls, setControls] = useState('');

  useLayoutEffect(() => {
    const marker = anchor.current;
    const host = marker?.parentElement;
    if (!enabled || !host || !CSS.supports('scrollbar-width', 'none') || typeof ResizeObserver === 'undefined') return;

    const customScrollbar = matchMedia('(forced-colors: none) and (any-pointer: fine)');
    const originalId = host.id;
    if (!originalId) host.id = id;
    setControls(host.id);
    let frame = 0;

    const measure = () => {
      const style = getComputedStyle(host);
      const paddingStart = Number.parseFloat(style.paddingBlockStart);
      const paddingEnd = Number.parseFloat(style.paddingBlockEnd);
      // Large trailing padding clears the dock and only needs to inset the bottom end.
      const inset = Math.max(8, paddingStart, Math.min(24, paddingEnd));
      // The sticky marker starts at the pane's content edge. Offset it only by the extra inset.
      const offset = inset - paddingStart;
      const height = host.clientHeight - inset - Math.max(inset, paddingEnd);
      const enhanced = customScrollbar.matches && /^(auto|scroll)$/.test(style.overflowY) && height >= 44;
      host.toggleAttribute('data-pane-scroll-enhanced', enhanced);
      const max = host.scrollHeight - host.clientHeight;
      const percent = enhanced && max > 1 ? Math.min(100, Math.max(0, (host.scrollTop / max) * 100)) : 0;
      const visibleHeight = enhanced && max > 1 ? height : 0;
      setMetrics((current) =>
        current.height === visibleHeight && current.offset === offset && current.percent === percent
          ? current
          : { height: visibleHeight, offset, percent },
      );
    };
    const scheduleMeasure = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    const resize = new ResizeObserver(scheduleMeasure);
    const observeContent = () => {
      resize.disconnect();
      resize.observe(host);
      for (const child of host.children) {
        if (child !== marker) resize.observe(child);
      }
    };
    const mutations = new MutationObserver((records) => {
      if (records.some(({ target }) => target === host)) observeContent();
      scheduleMeasure();
    });
    observeContent();
    mutations.observe(host, { childList: true, characterData: true, subtree: true });
    host.addEventListener('scroll', scheduleMeasure, { passive: true });
    window.addEventListener('resize', scheduleMeasure);
    customScrollbar.addEventListener('change', measure);
    measure();
    return () => {
      mutations.disconnect();
      resize.disconnect();
      cancelAnimationFrame(frame);
      host.removeEventListener('scroll', scheduleMeasure);
      window.removeEventListener('resize', scheduleMeasure);
      customScrollbar.removeEventListener('change', measure);
      host.removeAttribute('data-pane-scroll-enhanced');
      if (!originalId && host.id === id) host.removeAttribute('id');
    };
  }, [enabled, id]);

  return (
    <div className="pane-scroll-progress" ref={anchor} style={{ insetBlockStart: metrics.offset }}>
      {enabled && metrics.height > 0 ? (
        <div
          className="pane-scroll-progress-control"
          role="scrollbar"
          aria-label={label}
          aria-controls={controls}
          aria-orientation="vertical"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(metrics.percent)}
          tabIndex={0}
          style={{ blockSize: metrics.height }}
          onKeyDown={(event) => {
            const host = anchor.current?.parentElement;
            if (!host || event.altKey || event.ctrlKey || event.metaKey) return;
            switch (event.key) {
              case 'ArrowDown':
                host.scrollTop += 40;
                break;
              case 'ArrowUp':
                host.scrollTop -= 40;
                break;
              case 'PageDown':
                host.scrollTop += host.clientHeight;
                break;
              case 'PageUp':
                host.scrollTop -= host.clientHeight;
                break;
              case 'Home':
                host.scrollTop = 0;
                break;
              case 'End':
                host.scrollTop = host.scrollHeight;
                break;
              default:
                return;
            }
            event.preventDefault();
            event.stopPropagation();
          }}
          onPointerDown={(event) => {
            if (event.button !== 0 || !event.isPrimary) return;
            event.preventDefault();
            event.currentTarget.focus({ preventScroll: true });
            event.currentTarget.setPointerCapture(event.pointerId);
            scrollToPointer(anchor.current?.parentElement, event.currentTarget, event.clientY);
          }}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              scrollToPointer(anchor.current?.parentElement, event.currentTarget, event.clientY);
            }
          }}
        >
          <span aria-hidden="true" style={{ transform: `scaleY(${metrics.percent / 100})` }} />
        </div>
      ) : null}
    </div>
  );
}

function scrollToPointer(host: HTMLElement | null | undefined, rail: HTMLElement, y: number) {
  if (!host) return;
  const { top, height } = rail.getBoundingClientRect();
  host.scrollTop = ((y - top) / height) * (host.scrollHeight - host.clientHeight);
}
