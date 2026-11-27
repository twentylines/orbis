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
    path: '/monitor?section=performance',
    label: 'Performance',
    Icon: IconDeviceDesktopAnalytics,
    keywords: 'utilisation utilization charts processor ram bandwidth metrics',
  },
  {
    path: '/monitor?section=performance&metric=cpu#telemetry-cpu-title',
    label: 'CPU',
    Icon: IconDeviceDesktopAnalytics,
    keywords: 'processor performance utilisation utilization clock frequency cores logical processors recorded history',
  },
  {
    path: '/monitor?section=performance&metric=memory#telemetry-memory-title',
    label: 'Memory',
    Icon: IconDeviceDesktopAnalytics,
    keywords: 'ram performance utilisation utilization swap capacity recorded history',
  },
  {
    path: '/monitor?section=performance&metric=network#monitor-network-history-title',
    label: 'Network',
    Icon: IconDeviceDesktopAnalytics,
    keywords: 'performance traffic bandwidth download upload speed interface recorded history',
  },
  {
    path: '/monitor?section=devices#host-storage-title',
    label: 'Storage',
    Icon: IconDeviceDesktopAnalytics,
    keywords: 'disk filesystem filesystems mount capacity space usage',
  },
  {
    path: '/monitor?section=devices',
    label: 'Devices',
    Icon: IconDeviceDesktopAnalytics,
    keywords: 'host disks network interfaces hardware activity',
  },
  {
    path: '/monitor?section=sensors#host-gpus-title',
    label: 'GPU',
    Icon: IconDeviceDesktopAnalytics,
    keywords: 'graphics video utilisation utilization temperature vram',
  },
  {
    path: '/monitor?section=sensors#host-temperatures-title',
    label: 'Sensors',
    Icon: IconDeviceDesktopAnalytics,
    keywords: 'temperature heat thermal fans cooling rpm hardware',
  },
  {
    path: '/monitor?section=usage#containers',
    label: 'Containers',
    Icon: IconActivity,
    keywords: 'docker container cpu memory usage running health',
  },
  { path: '/monitor?section=usage#processes', label: 'Processes', Icon: IconActivity, keywords: 'host task process cpu memory pid usage' },
  {
    path: '/monitor#device-history',
    label: 'Device history',
    Icon: IconDeviceDesktopAnalytics,
    keywords: 'host network interface disk activity charts recorded history',
  },
  {
    path: '/monitor?section=drives#drive-health-title',
    label: 'Drive health',
    Icon: IconDeviceDesktopAnalytics,
    keywords: 'disk smart nvme temperature wear health self test storage scrutiny',
  },
  { path: '/settings?tab=customise', label: 'Customise', Icon: IconSettings, keywords: 'theme wallpaper light dark mode personalisation' },
  { path: '/settings?tab=security', label: 'Security', Icon: IconSettings, keywords: 'password account authentication two factor totp' },
  { path: '/settings?tab=general', label: 'General', Icon: IconSettings, keywords: 'hostname domain network configuration' },
  { path: '/settings?tab=store', label: 'Store', Icon: IconBrandAppstore, keywords: 'app stores repositories sources catalogue suggestions' },
  { path: '/settings?tab=updates', label: 'Update settings', Icon: IconRefresh, keywords: 'automatic updates channel schedule' },
  { path: '/settings?tab=backups', label: 'Backup & recovery', Icon: IconSettings, keywords: 'backup restore archive transfer' },
  { path: '/settings?tab=cluster', label: 'Cluster', Icon: IconSettings, keywords: 'pairing paired servers sync' },
  { path: '/settings?tab=about', label: 'About', Icon: IconSettings, keywords: 'software hardware version licenses' },
  { path: '/settings?tab=logs', label: 'System logs', Icon: IconActivity, keywords: 'orbis diagnostics' },
];
