import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import { Injectable } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import git from 'isomorphic-git';
import http from 'isomorphic-git/http/node';

@Injectable()
export class ReposHelpers {
  private readonly repoOperations = new Map<string, Promise<unknown>>();

  constructor(
    private readonly logger: LoggerService,
    private readonly configuration: ConfigurationService,
    private readonly filesystem: FilesystemService,
  ) {}

  private async withRepoLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.repoOperations.get(id) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(operation);
    this.repoOperations.set(id, pending);
    try {
      return await pending;
    } finally {
      if (this.repoOperations.get(id) === pending) this.repoOperations.delete(id);
    }
  }

  /**
   * Given a repo url, return a hash of it to be used as a folder name
   *
   * @param {string} repoUrl
   */
  public getRepoHash(repoUrl: string) {
    const hash = crypto.createHash('sha256');
    hash.update(repoUrl);
    return hash.digest('hex');
  }

  /**
   * Extracts the base URL and branch from a repository URL.
   * @param repoUrl The repository URL.
   * @returns An array containing the base URL and branch, or just the base URL if no branch is found.
   */
  private getRepoBaseUrlAndBranch(repoUrl: string) {
    const treeIndex = repoUrl.indexOf('/tree/');

    if (treeIndex !== -1) {
      const baseUrl = repoUrl.substring(0, treeIndex);
      const branch = repoUrl.substring(treeIndex + '/tree/'.length);
      return [baseUrl, branch];
    }

    return [repoUrl, undefined];
  }

  /**
   * Error handler for repo operations
   * @param {unknown} err
   */
  private handleRepoError(err: unknown) {
    Sentry.captureException(err);

    if (err instanceof Error) {
      this.logger.error(err);
      return { success: false, message: err.message };
    }

    return { success: false, message: `An error occurred: ${String(err)}` };
  }

  /**
   * Ensure directory exists and has correct permissions
   * @param {string} dirPath
   */
  private async ensureDirectoryWithPermissions(dirPath: string): Promise<void> {
    if (!(await this.filesystem.pathExists(dirPath))) {
      await fs.promises.mkdir(dirPath, { recursive: true });
    }

    await fs.promises.chmod(dirPath, 0o755);
    execFileSync('git', ['config', '--global', '--add', 'safe.directory', dirPath], {
      stdio: 'ignore',
    });
  }

  /**
   * Given a repo url, clone it to the repos folder if it doesn't exist
   *
   * @param {string} url
   */
  public async cloneRepo(url: string, id: string) {
    return this.withRepoLock(id, () => this.cloneRepoUnlocked(url, id));
  }

  private async cloneRepoUnlocked(url: string, id: string) {
    let stagingPath: string | undefined;
    try {
      const { dataDir } = this.configuration.get('directories');
      const repoPath = path.join(dataDir, 'repos', id);

      if (await this.filesystem.pathExists(repoPath)) {
        await git.resolveRef({ fs, dir: repoPath, ref: 'HEAD' });
        await this.ensureDirectoryWithPermissions(path.dirname(repoPath));
        this.logger.debug(`Repo ${url} already exists`);
        return { success: true, message: '' };
      }

      const [repoUrl, branch] = this.getRepoBaseUrlAndBranch(url);

      if (!repoUrl) {
        this.logger.error(`Invalid repo URL: ${url}`);
        return { success: false, message: `Invalid repo URL: ${url}` };
      }

      this.logger.debug(`Cloning repo ${repoUrl}${branch ? ` on branch ${branch}` : ''} to ${repoPath}`);

      await this.ensureDirectoryWithPermissions(path.dirname(repoPath));
      stagingPath = await fs.promises.mkdtemp(path.join(path.dirname(repoPath), `.${id}-clone-`));
      await git.clone({
        fs,
        http,
        dir: stagingPath,
        url: repoUrl,
        singleBranch: true,
        depth: 1,
        ref: branch || undefined,
      });

      await fs.promises.rename(stagingPath, repoPath);
      stagingPath = undefined;

      this.logger.info(`Cloned repo ${repoUrl} to ${repoPath}`);
      return { success: true, message: '' };
    } catch (err) {
      return this.handleRepoError(err);
    } finally {
      if (stagingPath) await fs.promises.rm(stagingPath, { recursive: true, force: true });
    }
  }

  /**
   * Given a repo url, pull it to the repos folder if it exists
   *
   * @param {string} repoUrl
   */
  public async pullRepo(repoUrl: string, slug: string) {
    return this.withRepoLock(slug, () => this.pullRepoUnlocked(repoUrl, slug));
  }

  private async pullRepoUnlocked(repoUrl: string, slug: string) {
    try {
      const cloned = await this.cloneRepoUnlocked(repoUrl, slug);
      if (!cloned.success) return cloned;

      const [remoteUrl] = this.getRepoBaseUrlAndBranch(repoUrl);

      const { dataDir } = this.configuration.get('directories');
      const repoPath = path.join(dataDir, 'repos', slug);

      if (!(await this.filesystem.pathExists(repoPath))) {
        this.logger.info(`Repo ${repoUrl} does not exist`);
        return { success: false, message: `Repo ${repoUrl} does not exist` };
      }

      this.logger.debug(`Pulling repo ${repoUrl} to ${repoPath}`);

      const currentBranch = await git.currentBranch({
        fs,
        dir: repoPath,
        fullname: false,
      });
      if (!currentBranch) {
        return { success: false, message: `No current branch found for repo ${slug}` };
      }
      const previousSha = await git.resolveRef({ fs, dir: repoPath, ref: 'HEAD' });
      const remoteBranchRef = `origin/${currentBranch}`;

      const fetchResult = await git.fetch({
        fs,
        http,
        dir: repoPath,
        url: remoteUrl,
        ref: currentBranch,
        depth: 1,
        singleBranch: true,
        tags: false,
      });
      this.logger.debug('Fetch result:', fetchResult, 'Current branch:', currentBranch);
      const targetSha = await git.resolveRef({
        fs,
        dir: repoPath,
        ref: remoteBranchRef,
      });
      this.logger.debug('Target SHA:', targetSha);
      try {
        await git.branch({ fs, dir: repoPath, ref: currentBranch, object: targetSha, force: true });
        await git.checkout({ fs, dir: repoPath, ref: currentBranch, force: true });
      } catch (error) {
        await git.branch({ fs, dir: repoPath, ref: currentBranch, object: previousSha, force: true });
        await git.checkout({ fs, dir: repoPath, ref: currentBranch, force: true });
        throw error;
      }

      this.logger.debug(`Pulled repo ${repoUrl} to ${repoPath}`);
      return { success: true, message: '' };
    } catch (error) {
      return this.handleRepoError(error);
    }
  }

  /**
   * Given a repo id, delete it from the repos folder
   */
  public async deleteRepo(id: string) {
    return this.withRepoLock(id, () => this.deleteRepoUnlocked(id));
  }

  private async deleteRepoUnlocked(id: string) {
    try {
      const { dataDir } = this.configuration.get('directories');
      const repoPath = path.join(dataDir, 'repos', id);

      if (!(await this.filesystem.pathExists(repoPath))) {
        this.logger.info(`Repo ${id} does not exist`);
        return { success: false, message: `Repo ${id} does not exist` };
      }

      this.logger.info(`Deleting repo ${id} from ${repoPath}`);
      await this.filesystem.removeDirectory(repoPath);

      this.logger.info(`Deleted repo ${id} from ${repoPath}`);
      return { success: true, message: '' };
    } catch (err) {
      return this.handleRepoError(err);
    }
  }

  public async deleteAllRepos() {
    const { dataDir } = this.configuration.get('directories');
    const repos = await this.filesystem.listFiles(path.join(dataDir, 'repos'));

    for (const repo of repos) {
      await this.deleteRepo(repo);
    }

    return { success: true, message: '' };
  }
}
