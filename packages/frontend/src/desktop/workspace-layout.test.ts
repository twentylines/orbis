import { expect, test } from 'bun:test';
import {
  defaultWorkspaceLayout,
  legacyWidgetSize,
  preferencePayload,
  resizeWidget,
  toolbarActionIds,
  validToolbarOrder,
  validWorkspaceLayout,
  workspaceCapabilities,
} from './workspace-layout';
import { reorderAt } from './workspace-sortable';

test('old and unknown backend capabilities never send new fields or mutate the cached draft', () => {
  const value = { toolbarOrder: [...toolbarActionIds], workspace: { order: ['activity'], layout: defaultWorkspaceLayout } };
  const before = JSON.stringify(value);
  expect(preferencePayload(value, workspaceCapabilities(null))).toEqual({ workspace: { order: ['activity'] } });
  expect(preferencePayload(value, workspaceCapabilities('workspace-layout-v1 unknown'))).toEqual({ workspace: value.workspace });
  expect(preferencePayload(value, workspaceCapabilities('workspace-layout-v1 toolbar-order-v1'))).toEqual(value);
  expect(JSON.stringify(value)).toBe(before);
});
test('toolbar order accepts exactly the six movable actions, preserving the fixed brand outside its contract', () => {
  expect(validToolbarOrder([...toolbarActionIds].reverse())).toBe(true);
  for (const order of [[], [...toolbarActionIds, 'brand'], ['mode', 'mode', 'battery', 'search', 'connection', 'logout'], null])
    expect(validToolbarOrder(order)).toBe(false);
});
test('versioned sizes preserve future widget metadata but bound count, identity and dimensions', () => {
  expect(validWorkspaceLayout({ version: 1, appView: 'icons', widgets: { 'future-widget': { columns: 3, height: 400 } } })).toBe(true);
  for (const widgets of [
    JSON.parse('{"__proto__":{"columns":2,"height":240}}'),
    { constructor: { columns: 2, height: 240 } },
    { activity: { columns: 1, height: 240 } },
    { activity: { columns: 2, height: Number.NaN } },
    { activity: { columns: 2, height: 961 } },
    Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`widget-${i}`, { columns: 2, height: 240 }])),
  ])
    expect(validWorkspaceLayout({ version: 1, appView: 'cards', widgets })).toBe(false);
  expect(validWorkspaceLayout({ ...defaultWorkspaceLayout, version: 2 })).toBe(false);
});
test('resize maps legacy width safely and bounds both axes without changing the source', () => {
  expect(legacyWidgetSize('applications', ['applications']).columns).toBe(4);
  expect(legacyWidgetSize('activity', []).columns).toBe(2);
  const size = { columns: 3 as const, height: 400 };
  expect(resizeWidget(size, -999, 9999, 100)).toEqual({ columns: 2, height: 960 });
  expect(resizeWidget(size, 100, -160, 100)).toEqual({ columns: 4, height: 240 });
  expect(size).toEqual({ columns: 3, height: 400 });
});
test('pointer and keyboard placement keep identities and handle either direction and outside targets', () => {
  const ids = ['applications', 'activity', 'storage', 'attention'];
  expect(reorderAt(ids, 'applications', 'storage')).toEqual(['activity', 'storage', 'applications', 'attention']);
  expect(reorderAt(ids, 'attention', 'activity')).toEqual(['applications', 'attention', 'activity', 'storage']);
  expect(reorderAt(ids, 'outside', 'activity')).toEqual(ids);
  expect(ids).toEqual(['applications', 'activity', 'storage', 'attention']);
});
