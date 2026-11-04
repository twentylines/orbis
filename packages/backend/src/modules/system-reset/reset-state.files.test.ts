import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ResetAuthorityError } from './reset-authority';
import { STAGE_PREFIX } from './reset-preference-store';
import { ResetState, type ResetJournal, type ResetStateOptions } from './reset-state';

const journal = (overrides: Partial<ResetJournal> = {}): ResetJournal => ({
  version: 1,
  id: randomUUID(),
  controller: os.hostname(),
  accounts: 'keep',
  users: [7],
  phase: 'prepared',
  createdAt: Date.now(),
  ...overrides,
});
const mountLine = (mount: string, fsType = 'ext4', source = '/dev/sda1') => `36 35 98:0 / ${mount} rw,relatime - ${fsType} ${source} rw`;
const mountTable = (...lines: string[]) => `${lines.join('\n')}\n`;
const authorityCode = (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (error: unknown) => (error instanceof ResetAuthorityError ? error.code : 'unexpected'),
  );
const stages = async (directory: string) => (await fs.readdir(directory)).filter((name) => name.startsWith(STAGE_PREFIX));

let root: string;
let authority: string;
let legacy: string;
let mounts: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-reset-state-')));
  await fs.mkdir(path.join(root, 'state'), { mode: 0o700 });
  authority = path.join(root, 'orbis-reset');
  legacy = path.join(root, 'state/orbis-reset');
  mounts = mountTable(mountLine(root));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const seams = (extra: ResetStateOptions = {}): ResetStateOptions => ({
  readMounts: async () => mounts,
  descriptorRoot: (_fd, directory) => directory,
  ...extra,
});
const store = (extra: ResetStateOptions = {}) => new ResetState(root, seams(extra));
async function dedicated(extra: ResetStateOptions = {}) {
  await fs.mkdir(authority, { mode: 0o700 });
  mounts = mountTable(mountLine(root), mountLine(authority));
  return store(extra);
}
async function file(relative: string, content = 'old preference') {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.writeFile(target, content, { mode: 0o600 });
  return target;
}

it('keeps the strict legacy journal when no dedicated mount is verified', async () => {
  const legacyState = store();
  expect(await legacyState.read()).toBeNull();
  const pending = journal();
  await legacyState.save(pending);
  expect(await legacyState.read()).toEqual(pending);
  expect(await legacyState.active()).toEqual(pending);
  expect(JSON.parse(await fs.readFile(path.join(legacy, 'active.json'), 'utf8'))).toEqual(pending);
  expect((await fs.lstat(path.join(legacy, 'active.json'))).mode & 0o777).toBe(0o600);
  expect(await legacyState.targets(pending)).toEqual([
    'desktop/7.json',
    'onboarding/7.json',
    'theme-settings/7.json',
    'theme-packs/7',
    'wallpapers/7.image',
    'wallpapers/7.image.saved',
    '.orbis-onboarding-origin.json',
  ]);
  await expect(fs.lstat(authority)).rejects.toMatchObject({ code: 'ENOENT' });
  const release = await legacyState.acquireLease();
  await expect(legacyState.acquireLease()).rejects.toThrow('locked');
  await release();
});

it.skipIf(process.platform === 'linux')('keeps the legacy layout outside Linux even when a directory appears at the authority path', async () => {
  await fs.mkdir(authority, { mode: 0o700 });
  const legacyState = new ResetState(root);
  const pending = journal();
  await legacyState.save(pending);
  expect(await new ResetState(root).read()).toEqual(pending);
  expect(await fs.readdir(authority)).toEqual([]);
});

it('still refuses a legacy reset journal below a group-writable state root', async () => {
  await fs.chmod(path.join(root, 'state'), 0o777);
  expect(await store().read()).toBeNull();
  await fs.mkdir(legacy, { mode: 0o700 });
  await expect(store().read()).rejects.toThrow('Reset storage needs local review');
});

it('uses a verified dedicated mount for the journal, lease and recovery state', async () => {
  const dedicatedState = await dedicated();
  expect(await dedicatedState.read()).toBeNull();
  const pending = journal();
  await dedicatedState.save(pending);
  expect(await dedicatedState.read()).toEqual(pending);
  expect(await dedicatedState.active()).toEqual(pending);
  expect(JSON.parse(await fs.readFile(path.join(authority, 'active.json'), 'utf8'))).toEqual(pending);
  await expect(fs.lstat(legacy)).rejects.toMatchObject({ code: 'ENOENT' });

  const release = await dedicatedState.acquireLease();
  await expect(dedicatedState.acquireLease()).rejects.toThrow('Reset storage needs local review');
  await release();

  // A recreated process instance reads the same durable journal and never the legacy path.
  expect(await store().read()).toEqual(pending);
  await store().save({ ...pending, phase: 'complete' });
  expect(await store().active()).toEqual({ ...pending, phase: 'complete' });
  const held = await store().acquireLease();
  expect(await store().active()).toEqual({ ...pending, phase: 'recovery' });
  await held();
  expect(await store().active()).toEqual({ ...pending, phase: 'complete' });
});

it('fails closed on unreadable mount discovery instead of falling back to legacy', async () => {
  const unresolved = new ResetState(root, { readMounts: async () => null });
  expect(await authorityCode(unresolved.read())).toBe('mounts-unavailable');
  expect(await authorityCode(unresolved.save(journal()))).toBe('mounts-unavailable');
  await expect(fs.lstat(legacy)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('fails closed when the authority path is not an actual mount point', async () => {
  await fs.mkdir(authority, { mode: 0o700 });
  expect(await authorityCode(store().read())).toBe('not-mounted');
  expect(await authorityCode(store().save(journal()))).toBe('not-mounted');
  expect(await fs.readdir(authority)).toEqual([]);
  await expect(fs.lstat(legacy)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('fails closed for ephemeral mounts and for a declared mount without a directory', async () => {
  await fs.mkdir(authority, { mode: 0o700 });
  mounts = mountTable(mountLine(root), mountLine(authority, 'tmpfs'));
  expect(await authorityCode(store().read())).toBe('ephemeral-mount');
  await fs.rmdir(authority);
  mounts = mountTable(mountLine(root), mountLine(authority));
  expect(await authorityCode(store().read())).toBe('authority-unsafe');
  await expect(fs.lstat(authority)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('fails closed when the dedicated mount would hide an unfinished legacy journal', async () => {
  const pending = journal({ phase: 'preferences' });
  await store().save(pending);
  const dedicatedState = await dedicated();
  expect(await authorityCode(dedicatedState.read())).toBe('legacy-journal');
  expect(await authorityCode(dedicatedState.save(journal()))).toBe('legacy-journal');
  expect(JSON.parse(await fs.readFile(path.join(legacy, 'active.json'), 'utf8'))).toEqual(pending);
});

it('migrates after a completed legacy reset and preserves its empty staging evidence', async () => {
  const complete = journal({ phase: 'complete' });
  await store().save(complete);
  const stage = path.join(legacy, complete.id);
  await fs.mkdir(stage, { mode: 0o700 });

  const dedicatedState = await dedicated();
  expect(await dedicatedState.read()).toBeNull();
  expect(await dedicatedState.active()).toBeNull();
  expect(JSON.parse(await fs.readFile(path.join(legacy, 'active.json'), 'utf8'))).toEqual(complete);
  expect(await fs.readdir(stage)).toEqual([]);

  const next = journal();
  await dedicatedState.save(next);
  expect(await store().read()).toEqual(next);
  expect(JSON.parse(await fs.readFile(path.join(legacy, 'active.json'), 'utf8'))).toEqual(complete);
});

it('preflights and erases the journal preferences through the dedicated store', async () => {
  const dedicatedState = await dedicated();
  const pending = journal();
  const target = await file('state/desktop/7.json');
  const kept = await file('state/desktop/8.json');
  await dedicatedState.preflight(pending);
  expect((await fs.readdir(path.join(root, 'state/desktop'))).sort()).toEqual(['7.json', '8.json']);
  await dedicatedState.save(pending);
  await dedicatedState.erasePreferences(pending);
  await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await fs.readFile(kept, 'utf8')).toBe('old preference');
  expect(await stages(path.join(root, 'state/desktop'))).toEqual([]);
  // Staging never crosses into the dedicated authority mount.
  expect(await fs.readdir(authority)).toEqual(['active.json']);
});

it('refuses to stage preferences before this journal is durable in the authority', async () => {
  const dedicatedState = await dedicated();
  const pending = journal();
  const target = await file('state/desktop/7.json');
  await expect(dedicatedState.erasePreferences(pending)).rejects.toThrow('Reset storage needs local review');
  await dedicatedState.save(journal());
  await expect(dedicatedState.erasePreferences(pending)).rejects.toThrow('Reset storage needs local review');
  expect(await fs.readFile(target, 'utf8')).toBe('old preference');
  expect(await stages(path.dirname(target))).toEqual([]);
});

it('resumes an interrupted preference erase from the journal-bound stage', async () => {
  const pending = journal();
  const first = await file('state/desktop/7.json');
  const second = await file('state/wallpapers/7.image');
  const interrupted = await dedicated({
    rename: async (from, to) => {
      if (from.endsWith('7.image')) throw Object.assign(new Error('fixture interruption'), { code: 'EIO' });
      await fs.rename(from, to);
    },
  });
  await interrupted.save(pending);
  await expect(interrupted.erasePreferences(pending)).rejects.toThrow('Reset preferences need local review');
  await expect(fs.stat(first)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await fs.readFile(second, 'utf8')).toBe('old preference');
  expect(await stages(path.join(root, 'state/wallpapers'))).toEqual([`${STAGE_PREFIX}${pending.id}`]);

  await store().erasePreferences(pending);
  await expect(fs.stat(second)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await stages(path.join(root, 'state/wallpapers'))).toEqual([]);
});

it('fails closed when a preference is recreated during recovery', async () => {
  const pending = journal();
  const image = await file('state/wallpapers/7.image');
  const saved = await file('state/wallpapers/7.image.saved');
  const interrupted = await dedicated({
    rename: async (from, to) => {
      await fs.rename(from, to);
      if (from.endsWith('7.image')) throw Object.assign(new Error('fixture interruption'), { code: 'EIO' });
    },
  });
  await interrupted.save(pending);
  await expect(interrupted.erasePreferences(pending)).rejects.toThrow('Reset preferences need local review');
  await fs.writeFile(image, 'recreated during reset', { mode: 0o600 });

  await expect(store().erasePreferences(pending)).rejects.toThrow('Reset preferences need local review');
  expect(await fs.readFile(image, 'utf8')).toBe('recreated during reset');
  expect(await fs.readFile(saved, 'utf8')).toBe('old preference');
  expect((await fs.readdir(path.join(root, 'state/wallpapers', `${STAGE_PREFIX}${pending.id}`))).sort()).toContain('7.image');
});

it('changes no permissions when a preference parent is shared', async () => {
  const dedicatedState = await dedicated();
  const pending = journal();
  const parent = path.join(root, 'state/desktop');
  await file('state/desktop/7.json');
  await fs.chmod(parent, 0o777);
  await expect(dedicatedState.preflight(pending)).rejects.toThrow('Reset preferences need local review');
  expect((await fs.lstat(parent)).mode & 0o777).toBe(0o777);
  expect(await dedicatedState.read()).toBeNull();
  expect(await stages(parent)).toEqual([]);
});
