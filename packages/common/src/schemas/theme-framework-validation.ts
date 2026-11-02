import { type } from 'arktype';
import { themeFrameworkDocumentSchema, type FrameworkAsset, type FrameworkSetting, type ThemeFrameworkDocument } from './theme-framework-contract.js';
import {
  essentialFrameworkComponents,
  frameworkActions,
  frameworkComponents,
  frameworkViewports,
  frameworkCoreLayout,
  frameworkTokenRules,
  type FrameworkTokenId,
} from './theme-framework-registry.js';
import { parseOrbisVersion, orbisVersionOrder } from './orbis-release-channel.js';

export type FrameworkValidationIssue = { code: string; path: string };
export type FrameworkValidationResult = { valid: true; document: ThemeFrameworkDocument } | { valid: false; issues: FrameworkValidationIssue[] };
const reserved = new Set(['constructor', 'prototype', '__proto__']);
const additionSlots = new Set(['shell.primary', 'settings.content', 'window.toolbar', 'notification.actions']);

export function frameworkTokenAllows(document: Pick<ThemeFrameworkDocument, 'assets'>, token: FrameworkTokenId, value: unknown): boolean {
  if (!Object.hasOwn(frameworkTokenRules, token)) return false;
  const rule = frameworkTokenRules[token];
  if (rule.kind === 'number') return typeof value === 'number' && Number.isFinite(value) && value >= (rule.min ?? 0) && value <= (rule.max ?? 0);
  if (rule.kind === 'colour') return typeof value === 'string' && /^#[a-f0-9]{6}$/i.test(value);
  if (rule.kind === 'curve') return ['linear', 'standard', 'decelerate'].includes(value as string);
  return ['system', 'source-sans'].includes(value as string) || document.assets.some((asset) => asset.kind === 'font' && asset.id === value);
}

// Inspect descriptors before schema traversal so untrusted getters are never invoked.
export function frameworkJsonDataAllows(value: unknown, depth = 0, budget = { nodes: 0 }): boolean {
  if (++budget.nodes > 30000 || depth > 24) return false;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (!value || typeof value !== 'object' || (!Array.isArray(value) && ![null, Object.prototype].includes(Object.getPrototypeOf(value))))
    return false;
  if (Object.getOwnPropertySymbols(value).length) return false;
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (Array.isArray(value) && key === 'length') continue;
    if (reserved.has(key) || !descriptor.enumerable || !('value' in descriptor) || !frameworkJsonDataAllows(descriptor.value, depth + 1, budget))
      return false;
  }
  return !Array.isArray(value) || Object.keys(value).length === value.length;
}

export function frameworkSettingAllows(setting: FrameworkSetting, value: unknown, assets: readonly FrameworkAsset[]): boolean {
  switch (setting.kind) {
    case 'boolean':
      return typeof value === 'boolean';
    case 'colour':
      return value === null || (typeof value === 'string' && /^#[a-f0-9]{6}$/i.test(value));
    case 'enum':
      return setting.options.some((option) => option.value === value);
    case 'asset':
      return value === null || assets.some((asset) => asset.id === value && asset.kind === setting.assetKind);
    case 'integer':
      return (
        value === null ||
        (typeof value === 'number' &&
          Number.isSafeInteger(value) &&
          value >= setting.min &&
          value <= setting.max &&
          (value - setting.min) % setting.step === 0)
      );
  }
}

export function validateThemeFrameworkDocument(value: unknown): FrameworkValidationResult {
  if (!frameworkJsonDataAllows(value)) return { valid: false, issues: [{ code: 'json-data-only', path: '' }] };
  const result = themeFrameworkDocumentSchema(value);
  if (result instanceof type.errors) return { valid: false, issues: [{ code: 'structure', path: '' }] };
  const document = result;
  const issues: FrameworkValidationIssue[] = [];
  const issue = (code: string, path: string) => {
    if (issues.length < 128) issues.push({ code, path });
  };
  const unique = (values: readonly (string | number)[], path: string) => {
    if (new Set(values).size !== values.length) issue('duplicate', path);
  };
  const identifier = (id: string, path: string) => {
    if (id.split(/[.-]/).some((part) => reserved.has(part))) issue('reserved-id', path);
  };
  if (document.id === 'default' || document.id.startsWith('orbis-')) issue('reserved-identity', 'id');
  const scan = (item: unknown, path: string) => {
    if (!item || typeof item !== 'object') return;
    for (const [key, child] of Object.entries(item)) {
      if (['id', 'key', 'group', 'value'].includes(key) && typeof child === 'string') identifier(child, `${path}.${key}`);
      if (['label', 'name', 'text', 'alt'].includes(key) && typeof child === 'string' && !child.trim()) issue('empty-label', `${path}.${key}`);
      scan(child, `${path}.${key}`);
    }
  };
  scan(document, '');
  unique(document.supportsUiRevisions, 'supportsUiRevisions');
  unique(
    document.requires.releases.map((release) => release.replace(/^v/, '')),
    'requires.releases',
  );
  if (document.requires.releases.some((release) => !parseOrbisVersion(release) || orbisVersionOrder(release, release) !== 0))
    issue('release-version', 'requires.releases');
  unique(
    document.components.map((component) => component.id),
    'components',
  );
  for (const component of document.components)
    if (!frameworkComponents[component.id].variants.includes(component.variant)) issue('component-variant', `components.${component.id}`);
  unique(
    document.assets.map((asset) => asset.id),
    'assets',
  );
  unique(
    document.assets.map((asset) => asset.path),
    'assets.path',
  );
  if (document.assets.reduce((sum, asset) => sum + asset.bytes, 0) > 67108864) issue('asset-budget', 'assets');
  const extensions: Record<string, readonly string[]> = {
    'image/png': ['png'],
    'image/jpeg': ['jpg', 'jpeg'],
    'image/webp': ['webp'],
    'font/woff2': ['woff2'],
    'audio/mpeg': ['mp3'],
    'audio/ogg': ['ogg'],
    'audio/wav': ['wav'],
  };
  for (const asset of document.assets) {
    if (!extensions[asset.mime]?.some((extension) => asset.path.endsWith(`.${extension}`))) issue('asset-extension', `assets.${asset.id}`);
    if (asset.path.split('/').some((part) => part === '.' || part === '..')) issue('asset-path', `assets.${asset.id}`);
    if (
      (asset.kind === 'font' && asset.bytes > 4194304) ||
      (asset.kind === 'icon' && (asset.bytes > 1048576 || asset.width > 1024 || asset.height > 1024)) ||
      ((asset.kind === 'image' || asset.kind === 'icon') && asset.width * asset.height > 33554432)
    )
      issue('asset-resource', `assets.${asset.id}`);
  }
  if (
    !['system', 'source-sans'].includes(document.tokens.typography.family) &&
    !document.assets.some((asset) => asset.id === document.tokens.typography.family && asset.kind === 'font')
  )
    issue('font-reference', 'tokens.typography.family');
  unique(
    document.settings.map((setting) => setting.key),
    'settings',
  );
  unique(
    document.conditions.map((condition) => condition.id),
    'conditions',
  );
  unique(
    document.customisation.sections.map((section) => section.id),
    'customisation.sections',
  );
  unique(
    document.customisation.presets.map((preset) => preset.id),
    'customisation.presets',
  );
  const settings = new Map(document.settings.map((setting) => [setting.key, setting]));
  const conditions = new Map(document.conditions.map((condition) => [condition.id, condition]));
  const visible = (reference: string | undefined, path: string) => {
    if (reference !== undefined && !conditions.has(reference)) issue('condition-reference', path);
  };
  for (const setting of document.settings) {
    if (!frameworkSettingAllows(setting, setting.default, document.assets)) issue('setting-default', `settings.${setting.key}`);
    if (setting.kind === 'integer' && (setting.min > setting.max || (setting.max - setting.min) % setting.step !== 0))
      issue('integer-range', `settings.${setting.key}`);
    if (setting.kind === 'enum')
      unique(
        setting.options.map((option) => option.value),
        `settings.${setting.key}.options`,
      );
    visible(setting.visibleWhen, `settings.${setting.key}.visibleWhen`);
  }
  for (const condition of document.conditions) {
    unique(
      condition.all.map((comparison) => comparison.setting),
      `conditions.${condition.id}`,
    );
    for (const comparison of condition.all) {
      const setting = settings.get(comparison.setting);
      if (!setting || !frameworkSettingAllows(setting, comparison.equals, document.assets)) issue('condition-setting', `conditions.${condition.id}`);
    }
  }
  unique(
    document.modes.map((mode) => mode.mode),
    'modes',
  );
  for (const mode of document.modes) {
    unique(
      mode.values.map((item) => item.token),
      `modes.${mode.mode}`,
    );
    for (const item of mode.values)
      if (!frameworkTokenAllows(document, item.token, item.value)) issue('token-value', `modes.${mode.mode}.${item.token}`);
  }
  for (const rule of document.tokenRules) {
    visible(rule.when, 'tokenRules');
    unique(
      rule.values.map((item) => item.token),
      'tokenRules.values',
    );
    for (const item of rule.values) if (!frameworkTokenAllows(document, item.token, item.value)) issue('token-value', `tokenRules.${item.token}`);
  }
  unique(
    document.tokenBindings.map((binding) => `${binding.token}:${binding.when ?? ''}`),
    'tokenBindings',
  );
  for (const binding of document.tokenBindings) {
    visible(binding.when, 'tokenBindings');
    const setting = settings.get(binding.setting);
    const target = frameworkTokenRules[binding.token];
    const valid =
      setting &&
      (target.kind === 'number'
        ? setting.kind === 'integer' &&
          frameworkTokenAllows(document, binding.token, setting.min / (binding.transform === 'percent' ? 100 : 1)) &&
          frameworkTokenAllows(document, binding.token, setting.max / (binding.transform === 'percent' ? 100 : 1))
        : binding.transform === 'identity' &&
          (target.kind === 'colour'
            ? setting.kind === 'colour'
            : target.kind === 'font' && setting.kind === 'asset'
              ? setting.assetKind === 'font'
              : setting.kind === 'enum' && setting.options.every((option) => frameworkTokenAllows(document, binding.token, option.value))));
    if (!valid) issue('token-binding', `tokenBindings.${binding.token}`);
  }
  unique(
    document.icons.map((icon) => `${icon.role}:${icon.mode}:${icon.when ?? ''}`),
    'icons',
  );
  for (const icon of document.icons) {
    visible(icon.when, 'icons');
    if (icon.asset !== null && !document.assets.some((asset) => asset.id === icon.asset && asset.kind === 'icon'))
      issue('icon-reference', `icons.${icon.role}`);
    if (icon.setting !== undefined) {
      const setting = settings.get(icon.setting);
      if (!setting || setting.kind !== 'asset' || setting.assetKind !== 'icon') issue('icon-setting', `icons.${icon.role}`);
    }
  }
  const assigned = document.customisation.sections.flatMap((section) => section.settings);
  unique(assigned, 'customisation.sections.settings');
  if (assigned.length !== settings.size || assigned.some((key) => !settings.has(key))) issue('settings-coverage', 'customisation.sections');
  for (const section of document.customisation.sections) {
    visible(section.visibleWhen, `customisation.sections.${section.id}`);
    if (section.settings.some((key) => settings.get(key)?.group !== section.id)) issue('setting-group', `customisation.sections.${section.id}`);
  }
  const settingDependencies = (key: string): string[] => {
    const setting = settings.get(key);
    const section = document.customisation.sections.find((item) => item.settings.includes(key));
    return [setting?.visibleWhen, section?.visibleWhen].flatMap((id) =>
      id === undefined ? [] : (conditions.get(id)?.all.map((item) => item.setting) ?? []),
    );
  };
  const cycles = (keys: readonly string[], dependencies: (key: string) => readonly string[], path: string, maxDepth = 96) => {
    const heights = new Map<string, number>();
    const visiting = new Set<string>();
    const visit = (key: string): number => {
      const known = heights.get(key);
      if (known !== undefined) return known;
      if (visiting.has(key)) {
        issue('dependency-cycle-or-depth', path);
        return maxDepth + 1;
      }
      visiting.add(key);
      let height = 0;
      for (const dependency of dependencies(key)) height = Math.max(height, 1 + visit(dependency));
      visiting.delete(key);
      heights.set(key, height);
      if (height > maxDepth) issue('dependency-cycle-or-depth', path);
      return height;
    };
    for (const key of keys) visit(key);
  };
  cycles([...settings.keys()], settingDependencies, 'settings.visibility');
  for (const preset of document.customisation.presets) {
    unique(
      preset.values.map((value) => value.key),
      `presets.${preset.id}`,
    );
    for (const value of preset.values) {
      const setting = settings.get(value.key);
      if (!setting || !frameworkSettingAllows(setting, value.value, document.assets)) issue('preset-value', `presets.${preset.id}.${value.key}`);
    }
  }
  unique(
    document.layouts.map((layout) => layout.viewport),
    'layouts',
  );
  for (const layout of document.layouts) {
    const path = `layouts.${layout.viewport}`;
    const viewport = frameworkViewports[layout.viewport];
    if (layout.columns > viewport.maxColumns) issue('viewport-columns', path);
    unique(
      layout.nodes.map((node) => node.id),
      path,
    );
    unique(
      layout.nodes.map((node) => `${node.slot}:${node.parent ?? ''}:${node.order}`),
      `${path}.order`,
    );
    const nodes = new Map(layout.nodes.map((node) => [node.id, node]));
    for (const essential of essentialFrameworkComponents)
      if (layout.nodes.filter((node) => node.kind === 'core' && node.component === essential).length !== 1)
        issue('essential-component', `${path}.${essential}`);
    if (layout.nodes.filter((node) => node.placement.kind === 'float').length > 8) issue('floating-budget', path);
    for (const node of layout.nodes) {
      const location = `${path}.${node.id}`;
      visible(node.visibleWhen, location);
      if (node.anchor !== (node.parent === null ? 'viewport.safe' : 'parent.content')) issue('layout-anchor', location);
      if (node.kind === 'core') {
        const registration = frameworkCoreLayout[node.component];
        if (!registration.movable || node.id !== node.component || !registration.slots.includes(node.slot)) issue('core-placement', location);
        if (essentialFrameworkComponents.includes(node.component) && node.visibleWhen !== undefined) issue('essential-placement', location);
        if (
          node.constraints &&
          (node.constraints.minWidth < registration.minWidth ||
            node.constraints.minHeight < registration.minHeight ||
            node.constraints.scroll !== 'content')
        )
          issue('essential-placement', location);
        if (essentialFrameworkComponents.includes(node.component)) {
          let parent = node.parent;
          const seen = new Set<string>();
          while (parent !== null && !seen.has(parent)) {
            seen.add(parent);
            const ancestor = nodes.get(parent);
            if (!ancestor) break;
            if (ancestor.visibleWhen !== undefined || (ancestor.constraints && ancestor.constraints.scroll !== 'content'))
              issue('essential-ancestor', location);
            parent = ancestor.parent;
          }
        }
      } else if (!node.id.startsWith('theme.') || (node.kind !== 'group' && !additionSlots.has(node.slot)) || node.placement.kind === 'host')
        issue('addition-placement', location);
      if (node.parent !== null) {
        const parent = nodes.get(node.parent);
        if (!parent || parent.kind !== 'group' || parent.slot !== node.slot) issue('parent-reference', location);
      }
      if (
        node.constraints &&
        (node.constraints.minWidth > node.constraints.maxWidth ||
          node.constraints.minHeight > node.constraints.maxHeight ||
          node.constraints.minWidth > viewport.minWidth - document.tokens.spacing.inset * 2 ||
          ((node.kind === 'action' || node.kind === 'control') && (node.constraints.minWidth < 44 || node.constraints.minHeight < 44)))
      )
        issue('constraints', location);
      if (node.placement.kind === 'flow' && node.placement.span > layout.columns) issue('flow-span', location);
      if (
        node.placement.kind === 'float' &&
        (node.placement.x + node.placement.width > 100 || node.placement.y + node.placement.height > 100 || node.constraints?.scroll !== 'content')
      )
        issue('floating-placement', location);
      if (node.kind === 'image' && !document.assets.some((asset) => asset.id === node.asset && ['image', 'icon'].includes(asset.kind)))
        issue('image-reference', location);
      if (node.kind === 'control' && !settings.has(node.setting)) issue('control-reference', location);
      if (node.kind === 'action') {
        const action = frameworkActions[node.action];
        if (
          (action.context === 'window' && node.slot !== 'window.toolbar') ||
          (action.context === 'notification' && node.slot !== 'notification.actions')
        )
          issue('action-context', location);
      }
    }
    cycles(
      [...nodes.keys()],
      (key) => {
        const parent = nodes.get(key)?.parent;
        return parent ? [parent] : [];
      },
      path,
      8,
    );
  }
  unique(
    document.sounds.map((sound) => sound.event),
    'sounds',
  );
  for (const sound of document.sounds)
    if (
      (sound.asset === null && sound.gain !== 0) ||
      (sound.asset !== null && !document.assets.some((asset) => asset.id === sound.asset && asset.kind === 'audio'))
    )
      issue('sound-reference', `sounds.${sound.event}`);
  return issues.length ? { valid: false, issues } : { valid: true, document: structuredClone(document) };
}
