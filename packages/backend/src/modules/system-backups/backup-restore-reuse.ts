import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { BackupRequirementError } from './backup-files';
import type { BackupRestoreJournal } from './backup-restore-journal';

const failed = () => new BackupRequirementError('The saved restore archive could not be verified. Its recovery files have been preserved.');
async function directory(value: string) {
  const stat = await fs.lstat(value);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.mode & 0o077 ||
    (process.getuid && stat.uid !== process.getuid()) ||
    (await fs.realpath(value)) !== value
  )
    throw failed();
}
const signature = (stat: Awaited<ReturnType<Awaited<ReturnType<typeof fs.open>>['stat']>>) =>
  [stat.dev, stat.ino, stat.size, stat.uid, stat.mode, stat.nlink, stat.mtimeMs, stat.ctimeMs].join(':');

// The journal keeps ownership; only a separately verified ciphertext copy enters import retention.
export async function reuseRestoreArchive<T>(
  journal: BackupRestoreJournal,
  ownerId: number,
  signal: AbortSignal,
  consume: (source: Readable, bytes: number, verify: () => Promise<void>) => Promise<T>,
) {
  signal.throwIfAborted();
  const source = path.join(journal.directory, 'source');
  const payload = path.join(source, 'payload');
  await directory(journal.directory);
  await directory(source);
  await directory(payload);
  const metadata = await fs.open(path.join(payload, 'job.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
  let expected: number;
  try {
    const stat = await metadata.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.mode & 0o077 || stat.size > 16 * 1024 || (process.getuid && stat.uid !== process.getuid()))
      throw failed();
    const job: unknown = JSON.parse(await metadata.readFile('utf8'));
    if (
      !job ||
      typeof job !== 'object' ||
      !('id' in job) ||
      typeof job.id !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(job.id) ||
      !('ownerId' in job) ||
      job.ownerId !== ownerId ||
      !('uploadedBytes' in job) ||
      !Number.isSafeInteger(job.uploadedBytes) ||
      typeof job.uploadedBytes !== 'number' ||
      job.uploadedBytes < 52 ||
      'origin' in job
    )
      throw failed();
    expected = job.uploadedBytes;
  } finally {
    await metadata.close();
  }
  const file = path.join(payload, 'backup.orbis');
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let stream: Readable | undefined;
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.mode & 0o077 ||
      before.size !== expected ||
      (process.getuid && before.uid !== process.getuid()) ||
      (await fs.realpath(file)) !== file
    )
      throw failed();
    const digest = createHash('sha256');
    signal.throwIfAborted();
    for await (const chunk of handle.createReadStream({ autoClose: false, start: 0, signal })) digest.update(chunk);
    const expectedDigest = digest.digest('hex');
    if (signature(before) !== signature(await handle.stat())) throw failed();
    const copying = createHash('sha256');
    stream = Readable.from(
      (async function* () {
        for await (const chunk of handle.createReadStream({ autoClose: false, start: 0, signal })) {
          copying.update(chunk);
          yield chunk;
        }
      })(),
    );
    return await consume(stream, expected, async () => {
      signal.throwIfAborted();
      await directory(source);
      await directory(payload);
      const after = await handle.stat();
      const named = await fs.lstat(file);
      if (copying.digest('hex') !== expectedDigest || signature(before) !== signature(after) || signature(after) !== signature(named)) throw failed();
    });
  } finally {
    stream?.destroy();
    await handle.close();
  }
}
