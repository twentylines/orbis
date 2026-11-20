import { IconBrowserPlus } from '@tabler/icons-react';
import './app-tab-indicator.css';

export function AppTabIndicator() {
  return (
    <span className="app-tab-indicator" role="img" aria-label="Opens in a new tab" title="Opens in a new tab">
      <IconBrowserPlus aria-hidden="true" />
    </span>
  );
}
