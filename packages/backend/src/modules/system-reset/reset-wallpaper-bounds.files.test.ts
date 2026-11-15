import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ResetPreferenceStore, STAGE_PREFIX } from './reset-preference-store';
import { ResetState, type ResetJournal } from './reset-state';

const MiB = 1024 * 1024;
let root: string;
const descriptorRoot = (_fd: number, directory: string) => directory;
const preferences = (rename?: (from: string, to: string) => Promise<void>) => new ResetPreferenceStore({ dataDir: root, descriptorRoot, rename });
const legacy = () => new ResetState(root, { readMounts: async () => `36 35 98:0 / ${root} rw - ext4 /dev/sda1 rw\n`, descriptorRoot });
const journal = (): ResetJournal => ({
  version: 1,
  id: randomUUID(),
  controller: 'fixture',
  accounts: 'keep',
  users: [7],
  phase: 'prepared',
  createdAt: 1,
});

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-reset-wallpaper-')));
  await fs.mkdir(path.join(root, 'state'), { mode: 0o700 });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

async function sized(relative: string, bytes: number) {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const file = await fs.open(target, 'wx', 0o600);
  try {
    await file.truncate(bytes);
  } finally {
    await file.close();
  }
  return target;
}

it('erases both wallpaper generations at the upload limit through pinned staging', async () => {
  const targets = await Promise.all(['state/wallpapers/7.image', 'state/wallpapers/7.image.saved'].map((name) => sized(name, 32 * MiB)));
  const kept = await sized('state/wallpapers/8.image', 32 * MiB);
  await preferences().erase(randomUUID(), targets);
  for (const target of targets) await expect(fs.lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await fs.stat(kept)).size).toBe(32 * MiB);
  expect(await fs.readdir(path.dirname(kept))).toEqual(['8.image']);
});

it('erases both wallpaper generations at the upload limit through legacy indexed staging', async () => {
  const targets = await Promise.all(['state/wallpapers/7.image', 'state/wallpapers/7.image.saved'].map((name) => sized(name, 32 * MiB)));
  const value = journal();
  await legacy().preflight(value);
  await legacy().erasePreferences(value);
  for (const target of targets) await expect(fs.lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['7.image', '7.image.saved'])('rejects a wallpaper above the upload limit before mutation: %s', async (name) => {
  const target = await sized(`state/wallpapers/${name}`, 32 * MiB + 1);
  await expect(preferences().erase(randomUUID(), [target])).rejects.toMatchObject({ code: 'unsafe' });
  await expect(legacy().preflight(journal())).rejects.toThrow('local review');
  expect((await fs.stat(target)).size).toBe(32 * MiB + 1);
  expect(await fs.readdir(path.dirname(target))).toEqual([name]);
});

it.each([
  'state/desktop/7.json',
  'state/theme-packs/7/asset.image',
  'state/wallpapers/not-an-account.image',
  'state/wallpapers/07.image',
  'state/wallpapers/9007199254740992.image',
  'state/wallpapers/7.image/child',
])('keeps the ordinary limit outside exact account wallpaper files: %s', async (relative) => {
  const target = await sized(relative, 8 * MiB + 1);
  const selected = relative.endsWith('/child')
    ? path.dirname(target)
    : relative.includes('theme-packs')
      ? path.join(root, 'state/theme-packs/7')
      : target;
  await expect(preferences().erase(randomUUID(), [selected])).rejects.toMatchObject({ code: 'unsafe' });
  expect((await fs.stat(target)).size).toBe(8 * MiB + 1);
});

it('resumes a moved 32 MiB wallpaper using its logical target limit', async () => {
  const target = await sized('state/wallpapers/7.image', 32 * MiB);
  const id = randomUUID();
  await expect(
    preferences(async (from, to) => {
      await fs.rename(from, to);
      throw Object.assign(new Error('fixture crash after rename'), { code: 'EIO' });
    }).erase(id, [target]),
  ).rejects.toMatchObject({ code: 'rename-failed' });
  const staged = path.join(path.dirname(target), `${STAGE_PREFIX}${id}`, path.basename(target));
  expect((await fs.stat(staged)).size).toBe(32 * MiB);
  await preferences().erase(id, [target]);
  await expect(fs.lstat(staged)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('rejects a staged wallpaper grown beyond its limit and retains the recovery binding', async () => {
  const target = await sized('state/wallpapers/7.image', 32 * MiB);
  const id = randomUUID();
  await expect(
    preferences(async (from, to) => {
      await fs.rename(from, to);
      throw Object.assign(new Error('fixture crash'), { code: 'EIO' });
    }).erase(id, [target]),
  ).rejects.toMatchObject({ code: 'rename-failed' });
  const stage = path.join(path.dirname(target), `${STAGE_PREFIX}${id}`);
  await fs.truncate(path.join(stage, '7.image'), 32 * MiB + 1);
  await expect(preferences().erase(id, [target])).rejects.toMatchObject({ code: 'unsafe' });
  expect((await fs.stat(path.join(stage, '7.image'))).size).toBe(32 * MiB + 1);
  expect(await fs.readdir(stage)).toEqual(['7.image', 'binding.json']);
});

it('rechecks a live wallpaper grown after preflight before moving it', async () => {
  const target = await sized('state/wallpapers/7.image', 32 * MiB);
  const store = preferences();
  const plan = await store.preflight(randomUUID(), [target]);
  try {
    await store.begin(plan);
    await fs.truncate(target, 32 * MiB + 1);
    await expect(store.commit(plan)).rejects.toMatchObject({ code: 'unsafe' });
    expect((await fs.stat(target)).size).toBe(32 * MiB + 1);
  } finally {
    await plan.close();
  }
});

it('resumes legacy indexed wallpaper staging with the original target limit', async () => {
  const value = journal();
  const relative = 'wallpapers/7.image.saved';
  const index = legacy().targets(value).indexOf(relative);
  expect(index).toBeGreaterThanOrEqual(0);
  const staged = await sized(`state/orbis-reset/${value.id}/${index}`, 32 * MiB);
  await legacy().erasePreferences(value);
  await expect(fs.lstat(staged)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('keeps the ordinary limit for a legacy staged non-wallpaper', async () => {
  const value = journal();
  const index = legacy().targets(value).indexOf('desktop/7.json');
  const staged = await sized(`state/orbis-reset/${value.id}/${index}`, 8 * MiB + 1);
  await expect(legacy().erasePreferences(value)).rejects.toThrow('local review');
  expect((await fs.stat(staged)).size).toBe(8 * MiB + 1);
});

it('does not authorize a noncanonical legacy stage alias as a wallpaper', async () => {
  const value = journal();
  const index = legacy().targets(value).indexOf('wallpapers/7.image');
  const staged = await sized(`state/orbis-reset/${value.id}/0${index}`, 8 * MiB + 1);
  await expect(legacy().erasePreferences(value)).rejects.toThrow('local review');
  expect((await fs.stat(staged)).size).toBe(8 * MiB + 1);
});
