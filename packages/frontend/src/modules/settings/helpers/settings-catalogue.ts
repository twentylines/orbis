import { createSearchMatcher, normaliseSearch } from '@runtipi/common/types';
export const settingsSections = [
  { id: 'general', label: 'General', detail: 'Server and network' },
  { id: 'customise', label: 'Customisation', detail: 'Colours and workspace' },
  { id: 'store', label: 'Store', detail: 'Sources and suggestions' },
  { id: 'updates', label: 'Updates', detail: 'Releases and schedules' },
  { id: 'backups', label: 'Backup & recovery', detail: 'Archives and transfers' },
  { id: 'security', label: 'Security', detail: 'Account and sign-in' },
  { id: 'https', label: 'HTTPS', detail: 'Private secure access' },
  { id: 'cluster', label: 'Cluster', detail: 'Paired servers and sync' },
  { id: 'logs', label: 'Logs', detail: 'Server diagnostics' },
  { id: 'about', label: 'About', detail: 'Software and hardware' },
] as const;
export type SettingsSection = (typeof settingsSections)[number]['id'];
export type SettingsAccess = { operator: boolean; advanced?: boolean; http?: boolean };
export type SettingEntry = {
  id: string;
  label: string;
  section: SettingsSection;
  anchor: string;
  aliases: string;
  operator?: boolean;
  advanced?: boolean;
  httpOnly?: boolean;
  focus?: string;
  exactAliases?: readonly string[];
  controlLabel?: string;
};
export function resolveSettingsSection(value: string | null): SettingsSection {
  const aliases: Record<string, SettingsSection> = { appearance: 'customise', settings: 'general', appstores: 'store', backup: 'backups' };
  return (
    settingsSections.find((section) => section.id === value)?.id ?? (value && Object.hasOwn(aliases, value) ? aliases[value] : undefined) ?? 'general'
  );
}

export const settingsCatalogue: readonly SettingEntry[] = [
  {
    id: 'server-name',
    label: 'Server name',
    section: 'customise',
    anchor: 'desktop-server-name',
    aliases: 'servername rename display name hostname workspace',
  },
  { id: 'colour-mode', label: 'Colour mode', section: 'customise', anchor: 'appearance-mode', aliases: 'color theme system appearance' },
  {
    id: 'dark-mode',
    label: 'Dark mode',
    section: 'customise',
    anchor: 'appearance-mode',
    aliases: 'dark night black theme',
    focus: '[data-setting-value="dark"]',
  },
  {
    id: 'light-mode',
    label: 'Light mode',
    section: 'customise',
    anchor: 'appearance-mode',
    aliases: 'light bright white theme',
    focus: '[data-setting-value="light"]',
  },
  {
    id: 'colour-preset',
    label: 'Colour preset',
    section: 'customise',
    anchor: 'appearance-preset',
    aliases: 'color palette frost forest graphite stone ocean blush',
  },
  { id: 'theme-packs', label: 'Theme packs', section: 'customise', anchor: 'setting-theme-packs', aliases: 'themes catalogue fonts typography' },
  { id: 'text-size', label: 'Text size', section: 'customise', anchor: 'appearance-text', aliases: 'font scale larger small accessibility zoom' },
  {
    id: 'wallpaper',
    label: 'Wallpaper',
    section: 'customise',
    anchor: 'appearance-wallpaper',
    aliases: 'background image photo upload custom picture',
  },
  {
    id: 'wallpaper-dim',
    label: 'Dim wallpaper',
    section: 'customise',
    anchor: 'appearance-wallpaper',
    aliases: 'wallpaper dim darkness brightness',
    controlLabel: 'Dim wallpaper',
  },
  {
    id: 'wallpaper-blur',
    label: 'Wallpaper blur',
    section: 'customise',
    anchor: 'appearance-wallpaper',
    aliases: 'wallpaper blur background',
    controlLabel: 'Wallpaper blur',
  },
  { id: 'accent-colour', label: 'Accent colour', section: 'customise', anchor: 'appearance-accent', aliases: 'color custom hex buttons' },
  {
    id: 'transparency',
    label: 'Transparency & blur',
    section: 'customise',
    anchor: 'appearance-glass',
    aliases: 'opaque glass translucent opacity material',
  },
  {
    id: 'panel-opacity',
    label: 'Panel opacity',
    section: 'customise',
    anchor: 'appearance-glass',
    aliases: 'panels opacity transparency',
    controlLabel: 'Panel opacity',
  },
  {
    id: 'panel-blur',
    label: 'Panel blur',
    section: 'customise',
    anchor: 'appearance-glass',
    aliases: 'panels blur glass',
    controlLabel: 'Panel blur',
  },
  { id: 'motion', label: 'Motion', section: 'customise', anchor: 'appearance-motion', aliases: 'animation movement reduced motion accessibility' },
  {
    id: 'surfaces',
    label: 'Solid surfaces',
    section: 'customise',
    anchor: 'appearance-transparency',
    aliases: 'transparency opaque solid reduce transparency',
  },
  {
    id: 'energy-saving',
    label: 'Energy saving',
    section: 'customise',
    anchor: 'appearance-effects',
    aliases: 'performance energy low effects cpu gpu battery',
  },
  { id: 'density', label: 'Spacing', section: 'customise', anchor: 'appearance-density', aliases: 'density compact comfortable spacing rows' },
  { id: 'opening-apps', label: 'Opening apps', section: 'customise', anchor: 'app-opening-heading', aliases: 'browser tab windows launcher open' },
  {
    id: 'customisation-file',
    label: 'Import and export customisation',
    section: 'customise',
    anchor: 'appearance-transfer',
    aliases: 'preferences configuration json file export import',
  },
  {
    id: 'reset-customisation',
    label: 'Reset customisation',
    section: 'customise',
    anchor: 'appearance-reset',
    aliases: 'restore defaults appearance reset',
  },
  { id: 'time-zone', label: 'Time zone', section: 'general', anchor: 'setting-time-zone', aliases: 'timezone clock time region', operator: true },
  {
    id: 'local-domain',
    label: 'Local domain',
    section: 'general',
    anchor: 'setting-localDomain',
    aliases: 'private dns hostname localdomain address https',
    operator: true,
  },
  {
    id: 'guest-dashboard',
    label: 'Guest dashboard',
    section: 'general',
    anchor: 'setting-guestDashboard',
    aliases: 'guest public dashboard access',
    operator: true,
  },
  {
    id: 'error-monitoring',
    label: 'Error reporting',
    section: 'general',
    anchor: 'setting-allowErrorMonitoring',
    aliases: 'monitoring diagnostics error telemetry',
    operator: true,
  },
  {
    id: 'advanced-settings',
    label: 'Advanced settings',
    section: 'general',
    anchor: 'setting-advancedSettings',
    aliases: 'advanced network ports internal ip listen address app data authentication',
    operator: true,
  },
  { id: 'http-port', label: 'HTTP port', section: 'general', anchor: 'setting-port', aliases: 'port network http', operator: true, advanced: true },
  {
    id: 'https-port',
    label: 'HTTPS port',
    section: 'general',
    anchor: 'setting-sslPort',
    aliases: 'ssl secure port https',
    operator: true,
    advanced: true,
  },
  {
    id: 'app-data-path',
    label: 'App data path',
    section: 'general',
    anchor: 'setting-appDataPath',
    aliases: 'storage folder app data directory',
    operator: true,
    advanced: true,
  },
  {
    id: 'internal-ip',
    label: 'Internal IP address',
    section: 'general',
    anchor: 'setting-internalIp',
    aliases: 'internal ip private address network',
    operator: true,
    advanced: true,
  },
  {
    id: 'listen-ip',
    label: 'Listen address',
    section: 'general',
    anchor: 'setting-listenIp',
    aliases: 'listen bind ip network address',
    operator: true,
    advanced: true,
  },
  {
    id: 'external-domain',
    label: 'Domain',
    section: 'general',
    anchor: 'setting-domain',
    aliases: 'domain hostname dns external',
    operator: true,
    advanced: true,
  },
  {
    id: 'backup-limit',
    label: 'App backup limit',
    section: 'general',
    anchor: 'setting-maxBackups',
    aliases: 'maximum backups limit retention count',
    operator: true,
    advanced: true,
  },
  {
    id: 'event-timeout',
    label: 'Operation timeout',
    section: 'general',
    anchor: 'setting-eventsTimeout',
    aliases: 'events timeout queue minutes',
    operator: true,
    advanced: true,
  },
  {
    id: 'forward-auth',
    label: 'Forward authentication URL',
    section: 'general',
    anchor: 'setting-forwardAuthUrl',
    aliases: 'authentication forward auth url login',
    operator: true,
    advanced: true,
  },
  {
    id: 'store-suggestions',
    label: 'Store suggestions',
    section: 'store',
    anchor: 'store-recommendations-heading',
    aliases: 'recommendations collections gaming media ai categories hidden suggestions',
  },
  {
    id: 'store-app-updates',
    label: 'Automatic app updates',
    section: 'updates',
    anchor: 'setting-app-updates',
    aliases: 'auto apps upgrade installed default manual',
    operator: true,
  },
  {
    id: 'store-sources',
    label: 'App sources',
    section: 'store',
    anchor: 'setting-store-sources',
    aliases: 'appstores repositories catalogue store add refresh sources',
    operator: true,
  },
  {
    id: 'release-channel',
    label: 'Release channel',
    section: 'updates',
    anchor: 'setting-release-channel',
    aliases: 'stable nightly version release channel',
    operator: true,
  },
  {
    id: 'automatic-updates',
    label: 'Automatic Orbis updates',
    section: 'updates',
    anchor: 'setting-orbis-updates',
    aliases: 'autoupdates automatic updates orbis idle schedule',
    operator: true,
  },
  {
    id: 'system-updates',
    label: 'System package updates',
    section: 'updates',
    anchor: 'setting-system-updates',
    aliases: 'ubuntu operating system packages apt automatic update',
    operator: true,
  },
  {
    id: 'server-backups',
    exactAliases: ['backup', 'backups'],
    label: 'Server backups',
    section: 'backups',
    anchor: 'setting-server-backups',
    aliases: 'backup archive export encrypted create download',
    operator: true,
  },
  {
    id: 'server-transfer',
    label: 'Transfer a server',
    section: 'backups',
    anchor: 'setting-server-transfer',
    aliases: 'transfer move receive import restore orbis nearby',
    operator: true,
  },
  {
    id: 'username',
    label: 'Username or email',
    section: 'security',
    anchor: 'setting-username',
    aliases: 'username account email login sign in name',
  },
  { id: 'password', label: 'Password', section: 'security', anchor: 'setting-password', aliases: 'password change account credentials' },
  {
    id: 'https-setup',
    label: 'HTTPS setup',
    section: 'https',
    anchor: 'setting-https-setup',
    aliases: 'https ssl secure local certificate cert trust setup',
    httpOnly: true,
  },
  { id: 'passkeys', label: 'Passkeys', section: 'security', anchor: 'setting-passkeys', aliases: 'passkey fingerprint touch face biometric login' },
  {
    id: 'two-factor',
    label: 'Two-factor authentication',
    section: 'security',
    anchor: 'setting-two-factor',
    aliases: 'totp otp 2fa authenticator security code two factor',
  },
  {
    id: 'cluster-pairing',
    label: 'Server pairing',
    section: 'cluster',
    anchor: 'setting-cluster-pairing',
    aliases: 'cluster pair join code certificate private ca trust',
    operator: true,
  },
  {
    id: 'nearby-visibility',
    label: 'Nearby visibility',
    section: 'cluster',
    anchor: 'cluster-nearby-heading',
    aliases: 'nearby discovery discoverable visible servers multicast network',
    operator: true,
  },
  {
    id: 'settings-sync',
    label: 'Settings sync',
    section: 'cluster',
    anchor: 'cluster-sync-heading',
    aliases: 'cluster sync automatic receiving consent share settings',
    operator: true,
  },
  {
    id: 'system-logs',
    label: 'System logs',
    section: 'logs',
    anchor: 'setting-system-logs',
    aliases: 'logs errors diagnostics terminal',
    operator: true,
  },
  {
    id: 'installed-software',
    label: 'Installed software',
    section: 'about',
    anchor: 'about-software-title',
    aliases: 'orbis runtipi version build software license',
  },
  {
    id: 'server-hardware',
    label: 'Server hardware',
    section: 'about',
    anchor: 'about-hardware-title',
    aliases: 'hardware cpu memory architecture system model',
  },
];

export function searchSettings(query: string, access: SettingsAccess, limit = 12): SettingEntry[] {
  const needle = normaliseSearch(query.slice(0, 160)).slice(0, 80);
  if (!needle) return [];
  const match = createSearchMatcher(query);
  return settingsCatalogue
    .filter((entry) => settingAvailable(entry, access))
    .map((entry, index) => ({
      entry,
      index,
      score: entry.exactAliases?.some((alias) => normaliseSearch(alias) === needle) ? 975 : match(entry.label, entry.aliases),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, Math.max(0, Math.min(20, Math.trunc(limit) || 0)))
    .map(({ entry }) => entry);
}
export const settingsPath = (entry: SettingEntry) => `/settings?tab=${entry.section}&setting=${entry.id}`;
export const settingAvailable = (entry: SettingEntry, access: SettingsAccess) =>
  (!entry.operator || access.operator) && (!entry.advanced || access.advanced) && (!entry.httpOnly || access.http === true);

export function retainSettingsSections(previous: ReadonlySet<SettingsSection>, current: SettingsSection): ReadonlySet<SettingsSection> {
  return previous.has(current) ? previous : new Set([...previous, current]);
}

export function settingsLocation(pathname: string, search: string, section: SettingsSection, entry?: SettingEntry) {
  const params = new URLSearchParams(search);
  params.set('tab', section);
  if (entry) params.set('setting', entry.id);
  else params.delete('setting');
  return { pathname, search: `?${params}`, hash: '' };
}
