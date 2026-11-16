export const toolbarActionIds = ['mode', 'tasks', 'battery', 'search', 'connection', 'logout'] as const;
export type ToolbarActionId = (typeof toolbarActionIds)[number];
export type WidgetSize = { columns: 2 | 3 | 4; height: number };
export type WorkspaceLayout = { version: 1; appView: 'cards' | 'icons'; widgets: Record<string, WidgetSize> };
export type WorkspaceCapabilities = { toolbarOrder: boolean; workspaceLayout: boolean };
export const unavailableWorkspaceCapabilities: WorkspaceCapabilities = { toolbarOrder: false, workspaceLayout: false };
export const defaultWorkspaceLayout: WorkspaceLayout = { version: 1, appView: 'cards', widgets: {} };
export const workspaceEditingEvent = 'orbis-workspace-editing';

export function workspaceCapabilities(header: string | null): WorkspaceCapabilities {
  const capabilities = new Set(header?.split(/\s+/));
  return { toolbarOrder: capabilities.has('toolbar-order-v1'), workspaceLayout: capabilities.has('workspace-layout-v1') };
}
export function validToolbarOrder(value: unknown): value is ToolbarActionId[] {
  return (
    Array.isArray(value) &&
    value.length === toolbarActionIds.length &&
    new Set(value).size === value.length &&
    value.every((id) => toolbarActionIds.includes(id))
  );
}
export function validWorkspaceLayout(value: unknown): value is WorkspaceLayout {
  if (!value || typeof value !== 'object') return false;
  const layout = value as WorkspaceLayout;
  if (Object.keys(layout).some((key) => !['version', 'appView', 'widgets'].includes(key))) return false;
  if (
    layout.version !== 1 ||
    !['cards', 'icons'].includes(layout.appView) ||
    !layout.widgets ||
    typeof layout.widgets !== 'object' ||
    Array.isArray(layout.widgets)
  )
    return false;
  const entries = Object.entries(layout.widgets);
  return (
    entries.length <= 32 &&
    entries.every(
      ([id, size]) =>
        /^[a-z][a-z0-9-]{0,63}$/.test(id) &&
        !['constructor', 'prototype', '__proto__'].includes(id) &&
        size &&
        typeof size === 'object' &&
        Object.keys(size).every((key) => ['columns', 'height'].includes(key)) &&
        [2, 3, 4].includes(size.columns) &&
        Number.isInteger(size.height) &&
        size.height >= 240 &&
        size.height <= 960,
    )
  );
}
export function legacyWidgetSize(id: string, wide: readonly string[]): WidgetSize {
  return { columns: wide.includes(id) ? 4 : 2, height: id === 'activity' ? 480 : 320 };
}
export function workspaceWidgetSize(layout: WorkspaceLayout | undefined, id: string, wide: readonly string[]): WidgetSize {
  return layout?.widgets[id] ?? legacyWidgetSize(id, wide);
}
export function resizeWidget(size: WidgetSize, dx: number, dy: number, columnWidth: number): WidgetSize {
  return {
    columns: Math.max(2, Math.min(4, size.columns + Math.round(dx / Math.max(1, columnWidth)))) as WidgetSize['columns'],
    height: Math.max(240, Math.min(960, Math.round((size.height + dy) / 40) * 40)),
  };
}
type CompatiblePreferencePayload<T extends { workspace: { layout?: WorkspaceLayout } }> = Omit<T, 'toolbarOrder' | 'workspace'> & {
  toolbarOrder?: ToolbarActionId[];
  workspace: Omit<T['workspace'], 'layout'> & { layout?: WorkspaceLayout };
};
export function preferencePayload<T extends { toolbarOrder?: ToolbarActionId[]; workspace: { layout?: WorkspaceLayout } }>(
  value: T,
  capabilities: WorkspaceCapabilities,
): CompatiblePreferencePayload<T> {
  const next = { ...value, workspace: { ...value.workspace } };
  if (!capabilities.toolbarOrder) delete next.toolbarOrder;
  if (!capabilities.workspaceLayout) delete next.workspace.layout;
  return next as CompatiblePreferencePayload<T>;
}
