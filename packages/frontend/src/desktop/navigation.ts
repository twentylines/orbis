import { IconActivity, IconApps, IconBrandAppstore, IconDeviceDesktopAnalytics, IconHome, IconRefresh, IconSettings } from '@tabler/icons-react';

export const desktopNavigation = [
  { path: '/dashboard', label: 'Workspace', dockLabel: 'Home', Icon: IconHome, keywords: 'home dashboard' },
  { path: '/apps', label: 'Applications', dockLabel: 'Apps', Icon: IconApps, keywords: 'installed docker containers' },
  { path: '/app-store', label: 'App Store', dockLabel: 'Store', Icon: IconBrandAppstore, keywords: 'install catalogue marketplace' },
  { path: '/monitor', label: 'Monitor', Icon: IconDeviceDesktopAnalytics, keywords: 'status system cpu memory storage resources' },
  { path: '/updates', label: 'Updates', Icon: IconRefresh, keywords: 'orbis server system changelog release upgrade' },
  { path: '/settings', label: 'Settings', Icon: IconSettings, keywords: 'configuration preferences' },
  { path: '/tasks', label: 'Task centre', Icon: IconActivity, keywords: 'task center operations activity history' },
];

export const desktopSearchSections = [
  ...desktopNavigation,
  { path: '/settings?tab=appearance', label: 'Appearance', Icon: IconSettings, keywords: 'theme wallpaper light dark mode personalisation' },
  { path: '/settings?tab=security', label: 'Security', Icon: IconSettings, keywords: 'password account authentication two factor totp' },
  { path: '/settings?tab=settings', label: 'Server settings', Icon: IconSettings, keywords: 'hostname domain network configuration' },
  { path: '/settings?tab=appstores', label: 'App stores', Icon: IconBrandAppstore, keywords: 'repositories sources catalogue' },
  { path: '/settings?tab=logs', label: 'System logs', Icon: IconActivity, keywords: 'orbis runtipi diagnostics' },
];
