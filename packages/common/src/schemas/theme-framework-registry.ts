export const themeFrameworkApiVersion = 1 as const;
export const themeFrameworkRuntimeAvailable = false as const;
export const frameworkSlotIds = [
  'shell.header',
  'shell.primary',
  'shell.footer',
  'shell.sidebar',
  'shell.overlay',
  'window.toolbar',
  'settings.header',
  'settings.content',
  'notification.actions',
] as const;
export type FrameworkSlotId = (typeof frameworkSlotIds)[number];
export const frameworkComponentIds = [
  'shell.system-bar',
  'shell.navigation',
  'shell.session',
  'shell.workspace',
  'layer.dialogs',
  'layer.notifications',
  'settings.recovery',
  'control.button',
  'control.dropdown',
  'control.slider',
  'control.checkbox',
  'control.colour',
  'surface.dialog',
  'surface.window',
  'surface.notification',
] as const;
export type FrameworkComponentId = (typeof frameworkComponentIds)[number];
type ComponentRegistration = { variants: readonly string[]; host: boolean; essentialSlots: readonly FrameworkSlotId[] };
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export const frameworkComponents: Readonly<Record<FrameworkComponentId, ComponentRegistration>> = freeze({
  'shell.system-bar': { variants: ['standard', 'compact'], host: true, essentialSlots: [] },
  'shell.navigation': { variants: ['standard', 'compact'], host: true, essentialSlots: ['shell.header', 'shell.footer', 'shell.sidebar'] },
  'shell.session': { variants: ['standard', 'compact'], host: true, essentialSlots: ['shell.header'] },
  'shell.workspace': { variants: ['standard'], host: true, essentialSlots: [] },
  'layer.dialogs': { variants: ['standard'], host: true, essentialSlots: ['shell.overlay'] },
  'layer.notifications': { variants: ['standard'], host: true, essentialSlots: ['shell.overlay'] },
  'settings.recovery': { variants: ['standard'], host: true, essentialSlots: ['settings.header'] },
  'control.button': { variants: ['standard', 'compact'], host: false, essentialSlots: [] },
  'control.dropdown': { variants: ['standard', 'compact'], host: false, essentialSlots: [] },
  'control.slider': { variants: ['standard', 'compact'], host: false, essentialSlots: [] },
  'control.checkbox': { variants: ['standard', 'compact'], host: false, essentialSlots: [] },
  'control.colour': { variants: ['standard'], host: false, essentialSlots: [] },
  'surface.dialog': { variants: ['standard', 'sheet'], host: false, essentialSlots: [] },
  'surface.window': { variants: ['standard', 'compact'], host: false, essentialSlots: [] },
  'surface.notification': { variants: ['standard', 'compact'], host: false, essentialSlots: [] },
});
export const essentialFrameworkComponents = freeze(frameworkComponentIds.filter((id) => frameworkComponents[id].essentialSlots.length > 0));
export const frameworkActionIds = [
  'navigation.open',
  'session.open',
  'theme.recover',
  'navigation.home',
  'navigation.apps',
  'navigation.store',
  'navigation.monitor',
  'navigation.updates',
  'navigation.settings',
  'session.logout',
  'window.close',
  'window.minimize',
  'window.maximize',
  'notification.dismiss',
] as const;
export type FrameworkActionId = (typeof frameworkActionIds)[number];
type ActionRegistration = { gesture: true; context: 'none' | 'session' | 'window' | 'notification'; confirmation: 'core' | 'none' };
export const frameworkActions: Readonly<Record<FrameworkActionId, ActionRegistration>> = freeze(
  Object.fromEntries(
    frameworkActionIds.map((id) => [
      id,
      {
        gesture: true,
        context: id.startsWith('window.')
          ? 'window'
          : id.startsWith('notification.')
            ? 'notification'
            : id.startsWith('session.')
              ? 'session'
              : 'none',
        confirmation: ['session.logout', 'theme.recover'].includes(id) ? 'core' : 'none',
      },
    ]),
  ) as Record<FrameworkActionId, ActionRegistration>,
);
export const frameworkSoundEventIds = [
  'session.login',
  'session.logout',
  'control.activate',
  'navigation.change',
  'notification.info',
  'notification.success',
  'notification.warning',
  'notification.error',
  'window.open',
  'window.close',
  'window.minimize',
  'window.maximize',
  'dialog.open',
  'dialog.close',
] as const;
export type FrameworkSoundEventId = (typeof frameworkSoundEventIds)[number];
export const frameworkViewports = freeze({
  phone: { minWidth: 320, minHeight: 480, maxColumns: 1, floating: false },
  tablet: { minWidth: 620, minHeight: 480, maxColumns: 8, floating: false },
  desktop: { minWidth: 1100, minHeight: 640, maxColumns: 12, floating: true },
});
export function silentFrameworkSounds(): Array<{ event: FrameworkSoundEventId; asset: null; gain: 0 }> {
  return frameworkSoundEventIds.map((event) => ({ event, asset: null, gain: 0 }));
}

export const frameworkModes = ['light', 'dark', 'oled'] as const;
export type FrameworkMode = (typeof frameworkModes)[number];
export const frameworkTokenIds = [
  'colours.background',
  'colours.surface',
  'colours.ink',
  'colours.muted',
  'colours.accent',
  'colours.danger',
  'colours.focus',
  'typography.family',
  'typography.baseSize',
  'typography.scale',
  'spacing.unit',
  'spacing.gap',
  'spacing.inset',
  'shape.radius',
  'shape.borderWidth',
  'motion.duration',
  'motion.curve',
] as const;
export type FrameworkTokenId = (typeof frameworkTokenIds)[number];
export const frameworkTokenRules: Readonly<Record<FrameworkTokenId, { kind: 'colour' | 'font' | 'curve' | 'number'; min?: number; max?: number }>> =
  freeze({
    'colours.background': { kind: 'colour' },
    'colours.surface': { kind: 'colour' },
    'colours.ink': { kind: 'colour' },
    'colours.muted': { kind: 'colour' },
    'colours.accent': { kind: 'colour' },
    'colours.danger': { kind: 'colour' },
    'colours.focus': { kind: 'colour' },
    'typography.family': { kind: 'font' },
    'typography.baseSize': { kind: 'number', min: 14, max: 24 },
    'typography.scale': { kind: 'number', min: 0.85, max: 1.5 },
    'spacing.unit': { kind: 'number', min: 2, max: 12 },
    'spacing.gap': { kind: 'number', min: 0, max: 48 },
    'spacing.inset': { kind: 'number', min: 0, max: 20 },
    'shape.radius': { kind: 'number', min: 0, max: 32 },
    'shape.borderWidth': { kind: 'number', min: 0, max: 3 },
    'motion.duration': { kind: 'number', min: 0, max: 600 },
    'motion.curve': { kind: 'curve' },
  });
export const frameworkIconRoles = [...frameworkActionIds, 'status.info', 'status.success', 'status.warning', 'status.error'] as const;
export type FrameworkIconRole = (typeof frameworkIconRoles)[number];
export const frameworkEscapeAnchors = freeze([
  { id: 'escape.navigation', action: 'navigation.open', label: 'Navigation', layer: 'host-escape' },
  { id: 'escape.session', action: 'session.open', label: 'Account', layer: 'host-escape' },
  { id: 'escape.recovery', action: 'theme.recover', label: 'Default', layer: 'host-escape' },
] as const);
export const frameworkLayoutAnchors = freeze({
  'viewport.safe': { escapeLayer: 'host-escape', themeLayer: 'theme', clipped: false },
  'parent.content': { overflow: 'auto', revealFocus: true, wrap: 'words' },
});
export const frameworkCoreLayout: Readonly<
  Record<FrameworkComponentId, { minWidth: number; minHeight: number; slots: readonly FrameworkSlotId[]; movable: boolean }>
> = freeze(
  Object.fromEntries(
    frameworkComponentIds.map((id) => [
      id,
      {
        minWidth: id === 'layer.dialogs' || id === 'surface.dialog' ? 240 : 44,
        minHeight: id === 'layer.dialogs' || id === 'surface.dialog' ? 160 : 44,
        slots:
          id === 'layer.dialogs' || id === 'layer.notifications'
            ? ['shell.overlay']
            : id === 'settings.recovery'
              ? ['settings.header', 'settings.content', 'shell.primary']
              : ['shell.header', 'shell.footer', 'shell.sidebar', 'shell.primary', 'window.toolbar', 'settings.content'],
        movable: frameworkComponents[id].host,
      },
    ]),
  ) as unknown as Record<FrameworkComponentId, { minWidth: number; minHeight: number; slots: readonly FrameworkSlotId[]; movable: boolean }>,
);

export const frameworkLayerOrder = freeze(['theme', 'host-overlay', 'host-escape'] as const);
