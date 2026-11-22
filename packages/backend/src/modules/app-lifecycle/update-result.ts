import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AppUrn } from '@runtipi/common/types';
import { appUpdateStorage as files } from '../docker/app-image-pins';
import { ordinaryUpdateFailure, verifyOrdinaryUpdateResult, type OrdinaryUpdateResult } from '../apps/app-update-commit';

function location(dataDir: string, requestId: string) {
  if (
    !path.isAbsolute(dataDir) ||
    path.resolve(dataDir) !== dataDir ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(requestId)
  )
    throw ordinaryUpdateFailure();
  return path.join(dataDir, 'ordinary-results', `${requestId}.json`);
}

/** Private update intent survives stage cleanup. It never establishes completion without the exact current SQL receipt. */
export async function readOrdinaryUpdateResult(dataDir: string, appUrn: AppUrn, requestId: string) {
  const name = location(dataDir, requestId);
  await files.noSymlinkParents(dataDir);
  const root = path.dirname(path.dirname(name));
  if (!(await files.directorySafe(root, false)) || !(await files.directorySafe(path.dirname(name), false))) return;
  const parent = await fs.open(path.dirname(name), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let file: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    const info = await parent.stat();
    const selected = process.platform === 'linux' ? `/proc/self/fd/${parent.fd}/${path.basename(name)}` : name;
    try {
      file = await fs.open(selected, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const stat = await file.stat({ bigint: true });
    if (
      !stat.isFile() ||
      stat.nlink !== 1n ||
      stat.mode & 0o077n ||
      stat.size > 64n * 1024n ||
      (process.geteuid && stat.uid !== BigInt(process.geteuid()))
    )
      throw ordinaryUpdateFailure();
    const bytes = Buffer.alloc(Number(stat.size) + 1);
    const read = await file.read(bytes, 0, bytes.length, 0);
    const after = await file.stat({ bigint: true });
    const named = await fs.lstat(name, { bigint: true });
    const directory = await fs.lstat(path.dirname(name));
    if (
      read.bytesRead !== Number(stat.size) ||
      [after, named].some((value) =>
        ['dev', 'ino', 'uid', 'gid', 'mode', 'size', 'nlink', 'mtimeNs', 'ctimeNs'].some((key) => Reflect.get(value, key) !== Reflect.get(stat, key)),
      ) ||
      !files.sameDirectory(directory, files.directoryIdentity(info))
    )
      throw ordinaryUpdateFailure();
    await files.noSymlinkParents(root);
    const body = bytes.subarray(0, read.bytesRead);
    const result = verifyOrdinaryUpdateResult(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)));
    if (result.appUrn !== appUrn || result.requestId !== requestId || !body.equals(Buffer.from(JSON.stringify(result))))
      throw ordinaryUpdateFailure();
    return result;
  } finally {
    await file?.close();
    await parent.close();
  }
}

export async function retainOrdinaryUpdateResult(dataDir: string, raw: OrdinaryUpdateResult) {
  const result = verifyOrdinaryUpdateResult(raw);
  const name = location(dataDir, result.requestId);
  const root = path.dirname(path.dirname(name));
  await files.noSymlinkParents(dataDir);
  await files.directorySafe(root, true);
  await files.directorySafe(path.dirname(name), true);
  const parent = await fs.open(path.dirname(name), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const info = await parent.stat();
    const selected = process.platform === 'linux' ? `/proc/self/fd/${parent.fd}/${path.basename(name)}` : name;
    let file: Awaited<ReturnType<typeof fs.open>>;
    try {
      file = await fs.open(selected, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (JSON.stringify(await readOrdinaryUpdateResult(dataDir, result.appUrn, result.requestId)) !== JSON.stringify(result))
        throw ordinaryUpdateFailure();
      return;
    }
    try {
      await file.writeFile(JSON.stringify(result));
      await file.sync();
    } finally {
      await file.close();
    }
    await parent.sync();
    await files.syncDirectory(root);
    if (
      !files.sameDirectory(await fs.lstat(path.dirname(name)), files.directoryIdentity(info)) ||
      JSON.stringify(await readOrdinaryUpdateResult(dataDir, result.appUrn, result.requestId)) !== JSON.stringify(result)
    )
      throw ordinaryUpdateFailure();
  } finally {
    await parent.close();
  }
}
