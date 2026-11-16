import { type } from 'arktype';

export const toolbarActionIds = ['mode', 'tasks', 'battery', 'search', 'connection', 'logout'] as const;
export const toolbarOrderSchema = type
  .enumerated(...toolbarActionIds)
  .array()
  .narrow((items) => items.length === toolbarActionIds.length && new Set(items).size === items.length);
export const widgetSizeSchema = type({ columns: '2 | 3 | 4', height: '240 <= number.integer <= 960' }).onUndeclaredKey('reject');
export const workspaceLayoutSchema = type({
  version: '1',
  appView: "'cards' | 'icons'",
  widgets: type({ '[string]': widgetSizeSchema }).narrow((widgets) => {
    const keys = Object.keys(widgets);
    return keys.length <= 32 && keys.every((key) => /^[a-z][a-z0-9-]{0,63}$/.test(key) && !['constructor', 'prototype', '__proto__'].includes(key));
  }),
}).onUndeclaredKey('reject');
