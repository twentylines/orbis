import { expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { bundledThemePacks } from '../../../../backend/src/modules/theme-packs/theme-pack-catalogue';
import { themePackSnapshotSchema, type ThemePackManifest, type ThemePackSnapshot } from '@runtipi/common/schemas/theme-pack';
import { runThemeApply, sameTheme, themeApplyAcknowledged, themeApplyAvailable, type ThemeApplyAction } from './theme-apply-state';
import {
  decodeThemeApplyHandoff,
  readThemeApplyHandoff,
  writeThemeApplyHandoff,
  themeApplyHandoffBootstrap,
  themeApplyHandoffKey,
} from './theme-apply-handoff';
import { scheduleThemeApplyPaint } from './theme-apply-paint';

const pack = (id: string, version = '1.1.0') => {
  const value = bundledThemePacks.find((item) => item.id === id && item.version === version);
  if (!value) throw new Error('Missing test pack');
  return value;
};
const selected = pack('tideline');
const reference = (manifest: ThemePackManifest) => ({ id: manifest.id, version: manifest.version });
const snapshot = (active: ThemePackManifest | null, installed = [selected]): ThemePackSnapshot => ({
  catalogue: bundledThemePacks,
  state: {
    formatVersion: 1,
    selected: active ? reference(active) : null,
    installed: installed.map((manifest) => ({
      manifest,
      digest: 'a'.repeat(64),
      installedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      previous: null,
    })),
  },
});
const before = snapshot(null);
const after = snapshot(selected);
const action: ThemeApplyAction = { kind: 'select', source: null, target: reference(selected), name: selected.name };
function harness(overrides: Partial<Parameters<typeof runThemeApply>[1]> = {}) {
  const events: string[] = [];
  const controller = new AbortController();
  const dependencies: Parameters<typeof runThemeApply>[1] = {
    signal: controller.signal,
    current: () => true,
    cover: async () => {
      events.push('cover');
    },
    read: async () => {
      events.push('read');
      return before;
    },
    execute: async () => {
      events.push('write');
      return after;
    },
    persist: () => {
      events.push('persist');
      return true;
    },
    reload: () => {
      events.push('reload');
    },
    stage: (stage) => events.push(stage),
    ...overrides,
  };
  return { dependencies, events, controller };
}

test('cover paint completes before any request, and only exact ACK/persistence permits reload', async () => {
  let paint!: () => void;
  const h = harness({
    cover: () =>
      new Promise<void>((resolve) => {
        paint = resolve;
      }),
  });
  const result = runThemeApply(action, h.dependencies);
  await Promise.resolve();
  expect(h.events).toEqual([]);
  paint();
  await result;
  expect(h.events).toEqual(['checking', 'read', 'applying', 'write', 'persist', 'reloading', 'reload']);
  expect(themePackSnapshotSchema.allows(after)).toBe(true);
  expect(themeApplyAcknowledged(after, action)).toBe(true);
  expect(sameTheme({ ...reference(selected) }, action.target)).toBe(true);
  expect(sameTheme(null, undefined)).toBe(true);
});

test('uninstalled targets and remotely changed source selection never execute a write', async () => {
  for (const value of [snapshot(null, []), snapshot(pack('alpine'), [selected, pack('alpine')])]) {
    const h = harness({ read: async () => value });
    await expect(runThemeApply(action, h.dependencies)).rejects.toThrow('selection changed');
    expect(h.events).not.toContain('write');
    expect(h.events).not.toContain('reload');
  }
});

test('already acknowledged target retries cache/reload without repeating a mutation', async () => {
  const h = harness({ read: async () => after });
  await runThemeApply(action, h.dependencies);
  expect(h.events).toEqual(['cover', 'checking', 'persist', 'reloading', 'reload']);
});

test('ambiguous network failure or wrong ACK reconciles with exactly one read before reload', async () => {
  for (const execute of [
    async () => {
      throw new Error('Timed out');
    },
    async () => before,
  ]) {
    let reads = 0;
    const h = harness({ execute, read: async () => (++reads === 1 ? before : after) });
    await runThemeApply(action, h.dependencies);
    expect(reads).toBe(2);
    expect(h.events).toContain('reconciling');
    expect(h.events.at(-1)).toBe('reload');
  }
});

test('unconfirmed or malformed ACK cannot reload or cache untrusted state', async () => {
  for (const bad of [before, {} as ThemePackSnapshot]) {
    let reads = 0;
    const h = harness({
      execute: async () => bad,
      read: async () => {
        reads++;
        return before;
      },
    });
    await expect(runThemeApply(action, h.dependencies)).rejects.toThrow('could not be confirmed');
    expect(reads).toBe(2);
    expect(h.events).not.toContain('persist');
    expect(h.events).not.toContain('reload');
  }
});

test('captured session abortion after dispatch rejects late ACK without any readback or persistence', async () => {
  let reads = 0;
  const h = harness({
    read: async () => {
      reads++;
      return before;
    },
  });
  h.dependencies.execute = async () => {
    h.controller.abort();
    return after;
  };
  await expect(runThemeApply(action, h.dependencies)).rejects.toThrow();
  expect(reads).toBe(1);
  expect(h.events).not.toContain('persist');
  expect(h.events).not.toContain('reload');
});

test('current epoch guard is checked after read and storage failure has no reload', async () => {
  let current = true;
  const h = harness({
    current: () => current,
    read: async () => {
      current = false;
      return after;
    },
  });
  await expect(runThemeApply(action, h.dependencies)).rejects.toThrow('session changed');
  expect(h.events).not.toContain('persist');
  const blocked = harness({ persist: () => false });
  await expect(runThemeApply(action, blocked.dependencies)).rejects.toThrow('prepare the reload');
  expect(blocked.events).not.toContain('reload');
});

test('active update, rollback and removal require exact version and removal postconditions', () => {
  const old = pack('tideline', '1.0.0');
  const installed = snapshot(old, [old]);
  const update = { ...action, kind: 'update' as const, source: reference(old), id: old.id };
  expect(themeApplyAvailable(installed, update)).toBe(true);
  expect(themeApplyAcknowledged(after, update)).toBe(true);
  const rollbackState = snapshot(selected);
  const record = rollbackState.state.installed[0];
  if (!record) throw new Error('Missing record');
  record.previous = { manifest: old, digest: 'b'.repeat(64) };
  const rollback = { ...action, kind: 'rollback' as const, id: selected.id, source: reference(selected), target: reference(old) };
  expect(themeApplyAvailable(rollbackState, rollback)).toBe(true);
  expect(themeApplyAcknowledged(installed, rollback)).toBe(true);
  const remove = { ...action, kind: 'remove' as const, id: selected.id, source: reference(selected), target: null };
  expect(themeApplyAvailable(after, remove)).toBe(true);
  expect(themeApplyAcknowledged(before, remove)).toBe(false);
  expect(themeApplyAcknowledged(snapshot(null, []), remove)).toBe(true);
});

test('handoff is strict, bounded, short-lived and writes only its separate public key', () => {
  const now = Date.now();
  const valid = { version: 1 as const, savedAt: now, selected: action.target };
  expect(decodeThemeApplyHandoff(JSON.stringify(valid), now)).toEqual(valid);
  expect(decodeThemeApplyHandoff(JSON.stringify({ ...valid, selected: null }), now)?.selected).toBeNull();
  for (const value of [
    { ...valid, account: 'no' },
    { ...valid, savedAt: now + 1 },
    { ...valid, savedAt: now - 120_000 },
    { ...valid, selected: { ...action.target, script: 'no' } },
    { ...valid, selected: { id: 'https://unsafe.invalid', version: '1.0.0' } },
  ])
    expect(decodeThemeApplyHandoff(JSON.stringify(value), now)).toBeNull();
  expect(decodeThemeApplyHandoff('x'.repeat(513), now)).toBeNull();
  const values = new Map([['unrelated', 'keep']]);
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  expect(writeThemeApplyHandoff(action.target, storage)).toBe(true);
  expect(readThemeApplyHandoff(storage)?.selected).toEqual(action.target);
  values.set(themeApplyHandoffKey, '{}');
  expect(readThemeApplyHandoff(storage)).toBeNull();
  expect(values.get('unrelated')).toBe('keep');
  expect(
    writeThemeApplyHandoff(null, {
      ...storage,
      setItem: () => {
        throw new Error('Denied');
      },
    }),
  ).toBe(false);
});

test('prepaint bootstrap covers only a valid handoff and never clears unrelated storage', () => {
  const values = new Map([
    [themeApplyHandoffKey, JSON.stringify({ version: 1, savedAt: Date.now(), selected: action.target })],
    ['unrelated', 'keep'],
  ]);
  const attributes = new Map<string, string>();
  const context = {
    sessionStorage: { getItem: (key: string) => values.get(key) ?? null, removeItem: (key: string) => values.delete(key) },
    document: { documentElement: { setAttribute: (key: string, value: string) => attributes.set(key, value) } },
  };
  runInNewContext(themeApplyHandoffBootstrap, context);
  expect(attributes.get('data-orbis-theme-reload')).toBe('pending');
  attributes.clear();
  values.set(themeApplyHandoffKey, '{}');
  runInNewContext(themeApplyHandoffBootstrap, context);
  expect(attributes.size).toBe(0);
  expect(values.has(themeApplyHandoffKey)).toBe(false);
  expect(values.get('unrelated')).toBe('keep');
});

test('paint gate waits two frame callbacks and cleanup cancels both', () => {
  const frames = new Map<number, FrameRequestCallback>();
  let next = 0;
  let painted = 0;
  const request = (callback: FrameRequestCallback) => {
    frames.set(++next, callback);
    return next;
  };
  const cancel = (id: number) => {
    frames.delete(id);
  };
  const dispose = scheduleThemeApplyPaint(
    () => {
      painted++;
    },
    request,
    cancel,
  );
  frames.get(1)?.(0);
  expect(painted).toBe(0);
  frames.get(2)?.(16);
  expect(painted).toBe(1);
  dispose();
  expect(frames.size).toBe(0);
  const abandon = scheduleThemeApplyPaint(
    () => {
      painted++;
    },
    request,
    cancel,
  );
  frames.get(3)?.(32);
  abandon();
  expect(frames.size).toBe(0);
  expect(painted).toBe(1);
});

for (const scenario of [
  'current-noop',
  'confirmation-paint-reload',
  'session-abort',
  'storage-retry-duplicate',
  'cancel-no-rollback',
  'startup-verified',
  'startup-recovery',
]) {
  test(`mounted theme apply hook: ${scenario}`, async () => {
    const child = Bun.spawn([process.execPath, new URL('./theme-apply.fixture.tsx', import.meta.url).pathname, scenario], {
      cwd: new URL('../../..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
    expect(JSON.parse(stdout)).toEqual({ scenario, mountedReact: true, compositor: false, network: false });
  });
}

test('minified handoff bootstrap stays self-contained before the application bundle', async () => {
  const entry = new URL('./theme-apply-handoff.ts', import.meta.url).pathname;
  const script = `const result=await Bun.build({entrypoints:[${JSON.stringify(entry)}],target:'browser',format:'cjs',minify:true,write:false});if(!result.success)throw new Error('Bundle failed');const source=await result.outputs[0].text();const module={exports:{}};new Function('module','exports',source)(module,module.exports);process.stdout.write(JSON.stringify(module.exports.themeApplyHandoffBootstrap));`;
  const child = Bun.spawn([process.execPath, '--eval', script], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
  const attributes = new Map<string, string>();
  runInNewContext(JSON.parse(stdout), {
    sessionStorage: { getItem: () => JSON.stringify({ version: 1, savedAt: Date.now(), selected: action.target }) },
    document: { documentElement: { setAttribute: (key: string, value: string) => attributes.set(key, value) } },
  });
  expect(attributes.get('data-orbis-theme-reload')).toBe('pending');
});

for (const scenario of ['startup-sessions', 'startup-gated', 'startup-error']) {
  test(`mounted startup boundary: ${scenario}`, async () => {
    const child = Bun.spawn([process.execPath, new URL('./theme-startup.fixture.tsx', import.meta.url).pathname, scenario], {
      cwd: new URL('../../..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
    expect(JSON.parse(stdout)).toEqual({ scenario, mountedReact: true, compositor: false, network: false });
  });
}

test('cover markup names loading/recovery, retains keyboard actions and has no fake progress', async () => {
  const child = Bun.spawn([process.execPath, new URL('./theme-apply-view.fixture.tsx', import.meta.url).pathname], {
    cwd: new URL('../../..', import.meta.url).pathname,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
  expect(JSON.parse(stdout)).toEqual({ accessibilityMarkup: true, layout: false, network: false });
});

test('prepaint watchdog exposes static recovery if React never supplies its cover', () => {
  const attributes = new Map<string, string>();
  const values = new Map([
    [themeApplyHandoffKey, JSON.stringify({ version: 1, savedAt: Date.now(), selected: action.target })],
    ['unrelated', 'keep'],
  ]);
  let timeout!: () => void;
  let covered = false;
  runInNewContext(themeApplyHandoffBootstrap, {
    sessionStorage: { getItem: (key: string) => values.get(key) ?? null, removeItem: (key: string) => values.delete(key) },
    setTimeout: (callback: () => void, delay: number) => {
      expect(delay).toBe(20_000);
      timeout = callback;
    },
    document: {
      documentElement: {
        setAttribute: (key: string, value: string) => attributes.set(key, value),
        getAttribute: (key: string) => attributes.get(key) ?? null,
      },
      querySelector: () => (covered ? {} : null),
    },
  });
  attributes.set('data-orbis-theme-reload', 'checking');
  covered = true;
  timeout();
  expect(attributes.get('data-orbis-theme-reload')).toBe('checking');
  expect(values.has(themeApplyHandoffKey)).toBe(true);
  covered = false;
  timeout();
  expect(attributes.get('data-orbis-theme-reload')).toBe('failed');
  expect(values.has(themeApplyHandoffKey)).toBe(false);
  expect(values.get('unrelated')).toBe('keep');
});
