import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '@/common/constants';
import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { ReposHelpers } from '../repos.helpers';

const git = vi.hoisted(() => ({
  clone: vi.fn(),
  currentBranch: vi.fn(),
  fetch: vi.fn(),
  resolveRef: vi.fn(),
  branch: vi.fn(),
  checkout: vi.fn(),
}));

vi.mock('isomorphic-git', () => ({ default: git }));
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('@sentry/nestjs', () => ({ captureException: vi.fn() }));

const repoUrl = 'https://example.com/owned-fixture.git';
const slug = 'owned-fixture';
const reposPath = path.join(DATA_DIR, 'repos');
const repoPath = path.join(reposPath, slug);
const configPath = path.join(repoPath, 'apps', 'demo', 'config.json');
const refPath = path.join(repoPath, '.git', 'refs', 'heads', 'main');
const oldConfig = JSON.stringify({ id: 'demo', tipi_version: 1 });
const oldSha = '1'.repeat(40);
const newSha = '2'.repeat(40);

const deferred = () => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

const writeCheckout = async (directory: string, config = oldConfig) => {
  await fs.promises.mkdir(path.join(directory, 'apps', 'demo'), { recursive: true });
  await fs.promises.mkdir(path.join(directory, '.git', 'refs', 'heads'), { recursive: true });
  await fs.promises.writeFile(path.join(directory, 'apps', 'demo', 'config.json'), config);
  await fs.promises.writeFile(path.join(directory, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await fs.promises.writeFile(path.join(directory, '.git', 'refs', 'heads', 'main'), oldSha);
};

describe('ReposHelpers staged clones and offline refresh', () => {
  const configuration = mock<ConfigurationService>();
  const logger = mock<LoggerService>();
  const filesystem = new FilesystemService(logger);
  let helpers: ReposHelpers;

  afterEach(() => vi.restoreAllMocks());

  beforeEach(() => {
    vi.clearAllMocks();
    for (const method of Object.values(git)) method.mockReset();
    configuration.get.calledWith('directories').mockReturnValue({ dataDir: DATA_DIR } as never);
    configuration.get.calledWith('__prod__').mockReturnValue(true);
    git.currentBranch.mockResolvedValue('main');
    git.resolveRef.mockImplementation(async ({ ref }: { ref: string }) => (ref === 'origin/main' ? newSha : oldSha));
    git.fetch.mockResolvedValue({ fetchHead: newSha });
    git.branch.mockResolvedValue(undefined);
    git.checkout.mockResolvedValue(undefined);
    git.clone.mockImplementation(async ({ dir }: { dir: string }) => writeCheckout(dir));
    helpers = new ReposHelpers(logger, configuration, filesystem);
  });

  it('publishes a completed clone from staging and leaves no staging directories', async () => {
    git.clone.mockImplementation(async ({ dir }: { dir: string }) => {
      expect(dir).not.toBe(repoPath);
      expect(path.dirname(dir)).toBe(reposPath);
      expect(await filesystem.pathExists(repoPath)).toBe(false);
      await writeCheckout(dir);
    });

    expect(await helpers.cloneRepo(`${repoUrl}/tree/rehearsal`, slug)).toMatchObject({ success: true });

    expect(git.clone).toHaveBeenCalledOnce();
    expect(git.clone).toHaveBeenCalledWith(expect.objectContaining({ url: repoUrl, ref: 'rehearsal', depth: 1, singleBranch: true }));
    expect(await fs.promises.readFile(configPath, 'utf8')).toBe(oldConfig);
    expect(await fs.promises.readdir(reposPath)).toEqual([slug]);
  });

  it('removes a failed partial clone without publishing it as a repository', async () => {
    git.clone.mockImplementation(async ({ dir }: { dir: string }) => {
      await writeCheckout(dir, 'partial clone');
      throw new Error('fixture offline');
    });

    expect(await helpers.cloneRepo(repoUrl, slug)).toMatchObject({ success: false, message: expect.stringContaining('fixture offline') });

    expect(await filesystem.pathExists(repoPath)).toBe(false);
    expect(await fs.promises.readdir(reposPath)).toEqual([]);
  });

  it('retries a failed clone instead of treating its partial directory as a successful checkout', async () => {
    git.clone.mockImplementationOnce(async ({ dir }: { dir: string }) => {
      await writeCheckout(dir, 'partial clone');
      throw new Error('fixture offline');
    });

    expect((await helpers.cloneRepo(repoUrl, slug)).success).toBe(false);
    expect((await helpers.cloneRepo(repoUrl, slug)).success).toBe(true);

    expect(git.clone).toHaveBeenCalledTimes(2);
    expect(await fs.promises.readFile(configPath, 'utf8')).toBe(oldConfig);
    expect(await fs.promises.readdir(reposPath)).toEqual([slug]);
  });

  it('does not clone over an existing checkout', async () => {
    await writeCheckout(repoPath);

    expect((await helpers.cloneRepo(repoUrl, slug)).success).toBe(true);

    expect(git.clone).not.toHaveBeenCalled();
    expect(await fs.promises.readFile(configPath, 'utf8')).toBe(oldConfig);
    expect(await fs.promises.readFile(refPath, 'utf8')).toBe(oldSha);
  });

  it.each([true, false])('preserves the last good catalogue when fetch fails (production=%s)', async (production) => {
    configuration.get.calledWith('__prod__').mockReturnValue(production);
    await writeCheckout(repoPath);
    git.fetch.mockRejectedValue(new Error('fixture offline'));
    const remove = vi.spyOn(filesystem, 'removeDirectory');

    const result = await helpers.pullRepo(repoUrl, slug);

    expect(result).toMatchObject({ success: false, message: expect.stringContaining('fixture offline') });
    expect(await fs.promises.readFile(configPath, 'utf8')).toBe(oldConfig);
    expect(await fs.promises.readFile(refPath, 'utf8')).toBe(oldSha);
    expect(await fs.promises.readFile(path.join(repoPath, '.git', 'HEAD'), 'utf8')).toBe('ref: refs/heads/main\n');
    expect(git.clone).not.toHaveBeenCalled();
    expect(git.branch).not.toHaveBeenCalled();
    expect(git.checkout).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalledWith(repoPath);
    remove.mockRestore();
  });

  it('returns failure when an absent repository cannot be cloned and does not fetch it', async () => {
    git.clone.mockImplementation(async ({ dir }: { dir: string }) => {
      await writeCheckout(dir, 'partial clone');
      throw new Error('fixture offline');
    });

    expect((await helpers.pullRepo(repoUrl, slug)).success).toBe(false);

    expect(git.clone).toHaveBeenCalledOnce();
    expect(git.fetch).not.toHaveBeenCalled();
    expect(git.currentBranch).not.toHaveBeenCalled();
    expect(await filesystem.pathExists(repoPath)).toBe(false);
    expect(await fs.promises.readdir(reposPath)).toEqual([]);
  });

  it('refreshes an existing checkout once on its current branch', async () => {
    await writeCheckout(repoPath);
    git.checkout.mockImplementation(async () => {
      await fs.promises.writeFile(configPath, JSON.stringify({ id: 'demo', tipi_version: 2 }));
      await fs.promises.writeFile(refPath, newSha);
    });

    expect((await helpers.pullRepo(`${repoUrl}/tree/main`, slug)).success).toBe(true);

    expect(git.clone).not.toHaveBeenCalled();
    expect(git.fetch).toHaveBeenCalledOnce();
    expect(git.fetch).toHaveBeenCalledWith(expect.objectContaining({ url: repoUrl, dir: repoPath, ref: 'main', singleBranch: true }));
    expect(git.branch).toHaveBeenCalledWith(expect.objectContaining({ dir: repoPath, ref: 'main', object: newSha }));
    expect(git.checkout).toHaveBeenCalledOnce();
    expect(JSON.parse(await fs.promises.readFile(configPath, 'utf8')).tipi_version).toBe(2);
    expect(await fs.promises.readFile(refPath, 'utf8')).toBe(newSha);
  });

  it('restores the previous branch and catalogue after a checkout partially fails', async () => {
    await writeCheckout(repoPath);
    git.branch.mockImplementation(async ({ object }: { object: string }) => {
      await fs.promises.writeFile(refPath, object);
    });
    git.checkout.mockImplementation(async () => {
      const currentSha = await fs.promises.readFile(refPath, 'utf8');
      if (currentSha === newSha) {
        await fs.promises.writeFile(configPath, 'partially applied v2');
        throw new Error('checkout interrupted');
      }
      expect(currentSha).toBe(oldSha);
      await fs.promises.writeFile(configPath, oldConfig);
    });

    const result = await helpers.pullRepo(repoUrl, slug);

    expect(result).toMatchObject({ success: false, message: 'checkout interrupted' });
    expect(git.branch.mock.calls.map(([options]) => options.object)).toEqual([newSha, oldSha]);
    expect(git.checkout).toHaveBeenCalledTimes(2);
    expect(await fs.promises.readFile(refPath, 'utf8')).toBe(oldSha);
    expect(await fs.promises.readFile(configPath, 'utf8')).toBe(oldConfig);
    expect(git.clone).not.toHaveBeenCalled();
  });

  it('serializes concurrent refreshes through checkout while allowing another repository to refresh', async () => {
    const otherSlug = 'other-fixture';
    const otherPath = path.join(reposPath, otherSlug);
    await writeCheckout(repoPath);
    await writeCheckout(otherPath);
    const enteredCheckout = deferred();
    const releaseCheckout = deferred();
    const events: string[] = [];
    let primaryCheckouts = 0;
    git.checkout.mockImplementation(async ({ dir }: { dir: string }) => {
      if (dir !== repoPath) return;
      const checkout = ++primaryCheckouts;
      events.push(`start-${checkout}`);
      if (checkout === 1) {
        enteredCheckout.resolve();
        await releaseCheckout.promise;
      }
      events.push(`finish-${checkout}`);
    });

    const first = helpers.pullRepo(repoUrl, slug);
    await enteredCheckout.promise;
    const second = helpers.pullRepo(repoUrl, slug);
    try {
      expect((await helpers.pullRepo('https://example.com/other.git', otherSlug)).success).toBe(true);
      expect(git.fetch.mock.calls.filter(([options]) => options.dir === repoPath)).toHaveLength(1);
      expect(primaryCheckouts).toBe(1);
    } finally {
      releaseCheckout.resolve();
      const results = await Promise.all([first, second]);
      expect(results.every((result) => result.success)).toBe(true);
    }

    expect(events).toEqual(['start-1', 'finish-1', 'start-2', 'finish-2']);
    expect(git.fetch.mock.calls.filter(([options]) => options.dir === repoPath)).toHaveLength(2);
  });

  it('coalesces concurrent initial clones by checking the published checkout after the first clone finishes', async () => {
    const enteredClone = deferred();
    const releaseClone = deferred();
    git.clone.mockImplementation(async ({ dir, url }: { dir: string; url: string }) => {
      if (url === repoUrl) {
        enteredClone.resolve();
        await releaseClone.promise;
      }
      await writeCheckout(dir);
    });

    const first = helpers.cloneRepo(repoUrl, slug);
    await enteredClone.promise;
    const second = helpers.cloneRepo(repoUrl, slug);
    try {
      expect((await helpers.cloneRepo('https://example.com/other.git', 'other-fixture')).success).toBe(true);
      expect(git.clone.mock.calls.filter(([options]) => options.url === repoUrl)).toHaveLength(1);
      expect(await filesystem.pathExists(repoPath)).toBe(false);
    } finally {
      releaseClone.resolve();
      const results = await Promise.all([first, second]);
      expect(results.every((result) => result.success)).toBe(true);
    }

    expect(git.clone.mock.calls.filter(([options]) => options.url === repoUrl)).toHaveLength(1);
    expect(await fs.promises.readFile(configPath, 'utf8')).toBe(oldConfig);
    expect((await fs.promises.readdir(reposPath)).sort()).toEqual(['other-fixture', slug].sort());
  });
});
