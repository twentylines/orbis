import { IconLock } from '@tabler/icons-react';
import { hasHttpsConnection } from '@/desktop/secure-access';
import './secure-connection-indicator.css';

export function SecureConnectionIndicator({
  compact = false,
  protocol = typeof window === 'undefined' ? '' : window.location.protocol,
  secureContext = typeof window !== 'undefined' && window.isSecureContext,
}: {
  compact?: boolean;
  protocol?: string;
  secureContext?: boolean;
}) {
  if (!hasHttpsConnection(protocol, secureContext)) return null;
  return (
    <span className="secure-connection-indicator" title="HTTPS connection" role="img" aria-label="HTTPS connection">
      <IconLock size={16} aria-hidden="true" />
      {compact ? null : <span>HTTPS</span>}
    </span>
  );
}
