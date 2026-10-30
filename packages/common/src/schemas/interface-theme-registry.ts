import {
  interfaceThemeDescriptorSchema,
  interfaceThemeIdentitySchema,
  type InterfaceThemeDescriptor,
  type InterfaceThemeSetting,
} from './interface-theme.js';

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export const legacyThemeIdentities = [
  { id: 'alpine', name: 'Alpine' },
  { id: 'tideline', name: 'Tideline' },
  { id: 'woodland', name: 'Woodland' },
] as const;
export const legacyThemeVersions = ['1.0.0', '1.1.0'] as const;

export function orbisThemeSettings(includePalette: boolean): InterfaceThemeSetting[] {
  const integer = (key: string, label: string, min: number, max: number): InterfaceThemeSetting => ({
    key,
    label,
    group: 'material',
    kind: 'integer',
    min,
    max,
    step: 1,
    default: null,
  });
  return [
    ...(includePalette
      ? ([
          {
            key: 'palette',
            label: 'Colour preset',
            group: 'colour',
            kind: 'enum',
            default: 'frost',
            options: [
              { value: 'frost', label: 'Frost' },
              { value: 'graphite', label: 'Graphite' },
              { value: 'forest', label: 'Forest' },
              { value: 'stone', label: 'Warm stone' },
              { value: 'ocean', label: 'Ocean' },
              { value: 'blush', label: 'Blush' },
            ],
          },
        ] satisfies InterfaceThemeSetting[])
      : []),
    { key: 'accent', label: 'Accent colour', group: 'colour', kind: 'colour', default: null },
    integer('panel-opacity', 'Panel opacity', 90, 100),
    integer('chrome-opacity', 'Bar and dock opacity', 80, 100),
    integer('panel-blur', 'Panel blur', 0, 40),
    integer('chrome-blur', 'Bar and dock blur', 0, 64),
    integer('panel-tint', 'Panel tint', 0, 30),
    {
      key: 'transparency',
      label: 'Surfaces',
      group: 'material',
      kind: 'enum',
      default: 'system',
      options: [
        { value: 'system', label: 'Use device setting' },
        { value: 'glass', label: 'Translucent' },
        { value: 'solid', label: 'Solid' },
      ],
    },
    {
      key: 'motion',
      label: 'Motion',
      group: 'effects',
      kind: 'enum',
      default: 'system',
      options: [
        { value: 'system', label: 'Follow device setting' },
        { value: 'reduced', label: 'Reduce motion' },
      ],
    },
    { key: 'low-effects', label: 'Energy saving', group: 'effects', kind: 'boolean', default: false },
  ];
}

export function legacyThemeDescriptor(id: string, version: string): InterfaceThemeDescriptor | null {
  const identity = legacyThemeIdentities.find((item) => item.id === id);
  if (!identity || !legacyThemeVersions.some((supported) => supported === version)) return null;
  return interfaceThemeDescriptorSchema.assert({
    formatVersion: 1,
    id,
    version,
    hostApiVersion: 1,
    settingsVersion: 1,
    name: identity.name,
    kind: 'legacy-pack',
    implementation: 'orbis-legacy-v1',
    capabilities: [
      'palette',
      'material',
      'wallpaper',
      'typography',
      'icon-treatment',
      'control-treatment',
      'chart-treatment',
      'menu-treatment',
      'motion-treatment',
    ],
    settings: orbisThemeSettings(false),
  });
}

export const builtinInterfaceTheme: InterfaceThemeDescriptor = freeze(
  interfaceThemeDescriptorSchema.assert({
    formatVersion: 1,
    id: 'orbis-builtin',
    version: '1.0.0',
    hostApiVersion: 1,
    settingsVersion: 1,
    name: 'Orbis',
    kind: 'builtin',
    implementation: 'orbis-v1',
    capabilities: ['palette', 'material'],
    settings: orbisThemeSettings(true),
  }),
);

// Only host-reviewed descriptors enter this registry. Packages cannot register executable implementations.
const registry = freeze([
  builtinInterfaceTheme,
  ...legacyThemeIdentities.flatMap((identity) =>
    legacyThemeVersions.map((version) => {
      const descriptor = legacyThemeDescriptor(identity.id, version);
      if (!descriptor) throw new Error('Invalid bundled legacy theme identity.');
      return descriptor;
    }),
  ),
]);

export function registeredInterfaceTheme(value: unknown): InterfaceThemeDescriptor | null {
  if (!interfaceThemeIdentitySchema.allows(value)) return null;
  return registry.find((descriptor) => descriptor.id === value.id && descriptor.version === value.version) ?? null;
}
