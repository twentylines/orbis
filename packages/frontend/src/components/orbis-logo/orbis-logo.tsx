import type { CSSProperties } from 'react';
import './orbis-logo.css';

export function OrbisLogo({ size = 28, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      className={`orbis-logo ${className}`.trim()}
      width={size}
      height={size}
      style={{ '--orbis-logo-size': `${size}px` } as CSSProperties}
      viewBox="0 0 64 64"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="2" y="2" width="60" height="60" rx="17" fill="var(--desktop-action)" />
      <circle cx="32" cy="32" r="17" fill="none" stroke="var(--desktop-action-ink)" strokeWidth="2.4" />
      <ellipse cx="32" cy="32" rx="26" ry="9.5" fill="none" stroke="var(--desktop-logo-orbit)" strokeWidth="2.5" transform="rotate(-32 32 32)" />
      <circle cx="32" cy="32" r="5" fill="var(--desktop-action-ink)" />
      <circle cx="52" cy="18" r="3" fill="var(--desktop-logo-orbit)" />
    </svg>
  );
}
