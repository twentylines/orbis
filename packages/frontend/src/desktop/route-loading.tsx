import { useEffect, useState } from 'react';

export function DelayedRouteLoading({ label = 'Loading page…', delay = 300 }: { label?: string; delay?: number }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(true), delay);
    return () => window.clearTimeout(timer);
  }, [delay]);
  if (!visible) return null;
  return (
    <output className="desktop-route-loading">
      <span className="desktop-route-loading-lines" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span>{label}</span>
    </output>
  );
}
