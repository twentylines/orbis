import { expect, test } from 'bun:test';
import { appWindowReducer as reduce, appWorkspace, type AppWindowState } from './app-window-state';

const first = { urn: 'first:store', name: 'First', launchUrl: 'https://first.local' };
const second = { urn: 'second:store', name: 'Second', launchUrl: 'https://second.local' };
const open = (state: AppWindowState, request = first) => reduce(state, { type: 'open', request });

test('snap offers a partner, pairs independent documents, and focusing either pane keeps both visible', () => {
  const snapped = reduce(open({ windows: [] }), { type: 'place', urn: first.urn, mode: 'left' });
  expect(appWorkspace(snapped).split).toEqual({ anchor: first.urn, side: 'left' });
  const paired = reduce(snapped, { type: 'pair', request: second });
  expect(paired.windows.map(({ mode, status }) => [mode, status])).toEqual([
    ['left', 'visible'],
    ['right', 'visible'],
  ]);
  const focused = reduce(paired, { type: 'focus', urn: first.urn });
  expect(focused.windows).toBe(paired.windows);
  expect(appWorkspace(focused).split?.partner).toBe(second.urn);
});

test('opening, minimizing, restoring and crossing the desktop breakpoint retain the same document requests', () => {
  const both = open(open({ windows: [] }), second);
  expect(both.windows.map(({ status }) => status)).toEqual(['visible', 'visible']);
  const restored = open(both);
  expect(restored.windows[0]?.request).toBe(first);
  expect(restored.windows[1]?.request).toBe(second);
  const compact = reduce(restored, { type: 'hide' });
  expect(compact.windows.every(({ status }) => status === 'minimized')).toBe(true);
  expect(open(compact).windows[0]?.request).toBe(first);
});

test('removing a split partner offers the empty half without replacing the surviving app', () => {
  const pair = reduce(reduce(open({ windows: [] }), { type: 'place', urn: first.urn, mode: 'right' }), { type: 'pair', request: second });
  const removed = reduce(pair, { type: 'remove', urn: second.urn });
  expect(appWorkspace(removed).split).toEqual({ anchor: first.urn, side: 'right' });
  expect(removed.windows).toHaveLength(1);
  expect(removed.windows[0]?.request).toBe(first);
  expect(removed.windows[0]?.status).toBe('visible');
});

test('closing either half reopens the picker after the close animation, retaining its ratio', () => {
  for (const closing of [first, second]) {
    let state = reduce(reduce(open({ windows: [] }), { type: 'place', urn: first.urn, mode: 'left' }), { type: 'pair', request: second });
    state = reduce(state, { type: 'ratio', value: 0.6 });
    const other = closing === first ? second : first;
    const pending = reduce(state, { type: 'close', urn: closing.urn });
    expect(appWorkspace(pending).split?.partner).toBe(second.urn);
    const complete = reduce(pending, { type: 'closed', urn: closing.urn });
    expect(appWorkspace(complete).split).toEqual({ anchor: other.urn, side: closing === first ? 'right' : 'left' });
    expect(appWorkspace(complete).ratio).toBe(0.6);
    expect(complete.windows[0]?.request).toBe(other);
  }
});

test('explicitly dismissing the picker survives closing a partner; snapping again reopens it', () => {
  const snapped = reduce(open({ windows: [] }), { type: 'place', urn: first.urn, mode: 'right' });
  let state = reduce(snapped, { type: 'dismiss-picker' });
  expect(appWorkspace(state).split).toEqual({ anchor: first.urn, side: 'right' });
  expect(appWorkspace(state).pickerDismissed).toBe(true);
  state = open(state, second);
  state = reduce(state, { type: 'remove', urn: second.urn });
  expect(appWorkspace(state).pickerDismissed).toBe(true);
  state = reduce(state, { type: 'place', urn: first.urn, mode: 'left' });
  expect(appWorkspace(state).pickerDismissed).toBe(false);
});

test('reusing an already opened app as a split partner preserves its document and stable DOM order', () => {
  const opened = open(open({ windows: [] }), second);
  const paired = reduce(reduce(opened, { type: 'place', urn: second.urn, mode: 'left' }), { type: 'pair', request: { ...first, name: 'New label' } });
  expect(paired.windows.map(({ request }) => request)).toEqual([first, second]);
  expect(paired.windows[0]?.request).toBe(first);
  expect(paired.windows[0]?.mode).toBe('right');
});

test('opening another app cannot cancel a pending close, and leaving desktop discards that closing frame', () => {
  const closing = reduce(open({ windows: [] }), { type: 'close', urn: first.urn });
  const opened = open(closing, second);
  expect(opened.windows[0]?.status).toBe('closing');
  expect(reduce(opened, { type: 'hide' }).windows.map(({ request }) => request.urn)).toEqual([second.urn]);
  expect(reduce(opened, { type: 'remove', urn: first.urn }).windows[0]?.status).toBe('visible');
});

test('section changes animate every visible window and restore only automatically minimized documents', () => {
  let state = open(open({ windows: [], section: '/dashboard' }), second);
  const third = { ...first, urn: 'third:store' };
  state = open(state, third);
  state = reduce(state, { type: 'minimize', urn: third.urn });
  state = reduce(state, { type: 'minimized', urn: third.urn });
  state = reduce(state, { type: 'visit', section: '/app-store' });
  expect(state.windows.map(({ status }) => status)).toEqual(['minimizing', 'minimizing', 'minimized']);
  state = reduce(state, { type: 'visit', section: '/dashboard' });
  expect(state.windows.map(({ status }) => status)).toEqual(['visible', 'visible', 'minimized']);
  expect(state.windows[0]?.request).toBe(first);
  state = reduce(state, { type: 'minimized', urn: first.urn });
  expect(state.windows[0]?.status).toBe('visible');
});

test('independent section groups preserve their split pair and active window', () => {
  let state = reduce(reduce(open({ windows: [], section: '/dashboard' }), { type: 'place', urn: first.urn, mode: 'left' }), {
    type: 'pair',
    request: second,
  });
  state = reduce(state, { type: 'ratio', value: 0.6 });
  state = reduce(state, { type: 'visit', section: '/apps' });
  const third = { ...first, urn: 'third:store' };
  state = open(state, third);
  expect(appWorkspace(state).active).toBe(third.urn);
  state = reduce(state, { type: 'visit', section: '/dashboard' });
  expect(appWorkspace(state).split).toEqual({ anchor: first.urn, side: 'left', partner: second.urn });
  expect(state.windows.map(({ status }) => status)).toEqual(['visible', 'visible', 'minimizing']);
  expect(state.windows.map(({ mode }) => mode)).toEqual(['left', 'right', 'floating']);
  expect(appWorkspace(state).ratio).toBe(0.6);
});

test('an obsolete close completion cannot remove a reopened window', () => {
  const closing = reduce(open({ windows: [] }), { type: 'close', urn: first.urn });
  const reopened = open(closing);
  expect(reduce(reopened, { type: 'closed', urn: first.urn })).toBe(reopened);
});

test('disabling windows keeps automatically minimized apps hidden when their section returns', () => {
  const leaving = reduce(open({ windows: [], section: '/dashboard' }), { type: 'visit', section: '/apps' });
  const disabled = reduce(leaving, { type: 'hide' });
  const returned = reduce(disabled, { type: 'visit', section: '/dashboard' });
  expect(returned.windows[0]?.status).toBe('minimized');
  expect(returned.windows[0]?.automatic).toBe(false);
});
test('snapping two visible windows places the partner on the other side and restores the picker when one minimizes', () => {
  let state = open(open({ windows: [], section: '/dashboard' }), second);
  state = reduce(state, { type: 'place', urn: first.urn, mode: 'right', partner: second.urn });
  expect(appWorkspace(state).split).toEqual({ anchor: first.urn, side: 'right', partner: second.urn });
  expect(state.windows.map(({ mode }) => mode)).toEqual(['right', 'left']);
  state = reduce(state, { type: 'minimize', urn: first.urn });
  expect(appWorkspace(state).split).toEqual({ anchor: second.urn, side: 'left' });
  expect(appWorkspace(state).pickerDismissed).toBe(false);
});
