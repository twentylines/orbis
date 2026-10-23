import clsx from 'clsx';
import { memo, useState } from 'react';
import './app-logo.css';

type AppLogoProps = {
  urn?: string;
  url?: string;
  size?: number;
  className?: string;
  alt?: string;
  placeholder?: boolean;
};
export const AppLogo = memo(function AppLogo({ urn, url, size = 80, className = '', alt = '' }: AppLogoProps) {
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
      draggable={false}
      style={{ width: `var(--app-logo-size, ${size}px)`, height: `var(--app-logo-size, ${size}px)`, minWidth: `var(--app-logo-size, ${size}px)` }}
      onError={() => setFailed(logoUrl)}
    />
  );
});
