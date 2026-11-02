import type { FrameworkAsset, FrameworkNode, ThemeFrameworkDocument } from './theme-framework-contract.js';
import {
  frameworkCoreLayout,
  frameworkEscapeAnchors,
  frameworkModes,
  frameworkIconRoles,
  type FrameworkActionId,
  type FrameworkIconRole,
  type FrameworkMode,
  type FrameworkTokenId,
} from './theme-framework-registry.js';
import { frameworkJsonDataAllows, frameworkSettingAllows, validateThemeFrameworkDocument } from './theme-framework-validation.js';

function checked(document: ThemeFrameworkDocument): ThemeFrameworkDocument {
  const result = validateThemeFrameworkDocument(document);
  if (!result.valid) throw new TypeError('Invalid theme framework document.');
  return result.document;
}
function valuesFor(document: ThemeFrameworkDocument, supplied: unknown): Map<string, unknown> {
  if (!frameworkJsonDataAllows(supplied) || !Array.isArray(supplied) || supplied.length > 96) throw new TypeError('Invalid theme settings values.');
  const values = new Map(document.settings.map((setting) => [setting.key, setting.default]));
  const seen = new Set<string>();
  for (const item of supplied) {
    if (
      !item ||
      typeof item !== 'object' ||
      Object.keys(item).length !== 2 ||
      !('key' in item) ||
      !('value' in item) ||
      typeof item.key !== 'string' ||
      seen.has(item.key)
    )
      throw new TypeError('Invalid theme settings values.');
    const setting = document.settings.find((setting) => setting.key === item.key);
    if (!setting || !frameworkSettingAllows(setting, item.value, document.assets)) throw new TypeError('Unknown or incompatible theme setting.');
    seen.add(item.key);
    values.set(item.key, item.value);
  }
  return values;
}
function conditionsFor(document: ThemeFrameworkDocument, values: Map<string, unknown>): Map<string, boolean> {
  return new Map(document.conditions.map((condition) => [condition.id, condition.all.every((item) => values.get(item.setting) === item.equals)]));
}
function assignToken(tokens: ThemeFrameworkDocument['tokens'], token: FrameworkTokenId, value: string | number): void {
  const [group, key] = token.split('.') as [keyof typeof tokens, string];
  (tokens[group] as Record<string, unknown>)[key] = value;
}
export type FrameworkTokenHost = {
  mode: FrameworkMode;
  textScale: number;
  reducedMotion: boolean;
  forcedColours?: ThemeFrameworkDocument['tokens']['colours'];
};
export function resolveThemeFrameworkTokens(
  document: ThemeFrameworkDocument,
  supplied: unknown,
  host: FrameworkTokenHost,
): ThemeFrameworkDocument['tokens'] {
  const data = checked(document);
  if (
    !frameworkModes.includes(host.mode) ||
    !Number.isFinite(host.textScale) ||
    host.textScale < 1 ||
    host.textScale > 2 ||
    typeof host.reducedMotion !== 'boolean'
  )
    throw new TypeError('Invalid host accessibility state.');
  const values = valuesFor(data, supplied);
  const conditions = conditionsFor(data, values);
  const tokens = structuredClone(data.tokens);
  for (const mode of host.mode === 'oled' ? ['dark', 'oled'] : [host.mode])
    for (const assignment of data.modes.find((item) => item.mode === mode)?.values ?? []) assignToken(tokens, assignment.token, assignment.value);
  for (const rule of data.tokenRules)
    if ((rule.mode === 'all' || rule.mode === host.mode) && conditions.get(rule.when))
      for (const assignment of rule.values) assignToken(tokens, assignment.token, assignment.value);
  for (const binding of data.tokenBindings) {
    if (binding.when !== undefined && !conditions.get(binding.when)) continue;
    const value = values.get(binding.setting);
    if (typeof value === 'number') assignToken(tokens, binding.token, binding.transform === 'percent' ? value / 100 : value);
    else if (typeof value === 'string') assignToken(tokens, binding.token, value);
  }
  if (host.forcedColours !== undefined) {
    const keys = Object.keys(tokens.colours);
    if (
      !frameworkJsonDataAllows(host.forcedColours) ||
      Object.keys(host.forcedColours).length !== keys.length ||
      !keys.every((key) => /^#[a-f0-9]{6}$/i.test((host.forcedColours as Record<string, string>)[key] ?? ''))
    )
      throw new TypeError('Invalid host forced colours.');
    tokens.colours = structuredClone(host.forcedColours);
  }
  tokens.typography.scale *= host.textScale;
  if (host.reducedMotion) tokens.motion.duration = 0;
  return tokens;
}
export function resolveThemeFrameworkIcon(
  document: ThemeFrameworkDocument,
  role: FrameworkIconRole,
  mode: FrameworkMode,
  supplied: unknown,
): { source: 'core'; role: FrameworkIconRole } | { source: 'asset'; role: FrameworkIconRole; asset: FrameworkAsset } {
  const data = checked(document);
  if (!frameworkModes.includes(mode) || !frameworkIconRoles.includes(role)) throw new TypeError('Invalid host colour mode.');
  const values = valuesFor(data, supplied);
  const conditions = conditionsFor(data, values);
  let selected: string | null = null;
  for (const scope of ['all', ...(mode === 'oled' ? ['dark', 'oled'] : [mode])])
    for (const icon of data.icons) {
      if (icon.role !== role || icon.mode !== scope || (icon.when !== undefined && !conditions.get(icon.when))) continue;
      const setting = icon.setting === undefined ? null : values.get(icon.setting);
      selected = typeof setting === 'string' ? setting : icon.asset;
    }
  const asset = data.assets.find((asset) => asset.id === selected && asset.kind === 'icon');
  return asset ? { source: 'asset', role, asset: structuredClone(asset) } : { source: 'core', role };
}
export type FrameworkRect = { x: number; y: number; width: number; height: number };
export type FrameworkMeasurement = { minWidth: number; height: number };
export type FrameworkProjectionHost = {
  width: number;
  height: number;
  textScale: number;
  mode: FrameworkMode;
  safeInsets: { top: number; right: number; bottom: number; left: number };
  // These callbacks belong to the trusted host, never to a package or manifest.
  measureText: (text: string, width: number, scale: number, family: string) => FrameworkMeasurement;
  measureCore: (
    component: Extract<FrameworkNode, { kind: 'core' }>['component'],
    width: number,
    scale: number,
    family: string,
  ) => FrameworkMeasurement;
  escapeLabels?: { navigation: string; session: string; recovery: string };
};
export type FrameworkProjectedNode = {
  id: string;
  parent: string | null;
  order: number;
  space: 'anchor' | 'flow-content';
  rect: FrameworkRect;
  contentHeight: number;
  placement: 'flow' | 'dock' | 'float' | 'host';
  reflowed: boolean;
  wrap: 'words';
  overflow: 'auto';
  revealFocus: true;
  layer: 'theme' | 'host-overlay';
};
export type FrameworkFlowRegion = { parent: string | null; rect: FrameworkRect; contentHeight: number; overflow: 'auto'; revealFocus: true };
export type FrameworkEscape = Readonly<{
  id: string;
  action: FrameworkActionId;
  label: string;
  rect: Readonly<FrameworkRect>;
  layer: 'host-escape';
  visibility: 'always';
  replaceable: false;
  style: 'host-accessible';
  parent: null;
}>;
export type FrameworkLayoutFallbackReason =
  | 'insufficient-safe-viewport'
  | 'content-cannot-reflow'
  | 'group-cannot-reflow'
  | 'non-scrollable-content'
  | 'content-budget'
  | 'projection-work-budget'
  | 'measurement-failed';
export type FrameworkProjection = {
  status: 'resolved' | 'host-fallback';
  reason: FrameworkLayoutFallbackReason | null;
  profile: 'phone' | 'tablet' | 'desktop';
  viewport: FrameworkRect;
  contentHeight: number;
  escapes: readonly FrameworkEscape[];
  nodes: FrameworkProjectedNode[];
  regions: FrameworkFlowRegion[];
  overflow: 'auto';
  revealFocus: true;
  wrap: 'words';
};
function finite(value: number, min: number, max: number): boolean {
  return Number.isFinite(value) && value >= min && value <= max;
}
function overlap(a: FrameworkRect, b: FrameworkRect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}
function measured(value: FrameworkMeasurement, width: number): FrameworkMeasurement {
  if (!value || !finite(value.minWidth, 0, 1000000) || !finite(value.height, 1, 1000000)) throw new TypeError('Invalid trusted host measurement.');
  if (value.minWidth > width + 0.01) throw new RangeError('content-cannot-reflow');
  return value;
}
export function resolveThemeFrameworkLayout(document: ThemeFrameworkDocument, supplied: unknown, host: FrameworkProjectionHost): FrameworkProjection {
  const data = checked(document);
  if (
    !finite(host.width, 160, 32768) ||
    !finite(host.height, 160, 32768) ||
    !finite(host.textScale, 1, 2) ||
    !frameworkModes.includes(host.mode) ||
    !frameworkJsonDataAllows(host.safeInsets) ||
    Object.keys(host.safeInsets).length !== 4 ||
    !(['top', 'right', 'bottom', 'left'] as const).every((key) => finite(host.safeInsets[key], 0, 1024))
  )
    throw new TypeError('Invalid host viewport.');
  const values = valuesFor(data, supplied);
  const conditions = conditionsFor(data, values);
  const tokens = resolveThemeFrameworkTokens(data, supplied, { mode: host.mode, textScale: host.textScale, reducedMotion: false });
  const profile =
    host.width / host.textScale >= 1100 && host.height / host.textScale >= 640
      ? 'desktop'
      : host.width / host.textScale >= 620 && host.height / host.textScale >= 480
        ? 'tablet'
        : 'phone';
  const layout = data.layouts.find((layout) => layout.viewport === profile);
  if (!layout) throw new TypeError('Missing responsive layout.');
  const measureScale = (tokens.typography.scale * tokens.typography.baseSize) / 16;
  const gap = tokens.spacing.gap;
  const inset = tokens.spacing.inset;
  const target = 44 * host.textScale;
  const safe = {
    x: host.safeInsets.left + inset,
    y: host.safeInsets.top + inset,
    width: host.width - host.safeInsets.left - host.safeInsets.right - inset * 2,
    height: host.height - host.safeInsets.top - host.safeInsets.bottom - inset * 2,
  };
  const result: FrameworkProjection = {
    status: 'resolved',
    reason: null,
    profile,
    viewport: { ...safe },
    contentHeight: 0,
    escapes: [],
    nodes: [],
    regions: [],
    overflow: 'auto',
    revealFocus: true,
    wrap: 'words',
  };
  const fallback = (reason: FrameworkLayoutFallbackReason): FrameworkProjection => ({
    ...result,
    status: 'host-fallback',
    reason,
    nodes: [],
    regions: [],
    contentHeight: 0,
  });
  if (safe.width < target || safe.height < target) return fallback('insufficient-safe-viewport');
  try {
    const escapeRows: Array<{
      items: Array<{ id: string; action: FrameworkActionId; label: string; width: number; height: number }>;
      height: number;
      width: number;
    }> = [];
    for (const anchor of frameworkEscapeAnchors) {
      const label = host.escapeLabels?.[anchor.id.replace('escape.', '') as 'navigation' | 'session' | 'recovery'] ?? anchor.label;
      if (typeof label !== 'string' || !label.trim() || label.length > 160) throw new TypeError('Invalid host escape label.');
      const metric = measured(host.measureText(label, Math.max(target, safe.width - 24), host.textScale, 'system'), safe.width - 24);
      const width = Math.min(safe.width, Math.max(target, metric.minWidth + 24));
      const wrapped = measured(host.measureText(label, width - 24, host.textScale, 'system'), width - 24);
      const height = Math.max(target, wrapped.height + 16);
      let row = escapeRows[escapeRows.length - 1];
      if (!row || row.width + gap + width > safe.width) {
        row = { items: [], height: 0, width: 0 };
        escapeRows.push(row);
      }
      row.items.push({ id: anchor.id, action: anchor.action, label, width, height });
      row.width += (row.items.length > 1 ? gap : 0) + width;
      row.height = Math.max(row.height, height);
    }
    const escapeHeight = escapeRows.reduce((sum, row) => sum + row.height, 0) + gap * Math.max(0, escapeRows.length - 1);
    if (escapeHeight + gap + target > safe.height) return fallback('insufficient-safe-viewport');
    let escapeY = safe.y + safe.height - escapeHeight;
    const escapes: FrameworkEscape[] = [];
    for (const row of escapeRows) {
      let x = safe.x;
      for (const item of row.items) {
        escapes.push(
          Object.freeze({
            id: item.id,
            action: item.action,
            label: item.label,
            rect: Object.freeze({ x, y: escapeY, width: item.width, height: row.height }),
            layer: 'host-escape',
            visibility: 'always',
            replaceable: false,
            style: 'host-accessible',
            parent: null,
          }),
        );
        x += item.width + gap;
      }
      escapeY += row.height + gap;
    }
    result.escapes = Object.freeze(escapes);
    result.viewport.height = safe.height - escapeHeight - gap;
    const visible = new Map(layout.nodes.map((node) => [node.id, node.visibleWhen === undefined || conditions.get(node.visibleWhen) === true]));
    const byId = new Map(layout.nodes.map((node) => [node.id, node]));
    const isVisible = (node: FrameworkNode): boolean =>
      visible.get(node.id) === true && (node.parent === null || isVisible(byId.get(node.parent) as FrameworkNode));
    const active = layout.nodes.filter(isVisible);
    const nodes: FrameworkProjectedNode[] = [];
    let work = 0;
    const sizeFor = (
      node: FrameworkNode,
      width: number,
      availableHeight: number,
    ): { height: number; minWidth: number; children: FrameworkProjectedNode[]; regions: FrameworkFlowRegion[] } => {
      if (++work > 8192) throw new RangeError('projection-work-budget');
      if (!finite(width, 1, 32768)) throw new RangeError('content-cannot-reflow');
      const minimum =
        node.kind === 'core'
          ? {
              minWidth: Math.max(target, frameworkCoreLayout[node.component].minWidth),
              minHeight: Math.max(target, frameworkCoreLayout[node.component].minHeight),
            }
          : {
              minWidth: node.kind === 'action' || node.kind === 'control' ? target : 0,
              minHeight: node.kind === 'action' || node.kind === 'control' ? target : 0,
            };
      if (width < minimum.minWidth || width < (node.constraints?.minWidth ?? 0)) throw new RangeError('content-cannot-reflow');
      let metric: FrameworkMeasurement;
      let children: FrameworkProjectedNode[] = [];
      let regions: FrameworkFlowRegion[] = [];
      if (node.kind === 'group') {
        const heading = measured(host.measureText(node.label, width, measureScale, tokens.typography.family), width);
        const headingHeight = heading.height + gap;
        const maximum = Math.min(availableHeight, node.constraints?.maxHeight ?? availableHeight);
        if (maximum - headingHeight < target) throw new RangeError('group-cannot-reflow');
        let inner = arrange(node.id, width, maximum - headingHeight, node.axis === 'column' ? 1 : layout.columns, headingHeight);
        const natural = headingHeight + inner.height;
        const frameHeight = Math.min(maximum, Math.max(node.constraints?.minHeight ?? 0, natural));
        if (frameHeight < maximum)
          inner = arrange(node.id, width, frameHeight - headingHeight, node.axis === 'column' ? 1 : layout.columns, headingHeight);
        children = inner.nodes;
        regions = inner.regions;
        metric = { minWidth: 0, height: natural };
      } else if (node.kind === 'core') metric = measured(host.measureCore(node.component, width, measureScale, tokens.typography.family), width);
      else if (node.kind === 'image') {
        const asset = data.assets.find((asset) => asset.id === node.asset);
        metric = { minWidth: 0, height: asset && 'width' in asset ? (width * asset.height) / asset.width : target };
      } else {
        const label =
          node.kind === 'text'
            ? node.text
            : node.kind === 'action'
              ? node.label
              : (data.settings.find((setting) => setting.key === node.setting)?.label ?? '');
        metric = measured(
          host.measureText(label, Math.max(1, width - (node.kind === 'text' ? 0 : 24)), measureScale, tokens.typography.family),
          Math.max(1, width - (node.kind === 'text' ? 0 : 24)),
        );
        metric = { minWidth: metric.minWidth, height: metric.height + (node.kind === 'text' ? 0 : 16) };
      }
      const contentHeight = Math.max(minimum.minHeight, node.constraints?.minHeight ?? 0, metric.height);
      if (!finite(contentHeight, 0, 1000000)) throw new RangeError('content-budget');
      return {
        height: contentHeight,
        minWidth: Math.max(minimum.minWidth, metric.minWidth),
        children,
        regions,
      };
    };
    const arrange = (
      parent: string | null,
      width: number,
      height: number,
      requestedColumns: number,
      originY = 0,
      forcedFlow: ReadonlySet<string> = new Set(),
    ): { nodes: FrameworkProjectedNode[]; regions: FrameworkFlowRegion[]; height: number } => {
      const siblings = active
        .filter((node) => node.parent === parent)
        .sort((a, b) => a.order - b.order || layout.nodes.indexOf(a) - layout.nodes.indexOf(b));
      const columns = Math.max(1, Math.min(requestedColumns, Math.floor((width + gap) / (target + gap))));
      const out: FrameworkProjectedNode[] = [];
      const regions: FrameworkFlowRegion[] = [];
      const occupied: FrameworkRect[] = [];
      let cursorY = 0;
      let cursorColumn = 0;
      let rowHeight = 0;
      let top = 0;
      let left = 0;
      let right = width;
      let bottom = height;
      const emit = (
        node: FrameworkNode,
        rect: FrameworkRect,
        size: ReturnType<typeof sizeFor>,
        placement: FrameworkProjectedNode['placement'],
        reflowed: boolean,
      ) => {
        const own: FrameworkProjectedNode = {
          id: node.id,
          parent: node.parent,
          order: node.order,
          space: placement === 'dock' || placement === 'float' ? 'anchor' : 'flow-content',
          rect: placement === 'dock' || placement === 'float' ? { ...rect, y: rect.y + originY } : rect,
          contentHeight: size.height,
          placement,
          reflowed,
          wrap: 'words',
          overflow: 'auto',
          revealFocus: true,
          layer: node.slot === 'shell.overlay' ? 'host-overlay' : 'theme',
        };
        out.push(own, ...size.children);
        regions.push(...size.regions);
        occupied.push(placement === 'dock' || placement === 'float' ? rect : { ...rect, x: rect.x + left, y: rect.y + top });
      };
      const flow = (node: FrameworkNode, wasReflowed: boolean) => {
        let reflowed = wasReflowed;
        let span = node.placement.kind === 'flow' ? Math.min(columns, node.placement.span) : columns;
        if (cursorColumn + span > columns) {
          cursorY += rowHeight + gap;
          cursorColumn = 0;
          rowHeight = 0;
        }
        const unit = (right - left - gap * (columns - 1)) / columns;
        let w = Math.min(unit * span + gap * (span - 1), node.constraints?.maxWidth ?? width);
        let size: ReturnType<typeof sizeFor>;
        try {
          size = sizeFor(node, w, Math.max(target, bottom - top));
        } catch (error) {
          if (!(error instanceof RangeError) || span === columns) throw error;
          cursorY += rowHeight + (rowHeight ? gap : 0);
          cursorColumn = 0;
          rowHeight = 0;
          span = columns;
          w = Math.min(right - left, node.constraints?.maxWidth ?? width);
          size = sizeFor(node, w, Math.max(target, bottom - top));
          reflowed = true;
        }
        const constrained = Math.min(size.height, node.constraints?.maxHeight ?? size.height);
        const frameHeight = Math.min(constrained, Math.max(target, bottom - top));
        if (node.constraints?.scroll === 'none' && size.height > frameHeight) throw new RangeError('non-scrollable-content');
        reflowed ||= frameHeight < size.height;
        emit(
          node,
          { x: cursorColumn * (unit + gap), y: cursorY, width: w, height: frameHeight },
          size,
          node.placement.kind === 'host' ? 'host' : 'flow',
          reflowed || columns !== requestedColumns,
        );
        cursorColumn += span;
        rowHeight = Math.max(rowHeight, frameHeight);
        if (cursorColumn >= columns) {
          cursorY += rowHeight + gap;
          cursorColumn = 0;
          rowHeight = 0;
        }
      };
      const docked = siblings.filter((node) => node.placement.kind === 'dock');
      const pending = siblings.filter(
        (node) =>
          node.placement.kind !== 'dock' &&
          (node.placement.kind !== 'float' || forcedFlow.has(node.id) || profile !== 'desktop' || host.textScale > 1),
      );
      for (const node of docked) {
        if (node.placement.kind !== 'dock') continue;
        const edge = node.placement.edge;
        const horizontal = edge === 'left' || edge === 'right';
        if (profile === 'phone' || host.textScale > 1 || bottom - top < target * 2 || (horizontal && right - left < target * 3)) {
          pending.push(node);
          continue;
        }
        const w = Math.min(
          node.constraints?.maxWidth ?? width,
          horizontal ? Math.max(target, node.constraints?.minWidth ?? Math.min(240, (right - left) / 3)) : right - left,
        );
        let size: ReturnType<typeof sizeFor>;
        try {
          size = sizeFor(node, w, Math.max(target, bottom - top));
        } catch (error) {
          if (!(error instanceof RangeError)) throw error;
          pending.push(node);
          continue;
        }
        const h = horizontal
          ? Math.min(bottom - top, node.constraints?.maxHeight ?? height)
          : Math.max(target, Math.min(size.height, node.constraints?.maxHeight ?? size.height));
        if (
          (horizontal && w > right - left - target - gap) ||
          (!horizontal && h > bottom - top - target - gap) ||
          (node.constraints?.scroll === 'none' && size.height > h)
        ) {
          pending.push(node);
          continue;
        }
        const rect = { x: edge === 'right' ? right - w : left, y: edge === 'bottom' ? bottom - h : top, width: w, height: h };
        emit(node, rect, size, 'dock', false);
        if (edge === 'top') top += h + gap;
        else if (edge === 'bottom') bottom -= h + gap;
        else if (edge === 'left') left += w + gap;
        else right -= w + gap;
      }
      for (const node of pending.sort((a, b) => a.order - b.order || layout.nodes.indexOf(a) - layout.nodes.indexOf(b)))
        flow(node, node.placement.kind === 'dock' || node.placement.kind === 'float');
      for (const node of siblings.filter(
        (node) => node.placement.kind === 'float' && !forcedFlow.has(node.id) && profile === 'desktop' && host.textScale === 1,
      )) {
        if (node.placement.kind !== 'float') continue;
        const placement = node.placement;
        const rect = {
          x: (width * placement.x) / 100,
          y: (height * placement.y) / 100,
          width: Math.min((width * placement.width) / 100, node.constraints?.maxWidth ?? width),
          height: Math.min((height * placement.height) / 100, node.constraints?.maxHeight ?? height),
        };
        let size: ReturnType<typeof sizeFor> | null = null;
        try {
          size = sizeFor(node, rect.width, rect.height);
        } catch (error) {
          if (!(error instanceof RangeError)) throw error;
        }
        if (
          profile !== 'desktop' ||
          host.textScale > 1 ||
          !size ||
          size.height > rect.height ||
          cursorY + rowHeight > bottom - top ||
          occupied.some((other) => overlap(rect, other))
        )
          return arrange(parent, width, height, requestedColumns, originY, new Set([...forcedFlow, node.id]));
        emit(node, rect, size, 'float', false);
      }
      const extent = Math.max(
        top + cursorY + rowHeight,
        ...out.filter((node) => node.parent === parent).map((node) => node.rect.y + node.rect.height),
        0,
      );
      if (!finite(extent, 0, 1000000)) throw new RangeError('content-budget');
      regions.push({
        parent,
        rect: { x: left, y: top + originY, width: right - left, height: bottom - top },
        contentHeight: cursorY + rowHeight,
        overflow: 'auto',
        revealFocus: true,
      });
      return { nodes: out, regions, height: extent };
    };
    const arranged = arrange(null, result.viewport.width, result.viewport.height, layout.columns);
    nodes.push(...arranged.nodes);
    result.nodes = nodes;
    result.regions = arranged.regions;
    result.contentHeight = arranged.height;
    return result;
  } catch (error) {
    if (error instanceof RangeError) {
      const known: FrameworkLayoutFallbackReason[] = [
        'insufficient-safe-viewport',
        'content-cannot-reflow',
        'group-cannot-reflow',
        'non-scrollable-content',
        'content-budget',
        'projection-work-budget',
      ];
      return fallback(
        known.includes(error.message as FrameworkLayoutFallbackReason) ? (error.message as FrameworkLayoutFallbackReason) : 'measurement-failed',
      );
    }
    throw error;
  }
}
