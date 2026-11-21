import { IconExternalLink } from '@tabler/icons-react';
import './app-tab-indicator.css';

export function AppTabIndicator() {
  return (
    <span className="app-tab-indicator" role="img" aria-label="Opens in a new tab" title="Opens in a new tab">
      <IconExternalLink aria-hidden="true" />
    </span>
  );
}
