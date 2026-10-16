import { TranslatableError } from '@/common/error/translatable-error';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { AsyncMutex } from '@/utils/mutex/async-mutex';
import { APP_ASYNC_MUTEX } from '@/utils/mutex/mutex.module';
import { BadRequestException, HttpStatus, Inject, Injectable, NotFoundException } from '@nestjs/common';
import slugify from 'slugify';
import type { UpdateAppStoreBodyDto } from '../marketplace/dto/marketplace.dto';
import { RepoEventsQueue } from '../queue/entities/repo-events';
import { AppStoreRepository } from './app-store.repository';
import { APP_STORE_CATALOGUE_LOCK, appStoreLockKey } from './app-store-lock';
import { ReposHelpers } from './repos.helpers';

export const RESERVED_APP_STORE_SLUGS = ['_user'];

@Injectable()
export class AppStoreService {
  constructor(
    private readonly logger: LoggerService,
    private readonly repoQueue: RepoEventsQueue,
    private readonly repoHelpers: ReposHelpers,
    private readonly config: ConfigurationService,
    private readonly appStoreRepository: AppStoreRepository,
    @Inject(APP_ASYNC_MUTEX) private readonly mutex: AsyncMutex,
  ) {
    this.repoQueue.onEvent(async (data, reply) => {
      switch (data.command) {
        case 'update_all': {
          await reply(await this.pullRepositories());
          break;
        }
        case 'clone_all': {
          await reply(await this.refreshRepositories('clone'));
          break;
        }
        case 'clone':
        case 'update': {
          await reply(await this.refreshStore(data.id, data.command));
          break;
        }
      }
    });
  }

  private async withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const release = await this.mutex.acquire(key);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async refreshStore(slug: string, command: 'clone' | 'update', skipUnavailable = false) {
    return this.withLock(appStoreLockKey(slug), async () => {
      const store = await this.appStoreRepository.getAppStoreBySlug(slug);
      if (!store || !store.enabled) return { success: skipUnavailable, message: '' };
      this.logger.debug(`Refreshing app store ${store.slug}`);
      const result =
        command === 'clone' ? await this.repoHelpers.cloneRepo(store.url, store.slug) : await this.repoHelpers.pullRepo(store.url, store.slug);
      return { success: result.success, message: result.success ? '' : store.name };
    });
  }

  private async refreshRepositories(command: 'clone' | 'update') {
    const stores = await this.appStoreRepository.getEnabledAppStores();
    const failed: string[] = [];
    for (const store of stores) {
      const result = await this.refreshStore(store.slug, command, true);
      if (!result.success) failed.push(store.name);
    }
    return { success: failed.length === 0, message: failed.join(', ') };
  }

  public async pullRepositories() {
    return this.refreshRepositories('update');
  }

  /**
   * Migrate the legacy repo to the new app store system
   *
   * @returns The ID of the migrated repo
   */
  public async migrateLegacyRepo() {
    const { deprecatedAppsRepoUrl, deprecatedAppsRepoId } = this.config.getConfig();

    if (!deprecatedAppsRepoUrl) {
      this.logger.debug('Skipping repo migration, no deprecated repo URL to migrate');
      return;
    }

    const existing = await this.appStoreRepository.getAppStoreByHash('migrated');
    if (existing) {
      this.logger.info('Migrating default repo');
      await this.appStoreRepository.updateAppStoreHashAndUrl(existing.slug, { url: deprecatedAppsRepoUrl, hash: deprecatedAppsRepoId });
    }
  }

  public async getEnabledAppStores() {
    return this.appStoreRepository.getEnabledAppStores();
  }

  public async getAllAppStores() {
    return this.appStoreRepository.getAllAppStores();
  }

  /**
   * Given an app store ID and the new data, update the app store in the database
   *
   * @param slug The ID of the app store to update
   * @param body The new data to update the app store with
   */
  public async updateAppStore(slug: string, body: UpdateAppStoreBodyDto) {
    return this.withLock(appStoreLockKey(slug), async () => {
      const current = await this.appStoreRepository.getAppStoreBySlug(slug);
      if (!current) throw new NotFoundException(`App store ${slug} not found`);
      if (body.enabled && !current.enabled) {
        const refreshed = await this.repoHelpers.pullRepo(current.url, current.slug);
        if (!refreshed.success) throw new TranslatableError('APP_STORE_REFRESH_ERROR', { stores: current.name }, HttpStatus.BAD_GATEWAY);
      }
      return this.appStoreRepository.updateAppStore(slug, body);
    });
  }

  /**
   * Given an app store ID, delete it from the database and the filesystem
   *
   * @param slug The ID of the app store to delete
   */
  public async deleteAppStore(slug: string) {
    return this.withLock(APP_STORE_CATALOGUE_LOCK, () =>
      this.withLock(appStoreLockKey(slug), async () => {
        const stores = await this.appStoreRepository.getAllAppStores();
        const store = stores.find((appStore) => appStore.slug === slug);
        if (!store) throw new NotFoundException(`App store ${slug} not found`);
        if (stores.length === 1) throw new TranslatableError('APP_STORE_DELETE_ERROR_LAST_STORE', {}, HttpStatus.BAD_REQUEST);
        const count = await this.appStoreRepository.getAppCountForStore(slug);
        if (count && count.count > 0) throw new TranslatableError('APP_STORE_DELETE_ERROR_APPS_EXIST', {}, HttpStatus.BAD_REQUEST);

        const removed = await this.repoHelpers.deleteRepo(slug);
        if (!removed.success) throw new TranslatableError('APP_STORE_DELETE_ERROR', {}, HttpStatus.INTERNAL_SERVER_ERROR);
        await this.appStoreRepository.removeAppStoreEntity(slug);
        return { success: true };
      }),
    );
  }

  public async createAppStore(body: { url: string; name: string }) {
    return this.withLock(APP_STORE_CATALOGUE_LOCK, () => this.createAppStoreLocked(body));
  }

  private async createAppStoreLocked(body: { url: string; name: string }) {
    if (this.config.get('demoMode')) {
      throw new TranslatableError('SERVER_ERROR_NOT_ALLOWED_IN_DEMO');
    }

    if (RESERVED_APP_STORE_SLUGS.includes(body.name.trim().toLowerCase())) {
      throw new TranslatableError('SERVER_ERROR_APP_STORE_NAME_RESERVED', { name: body.name }, HttpStatus.BAD_REQUEST);
    }

    const hash = this.repoHelpers.getRepoHash(body.url);
    const existing = await this.appStoreRepository.getAppStoreByHash(hash);
    if (existing) {
      throw new TranslatableError('SERVER_ERROR_APP_STORE_ALREADY_EXISTS', {}, HttpStatus.CONFLICT);
    }

    const slug = slugify(body.name, { lower: true, trim: true });

    if (!slug || !/^[a-z0-9_-]+$/.test(slug)) {
      throw new BadRequestException('Invalid app store name');
    }

    const existingSlug = await this.appStoreRepository.getAppStoreBySlug(slug);
    if (existingSlug) {
      throw new TranslatableError('SERVER_ERROR_DUPLICATE_APP_STORE_NAME', {}, HttpStatus.CONFLICT);
    }

    return this.withLock(appStoreLockKey(slug), async () => {
      const created = await this.appStoreRepository.createAppStore({ ...body, slug });
      const { success } = await this.repoHelpers.cloneRepo(body.url, created.slug);
      if (!success) {
        await this.appStoreRepository.removeAppStoreEntity(created.slug);
        throw new TranslatableError('APP_STORE_CLONE_ERROR', {}, HttpStatus.BAD_REQUEST);
      }
      return created;
    });
  }

  public async getAppCountForStore(slug: string) {
    return this.appStoreRepository.getAppCountForStore(slug);
  }

  public async deleteAllRepos() {
    const removed = await this.repoHelpers.deleteAllRepos();
    if (!removed.success) throw new TranslatableError('APP_STORE_DELETE_ERROR', {}, HttpStatus.INTERNAL_SERVER_ERROR);
  }
}
