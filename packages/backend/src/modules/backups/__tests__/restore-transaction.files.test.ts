import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { createAppUrn } from '@/common/helpers/app-helpers';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import type { LoggerService } from '@/core/logger/logger.service';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RestoreTransaction } from '../restore-transaction';

const groups = ['app-data', 'app', 'user-config'] as const;
const urn = createAppUrn('demo', 'store');

describe('Restore transaction real filesystem and process interruptions', () => {
  let root: string;
  let locations: Record<(typeof groups)[number], string>;
  let sources: typeof locations;
  let transaction: RestoreTransaction;
  let filesystem: FilesystemService;
  const payload = Buffer.from([0, 255, 128, 10]);

  const journalRoot = () => path.join(root, 'data', 'state', 'app-restores');
  const makeTransaction = (reconcile?: () => Promise<void>) =>
    new RestoreTransaction(filesystem, { warn: vi.fn() } as unknown as LoggerService, journalRoot, () => locations, reconcile);

  beforeEach(async () => {
    root = await fs.promises.mkdtemp('/tmp/orbis-restore-transaction-');
    locations = Object.fromEntries(groups.map((name) => [name, path.join(root, 'live', name, 'store', 'demo')])) as typeof locations;
    sources = Object.fromEntries(groups.map((name) => [name, path.join(root, 'source', name)])) as typeof sources;
    await fs.promises.mkdir(path.join(root, 'data'), { recursive: true });
    for (const name of groups) {
      await fs.promises.mkdir(locations[name], { recursive: true });
      await fs.promises.mkdir(sources[name], { recursive: true });
      await fs.promises.writeFile(path.join(locations[name], 'record'), `old-${name}`);
      await fs.promises.writeFile(path.join(sources[name], 'record'), `new-${name}`);
      await fs.promises.writeFile(path.join(sources[name], '.binary'), payload);
    }
    filesystem = new FilesystemService({ error: vi.fn() } as unknown as LoggerService);
    transaction = makeTransaction();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  const expectFiles = async (version: 'old' | 'new', missing?: (typeof groups)[number]) => {
    for (const name of groups) {
      if (name === missing) await expect(fs.promises.lstat(locations[name])).rejects.toMatchObject({ code: 'ENOENT' });
      else expect(await fs.promises.readFile(path.join(locations[name], 'record'), 'utf8')).toBe(`${version}-${name}`);
    }
  };

  const expectClean = async () => {
    expect(await transaction.pendingApps()).toEqual([]);
    for (const name of groups) expect(await fs.promises.readdir(path.dirname(locations[name]))).toEqual(['demo']);
  };

  it('commits complete directories, binary contents, file modes and modification times together', async () => {
    const source = path.join(sources['app-data'], '.binary');
    await fs.promises.chmod(source, 0o640);
    await fs.promises.utimes(source, 1700000000, 1700000000);
    await transaction.replace(urn, sources);
    await expectFiles('new');
    const file = path.join(locations['app-data'], '.binary');
    expect(await fs.promises.readFile(file)).toEqual(payload);
    const original = await fs.promises.stat(source);
    const copied = await fs.promises.stat(file);
    expect(copied.mode & 0o7777).toBe(0o640);
    expect(copied.mtimeMs).toBe(original.mtimeMs);
    expect([copied.uid, copied.gid]).toEqual([original.uid, original.gid]);
    await expectClean();
  });

  const points = groups.flatMap((name) => [`old-${name}`, `new-${name}`]);
  for (const timing of ['before', 'after'])
    it.each(points)(`rolls back every directory after a ${timing}-rename failure at %s`, async (boundary) => {
      const rename = fs.promises.rename.bind(fs.promises);
      let failed = false;
      vi.spyOn(fs.promises, 'rename').mockImplementation(async (source, destination) => {
        const hit = groups.some(
          (name) =>
            (boundary === `old-${name}` && String(source) === locations[name]) ||
            (boundary === `new-${name}` && String(destination) === locations[name] && String(source).endsWith('/incoming')),
        );
        if (hit && !failed) {
          failed = true;
          if (timing === 'after') await rename(source, destination);
          throw new Error('Injected rename I/O failure');
        }
        await rename(source, destination);
      });
      await expect(transaction.replace(urn, sources)).rejects.toThrow('Injected rename I/O failure');
      expect(failed).toBe(true);
      await expectFiles('old');
      await expectClean();
    });

  const interrupt = async (boundary: string) => {
    const child = spawn('bun', ['src/modules/backups/__tests__/restore-crash-child.ts', root, boundary], { stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = once(child, 'exit');
    let stderr = '';
    child.stderr.on('data', (data) => {
      stderr += String(data).slice(0, 8192);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Crash fixture checkpoint timed out: ${stderr}`)), 10000);
        child.once('error', reject);
        child.stdout.on('data', (data) => {
          if (String(data).includes('CHECKPOINT')) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.once('exit', () => {
          clearTimeout(timer);
          reject(new Error(`Crash fixture exited before its checkpoint: ${stderr}`));
        });
      });
      expect(child.kill('SIGKILL')).toBe(true);
      const [code, signal] = await exited;
      expect(code).toBeNull();
      expect(signal).toBe('SIGKILL');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    }
  };

  it.each(['extracting', ...points, 'committed', 'cleanup'])(
    'recovers from a real SIGKILL at %s using a new transaction instance',
    async (boundary) => {
      await interrupt(boundary);
      transaction = makeTransaction();
      expect(await transaction.pendingApps()).toEqual([urn]);
      await transaction.recover(urn);
      await expectFiles(boundary === 'committed' || boundary === 'cleanup' ? 'new' : 'old');
      await expectClean();
      await transaction.recover(urn);
      await expectClean();
    },
    15000,
  );

  it.each(groups)(
    'restores the original absence of %s after a real interruption',
    async (name) => {
      await fs.promises.rm(locations[name], { recursive: true });
      await interrupt(`new-${name}`);
      transaction = makeTransaction();
      await transaction.recover(urn);
      await expectFiles('old', name);
      expect(await transaction.pendingApps()).toEqual([]);
    },
    15000,
  );

  it('retains a committed journal until database metadata reconciliation succeeds', async () => {
    transaction = makeTransaction(async () => {
      throw new Error('Database unavailable');
    });
    await expect(transaction.replace(urn, sources)).rejects.toThrow('Database unavailable');
    await expectFiles('new');
    expect(await transaction.pendingApps()).toEqual([urn]);
    const reconcile = vi.fn().mockResolvedValue(undefined);
    transaction = makeTransaction(reconcile);
    await transaction.recover(urn);
    expect(reconcile).toHaveBeenCalledExactlyOnceWith(urn);
    await expectFiles('new');
    await expectClean();
  });

  it('retains the committed journal after cleanup fails and keeps the complete restored data', async () => {
    const remove = fs.promises.rm.bind(fs.promises);
    let failed = false;
    vi.spyOn(fs.promises, 'rm').mockImplementation(async (file, options) => {
      if (!failed && path.basename(String(file)).includes('.orbis-restore-')) {
        failed = true;
        throw new Error('Cleanup storage unavailable');
      }
      await remove(file, options);
    });
    await transaction.replace(urn, sources);
    expect(failed).toBe(true);
    await expectFiles('new');
    expect(await transaction.pendingApps()).toEqual([urn]);
    vi.restoreAllMocks();
    transaction = makeTransaction();
    await transaction.recover(urn);
    await expectFiles('new');
    await expectClean();
  });

  it('keeps originals untouched if staged file contents cannot be synced', async () => {
    const open = fs.promises.open.bind(fs.promises);
    let failed = false;
    vi.spyOn(fs.promises, 'open').mockImplementation(async (file, flags, mode) => {
      const handle = await open(file, flags, mode);
      if (!failed && String(file).endsWith('/incoming/record')) {
        failed = true;
        vi.spyOn(handle, 'sync').mockRejectedValueOnce(new Error('Staged file sync failed'));
      }
      return handle;
    });
    await expect(transaction.replace(urn, sources)).rejects.toThrow('Staged file sync failed');
    expect(failed).toBe(true);
    await expectFiles('old');
    await expectClean();
  });

  it('rejects overlapping restore or recovery while a directory copy is active', async () => {
    const copy = filesystem.copyDirectory.bind(filesystem);
    let releaseCopy: () => void = () => undefined;
    let copyStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      copyStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseCopy = resolve;
    });
    vi.spyOn(filesystem, 'copyDirectory').mockImplementation(async (source, destination, options) => {
      copyStarted();
      await released;
      return copy(source, destination, options);
    });
    const first = transaction.replace(urn, sources);
    try {
      await started;
      await expect(transaction.replace(urn, sources)).rejects.toThrow('already in progress');
      await expect(transaction.recover(urn)).rejects.toThrow('already in progress');
      await expectFiles('old');
    } finally {
      releaseCopy();
      await first;
    }
    await expectFiles('new');
    await expectClean();
  });

  it('rejects a live destination symlink without touching its target', async () => {
    const outside = path.join(root, 'unrelated');
    await fs.promises.mkdir(outside);
    await fs.promises.writeFile(path.join(outside, 'record'), 'unrelated');
    await fs.promises.rename(locations['app-data'], path.join(root, 'held-original'));
    await fs.promises.symlink(outside, locations['app-data']);
    await expect(transaction.replace(urn, sources)).rejects.toThrow('not a regular directory');
    expect(await fs.promises.readFile(path.join(outside, 'record'), 'utf8')).toBe('unrelated');
    expect(await fs.promises.readFile(path.join(root, 'held-original', 'record'), 'utf8')).toBe('old-app-data');
    expect(await transaction.pendingApps()).toEqual([]);
  });

  it('rejects a replaced recovery workspace symlink without touching unrelated files', async () => {
    await interrupt('old-app-data');
    const file = path.join(journalRoot(), urn, 'journal.json');
    const journal = JSON.parse(await fs.promises.readFile(file, 'utf8')) as { id: string };
    const workspace = path.join(path.dirname(locations['app-data']), `.demo.orbis-restore-${journal.id}`);
    await fs.promises.rename(workspace, path.join(root, 'held-workspace'));
    const outside = path.join(root, 'unrelated');
    await fs.promises.mkdir(outside);
    await fs.promises.writeFile(path.join(outside, 'record'), 'unrelated');
    await fs.promises.symlink(outside, workspace);
    await expect(makeTransaction().recover(urn)).rejects.toThrow('not a regular directory');
    expect(await fs.promises.readFile(path.join(outside, 'record'), 'utf8')).toBe('unrelated');
    expect(await fs.promises.readFile(path.join(root, 'held-workspace', 'previous', 'record'), 'utf8')).toBe('old-app-data');
    expect(await transaction.pendingApps()).toEqual([urn]);
  }, 15000);

  it('keeps the original directories and journal when rollback itself fails, then recovers on retry', async () => {
    const rename = fs.promises.rename.bind(fs.promises);
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (source, destination) => {
      if ((String(source).endsWith('/incoming') && String(destination) === locations.app) || String(source).endsWith('/previous'))
        throw new Error('Storage unavailable');
      await rename(source, destination);
    });
    await expect(transaction.replace(urn, sources)).rejects.toThrow('Restore recovery is incomplete');
    expect(await transaction.pendingApps()).toEqual([urn]);
    vi.restoreAllMocks();
    transaction = makeTransaction();
    await transaction.recover(urn);
    await expectFiles('old');
    await expectClean();
  });

  it('rejects altered recovery paths and leaves unrelated data untouched', async () => {
    await interrupt('old-app');
    const file = path.join(journalRoot(), urn, 'journal.json');
    const journal = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    journal.entries[0].target = path.join(root, 'unrelated');
    await fs.promises.writeFile(file, JSON.stringify(journal));
    await fs.promises.writeFile(path.join(root, 'unrelated'), 'untouched');
    await expect(makeTransaction().recover(urn)).rejects.toThrow('Restore locations changed');
    expect(await fs.promises.readFile(path.join(root, 'unrelated'), 'utf8')).toBe('untouched');
    expect(await transaction.pendingApps()).toEqual([urn]);
  }, 15000);
});
