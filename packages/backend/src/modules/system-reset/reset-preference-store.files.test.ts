import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { PinnedDirectory, STAGE_PREFIX, ResetPreferenceError, ResetPreferenceStore } from './reset-preference-store';

const journal = () => randomUUID();
const descriptorRoot = (_fd: number, directory: string) => directory;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const exists = (target: string) =>
  fs.lstat(target).then(
    () => true,
    (error: unknown) => {
      if (missing(error)) return false;
      throw error;
    },
  );
const code = (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (error: unknown) => (error instanceof ResetPreferenceError ? error.code : 'unexpected'),
  );

let root: string;
let state: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-preferences-')));
  state = path.join(root, 'state');
  await fs.mkdir(state, { mode: 0o700 });
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function file(relative: string, content = 'old preference') {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.writeFile(target, content, { mode: 0o600 });
  return target;
}
const store = (options: { rename?: (from: string, to: string) => Promise<void> } = {}) =>
  new ResetPreferenceStore({ dataDir: root, descriptorRoot, ...options });
const stages = async (directory: string) => (await fs.readdir(directory)).filter((name) => name.startsWith(STAGE_PREFIX));

it('erases only the journal targets and stages inside the same private directory', async () => {
  const target = await file('state/desktop/7.json');
  const kept = await file('state/desktop/8.json');
  const walpaper = await file('state/wallpapers/7.image');
  const id = journal();
  await store().erase(id, [target, walpaper]);

  expect(await exists(target)).toBe(false);
  expect(await exists(walpaper)).toBe(false);
  expect(await fs.readFile(kept, 'utf8')).toBe('old preference');
  expect(await fs.readdir(path.join(state, 'desktop'))).toEqual(['8.json']);
  expect(await stages(path.join(state, 'desktop'))).toEqual([]);
  expect(await stages(path.join(state, 'wallpapers'))).toEqual([]);
  // Same-directory staging never needs the dedicated authority path, and never creates it.
  expect(await exists(path.join(root, 'orbis-reset'))).toBe(false);
});

it('erases a root-level preference through its own same-directory stage', async () => {
  const origin = await file('.orbis-onboarding-origin.json');
  await store().erase(journal(), [origin]);
  expect(await exists(origin)).toBe(false);
  expect(await stages(root)).toEqual([]);
});

it('removes matching directory targets recursively but preserves sibling entries', async () => {
  const target = await file('state/theme-packs/7/custom/asset');
  const kept = await file('state/theme-packs/8/custom/asset');
  await store().erase(journal(), [path.join(state, 'theme-packs/7')]);
  expect(await exists(path.dirname(path.dirname(target)))).toBe(false);
  expect(await fs.readFile(kept, 'utf8')).toBe('old preference');
});

it('works on a shared legacy state root without changing its permissions', async () => {
  await fs.chmod(state, 0o777);
  const target = await file('state/desktop/7.json');
  await store().erase(journal(), [target]);
  expect(await exists(target)).toBe(false);
  expect((await fs.lstat(state)).mode & 0o777).toBe(0o777);
});

it('handles the root-level password request only on a verified shared state mount', async () => {
  const target = await file('state/password-change-request');
  await fs.chmod(state, 0o777);
  const readMounts = async () => `36 35 98:0 / ${state} rw - ext4 /dev/sda1 rw\n`;
  const mounted = new ResetPreferenceStore({ dataDir: root, descriptorRoot, readMounts });
  await mounted.erase(journal(), [target]);
  expect(await exists(target)).toBe(false);
  expect((await fs.stat(state)).mode & 0o777).toBe(0o777);
  await file('state/password-change-request');
  const unmounted = new ResetPreferenceStore({
    dataDir: root,
    descriptorRoot,
    readMounts: async () => '36 35 98:0 / /different rw - ext4 /dev/sda1 rw\n',
  });
  expect(await code(unmounted.erase(journal(), [target]))).toBe('unsafe');
  expect(await exists(target)).toBe(true);
});

it('preserves a substituted target instead of deleting it after a raced rename', async () => {
  const target = await file('state/desktop/7.json', 'original');
  const sibling = await file('state/desktop/8.json', 'preserve substituted bytes');
  const id = journal();
  const raced = store({
    rename: async (from, to) => {
      await fs.rename(from, `${from}.held`);
      await fs.rename(sibling, from);
      await fs.rename(from, to);
    },
  });
  expect(await code(raced.erase(id, [target]))).toBe('identity-changed');
  expect(await fs.readFile(path.join(state, 'desktop', `${STAGE_PREFIX}${id}`, '7.json'), 'utf8')).toBe('preserve substituted bytes');
  expect(await fs.readFile(`${target}.held`, 'utf8')).toBe('original');
});

it('skips absent targets and absent parent directories without creating anything', async () => {
  const target = path.join(state, 'desktop/7.json');
  await store().erase(journal(), [target, path.join(state, 'missing/9.json')]);
  expect(await exists(target)).toBe(false);
  expect(await exists(path.join(state, 'desktop'))).toBe(false);
  expect(await exists(path.join(state, 'missing'))).toBe(false);
});

it('is read-only during preflight', async () => {
  const target = await file('state/desktop/7.json');
  const plan = await store().preflight(journal(), [target]);
  expect(await stages(path.join(state, 'desktop'))).toEqual([]);
  expect(await fs.readFile(target, 'utf8')).toBe('old preference');
  await plan.close();
});

it('rejects unsafe targets before creating any staging directory', async () => {
  const target = await file('state/desktop/7.json');
  const cases: [string, () => Promise<unknown>][] = [
    [
      'symlink',
      async () => {
        const link = path.join(state, 'desktop/9.json');
        await fs.symlink(target, link);
        return store().preflight(journal(), [link]);
      },
    ],
    [
      'hardlink',
      async () => {
        const link = path.join(state, 'desktop/10.json');
        await fs.link(target, link);
        return store().preflight(journal(), [link]);
      },
    ],
    [
      'nested symlink',
      async () => {
        const directory = path.join(state, 'theme-packs/7');
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        await fs.symlink(target, path.join(directory, 'asset'));
        return store().preflight(journal(), [directory]);
      },
    ],
    [
      'shared parent',
      async () => {
        await fs.chmod(path.join(state, 'desktop'), 0o777);
        return store().preflight(journal(), [target]);
      },
    ],
    [
      'symlinked parent',
      async () => {
        const real = path.join(state, 'real-desktop');
        const parent = path.join(state, 'desktop');
        await fs.mkdir(real, { mode: 0o700 });
        await fs.writeFile(path.join(real, '7.json'), 'old preference', { mode: 0o600 });
        await fs.rename(parent, path.join(state, 'desktop-real'));
        await fs.symlink(real, parent);
        return store().preflight(journal(), [path.join(parent, '7.json')]);
      },
    ],
  ];
  for (const [name, run] of cases) {
    expect(await code(run()), `${name}`).toBe('unsafe');
  }
  expect(await stages(path.join(state, 'desktop'))).toEqual([]);
  expect(await fs.readFile(target, 'utf8')).toBe('old preference');
});

it('rejects invalid target lists, foreign paths and the dedicated authority as staging', async () => {
  const target = await file('state/desktop/7.json');
  const invalid = [
    () => store().preflight('not-a-uuid', [target]),
    () => store().preflight(journal(), []),
    () => store().preflight(journal(), [target, target]),
    () => store().preflight(journal(), ['state/desktop/7.json']),
    () => store().preflight(journal(), ['/etc/passwd']),
    () => store().preflight(journal(), [path.join(root, 'orbis-reset/x.json')]),
  ];
  for (const run of invalid) expect(await code(run())).toBe('unsafe');
});

it('fails closed instead of silently adopting staging from another journal', async () => {
  const target = await file('state/desktop/7.json');
  const foreign = path.join(state, 'desktop', `${STAGE_PREFIX}${journal()}`);
  await fs.mkdir(foreign, { mode: 0o700 });
  const kept = path.join(foreign, '7.json');
  await fs.writeFile(kept, 'older reset', { mode: 0o600 });

  expect(await code(store().erase(journal(), [target]))).toBe('stage-conflict');
  expect(await fs.readFile(target, 'utf8')).toBe('old preference');
  expect(await fs.readFile(kept, 'utf8')).toBe('older reset');
});

it('resumes a journal-bound erase after an interrupted move and deletes the staged copy', async () => {
  const first = await file('state/desktop/7.json');
  const second = await file('state/wallpapers/7.image');
  const id = journal();
  const broken = async (from: string, to: string) => {
    if (from.endsWith('7.image')) throw Object.assign(new Error('fixture failure'), { code: 'EIO' });
    await fs.rename(from, to);
  };
  expect(await code(store({ rename: broken }).erase(id, [first, second]))).toBe('rename-failed');

  expect(await exists(first)).toBe(false);
  expect(await exists(second)).toBe(true);
  // The first group is fully committed; only the interrupted group keeps its journal-bound stage.
  expect(await stages(path.join(state, 'desktop'))).toEqual([]);
  expect(await stages(path.join(state, 'wallpapers'))).toEqual([`${STAGE_PREFIX}${id}`]);
  expect(await fs.readdir(path.join(state, 'wallpapers', `${STAGE_PREFIX}${id}`))).toEqual(['binding.json']);

  await store().erase(id, [first, second]);
  expect(await exists(first)).toBe(false);
  expect(await exists(second)).toBe(false);
  expect(await stages(path.join(state, 'desktop'))).toEqual([]);
  expect(await stages(path.join(state, 'wallpapers'))).toEqual([]);
});

it('resumes after a crash between the move and the staged deletion', async () => {
  const target = await file('state/desktop/7.json');
  const id = journal();
  const crashing = async (from: string, to: string) => {
    await fs.rename(from, to);
    throw Object.assign(new Error('fixture crash'), { code: 'EIO' });
  };
  expect(await code(store({ rename: crashing }).erase(id, [target]))).toBe('rename-failed');
  expect(await exists(target)).toBe(false);
  expect(await exists(path.join(state, 'desktop', `${STAGE_PREFIX}${id}`, '7.json'))).toBe(true);

  await store().erase(id, [target]);
  expect(await exists(path.join(state, 'desktop', `${STAGE_PREFIX}${id}`))).toBe(false);
});

it('treats a preference recreated during recovery as a conflict instead of deleting blindly', async () => {
  const first = await file('state/desktop/7.json');
  const second = await file('state/wallpapers/7.image');
  const id = journal();
  const crashing = async (from: string, to: string) => {
    await fs.rename(from, to);
    if (from.endsWith('7.image')) throw Object.assign(new Error('fixture crash'), { code: 'EIO' });
  };
  expect(await code(store({ rename: crashing }).erase(id, [first, second]))).toBe('rename-failed');
  expect(await exists(first)).toBe(false);
  expect(await exists(second)).toBe(false);
  expect(await exists(path.join(state, 'wallpapers', `${STAGE_PREFIX}${id}`, '7.image'))).toBe(true);
  await fs.writeFile(second, 'recreated during reset', { mode: 0o600 });

  expect(await code(store().erase(id, [first, second]))).toBe('stage-conflict');
  expect(await fs.readFile(second, 'utf8')).toBe('recreated during reset');
  expect(await exists(path.join(state, 'wallpapers', `${STAGE_PREFIX}${id}`, '7.image'))).toBe(true);
});

it('detects a target swapped between preflight and the move', async () => {
  const target = await file('state/desktop/7.json');
  const id = journal();
  const plan = await store().preflight(id, [target]);
  try {
    await fs.unlink(target);
    await fs.writeFile(target, 'swapped', { mode: 0o600 });
    await store().begin(plan);
    expect(await code(store().commit(plan))).toBe('identity-changed');
  } finally {
    await plan.close();
  }
  expect(await fs.readFile(target, 'utf8')).toBe('swapped');
});

it('rejects a new file generation even when the filesystem reuses its inode number', async () => {
  const target = await file('state/desktop/7.json');
  const selected = store();
  const plan = await selected.preflight(journal(), [target]);
  try {
    await selected.begin(plan);
    const group = plan.groups[0];
    const expected = group?.binding.targets[0];
    if (!group || !expected) throw new Error('Missing target fixture');
    await fs.unlink(target);
    await fs.writeFile(target, 'replacement must survive', { mode: 0o600 });
    const lstat = group.pin.lstat.bind(group.pin);
    group.pin.lstat = async (name) => {
      const actual = await lstat(name);
      if (name !== expected.name) return actual;
      return Object.assign(Object.create(actual), { dev: expected.dev, ino: expected.ino, birthtimeMs: expected.birthtimeMs + 1 });
    };
    expect(await code(selected.commit(plan))).toBe('identity-changed');
    expect(await fs.readFile(target, 'utf8')).toBe('replacement must survive');
  } finally {
    await plan.close();
  }
});

it('adopts a preference created after preflight and then erases it', async () => {
  const target = path.join(state, 'desktop/7.json');
  await fs.mkdir(path.dirname(target), { mode: 0o700 });
  const id = journal();
  const plan = await store().preflight(id, [target]);
  try {
    expect(await exists(target)).toBe(false);
    await fs.writeFile(target, 'created during reset', { mode: 0o600 });
    await store().begin(plan);
    await store().commit(plan);
  } finally {
    await plan.close();
  }
  expect(await exists(target)).toBe(false);
  expect(await stages(path.join(state, 'desktop'))).toEqual([]);
});

it('refuses to move when the pinned parent path was replaced before staging', async () => {
  const target = await file('state/desktop/7.json');
  const plan = await store().preflight(journal(), [target]);
  try {
    const parent = path.dirname(target);
    await fs.rename(parent, `${parent}-moved`);
    await fs.mkdir(parent, { mode: 0o700 });
    expect(await code(store().begin(plan))).toBe('identity-changed');
    expect(await fs.readdir(parent)).toEqual([]);
  } finally {
    await plan.close();
  }
});

it('converts a real cross-device rename failure into a hard error and leaves the target intact', async () => {
  const target = await file('state/desktop/7.json');
  const id = journal();
  const cross = async () => {
    throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
  };
  expect(await code(store({ rename: cross }).erase(id, [target]))).toBe('cross-device');
  expect(await fs.readFile(target, 'utf8')).toBe('old preference');
  expect(await stages(path.join(state, 'desktop'))).toEqual([`${STAGE_PREFIX}${id}`]);

  await store().erase(id, [target]);
  expect(await exists(target)).toBe(false);
  expect(await stages(path.join(state, 'desktop'))).toEqual([]);
});

it('fails closed when the journal binding or its permissions were tampered with', async () => {
  const target = await file('state/desktop/7.json');
  const id = journal();
  const plan = await store().preflight(id, [target]);
  await store().begin(plan);
  await plan.close();
  const stage = path.join(state, 'desktop', `${STAGE_PREFIX}${id}`);
  const binding = path.join(stage, 'binding.json');
  const saved = JSON.parse(await fs.readFile(binding, 'utf8'));

  await fs.writeFile(binding, JSON.stringify({ ...saved, journal: journal() }), { mode: 0o600 });
  expect(await code(store().erase(id, [target]))).toBe('stage-conflict');
  expect(await fs.readFile(target, 'utf8')).toBe('old preference');

  await fs.writeFile(binding, JSON.stringify(saved), { mode: 0o600 });
  await fs.chmod(binding, 0o644);
  expect(await code(store().erase(id, [target]))).toBe('stage-conflict');
  expect(await fs.readFile(target, 'utf8')).toBe('old preference');
});

it('fails closed when a resumed stage is missing its binding', async () => {
  const target = await file('state/desktop/7.json');
  const id = journal();
  const plan = await store().preflight(id, [target]);
  await store().begin(plan);
  await plan.close();
  const stage = path.join(state, 'desktop', `${STAGE_PREFIX}${id}`);
  await fs.writeFile(path.join(stage, '7.json'), 'staged', { mode: 0o600 });
  await fs.unlink(path.join(stage, 'binding.json'));
  expect(await code(store().erase(id, [target]))).toBe('stage-conflict');
  expect(await fs.readFile(target, 'utf8')).toBe('old preference');
});

it.skipIf(process.platform !== 'linux')('anchors moves to the pinned inode when the shared parent path is replaced', async () => {
  const parent = path.join(state, 'desktop');
  await file('state/desktop/7.json');
  const pinned = await PinnedDirectory.open(parent);
  const stagePath = path.join(parent, `${STAGE_PREFIX}${journal()}`);
  await fs.mkdir(stagePath, { mode: 0o700 });
  const stage = await PinnedDirectory.open(stagePath, { private: true });
  try {
    await fs.rename(parent, `${parent}-moved`);
    await fs.mkdir(parent, { mode: 0o700 });
    await fs.writeFile(path.join(parent, '7.json'), 'attacker replacement', { mode: 0o600 });
    await pinned.renameInto(stage, '7.json', '7.json');
  } finally {
    await pinned.close();
    await stage.close();
  }
  expect(await fs.readFile(path.join(parent, '7.json'), 'utf8')).toBe('attacker replacement');
  expect(await fs.readdir(path.join(`${parent}-moved`))).toEqual([path.basename(stagePath)]);
  expect(await fs.readFile(path.join(`${parent}-moved`, path.basename(stagePath), '7.json'), 'utf8')).toBe('old preference');
});

it.skipIf(process.platform === 'linux')('fails closed without a pinned descriptor root instead of using path renames', async () => {
  const target = await file('state/desktop/7.json');
  const plain = new ResetPreferenceStore({ dataDir: root });
  expect(await code(plain.erase(journal(), [target]))).toBe('unavailable');
  expect(await fs.readFile(target, 'utf8')).toBe('old preference');
  expect(await stages(path.join(state, 'desktop'))).toEqual([]);
});
