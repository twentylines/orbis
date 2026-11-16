import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { privateBackupDirectory } from './backup-files';
import { canonicalCoreJson } from './time-machine-core-payload';
import { TimeMachineStore } from './time-machine-store';
import { importCapsule } from '../time-machine-capsules/capsule';
import { coreCapsuleReview, verifyCapsuleContents, type VerifiedCapsuleContents } from '../time-machine-capsules/verify';
import type { CoreCapsulePayload } from '../time-machine-capsules/core-capsule-review';

export const corePortableWorkerCapability = Object.freeze({
  schema: 'orbis.core-portable-worker.v1',
  version: 1,
  pointVersion: 3,
  input: '/input',
  output: '/work',
  authority: 'destination-root-required',
  plaintextPayload: 'root-private-authenticated-custody',
  activation: false,
});
const fail = () => new Error('The portable core point could not be authenticated and staged.');
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const same = (a: Awaited<ReturnType<typeof fs.lstat>>, b: Awaited<ReturnType<typeof fs.lstat>>) =>
  ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].every((key) => Reflect.get(a, key) === Reflect.get(b, key));

async function bounded(file: string, maximum: number) {
  const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.uid !== process.getuid?.() ||
      ![0o400, 0o600].includes(before.mode & 0o7777) ||
      before.size < 1 ||
      before.size > maximum ||
      (await fs.realpath(file)) !== file
    )
      throw fail();
    const data = await handle.readFile();
    if (data.length !== before.size || !same(before, await handle.stat()) || !same(before, await fs.lstat(file))) throw fail();
    return data;
  } finally {
    await handle.close();
  }
}
async function materialize(payload: CoreCapsulePayload, output: string, signal: AbortSignal) {
  const required = payload.manifest.entries.reduce((sum, entry) => sum + entry.bytes, 0);
  const space = await fs.statfs(output, { bigint: true });
  if (!Number.isSafeInteger(required) || space.bavail * space.bsize < BigInt(required + 256 * 1024 * 1024)) throw fail();
  const directory = path.join(output, 'payload');
  await fs.mkdir(directory, { mode: 0o700 });
  await fs.mkdir(path.join(directory, 'images'), { mode: 0o700 });
  const files: Record<string, { bytes: number; sha256: string }> = {};
  for (const entry of payload.manifest.entries) {
    if (entry.name !== 'checkpoint.tar' && !/^images\/image-[a-f0-9]{64}\.tar$/.test(entry.name)) throw fail();
    const source = path.join(payload.directory, entry.name);
    const input = await fs.open(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const before = await input.stat();
      if (
        !before.isFile() ||
        before.uid !== process.getuid?.() ||
        before.nlink !== 1 ||
        (before.mode & 0o7777) !== 0o600 ||
        before.size !== entry.bytes ||
        (await fs.realpath(source)) !== source
      )
        throw fail();
      const destination = await fs.open(
        path.join(directory, entry.name),
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
        0o600,
      );
      try {
        const digest = createHash('sha256');
        let bytes = 0;
        for await (const raw of input.createReadStream({ autoClose: false, highWaterMark: 65536 })) {
          signal.throwIfAborted();
          const chunk = Buffer.from(raw);
          bytes += chunk.length;
          if (bytes > entry.bytes) throw fail();
          digest.update(chunk);
          let offset = 0;
          while (offset < chunk.length) {
            const result = await destination.write(chunk, offset, chunk.length - offset);
            if (!result.bytesWritten) throw fail();
            offset += result.bytesWritten;
          }
        }
        if (
          bytes !== entry.bytes ||
          digest.digest('hex') !== entry.sha256 ||
          !same(before, await input.stat()) ||
          !same(before, await fs.lstat(source))
        )
          throw fail();
        await destination.chmod(0o400);
        await destination.sync();
        files[entry.name] = { bytes: entry.bytes, sha256: entry.sha256 };
      } finally {
        await destination.close();
      }
    } finally {
      await input.close();
    }
  }
  const encoded = Buffer.from(canonicalCoreJson(payload.manifest));
  const file = await fs.open(path.join(directory, 'manifest.json'), 'wx', 0o400);
  try {
    await file.writeFile(encoded);
    await file.sync();
  } finally {
    await file.close();
  }
  files['manifest.json'] = { bytes: encoded.length, sha256: hash(encoded) };
  for (const name of [path.join(directory, 'images'), directory]) {
    const handle = await fs.open(name, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  return { schema: 'orbis.core-portable-payload.v1' as const, pointId: payload.manifest.pointId, manifestSha256: hash(encoded), files };
}

/** Fixed-path data worker. Root owns invocation, immutable input custody and publication authority. */
export async function stageCorePortableEnrollment(options: { input: string; output: string; signal: AbortSignal }) {
  const { input, output, signal } = options;
  for (const directory of [input, output]) {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o700 || (await fs.realpath(directory)) !== directory)
      throw fail();
  }
  if ((await fs.readdir(output)).length !== 0) throw fail();
  const encoded = await bounded(path.join(input, 'request.json'), 16384);
  let request: { operationId: string; capsuleSha256: string; ownerId: number; keyId: string; passphrase: string };
  try {
    request = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(encoded));
  } finally {
    encoded.fill(0);
  }
  if (
    !request ||
    Object.keys(request).sort().join(',') !== 'capsuleSha256,keyId,operationId,ownerId,passphrase' ||
    !uuid(request.operationId) ||
    !digest(request.capsuleSha256) ||
    !digest(request.keyId) ||
    !Number.isSafeInteger(request.ownerId) ||
    request.ownerId < 1 ||
    typeof request.passphrase !== 'string' ||
    request.passphrase.length < 8 ||
    request.passphrase.length > 1024
  )
    throw fail();
  const master = await bounded(path.join(input, 'master-v1.key'), 32);
  if (master.length !== 32 || hash(master) !== request.keyId) {
    master.fill(0);
    throw fail();
  }
  const library = path.join(output, 'library');
  const keys = path.join(library, 'backups/time-machine/keys');
  for (const directory of [library, path.join(library, 'backups'), path.join(library, 'backups/time-machine'), keys])
    await privateBackupDirectory(directory);
  try {
    const file = await fs.open(path.join(keys, 'master-v1.key'), 'wx', 0o600);
    try {
      await file.writeFile(master);
      await file.sync();
    } finally {
      await file.close();
    }
  } finally {
    master.fill(0);
  }
  const staging = path.join(output, 'capsules');
  await privateBackupDirectory(staging);
  let token: VerifiedCapsuleContents | undefined;
  let payload: Awaited<ReturnType<typeof materialize>> | undefined;
  const imported = await importCapsule({
    source: path.join(input, 'capsule.orbis-tm'),
    passphrase: request.passphrase,
    expectedSha256: request.capsuleSha256,
    stagingParent: staging,
    signal,
    verify: async (manifest, directory, signal) => {
      if (manifest.schema !== 'orbis.time-machine-capsule-private.v2') throw fail();
      token = await verifyCapsuleContents({
        manifest,
        directory,
        signal,
        database: {
          review: async () => {
            throw fail();
          },
        },
        target: { orbisVersion: '', runtipiVersion: '', architecture: '' },
        corePayload: async (verified) => {
          payload = await materialize(verified, output, signal);
        },
      });
    },
  });
  try {
    if (!token || !payload) throw fail();
    const summary = await coreCapsuleReview(token, signal);
    const { point, sourceOwnerId } = await new TimeMachineStore(library).stagePortableCorePoint(request.ownerId, token, signal);
    if (sourceOwnerId !== summary.sourceOwnerId || point.envelope.keyId !== request.keyId) throw fail();
    const directory = path.join(library, 'backups/time-machine/points', point.id);
    const files: Record<string, { bytes: number; sha256: string }> = {};
    for (const name of (await fs.readdir(directory)).sort()) {
      if (!['point.json', 'core.orbis', 'metadata.orbis', 'capture-draft.orbis', 'wallpaper.orbis', 'icons.orbis'].includes(name)) throw fail();
      const file = path.join(directory, name);
      const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.() || (before.mode & 0o7777) !== 0o600) throw fail();
        const sha = createHash('sha256');
        let bytes = 0;
        for await (const raw of handle.createReadStream({ autoClose: false, highWaterMark: 65536 })) {
          signal.throwIfAborted();
          bytes += raw.length;
          sha.update(raw);
        }
        if (bytes !== before.size || !same(before, await handle.stat()) || !same(before, await fs.lstat(file))) throw fail();
        files[name] = { bytes, sha256: sha.digest('hex') };
      } finally {
        await handle.close();
      }
    }
    const receipt = {
      schema: 'orbis.core-portable-staged.v1' as const,
      operationId: request.operationId,
      capsuleId: imported.capsuleId,
      capsuleSha256: imported.sha256,
      pointId: point.id,
      createdAt: point.createdAt,
      sourceOwnerId,
      ownerId: point.ownerId,
      keyId: request.keyId,
      metadata: summary.metadata,
      files,
      payload,
      restoreSupported: false as const,
    };
    const handle = await fs.open(path.join(output, 'review.json'), 'wx', 0o600);
    try {
      await handle.writeFile(canonicalCoreJson(receipt));
      await handle.sync();
    } finally {
      await handle.close();
    }
    return receipt;
  } finally {
    await imported.dispose();
  }
}

export async function runCorePortableWorker(args: readonly string[]) {
  if (args.length === 1 && args[0] === '--capability') return corePortableWorkerCapability;
  if (args.length !== 1 || args[0] !== '--stage' || process.platform !== 'linux' || process.getuid?.() !== 0) throw fail();
  return stageCorePortableEnrollment({ input: '/input', output: '/work', signal: AbortSignal.timeout(30 * 60_000) });
}
