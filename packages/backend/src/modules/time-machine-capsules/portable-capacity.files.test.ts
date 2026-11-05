import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { portablePointFixture } from './portable-point.fixture';
import { stabilizeDarwinFixtureCreation } from '../system-backups/darwin-files.fixture';
let root: string;
let restore: () => void;
beforeEach(async () => {
  if (!process.env.TMPDIR) throw new Error('Project-scoped TMPDIR required');
  root = await fs.realpath(await fs.mkdtemp(path.join(process.env.TMPDIR, 'portable-capacity-')));
  restore = stabilizeDarwinFixtureCreation(() => root);
});
afterEach(async () => {
  vi.restoreAllMocks();
  restore();
  await fs.rm(root, { recursive: true, force: true });
});
it('checks the backup destination filesystem even when the container data root reports enough space', async () => {
  const fixture = await portablePointFixture(root);
  const actual = await fs.statfs(fixture.destinationRoot, { bigint: true });
  const backupRoot = path.join(fixture.destinationRoot, 'backups/time-machine');
  await fs.mkdir(backupRoot, { recursive: true, mode: 0o700 });
  vi.spyOn(fs, 'statfs').mockImplementation((async (filename: unknown) => ({
    ...actual,
    bavail: String(filename) === backupRoot ? 0n : 1024n ** 4n,
  })) as typeof fs.statfs);
  try {
    await expect(fixture.destination.importPortablePoint(8, fixture.token, new AbortController().signal)).rejects.toThrow();
    expect(await fixture.destination.list()).toEqual([]);
    await expect(fs.stat(path.join(backupRoot, 'keys/master-v1.key'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await fixture.opened.dispose();
  }
});
