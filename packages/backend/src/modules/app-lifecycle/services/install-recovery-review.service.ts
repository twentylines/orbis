import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createAppUrn } from '@/common/helpers/app-helpers';
import { ConfigurationService } from '@/core/config/configuration.service';
import { AsyncMutex } from '@/utils/mutex/async-mutex';
import { APP_ASYNC_MUTEX } from '@/utils/mutex/mutex.module';
import { Inject, Injectable } from '@nestjs/common';
import type { InstallRecoveryReview } from '@runtipi/common/schemas/install-recovery-review';
import type { AppUrn } from '@runtipi/common/types';
import { AppsRepository } from '../../apps/apps.repository';
import { hasInstallRequestHold, installRequestDirectory } from '../install-request-receipt';

const requestIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const spentDirectoryPattern = /^spent-[a-zA-Z0-9]{6}$/;
const maxReceiptBytes = 4096;

type DirectoryStamp = { directory: string; device: bigint; inode: bigint; changed: bigint };

async function directoryStamp(directory: string, privateMode: boolean): Promise<DirectoryStamp> {
  const stat = await fs.lstat(directory, { bigint: true });
  if (!stat.isDirectory() || (privateMode && (stat.mode & 0o077n || (process.geteuid && stat.uid !== BigInt(process.geteuid()))))) {
    throw new Error('Install recovery directory is unavailable.');
  }
  return { directory, device: stat.dev, inode: stat.ino, changed: stat.ctimeNs };
}

async function singleEntry(directory: string) {
  const entries = await fs.opendir(directory);
  try {
    const first = await entries.read();
    if (first && (await entries.read())) throw new Error('The install hold contains multiple records.');
    return first?.name;
  } finally {
    await entries.close();
  }
}

async function readInstallHold(dataDir: string, appUrn: AppUrn) {
  const directory = installRequestDirectory(dataDir, appUrn);
  const root = path.dirname(directory);
  const parents = [await directoryStamp(dataDir, false)];
  try {
    parents.push(await directoryStamp(path.dirname(root), false), await directoryStamp(root, true), await directoryStamp(directory, true));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }

  const first = await singleEntry(directory);
  if (!first) return null;
  const spent = spentDirectoryPattern.test(first);
  const receiptDirectory = spent ? path.join(directory, first) : directory;
  if (spent) parents.push(await directoryStamp(receiptDirectory, true));
  const requestId = spent ? await singleEntry(receiptDirectory) : first;
  if (!requestId || !requestIdPattern.test(requestId)) throw new Error('Invalid install recovery record.');

  const receipt = path.join(receiptDirectory, requestId);
  const handle = await fs.open(receipt, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat({ bigint: true });
    if (
      !info.isFile() ||
      info.nlink !== 1n ||
      info.size > BigInt(maxReceiptBytes) ||
      info.mode & 0o077n ||
      (process.geteuid && info.uid !== BigInt(process.geteuid()))
    )
      throw new Error('Invalid install recovery record.');
    const content = Buffer.alloc(Number(info.size));
    const { bytesRead } = await handle.read(content, 0, content.length, 0);
    if (bytesRead !== content.length) throw new Error('The install recovery record changed.');

    const verify = async () => {
      const current = await fs.lstat(receipt, { bigint: true });
      if (current.ino !== info.ino || current.dev !== info.dev || current.ctimeNs !== info.ctimeNs || current.size !== info.size) {
        throw new Error('The install recovery record changed.');
      }
      for (const [index, previous] of parents.entries()) {
        const checked = await directoryStamp(previous.directory, index >= 2);
        // Other apps can create entries in shared state without changing this hold.
        if (checked.device !== previous.device || checked.inode !== previous.inode || (index >= 3 && checked.changed !== previous.changed)) {
          throw new Error('The install recovery directory changed.');
        }
      }
    };

    if (content.length === 0 && !spent) return { requestId, phase: 'provisional' as const, row: null, verify };
    const parsed: unknown = JSON.parse(content.toString('utf8'));
    if (
      !Array.isArray(parsed) ||
      !(
        (parsed[0] === 1 && parsed.length === 7) ||
        (parsed[0] === 2 && parsed.length === 8) ||
        (parsed[0] === 3 && parsed.length === 9 && parsed[8] === true)
      )
    )
      throw new Error('Invalid install recovery record.');
    const [version, owner, id, createdAt, appName, appStoreSlug, skipRun, appVersion] = parsed;
    if (
      (version !== 1 && (typeof appVersion !== 'number' || !Number.isSafeInteger(appVersion) || appVersion < 0)) ||
      typeof owner !== 'string' ||
      !requestIdPattern.test(owner) ||
      typeof skipRun !== 'boolean' ||
      typeof id !== 'number' ||
      !Number.isSafeInteger(id) ||
      id <= 0 ||
      typeof createdAt !== 'number' ||
      !Number.isSafeInteger(createdAt) ||
      createdAt < 0 ||
      typeof appName !== 'string' ||
      typeof appStoreSlug !== 'string' ||
      createAppUrn(appName, appStoreSlug) !== appUrn
    )
      throw new Error('Invalid install recovery record.');
    return {
      requestId,
      phase: spent ? ('spent' as const) : ('pending' as const),
      row: { id, createdAt, ...(version !== 1 ? { version: Number(appVersion) } : {}) },
      verify,
    };
  } finally {
    await handle.close();
  }
}

@Injectable()
export class InstallRecoveryReviewService {
  constructor(
    private readonly config: ConfigurationService,
    private readonly apps: AppsRepository,
    @Inject(APP_ASYNC_MUTEX) private readonly mutex: AsyncMutex,
  ) {}

  async review(appUrn: AppUrn): Promise<InstallRecoveryReview> {
    const sampled = () => ({ appUrn, sampledAt: new Date().toISOString() });
    const dataDir = this.config.get('directories').dataDir;
    try {
      if (this.mutex.resourceLocks.has(appUrn)) {
        const held = await hasInstallRequestHold(dataDir, appUrn);
        return { ...sampled(), state: held ? 'busy' : 'clear', hold: null };
      }
      const release = await this.mutex.acquire(appUrn);
      try {
        const receipt = await readInstallHold(dataDir, appUrn);
        if (!receipt) return { ...sampled(), state: 'clear', hold: null };
        let reservation: NonNullable<InstallRecoveryReview['hold']>['reservation'] = 'unconfirmed';
        if (receipt.row) {
          const app = await this.apps.getAppByUrn(appUrn);
          if (!app) reservation = 'missing';
          else if (
            app.id === receipt.row.id &&
            app.createdAt === receipt.row.createdAt &&
            (receipt.row.version === undefined || app.version === receipt.row.version) &&
            createAppUrn(app.appName, app.appStoreSlug) === appUrn
          ) {
            reservation = 'matches';
          } else reservation = 'changed';
        }
        await receipt.verify();
        return { ...sampled(), state: 'held', hold: { requestId: receipt.requestId, phase: receipt.phase, reservation } };
      } finally {
        release();
      }
    } catch {
      return { ...sampled(), state: 'unverified', hold: null };
    }
  }
}
