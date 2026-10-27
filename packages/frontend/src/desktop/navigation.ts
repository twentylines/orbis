import { IconActivity, IconApps, IconBrandAppstore, IconDeviceDesktopAnalytics, IconHome, IconRefresh, IconSettings } from '@tabler/icons-react';

export const desktopNavigation = [
  { path: '/dashboard', label: 'Workspace', dockLabel: 'Home', Icon: IconHome, keywords: 'home dashboard' },
  { path: '/apps', label: 'Apps', dockLabel: 'Apps', Icon: IconApps, keywords: 'applications installed docker containers' },
  { path: '/app-store', label: 'App Store', dockLabel: 'Store', Icon: IconBrandAppstore, keywords: 'install catalogue marketplace' },
  { path: '/monitor', label: 'Monitor', Icon: IconDeviceDesktopAnalytics, keywords: 'status system cpu memory storage resources processes usage' },
  { path: '/updates', label: 'Updates', Icon: IconRefresh, keywords: 'orbis server system changelog release upgrade' },
  { path: '/settings', label: 'Settings', Icon: IconSettings, keywords: 'configuration preferences' },
  { path: '/tasks', label: 'Task centre', Icon: IconActivity, keywords: 'task center operations activity history' },
];

export const desktopSearchSections = [
  ...desktopNavigation,
  {
    path: '/monitor#device-history',
    label: 'Device history',
    Icon: IconDeviceDesktopAnalytics,
    keywords: 'host network interface disk activity charts',
  },
  {
    path: '/monitor?section=drives#drive-health-title',
    label: 'Drive health',
    Icon: IconDeviceDesktopAnalytics,
    keywords: 'disk smart nvme temperature wear health self test storage scrutiny',
  },
  { path: '/settings?tab=appearance', label: 'Appearance', Icon: IconSettings, keywords: 'theme wallpaper light dark mode personalisation' },
  { path: '/settings?tab=security', label: 'Security', Icon: IconSettings, keywords: 'password account authentication two factor totp' },
  { path: '/settings?tab=settings', label: 'Server settings', Icon: IconSettings, keywords: 'hostname domain network configuration' },
  { path: '/settings?tab=appstores', label: 'App stores', Icon: IconBrandAppstore, keywords: 'repositories sources catalogue' },
  { path: '/settings?tab=logs', label: 'System logs', Icon: IconActivity, keywords: 'orbis runtipi diagnostics' },
];
