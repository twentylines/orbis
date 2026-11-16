import { expect, test } from 'bun:test';
import { toolbarActionIds, toolbarOrderSchema, workspaceLayoutSchema } from './workspace-layout';

test('toolbar layout is a complete permutation and rejects nonactions', () => {
  expect(toolbarOrderSchema.allows([...toolbarActionIds].reverse())).toBe(true);
  expect(toolbarOrderSchema.allows([...toolbarActionIds, 'brand'])).toBe(false);
  expect(toolbarOrderSchema.allows(['mode', 'mode', 'battery', 'search', 'connection', 'logout'])).toBe(false);
});
test('workspace layout survives JSON roundtrip with bounded future metadata and rejects unsafe keys', () => {
  const layout = { version: 1, appView: 'icons', widgets: { activity: { columns: 3, height: 480 }, 'future-widget': { columns: 2, height: 240 } } };
  expect(workspaceLayoutSchema.assert(JSON.parse(JSON.stringify(layout)))).toEqual(layout);
  for (const widgets of [
    JSON.parse('{"__proto__":{"columns":2,"height":240}}'),
    { constructor: { columns: 2, height: 240 } },
    { activity: { columns: 4, height: Number.POSITIVE_INFINITY } },
    { activity: { columns: 1, height: 320 } },
    { activity: { columns: 4, height: 320.5 } },
    Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`widget-${i}`, { columns: 2, height: 320 }])),
  ])
    expect(workspaceLayoutSchema.allows({ ...layout, widgets })).toBe(false);
});
