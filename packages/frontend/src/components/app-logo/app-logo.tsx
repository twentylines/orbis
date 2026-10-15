import clsx from 'clsx';
import type React from 'react';
import { useState } from 'react';
import './app-logo.css';

export const AppLogo: React.FC<{
  urn?: string;
  url?: string;
  size?: number;
  className?: string;
  alt?: string;
  placeholder?: boolean;
}> = ({ urn, url, size = 80, className = '', alt = '' }) => {
  const logoUrl = url || (urn ? `/api/marketplace/apps/${encodeURIComponent(urn)}/image` : '/app-not-found.jpg');
  const [failed, setFailed] = useState<string | null>(null);

  return (
    <img
      className={clsx('app-logo', 'drop-shadow', className)}
      src={failed === logoUrl ? '/app-not-found.jpg' : logoUrl}
      width={size}
      height={size}
      alt={alt}
      decoding="async"
      style={{ width: `var(--app-logo-size, ${size}px)`, height: `var(--app-logo-size, ${size}px)`, minWidth: `var(--app-logo-size, ${size}px)` }}
      onError={() => setFailed(logoUrl)}
    />
  );
};
