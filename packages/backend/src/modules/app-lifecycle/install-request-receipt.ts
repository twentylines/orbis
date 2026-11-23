import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createAppUrn } from '@/common/helpers/app-helpers';
import type { AppUrn } from '@runtipi/common/types';
import type { InstallAppReservation } from '../apps/apps.repository';

const requestIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

type InstallRequest = {
  requestId: string;
  owner: string;
  app: InstallAppReservation & { version?: number };
  skipRun: boolean;
};
type InstallRequestDraft = Omit<InstallRequest, 'app'>;

declare const ownershipBrand: unique symbol;
/** Live ownership of a claimed request. Copies and deserialized records cannot authorize installation. */
export type InstallRequestOwnership = Readonly<{
  appUrn: AppUrn;
  requestId: string;
  skipRun: boolean;
  reservation: Readonly<InstallAppReservation & { version?: number }>;
  [ownershipBrand]: true;
}>;
const ownershipChecks = new WeakMap<InstallRequestOwnership, () => Promise<void>>();
const ownershipFailure = () => new Error('The app install request ownership could not be verified. Its files were preserved.');
export async function verifyInstallRequestOwnership(ownership: InstallRequestOwnership, appUrn: AppUrn, requestId: string) {
  const verify = ownershipChecks.get(ownership);
  if (!verify || ownership.appUrn !== appUrn || ownership.requestId !== requestId) throw ownershipFailure();
  await verify();
  return { ...ownership.reservation };
}
const directoryIdentity = (info: BigIntStats) => [info.dev, info.ino, info.uid, info.gid, info.mode].join(':');
const fileIdentity = (info: BigIntStats) =>
  [info.dev, info.ino, info.uid, info.gid, info.mode, info.nlink, info.size, info.mtimeNs, info.ctimeNs].join(':');

export function installRequestDirectory(dataDir: string, appUrn: AppUrn) {
  return path.join(dataDir, 'state', 'orbis-install-requests', createHash('sha256').update(appUrn).digest('hex'));
}

function receiptBytes({ owner, app, skipRun }: InstallRequest) {
  if (app.preserveExisting) {
    if (!Number.isSafeInteger(app.version) || Number(app.version) < 0) throw ownershipFailure();
    return Buffer.from(JSON.stringify([3, owner, app.id, app.createdAt, app.appName, app.appStoreSlug, skipRun, app.version, true]));
  }
  if (app.version === undefined) return Buffer.from(JSON.stringify([1, owner, app.id, app.createdAt, app.appName, app.appStoreSlug, skipRun]));
  if (!Number.isSafeInteger(app.version) || app.version < 0) throw ownershipFailure();
  return Buffer.from(JSON.stringify([2, owner, app.id, app.createdAt, app.appName, app.appStoreSlug, skipRun, app.version]));
}

async function openDirectory(directory: string, requirePrivate = false) {
  const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    if (requirePrivate) {
      const info = await handle.stat();
      if (info.mode & 0o077 || (process.geteuid && info.uid !== process.geteuid())) throw new Error('Install request storage is unavailable.');
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function syncDirectory(directory: string) {
  const parent = await openDirectory(directory);
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
}

async function openReceiptDirectory(dataDir: string, directory: string) {
  await (await openDirectory(dataDir)).close();
  await (await openDirectory(path.join(dataDir, 'state'))).close();
  await (await openDirectory(path.dirname(directory), true)).close();
  return openDirectory(directory, true);
}

export async function hasInstallRequestHold(dataDir: string, appUrn: AppUrn) {
  const directory = installRequestDirectory(dataDir, appUrn);
  const held: { directory: string; handle: Awaited<ReturnType<typeof openDirectory>>; identity: string }[] = [];
  const identity = (info: import('node:fs').BigIntStats) =>
    [info.dev, info.ino, info.mode, info.uid, info.gid, info.nlink, info.mtimeNs, info.ctimeNs].join(':');
  const verify = async () => {
    for (const entry of held) {
      if (
        identity(await entry.handle.stat({ bigint: true })) !== entry.identity ||
        identity(await fs.lstat(entry.directory, { bigint: true })) !== entry.identity
      )
        throw new Error('Install request storage changed while it was being checked.');
    }
  };
  const pin = async (name: string, requirePrivate = false) => {
    const handle = await openDirectory(name, requirePrivate);
    try {
      const info = await handle.stat({ bigint: true });
      if (requirePrivate && (info.mode & 0o077n || (process.geteuid && info.uid !== BigInt(process.geteuid()))))
        throw new Error('Install request storage is unavailable.');
      held.push({ directory: name, handle, identity: identity(info) });
    } catch (error) {
      await handle.close();
      throw error;
    }
  };
  try {
    // The configured store must exist. Only optional receipt namespaces may
    // be absent, with every already-observed parent still the same directory.
    await pin(dataDir);
    for (const name of [path.join(dataDir, 'state'), path.dirname(directory), directory]) {
      try {
        await pin(name, name !== path.join(dataDir, 'state'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await verify();
        await fs.lstat(name).then(
          () => {
            throw new Error('Install request storage appeared while it was being checked.');
          },
          (missing: NodeJS.ErrnoException) => {
            if (missing.code !== 'ENOENT') throw missing;
          },
        );
        await verify();
        return false;
      }
    }
    const entries = await fs.opendir(directory);
    try {
      const present = (await entries.read()) !== null;
      await verify();
      return present;
    } finally {
      await entries.close();
    }
  } finally {
    await Promise.all(held.map(({ handle }) => handle.close()));
  }
}

export async function reserveInstallRequest<T extends InstallAppReservation>(
  dataDir: string,
  appUrn: AppUrn,
  request: InstallRequestDraft,
  createApp: () => Promise<T>,
) {
  if (!requestIdPattern.test(request.requestId)) throw new Error('Invalid install request ID.');
  const directory = installRequestDirectory(dataDir, appUrn);
  const root = path.dirname(directory);
  const state = path.dirname(root);
  await syncDirectory(dataDir);
  await fs.mkdir(state, { recursive: true, mode: 0o700 });
  await syncDirectory(state);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await (await openDirectory(root, true)).close();
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const parent = await openDirectory(directory, true);
  try {
    const handle = await fs.open(path.join(directory, request.requestId), 'wx', 0o600);
    try {
      // An empty provisional receipt holds the URN if row creation is interrupted.
      await handle.sync();
      await parent.sync();
      await syncDirectory(root);
      await syncDirectory(state);
      await syncDirectory(dataDir);
      const app = await createApp();
      if (createAppUrn(app.appName, app.appStoreSlug) !== appUrn) throw new Error('The app install reservation returned a different app.');
      await handle.writeFile(receiptBytes({ ...request, app }));
      await handle.sync();
      return app;
    } finally {
      await handle.close();
    }
  } finally {
    await parent.close();
  }
}

export async function takeInstallRequestReceipt(dataDir: string, request: InstallRequest) {
  if (!requestIdPattern.test(request.requestId)) return undefined;
  const directory = installRequestDirectory(dataDir, createAppUrn(request.app.appName, request.app.appStoreSlug));
  const file = path.join(directory, request.requestId);
  try {
    const parent = await openReceiptDirectory(dataDir, directory);
    try {
      const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await handle.stat({ bigint: true });
        const expected = receiptBytes(request);
        if (
          !info.isFile() ||
          info.nlink !== 1n ||
          info.size !== BigInt(expected.length) ||
          info.mode & 0o077n ||
          (process.geteuid && info.uid !== BigInt(process.geteuid()))
        )
          return undefined;
        const buffer = Buffer.alloc(expected.length);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead !== expected.length || !buffer.equals(expected)) return undefined;

        // Claim by moving the unique name to a different destination for each contender.
        // Concurrent unlink calls can both report success for the same pathname.
        const spentDirectory = await fs.mkdtemp(path.join(directory, 'spent-'));
        const spent = path.join(spentDirectory, request.requestId);
        try {
          await fs.rename(file, spent);
        } catch (error) {
          await fs.rmdir(spentDirectory).catch(() => undefined);
          throw error;
        }
        const moved = await fs.lstat(spent, { bigint: true });
        const reread = await handle.read(buffer, 0, buffer.length, 0);
        const original = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return undefined;
          throw error;
        });
        if (
          original ||
          !moved.isFile() ||
          moved.nlink !== 1n ||
          moved.ino !== info.ino ||
          moved.dev !== info.dev ||
          moved.mode !== info.mode ||
          moved.uid !== info.uid ||
          moved.size !== info.size ||
          reread.bytesRead !== expected.length ||
          !buffer.equals(expected)
        )
          throw new Error('The app install ownership receipt changed.');
        await handle.sync();
        await syncDirectory(spentDirectory);
        await parent.sync();

        const names = [dataDir, path.join(dataDir, 'state'), path.dirname(directory), directory, spentDirectory];
        const parents = await Promise.all(names.map(async (name) => ({ name, identity: directoryIdentity(await fs.lstat(name, { bigint: true })) })));
        let retired = false;
        const verify = async () => {
          const opened: Awaited<ReturnType<typeof openDirectory>>[] = [];
          let receipt: Awaited<ReturnType<typeof fs.open>> | undefined;
          try {
            if (retired) throw ownershipFailure();
            for (const entry of parents) {
              const selected = await openDirectory(entry.name, [path.dirname(directory), directory, spentDirectory].includes(entry.name));
              opened.push(selected);
              if (directoryIdentity(await selected.stat({ bigint: true })) !== entry.identity) throw ownershipFailure();
            }
            if ((await fs.readdir(spentDirectory)).join('\0') !== request.requestId) throw ownershipFailure();
            await fs.lstat(file).then(
              () => {
                throw ownershipFailure();
              },
              (error: NodeJS.ErrnoException) => {
                if (error.code !== 'ENOENT') throw error;
              },
            );
            receipt = await fs.open(spent, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            const observed = await receipt.stat({ bigint: true });
            if (!observed.isFile() || fileIdentity(observed) !== fileIdentity(moved)) throw ownershipFailure();
            const body = Buffer.alloc(expected.length + 1);
            const read = await receipt.read(body, 0, body.length, 0);
            if (read.bytesRead !== expected.length || !body.subarray(0, read.bytesRead).equals(expected)) throw ownershipFailure();
            if (
              fileIdentity(await receipt.stat({ bigint: true })) !== fileIdentity(moved) ||
              fileIdentity(await fs.lstat(spent, { bigint: true })) !== fileIdentity(moved)
            )
              throw ownershipFailure();
            for (let index = 0; index < parents.length; index++) {
              const entry = parents[index];
              const selected = opened[index];
              if (
                !entry ||
                !selected ||
                directoryIdentity(await selected.stat({ bigint: true })) !== entry.identity ||
                directoryIdentity(await fs.lstat(entry.name, { bigint: true })) !== entry.identity
              )
                throw ownershipFailure();
            }
          } catch {
            throw ownershipFailure();
          } finally {
            await receipt?.close();
            await Promise.all(opened.map((selected) => selected.close()));
          }
        };
        const reservation = Object.freeze({
          id: request.app.id,
          createdAt: request.app.createdAt,
          appName: request.app.appName,
          appStoreSlug: request.app.appStoreSlug,
          ...(request.app.version === undefined ? {} : { version: request.app.version }),
          ...(request.app.preserveExisting ? { preserveExisting: true as const } : {}),
        });
        const ownership = Object.freeze({
          appUrn: createAppUrn(reservation.appName, reservation.appStoreSlug),
          requestId: request.requestId,
          skipRun: request.skipRun,
          reservation,
        }) as InstallRequestOwnership;
        ownershipChecks.set(ownership, verify);
        await verify();
        const cleanup = async () => {
          await verify();
          await retireReceiptDirectory(directory, spentDirectory, request.requestId, moved, expected);
          retired = true;
          ownershipChecks.delete(ownership);
        };
        return Object.freeze(Object.assign(cleanup, { ownership }));
      } finally {
        await handle.close();
      }
    } finally {
      await parent.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function retireReceiptDirectory(directory: string, selected: string, requestId: string, expected: BigIntStats, bytes: Buffer) {
  const completed = path.join(directory, `completed-${requestId}`);
  if (selected !== completed) {
    await fs.lstat(completed).then(
      () => {
        throw ownershipFailure();
      },
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      },
    );
    const original = await fs.lstat(selected, { bigint: true });
    await fs.rename(selected, completed);
    if (directoryIdentity(await fs.lstat(completed, { bigint: true })) !== directoryIdentity(original)) throw ownershipFailure();
    await syncDirectory(directory);
  }
  const name = path.join(completed, requestId);
  const handle = await fs.open(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (fileIdentity(await handle.stat({ bigint: true })) !== fileIdentity(expected)) throw ownershipFailure();
    const body = Buffer.alloc(bytes.length + 1);
    const read = await handle.read(body, 0, body.length, 0);
    if (
      read.bytesRead !== bytes.length ||
      !body.subarray(0, read.bytesRead).equals(bytes) ||
      fileIdentity(await fs.lstat(name, { bigint: true })) !== fileIdentity(expected)
    )
      throw ownershipFailure();
    await fs.unlink(name);
    await syncDirectory(completed);
  } finally {
    await handle.close();
  }
  await fs.rmdir(completed);
  await syncDirectory(directory);
}

/** Reopens custody for outcome verification only. This deliberately cannot mint InstallRequestOwnership or execute installation. */
export async function reopenSpentInstallRequest(dataDir: string, appUrn: AppUrn, requestId: string) {
  if (!requestIdPattern.test(requestId)) return;
  const directory = installRequestDirectory(dataDir, appUrn);
  let parent: Awaited<ReturnType<typeof openDirectory>>;
  try {
    parent = await openReceiptDirectory(dataDir, directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  try {
    const names = await fs.readdir(directory);
    if (!names.length) return;
    if (names.length !== 1) throw ownershipFailure();
    const selectedName = names[0];
    if (!selectedName || (!/^spent-[a-zA-Z0-9]{6}$/.test(selectedName) && selectedName !== `completed-${requestId}`)) return;
    const selected = path.join(directory, selectedName);
    await (await openDirectory(selected, true)).close();
    const parents = await Promise.all(
      [dataDir, path.join(dataDir, 'state'), path.dirname(directory), directory, selected].map(async (name) => ({
        name,
        identity: directoryIdentity(await fs.lstat(name, { bigint: true })),
      })),
    );
    const children = await fs.readdir(selected);
    let retired = false;
    const verifyParents = async () => {
      if (retired) throw ownershipFailure();
      for (const entry of parents) {
        const handle = await openDirectory(entry.name, entry.name !== dataDir && entry.name !== path.join(dataDir, 'state'));
        try {
          if (
            directoryIdentity(await handle.stat({ bigint: true })) !== entry.identity ||
            directoryIdentity(await fs.lstat(entry.name, { bigint: true })) !== entry.identity
          )
            throw ownershipFailure();
        } finally {
          await handle.close();
        }
      }
      if ((await fs.readdir(directory)).join('\0') !== selectedName) throw ownershipFailure();
    };
    if (children.length === 0 && selectedName === `completed-${requestId}`) {
      const verify = async () => {
        await verifyParents();
        if ((await fs.readdir(selected)).length) throw ownershipFailure();
      };
      await verify();
      return Object.freeze({
        reservation: null,
        skipRun: null,
        verify,
        retire: async () => {
          await verify();
          await fs.rmdir(selected);
          retired = true;
          await syncDirectory(directory);
        },
      });
    }
    if (children.length !== 1 || children[0] !== requestId) throw ownershipFailure();
    const name = path.join(selected, requestId);
    const file = await fs.open(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let info: BigIntStats;
    let bytes: Buffer;
    let request: InstallRequest;
    try {
      info = await file.stat({ bigint: true });
      if (
        !info.isFile() ||
        info.nlink !== 1n ||
        info.mode & 0o077n ||
        info.size > 4096n ||
        (process.geteuid && info.uid !== BigInt(process.geteuid()))
      )
        throw ownershipFailure();
      const body = Buffer.alloc(Number(info.size) + 1);
      const read = await file.read(body, 0, body.length, 0);
      if (read.bytesRead !== Number(info.size)) throw ownershipFailure();
      bytes = body.subarray(0, read.bytesRead);
      const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!Array.isArray(parsed) || !((parsed[0] === 2 && parsed.length === 8) || (parsed[0] === 3 && parsed.length === 9 && parsed[8] === true)))
        return;
      const [, owner, id, createdAt, appName, appStoreSlug, skipRun, version] = parsed;
      if (
        typeof owner !== 'string' ||
        !requestIdPattern.test(owner) ||
        typeof skipRun !== 'boolean' ||
        typeof id !== 'number' ||
        !Number.isSafeInteger(id) ||
        id <= 0 ||
        typeof createdAt !== 'number' ||
        !Number.isSafeInteger(createdAt) ||
        createdAt < 0 ||
        typeof version !== 'number' ||
        !Number.isSafeInteger(version) ||
        version < 0 ||
        typeof appName !== 'string' ||
        typeof appStoreSlug !== 'string' ||
        createAppUrn(appName, appStoreSlug) !== appUrn
      )
        throw ownershipFailure();
      request = {
        owner,
        requestId,
        skipRun,
        app: { id, createdAt, appName, appStoreSlug, version, ...(parsed[0] === 3 ? { preserveExisting: true as const } : {}) },
      };
      if (!receiptBytes(request).equals(bytes)) throw ownershipFailure();
    } finally {
      await file.close();
    }
    const verify = async () => {
      await verifyParents();
      if ((await fs.readdir(selected)).join('\0') !== requestId) throw ownershipFailure();
      const handle = await fs.open(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        if (fileIdentity(await handle.stat({ bigint: true })) !== fileIdentity(info)) throw ownershipFailure();
        const body = Buffer.alloc(bytes.length + 1);
        const read = await handle.read(body, 0, body.length, 0);
        if (
          read.bytesRead !== bytes.length ||
          !body.subarray(0, read.bytesRead).equals(bytes) ||
          fileIdentity(await handle.stat({ bigint: true })) !== fileIdentity(info) ||
          fileIdentity(await fs.lstat(name, { bigint: true })) !== fileIdentity(info)
        )
          throw ownershipFailure();
      } finally {
        await handle.close();
      }
      await verifyParents();
    };
    await verify();
    return Object.freeze({
      reservation: Object.freeze({ ...request.app }),
      skipRun: request.skipRun,
      verify,
      retire: async () => {
        await verify();
        await retireReceiptDirectory(directory, selected, requestId, info, bytes);
        retired = true;
      },
    });
  } finally {
    await parent.close();
  }
}
