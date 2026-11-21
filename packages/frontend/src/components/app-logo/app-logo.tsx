import clsx from 'clsx';
import { memo, useState } from 'react';
import './app-logo.css';

const loadedLogos = new Set<string>();
const rememberLogo = (source: string) => {
  if (loadedLogos.size >= 512) loadedLogos.delete(loadedLogos.values().next().value ?? '');
  loadedLogos.add(source);
};

type AppLogoProps = {
  urn?: string;
  url?: string;
  size?: number;
  className?: string;
  alt?: string;
  placeholder?: boolean;
  loading?: 'eager' | 'lazy';
  startupOptional?: boolean;
};
export const AppLogo = memo(function AppLogo({
  urn,
  url,
  size = 80,
  className = '',
  alt = '',
  loading = 'lazy',
  startupOptional = false,
}: AppLogoProps) {
  const logoUrl = url || (urn ? `/api/marketplace/apps/${encodeURIComponent(urn)}/image` : '/app-not-found.jpg');
  const [failed, setFailed] = useState<string | null>(null);

  const source = failed === logoUrl ? '/app-not-found.jpg' : logoUrl;
  return (
    <img
      className={clsx('app-logo', 'drop-shadow', className)}
      src={source}
      width={size}
      height={size}
      alt={alt}
      decoding={loadedLogos.has(source) ? 'sync' : 'async'}
      loading={loading}
      data-startup-optional={startupOptional || undefined}
      draggable={false}
      style={{ width: `var(--app-logo-size, ${size}px)`, height: `var(--app-logo-size, ${size}px)`, minWidth: `var(--app-logo-size, ${size}px)` }}
      onLoad={() => rememberLogo(source)}
      onError={() => setFailed(logoUrl)}
    />
  );
});
