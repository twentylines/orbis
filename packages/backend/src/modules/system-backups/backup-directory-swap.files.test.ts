import fs from 'node:fs/promises';
import { watch, constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BackupDirectorySwap } from './backup-directory-swap';
import { BackupRequirementError } from './backup-files';

let directory: string;
beforeEach(async () => {
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-directory-swap-')));
  await fs.chmod(directory, 0o700);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

const signal = () => new AbortController().signal;
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const interrupted = () => Object.assign(new Error('Disposable rename interruption'), { code: 'EIO' });

async function watchedIdentity(root: string) {
  const entries: unknown[] = [];
  const visit = async (file: string) => {
    const stat = await fs.lstat(file, { bigint: true });
    entries.push({
      name: path.relative(root, file),
      device: String(stat.dev),
      inode: String(stat.ino),
      changed: String(stat.ctimeNs),
      modified: String(stat.mtimeNs),
      uid: String(stat.uid),
      gid: String(stat.gid),
      mode: String(stat.mode),
      ...(stat.isFile() ? { sha256: hash(await fs.readFile(file)) } : {}),
    });
    if (stat.isDirectory()) for (const name of (await fs.readdir(file)).sort()) await visit(path.join(file, name));
  };
  await visit(root);
  return entries;
}

it.each(['commit', 'rollback', 'discard'] as const)('preserved plans keep live identity and file watches intact during %s', async (outcome) => {
  const root = path.join(directory, 'watched-traefik');
  const journal = path.join(directory, 'private-plan');
  await fs.mkdir(path.join(root, 'tls'), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(root, 'dynamic.json'), 'destination routes');
  await fs.writeFile(path.join(root, 'tls', 'cert.pem'), 'destination certificate');
  const before = await watchedIdentity(root);
  const events: { file: string; event: string; name: string | undefined }[] = [];
  const watchers = [root, path.join(root, 'dynamic.json'), path.join(root, 'tls'), path.join(root, 'tls', 'cert.pem')].map((file) =>
    watch(file, (event, name) => events.push({ file: path.relative(root, file), event, name: name?.toString() })),
  );
  const mutations = ['mkdir', 'rename', 'rm', 'chmod', 'chown', 'utimes', 'writeFile'] as const;
  const observers = mutations.map((method) => vi.spyOn(fs, method));
  const opened = vi.spyOn(fs, 'open');
  try {
    const swap = await BackupDirectorySwap.create({ id: randomUUID(), root, journal, preserve: true });
    expect(swap.incomingDirectory).toBe(path.join(journal, 'incoming'));
    await fs.writeFile(path.join(swap.incomingDirectory, 'dynamic.json'), 'verified destination staging copy');
    await swap.seal(signal());
    if (outcome === 'discard') await swap.discardPrepared();
    else {
      await swap.promote(signal());
      if (outcome === 'commit') {
        await swap.commit();
        await swap.commit();
      } else {
        await swap.rollback();
        await swap.rollback();
      }
      expect((await swap.retainedDirectories()).directories).toEqual([]);
      await swap.cleanup();
      await swap.cleanup();
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(await watchedIdentity(root)).toEqual(before);
    const insideRoot = (value: unknown) => typeof value === 'string' && (value === root || value.startsWith(`${root}/`));
    for (const observer of observers) expect(observer.mock.calls.some((args) => args.some(insideRoot))).toBe(false);
    expect(
      opened.mock.calls.some(
        ([file, flags]) =>
          insideRoot(file) &&
          (typeof flags === 'number'
            ? !!(flags & (constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC | constants.O_APPEND))
            : flags !== 'r'),
      ),
    ).toBe(false);
    // macOS may deliver older directory-creation events; live inode identity and file watches remain observable.
    expect(events.filter((event) => ['dynamic.json', 'tls/cert.pem'].includes(event.file))).toEqual([]);
    const prior = events.length;
    await fs.appendFile(path.join(root, 'tls', 'cert.pem'), '-watch-probe');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events.slice(prior).some((event) => event.file === 'tls/cert.pem' && event.event === 'change')).toBe(true);
  } finally {
    for (const watcher of watchers) watcher.close();
  }
  expect((await fs.readdir(root)).sort()).toEqual(['dynamic.json', 'tls']);
  await expect(fs.lstat(path.join(journal, 'incoming'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['version', 'mode', 'incoming', 'staging', 'live-root'] as const)(
  'refuses forged preserved plan %s without touching live data',
  async (change) => {
    const root = path.join(directory, 'preserved-root');
    const journal = path.join(directory, 'private-plan');
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, 'keep'), 'protected');
    await BackupDirectorySwap.create({ id: randomUUID(), root, journal, preserve: true });
    const file = path.join(journal, 'swap.json');
    const plan = JSON.parse(await fs.readFile(file, 'utf8'));
    if (change === 'version') plan.version = 3;
    if (change === 'mode') plan.mode = 'swap';
    if (change === 'incoming') plan.incoming = ['keep'];
    if (change === 'staging') plan.staging.inode = '999999';
    if (change === 'live-root') {
      await fs.rename(root, `${root}-original`);
      await fs.mkdir(root);
      await fs.writeFile(path.join(root, 'keep'), 'protected');
    }
    await fs.writeFile(file, JSON.stringify(plan));
    await expect(BackupDirectorySwap.open(journal)).rejects.toThrow();
    expect(await fs.readFile(path.join(root, 'keep'), 'utf8')).toBe('protected');
  },
);

it('refuses deletion of a replaced private preservation stage', async () => {
  const root = path.join(directory, 'preserved-root');
  const journal = path.join(directory, 'private-plan');
  await fs.mkdir(root);
  const swap = await BackupDirectorySwap.create({ id: randomUUID(), root, journal, preserve: true });
  await swap.seal(signal());
  await swap.promote(signal());
  await swap.commit();
  await fs.rename(swap.incomingDirectory, `${swap.incomingDirectory}-original`);
  await fs.mkdir(swap.incomingDirectory, { mode: 0o700 });
  await fs.writeFile(path.join(swap.incomingDirectory, 'unrelated'), 'do not delete');
  await expect(swap.cleanup()).rejects.toThrow();
  expect(await fs.readFile(path.join(swap.incomingDirectory, 'unrelated'), 'utf8')).toBe('do not delete');
});

it('preserves reserved-looking names inside app data while keeping the top-level generation namespace private', async () => {
  const root = path.join(directory, 'root');
  await fs.mkdir(root, { mode: 0o700 });
  const swap = await BackupDirectorySwap.create({ id: randomUUID(), root, journal: path.join(directory, 'journal') });
  await fs.mkdir(path.join(swap.incomingDirectory, 'app'));
  await fs.writeFile(path.join(swap.incomingDirectory, 'app', '.orbis-restore-user-file'), 'app data');
  await swap.seal(signal());
  await swap.promote(signal());
  await swap.commit();
  await swap.commit();
  expect(await fs.readFile(path.join(root, 'app', '.orbis-restore-user-file'), 'utf8')).toBe('app data');
});
async function identity(file: string) {
  const stat = await fs.lstat(file, { bigint: true });
  return { device: String(stat.dev), inode: String(stat.ino), uid: Number(stat.uid), gid: Number(stat.gid), mode: Number(stat.mode & 0o777n) };
}
async function tree(root: string) {
  const entries: { name: string; type: string; identity: Awaited<ReturnType<typeof identity>>; sha256?: string }[] = [];
  const visit = async (current: string) => {
    for (const name of (await fs.readdir(current)).sort()) {
      if (current === root && name.startsWith('.orbis-restore-')) continue;
      const file = path.join(current, name);
      const stat = await fs.lstat(file);
      entries.push({
        name: path.relative(root, file),
        type: stat.isDirectory() ? 'directory' : 'file',
        identity: await identity(file),
        ...(stat.isFile() ? { sha256: hash(await fs.readFile(file)) } : {}),
      });
      if (stat.isDirectory()) await visit(file);
    }
  };
  await visit(root);
  return entries;
}
async function fixture(populated = true) {
  const root = path.join(directory, 'root');
  const journal = path.join(directory, 'journal');
  const id = randomUUID();
  await fs.mkdir(root, { mode: 0o750 });
  if (populated) {
    await fs.writeFile(path.join(root, 'common.txt'), 'old common', { mode: 0o640 });
    await fs.writeFile(path.join(root, 'old-only.txt'), 'old retained data', { mode: 0o600 });
    await fs.mkdir(path.join(root, 'old-dir'), { mode: 0o750 });
    await fs.writeFile(path.join(root, 'old-dir', 'nested'), 'old nested', { mode: 0o600 });
  }
  const before = await tree(root);
  const rootIdentity = await identity(root);
  const swap = await BackupDirectorySwap.create({ id, root, journal });
  return {
    root,
    journal,
    id,
    swap,
    before,
    rootIdentity,
    incoming: swap.incomingDirectory,
    previous: path.join(root, `.orbis-restore-${id}.previous`),
    plan: path.join(journal, 'swap.json'),
    wal: path.join(journal, 'moves.ndjson'),
  };
}
async function stage(test: Awaited<ReturnType<typeof fixture>>) {
  await fs.writeFile(path.join(test.incoming, 'common.txt'), 'new common', { mode: 0o600 });
  await fs.writeFile(path.join(test.incoming, 'new-only.txt'), 'new restored data', { mode: 0o640 });
  await fs.mkdir(path.join(test.incoming, 'new-dir'), { mode: 0o700 });
  await fs.writeFile(path.join(test.incoming, 'new-dir', 'nested'), 'new nested', { mode: 0o600 });
  await test.swap.seal(signal());
}
async function restored(test: Awaited<ReturnType<typeof fixture>>) {
  expect(await identity(test.root)).toEqual(test.rootIdentity);
  expect(await tree(test.root)).toEqual(test.before);
}
async function recoverTwice(test: Awaited<ReturnType<typeof fixture>>) {
  await (await BackupDirectorySwap.open(test.journal)).rollback();
  await (await BackupDirectorySwap.open(test.journal)).rollback();
  await restored(test);
}
function dataRenames(
  test: Awaited<ReturnType<typeof fixture>>,
  action: (index: number, from: string, to: string, rename: () => Promise<void>) => Promise<void>,
) {
  const actual = fs.rename.bind(fs);
  let count = 0;
  const spy = vi.spyOn(fs, 'rename').mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
    const from = String(args[0]);
    const to = String(args[1]);
    if (!from.startsWith(`${test.root}${path.sep}`) || !to.startsWith(`${test.root}${path.sep}`)) return actual(...args);
    const index = count++;
    return action(index, from, to, () => actual(...args));
  });
  return { spy, count: () => count };
}

it('promotes children while preserving the mount-root identity and can restore original nodes and attributes', async () => {
  const test = await fixture();
  await stage(test);
  expect((await fs.stat(test.incoming)).mode & 0o077).toBe(0);
  expect((await fs.stat(test.previous)).mode & 0o077).toBe(0);
  expect((await fs.stat(test.plan)).mode & 0o077).toBe(0);
  expect((await fs.stat(test.wal)).mode & 0o077).toBe(0);
  await test.swap.promote(signal());
  expect(await identity(test.root)).toEqual(test.rootIdentity);
  expect(await fs.readFile(path.join(test.root, 'common.txt'), 'utf8')).toBe('new common');
  expect(await fs.readFile(path.join(test.root, 'new-dir', 'nested'), 'utf8')).toBe('new nested');
  await expect(fs.stat(path.join(test.root, 'old-only.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  await fs.chmod(test.root, 0o700);
  await recoverTwice(test);
});

it('records exact source dev/inode identities before each move', async () => {
  const test = await fixture();
  await stage(test);
  const expected = new Map<string, { device: string; inode: string }>();
  for (const [kind, root] of [
    ['backup', test.root],
    ['promote', test.incoming],
  ] as const) {
    for (const name of await fs.readdir(root)) {
      if (name.startsWith('.orbis-restore-')) continue;
      const { device, inode } = await identity(path.join(root, name));
      expected.set(`${kind}/${name}`, { device, inode });
    }
  }
  await test.swap.promote(signal());
  const intents = (await fs.readFile(test.wal, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { kind: string; name: string; device: string; inode: string });
  expect(intents).toHaveLength(expected.size);
  for (const item of intents) {
    expect(Object.keys(item).sort()).toEqual(['device', 'inode', 'kind', 'name']);
    expect({ device: item.device, inode: item.inode }).toEqual(expected.get(`${item.kind}/${item.name}`));
  }
});

it('commits only a complete promotion and forbids rollback after reopening', async () => {
  const test = await fixture();
  await stage(test);
  await expect(test.swap.commit()).rejects.toBeInstanceOf(BackupRequirementError);
  await test.swap.promote(signal());
  await test.swap.commit();
  const promoted = await tree(test.root);
  await expect((await BackupDirectorySwap.open(test.journal)).rollback()).rejects.toBeInstanceOf(BackupRequirementError);
  expect(await tree(test.root)).toEqual(promoted);
  expect(await identity(test.root)).toEqual(test.rootIdentity);
});

it('keeps rollback available after a commit-plan temporary write fails', async () => {
  const test = await fixture();
  await stage(test);
  await test.swap.promote(signal());
  const actualOpen = fs.open.bind(fs);
  let injected = false;
  const opening = vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const file = await actualOpen(...args);
    if (typeof args[0] === 'string' && path.dirname(args[0]) === test.journal && args[0].endsWith('.tmp')) {
      const actualWrite = file.writeFile.bind(file);
      vi.spyOn(file, 'writeFile').mockImplementationOnce(async (value) => {
        if (typeof value === 'string' && JSON.parse(value).phase === 'committed') {
          injected = true;
          await actualWrite(value.slice(0, 20));
          throw interrupted();
        }
        return actualWrite(value);
      });
    }
    return file;
  });
  await expect(test.swap.commit()).rejects.toMatchObject({ code: 'EIO' });
  opening.mockRestore();
  expect(injected).toBe(true);
  expect(JSON.parse(await fs.readFile(test.plan, 'utf8')).phase).toBe('promoting');
  await test.swap.rollback();
  await recoverTwice(test);
});

it('does not let a stale instance roll back a published commit after directory sync fails', async () => {
  const test = await fixture();
  await stage(test);
  await test.swap.promote(signal());
  const promoted = await tree(test.root);
  const actualRename = fs.rename.bind(fs);
  const actualOpen = fs.open.bind(fs);
  let published = false;
  const renaming = vi.spyOn(fs, 'rename').mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
    const committing = args[1] === test.plan && JSON.parse(await fs.readFile(args[0], 'utf8')).phase === 'committed';
    await actualRename(...args);
    if (committing) published = true;
  });
  const opening = vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const file = await actualOpen(...args);
    if (published && args[0] === test.journal) vi.spyOn(file, 'sync').mockRejectedValueOnce(interrupted());
    return file;
  });
  await expect(test.swap.commit()).rejects.toMatchObject({ code: 'EIO' });
  opening.mockRestore();
  renaming.mockRestore();
  expect(published).toBe(true);
  expect(JSON.parse(await fs.readFile(test.plan, 'utf8')).phase).toBe('committed');
  await expect(test.swap.rollback()).rejects.toBeInstanceOf(BackupRequirementError);
  expect(await tree(test.root)).toEqual(promoted);
});

const interruptions = Array.from(
  { length: 6 },
  (_value, index) =>
    [
      ['before', index],
      ['after', index],
    ] as const,
).flat();
it.each(interruptions)('recovers promotion interrupted %s data rename %s', async (when, position) => {
  const test = await fixture();
  await stage(test);
  const moves = dataRenames(test, async (index, _from, _to, rename) => {
    if (index === position && when === 'before') throw interrupted();
    await rename();
    if (index === position && when === 'after') throw interrupted();
  });
  await expect(test.swap.promote(signal())).rejects.toMatchObject({ code: 'EIO' });
  expect(moves.count()).toBe(position + 1);
  moves.spy.mockRestore();
  await recoverTwice(test);
});

it.each(interruptions)('resumes rollback interrupted %s data rename %s', async (when, position) => {
  const test = await fixture();
  await stage(test);
  await test.swap.promote(signal());
  const moves = dataRenames(test, async (index, _from, _to, rename) => {
    if (index === position && when === 'before') throw interrupted();
    await rename();
    if (index === position && when === 'after') throw interrupted();
  });
  await expect(test.swap.rollback()).rejects.toMatchObject({ code: 'EIO' });
  expect(moves.count()).toBe(position + 1);
  moves.spy.mockRestore();
  await recoverTwice(test);
});

it.each([0, 2])('ignores the partial last WAL record before its rename, after %s completed moves', async (position) => {
  const test = await fixture();
  await stage(test);
  const actualOpen = fs.open.bind(fs);
  let writes = 0;
  const opening = vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const file = await actualOpen(...args);
    if (args[0] === test.wal) {
      const actualWrite = file.writeFile.bind(file);
      vi.spyOn(file, 'writeFile').mockImplementationOnce(async (value) => {
        if (writes++ === position) {
          if (typeof value !== 'string') throw new Error('Disposable WAL fixture expected text');
          await actualWrite(value.slice(0, 20));
          throw interrupted();
        }
        return actualWrite(value);
      });
    }
    return file;
  });
  const moves = dataRenames(test, async (_index, _from, _to, rename) => rename());
  await expect(test.swap.promote(signal())).rejects.toMatchObject({ code: 'EIO' });
  expect(moves.count()).toBe(position);
  opening.mockRestore();
  moves.spy.mockRestore();
  expect((await fs.readFile(test.wal, 'utf8')).endsWith('\n')).toBe(false);
  await recoverTwice(test);
});

it.each(['incoming', 'previous', 'wal'] as const)('recovers a partial create failure at %s', async (step) => {
  const root = path.join(directory, 'root');
  const journal = path.join(directory, 'journal');
  const id = randomUUID();
  await fs.mkdir(root, { mode: 0o750 });
  await fs.writeFile(path.join(root, 'original'), 'retain', { mode: 0o600 });
  const before = await tree(root);
  const rootId = await identity(root);
  if (step === 'wal') {
    const actualOpen = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (args[0] === path.join(journal, 'moves.ndjson')) throw interrupted();
      return actualOpen(...args);
    });
  } else {
    const actualMkdir = fs.mkdir.bind(fs);
    vi.spyOn(fs, 'mkdir').mockImplementation(async (...args: Parameters<typeof fs.mkdir>) => {
      if (args[0] === path.join(root, `.orbis-restore-${id}.${step}`)) throw interrupted();
      return actualMkdir(...args);
    });
  }
  await expect(BackupDirectorySwap.create({ id, root, journal })).rejects.toMatchObject({ code: 'EIO' });
  vi.restoreAllMocks();
  await (await BackupDirectorySwap.open(journal)).rollback();
  await (await BackupDirectorySwap.open(journal)).rollback();
  expect(await identity(root)).toEqual(rootId);
  expect(await tree(root)).toEqual(before);
});

it.each(['incoming', 'previous'] as const)('can reopen an interrupted rollback after partial creation of %s', async (step) => {
  const root = path.join(directory, 'root');
  const journal = path.join(directory, 'journal');
  const id = randomUUID();
  await fs.mkdir(root, { mode: 0o750 });
  await fs.writeFile(path.join(root, 'original'), 'retain', { mode: 0o600 });
  const before = await tree(root);
  const rootId = await identity(root);
  const actualMkdir = fs.mkdir.bind(fs);
  const creating = vi.spyOn(fs, 'mkdir').mockImplementation(async (...args: Parameters<typeof fs.mkdir>) => {
    if (args[0] === path.join(root, `.orbis-restore-${id}.${step}`)) throw interrupted();
    return actualMkdir(...args);
  });
  await expect(BackupDirectorySwap.create({ id, root, journal })).rejects.toMatchObject({ code: 'EIO' });
  creating.mockRestore();
  const recovering = await BackupDirectorySwap.open(journal);
  const actualChmod = fs.chmod.bind(fs);
  const changing = vi.spyOn(fs, 'chmod').mockImplementation(async (...args: Parameters<typeof fs.chmod>) => {
    if (args[0] === root) throw interrupted();
    return actualChmod(...args);
  });
  await expect(recovering.rollback()).rejects.toMatchObject({ code: 'EIO' });
  changing.mockRestore();
  await (await BackupDirectorySwap.open(journal)).rollback();
  await (await BackupDirectorySwap.open(journal)).rollback();
  expect(await identity(root)).toEqual(rootId);
  expect(await tree(root)).toEqual(before);
});

it('rejects normalized in-root journal aliases before creating any state', async () => {
  const root = path.join(directory, 'root');
  await fs.mkdir(root, { mode: 0o700 });
  const journal = path.join(root, 'journal');
  await expect(BackupDirectorySwap.create({ id: randomUUID(), root: `${root}/../root`, journal })).rejects.toBeInstanceOf(BackupRequirementError);
  expect(await fs.readdir(root)).toEqual([]);
  await expect(fs.stat(journal)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('refuses a replaced root inode without touching the replacement or the originals', async () => {
  const test = await fixture();
  await stage(test);
  const retained = path.join(directory, 'retained-root');
  await fs.rename(test.root, retained);
  await fs.mkdir(test.root, { mode: 0o700 });
  await fs.writeFile(path.join(test.root, 'foreign'), 'foreign target', { mode: 0o600 });
  const replacement = await tree(test.root);
  await expect(BackupDirectorySwap.open(test.journal)).rejects.toBeInstanceOf(BackupRequirementError);
  await expect(test.swap.rollback()).rejects.toBeInstanceOf(BackupRequirementError);
  expect(await tree(test.root)).toEqual(replacement);
  expect(await tree(retained)).toEqual(test.before);
});

it.each(['inode', 'device', 'unknown-key', 'mode', 'phase', 'traversal'] as const)('rejects untrusted plan metadata: %s', async (kind) => {
  const test = await fixture();
  await stage(test);
  const plan = JSON.parse(await fs.readFile(test.plan, 'utf8'));
  if (kind === 'inode') plan.inode = (BigInt(plan.inode) + 1n).toString();
  if (kind === 'device') plan.device = (BigInt(plan.device) + 1n).toString();
  if (kind === 'unknown-key') plan.unrecognized = true;
  if (kind === 'mode') plan.original.mode = 0o1000;
  if (kind === 'phase') plan.phase = 'unknown';
  if (kind === 'traversal') plan.incoming = ['../outside'];
  await fs.writeFile(test.plan, JSON.stringify(plan));
  await expect(BackupDirectorySwap.open(test.journal)).rejects.toBeInstanceOf(BackupRequirementError);
  await restored(test);
});

it.each(['plan-mode', 'incoming-mode', 'previous-mode'] as const)('rejects non-private transaction metadata: %s', async (kind) => {
  const test = await fixture();
  await stage(test);
  await fs.chmod(kind === 'plan-mode' ? test.plan : kind === 'incoming-mode' ? test.incoming : test.previous, 0o755);
  await expect(BackupDirectorySwap.open(test.journal)).rejects.toBeInstanceOf(BackupRequirementError);
  await restored(test);
});

it.each(['symlink', 'hardlink'] as const)('rejects a staged %s and preserves the linked target', async (kind) => {
  const test = await fixture();
  const outside = path.join(directory, 'outside');
  await fs.writeFile(outside, 'private fixture', { mode: 0o600 });
  const link = path.join(test.incoming, 'link');
  const original = hash(await fs.readFile(outside));
  if (kind === 'symlink') await fs.symlink(outside, link);
  else await fs.link(outside, link);
  await expect(test.swap.seal(signal())).rejects.toBeInstanceOf(BackupRequirementError);
  expect(hash(await fs.readFile(outside)) === original).toBe(true);
  await recoverTwice(test);
});

it('does not overwrite an external target created after original children were backed up', async () => {
  const test = await fixture();
  await stage(test);
  let backups = 0;
  const foreign = path.join(test.root, 'new-only.txt');
  const moves = dataRenames(test, async (_index, _from, to, rename) => {
    await rename();
    if (path.dirname(to) === test.previous && ++backups === 3) await fs.writeFile(foreign, 'external data', { mode: 0o600, flag: 'wx' });
  });
  await expect(test.swap.promote(signal())).rejects.toBeInstanceOf(BackupRequirementError);
  moves.spy.mockRestore();
  expect(await fs.readFile(foreign, 'utf8')).toBe('external data');
  await expect((await BackupDirectorySwap.open(test.journal)).rollback()).rejects.toBeInstanceOf(BackupRequirementError);
  expect(await fs.readFile(foreign, 'utf8')).toBe('external data');
});

it('refuses a WAL identity that no longer describes the backed-up node', async () => {
  const test = await fixture();
  await stage(test);
  const moves = dataRenames(test, async (_index, _from, _to, rename) => {
    await rename();
    throw interrupted();
  });
  await expect(test.swap.promote(signal())).rejects.toMatchObject({ code: 'EIO' });
  moves.spy.mockRestore();
  const intent = JSON.parse((await fs.readFile(test.wal, 'utf8')).trim()) as { name: string; inode: string };
  const retained = path.join(test.previous, intent.name);
  const original = await identity(retained);
  intent.inode = (BigInt(intent.inode) + 1n).toString();
  await fs.writeFile(test.wal, `${JSON.stringify(intent)}\n`);
  await expect((await BackupDirectorySwap.open(test.journal)).rollback()).rejects.toBeInstanceOf(BackupRequirementError);
  expect(await identity(retained)).toEqual(original);
});

it('honours cancellation during sealing and promotion, then permits rollback', async () => {
  const test = await fixture();
  await fs.writeFile(path.join(test.incoming, 'new'), 'new', { mode: 0o600 });
  await expect(test.swap.seal(AbortSignal.abort())).rejects.toThrow();
  await test.swap.seal(signal());
  const controller = new AbortController();
  const moves = dataRenames(test, async (_index, _from, _to, rename) => {
    await rename();
    controller.abort();
  });
  await expect(test.swap.promote(controller.signal)).rejects.toThrow();
  moves.spy.mockRestore();
  await recoverTwice(test);
});

it('honours an already-aborted seal even when the incoming directory is empty', async () => {
  const test = await fixture();
  await expect(test.swap.seal(AbortSignal.abort())).rejects.toThrow();
  await recoverTwice(test);
});

it('honours an already-aborted promotion even when both directories are empty', async () => {
  const test = await fixture(false);
  await test.swap.seal(signal());
  await expect(test.swap.promote(AbortSignal.abort())).rejects.toThrow();
  await recoverTwice(test);
});
