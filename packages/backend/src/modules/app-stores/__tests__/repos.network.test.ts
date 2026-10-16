import fs from 'node:fs';
import { type RequestListener, type Server, createServer } from 'node:http';
import path from 'node:path';
import { DATA_DIR } from '@/common/constants';
import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import git from 'isomorphic-git';
import { Volume, createFsFromVolume } from 'memfs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { ReposHelpers } from '../repos.helpers';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('@sentry/nestjs', () => ({ captureException: vi.fn() }));
vi.mock('../git-http', async () => {
  const original = await vi.importActual<typeof import('../git-http')>('../git-http');
  return {
    ...original,
    withGitHttp: <T>(operation: Parameters<typeof original.withGitHttp<T>>[0]) =>
      original.withGitHttp(operation, { idleTimeoutMs: 100, operationTimeoutMs: 2_000 }),
  };
});

const servers: Server[] = [];
const deferred = () => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};
const serve = async (listener: RequestListener) => {
  const server = createServer(listener);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Loopback listener did not bind');
  return `http://127.0.0.1:${address.port}/repository.git`;
};

describe('repository locks and real Git network cancellation', () => {
  const configuration = mock<ConfigurationService>();
  const logger = mock<LoggerService>();
  const filesystem = new FilesystemService(logger);
  const slug = 'network-fixture';
  const reposPath = path.join(DATA_DIR, 'repos');
  const repoPath = path.join(reposPath, slug);
  let helpers: ReposHelpers;

  beforeEach(() => {
    configuration.get.calledWith('directories').mockReturnValue({ dataDir: DATA_DIR } as never);
    helpers = new ReposHelpers(logger, configuration, filesystem);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('cancels an actual stalled clone and holds queued removal until staging cleanup finishes', async () => {
    const requested = deferred();
    const disconnected = deferred();
    const cleanupEntered = deferred();
    const finishCleanup = deferred();
    const url = await serve((request) => {
      request.on('close', disconnected.resolve);
      requested.resolve();
    });
    const remove = fs.promises.rm.bind(fs.promises);
    const stagingRemoval = vi.spyOn(fs.promises, 'rm').mockImplementation(async (directory, options) => {
      if (String(directory).startsWith(path.join(reposPath, `.${slug}-clone-`))) {
        cleanupEntered.resolve();
        await finishCleanup.promise;
      }
      return remove(directory, options);
    });
    const deleteRepo = vi.spyOn(filesystem, 'removeDirectory');
    const clone = helpers.cloneRepo(url, slug);
    await requested.promise;
    const deletion = helpers.deleteRepo(slug);
    try {
      await cleanupEntered.promise;
      expect(deleteRepo).not.toHaveBeenCalled();
      expect(await filesystem.pathExists(repoPath)).toBe(false);
      expect((await fs.promises.readdir(reposPath)).some((name) => name.startsWith(`.${slug}-clone-`))).toBe(true);
    } finally {
      finishCleanup.resolve();
    }
    expect(await clone).toMatchObject({ success: false, message: 'App store connection stopped responding.' });
    expect(await deletion).toMatchObject({ success: true });
    await disconnected.promise;
    expect(stagingRemoval).toHaveBeenCalled();
    expect(deleteRepo).toHaveBeenCalledExactlyOnceWith(repoPath);
    expect(await fs.promises.readdir(reposPath)).toEqual([]);
  });

  it('keeps an actual last-good Git checkout after a timed-out refresh and releases its lock', async () => {
    const disconnected = deferred();
    const url = await serve((request) => request.on('close', disconnected.resolve));
    await git.init({ fs, dir: repoPath, defaultBranch: 'main' });
    const configPath = path.join(repoPath, 'catalogue.json');
    await fs.promises.writeFile(configPath, '{"fixture":"last-good"}\n');
    await git.add({ fs, dir: repoPath, filepath: 'catalogue.json' });
    const sha = await git.commit({ fs, dir: repoPath, message: 'Synthetic fixture', author: { name: 'Fixture', email: 'fixture@example.invalid' } });

    expect(await helpers.pullRepo(url, slug)).toMatchObject({ success: false, message: 'App store connection stopped responding.' });
    await disconnected.promise;
    expect(await git.resolveRef({ fs, dir: repoPath, ref: 'HEAD' })).toBe(sha);
    expect(await fs.promises.readFile(configPath, 'utf8')).toBe('{"fixture":"last-good"}\n');
    expect(await fs.promises.readdir(reposPath)).toEqual([slug]);
    expect(await helpers.cloneRepo(url, slug)).toMatchObject({ success: true });
  });

  it('clones a real pack, preserves it after a mid-pack timeout, then refreshes successfully', async () => {
    const remoteFs = createFsFromVolume(new Volume());
    const remoteDir = '/remote';
    await git.init({ fs: remoteFs, dir: remoteDir, defaultBranch: 'main' });
    const packet = (value: string | Buffer) => {
      const bytes = Buffer.from(value);
      return Buffer.concat([Buffer.from((bytes.length + 4).toString(16).padStart(4, '0')), bytes]);
    };
    const version = async (number: number) => {
      await remoteFs.promises.writeFile(`${remoteDir}/catalogue.json`, JSON.stringify({ version: number }));
      await git.add({ fs: remoteFs, dir: remoteDir, filepath: 'catalogue.json' });
      const sha = await git.commit({
        fs: remoteFs,
        dir: remoteDir,
        message: `Version ${number}`,
        author: { name: 'Fixture', email: 'fixture@example.invalid' },
      });
      const tree = (await git.readCommit({ fs: remoteFs, dir: remoteDir, oid: sha })).commit.tree;
      const entries = (await git.readTree({ fs: remoteFs, dir: remoteDir, oid: tree })).tree;
      const packed = await git.packObjects({ fs: remoteFs, dir: remoteDir, oids: [sha, tree, ...entries.map((entry) => entry.oid)] });
      if (!packed.packfile) throw new Error('Fixture pack was not generated');
      return { sha, pack: Buffer.from(packed.packfile) };
    };
    let remote = await version(1);
    let stall = false;
    let serverError = false;
    const url = await serve((request, response) => {
      if (request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement' });
        response.end(
          Buffer.concat([
            packet('# service=git-upload-pack\n'),
            Buffer.from('0000'),
            packet(`${remote.sha} HEAD\0side-band-64k shallow symref=HEAD:refs/heads/main\n`),
            packet(`${remote.sha} refs/heads/main\n`),
            Buffer.from('0000'),
          ]),
        );
      } else {
        request.resume();
        if (serverError) {
          response.writeHead(500);
          response.write('Temporary fixture failure');
          return;
        }
        response.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
        response.write(Buffer.concat([packet(`shallow ${remote.sha}\n`), Buffer.from('0000'), packet('NAK\n')]));
        response.write(packet(Buffer.concat([Buffer.from([1]), stall ? remote.pack.subarray(0, 16) : remote.pack])));
        if (!stall) response.end('0000');
      }
    });

    expect(await helpers.cloneRepo(url, slug)).toMatchObject({ success: true });
    const firstSha = remote.sha;
    const configPath = path.join(repoPath, 'catalogue.json');
    expect(await fs.promises.readFile(configPath, 'utf8')).toBe('{"version":1}');
    remote = await version(2);
    const unhandled: unknown[] = [];
    const observeRejection = (error: unknown) => unhandled.push(error);
    process.on('unhandledRejection', observeRejection);
    try {
      serverError = true;
      expect((await helpers.pullRepo(url, slug)).success).toBe(false);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      expect(await git.resolveRef({ fs, dir: repoPath, ref: 'HEAD' })).toBe(firstSha);
      expect(await fs.promises.readFile(configPath, 'utf8')).toBe('{"version":1}');
    } finally {
      process.removeListener('unhandledRejection', observeRejection);
      serverError = false;
    }
    stall = true;
    expect((await helpers.pullRepo(url, slug)).success).toBe(false);
    expect(await git.resolveRef({ fs, dir: repoPath, ref: 'HEAD' })).toBe(firstSha);
    expect(await fs.promises.readFile(configPath, 'utf8')).toBe('{"version":1}');
    expect(await fs.promises.readdir(reposPath)).toEqual([slug]);

    stall = false;
    expect(await helpers.pullRepo(url, slug)).toMatchObject({ success: true });
    expect(await git.resolveRef({ fs, dir: repoPath, ref: 'HEAD' })).toBe(remote.sha);
    expect(await fs.promises.readFile(configPath, 'utf8')).toBe('{"version":2}');
    expect(await fs.promises.readdir(reposPath)).toEqual([slug]);
  });
});
