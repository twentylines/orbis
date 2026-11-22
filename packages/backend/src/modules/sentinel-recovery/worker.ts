import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { verifyRecoveryCredentials, verifyRecoveryPasskeyCounter } from './authentication';
import {
  RecoveryIdentityError,
  recoveryBase64,
  describeRecoveryIdentity,
  describeRecoveryIdentityContent,
  describeRecoveryEffectiveIdentityContent,
  exactRecoveryObject,
} from './identity';

const profilePath = '/run/orbis-recovery/identity.json';
const parents = ['/', '/run', '/run/orbis-recovery'];
export const recoveryAuthenticationCapability = Object.freeze({
  schema: 'orbis.sentinel-authentication-worker.v1',
  version: 1,
  methods: ['password', 'passkey'],
  role: 'operator',
  maxIdentityBytes: 65536,
  maxRequestBytes: 32768,
  deadlineMs: 10000,
  databaseRequired: false,
  mutations: 'none',
  grantsAuthority: false,
  identityContentProof: 'orbis.sentinel-identity-content.v1',
  effectiveIdentityContentProof: 'orbis.sentinel-effective-identity-content.v1',
  passkeyCounterProof: 'orbis.sentinel-passkey-counter.v1',
});

export function recoveryAuthenticationArguments(args: readonly string[]) {
  if (args.length === 1 && args[0] === '--capability') return { mode: 'capability' as const };
  if (args.length === 2 && args[0] === '--describe-identity' && typeof args[1] === 'string' && /^[a-f0-9]{64}$/.test(args[1]))
    return { mode: 'describe-identity' as const, identitySha256: args[1] };
  if (args.length === 2 && args[0] === '--describe-content' && typeof args[1] === 'string' && /^[a-f0-9]{64}$/.test(args[1]))
    return { mode: 'describe-content' as const, identitySha256: args[1] };
  if (args.length === 2 && args[0] === '--describe-effective-content' && typeof args[1] === 'string' && /^[a-f0-9]{64}$/.test(args[1]))
    return { mode: 'describe-effective-content' as const, identitySha256: args[1] };
  if (
    args.length !== 3 ||
    !['--verify', '--verify-counter'].includes(args[0] ?? '') ||
    typeof args[1] !== 'string' ||
    !/^[a-f0-9]{64}$/.test(args[1]) ||
    !recoveryBase64(args[2], 43) ||
    Buffer.from(args[2], 'base64url').length !== 32
  )
    throw new RecoveryIdentityError();
  return { mode: args[0] === '--verify-counter' ? ('verify-counter' as const) : ('verify' as const), identitySha256: args[1], challenge: args[2] };
}

const same = (left: BigIntStats, right: BigIntStats) =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.uid === right.uid &&
  left.gid === right.gid &&
  left.mode === right.mode &&
  left.nlink === right.nlink &&
  left.size === right.size &&
  left.ctimeNs === right.ctimeNs &&
  left.mtimeNs === right.mtimeNs;

async function withProtectedIdentity<T>(action: (bytes: Buffer) => Promise<T>): Promise<T> {
  const directories: Array<{ path: string; handle: FileHandle; info: BigIntStats }> = [];
  let profile: FileHandle | undefined;
  try {
    for (const path of parents) {
      const handle = await fs.open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const info = await handle.stat({ bigint: true });
      directories.push({ path, handle, info });
      if (!info.isDirectory() || info.uid !== 0n || (info.mode & 0o022n) !== 0n || (path === parents[2] && (info.mode & 0o7777n) !== 0o700n))
        throw new RecoveryIdentityError();
    }
    profile = await fs.open(profilePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await profile.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.uid !== 0n ||
      before.nlink !== 1n ||
      (before.mode & 0o7777n) !== 0o600n ||
      before.size < 1n ||
      before.size > 65536n ||
      (await fs.realpath(profilePath)) !== profilePath
    )
      throw new RecoveryIdentityError();
    const buffer = Buffer.alloc(65537);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await profile.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size !== Number(before.size)) throw new RecoveryIdentityError();
    const result = await action(buffer.subarray(0, size));
    if (!same(before, await profile.stat({ bigint: true })) || !same(before, await fs.lstat(profilePath, { bigint: true })))
      throw new RecoveryIdentityError();
    for (const directory of directories) {
      if (
        !same(directory.info, await directory.handle.stat({ bigint: true })) ||
        !same(directory.info, await fs.lstat(directory.path, { bigint: true }))
      )
        throw new RecoveryIdentityError();
    }
    return result;
  } finally {
    await profile?.close();
    for (const directory of directories.reverse()) await directory.handle.close();
  }
}

async function readRequest() {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > recoveryAuthenticationCapability.maxRequestBytes) throw new RecoveryIdentityError();
    chunks.push(bytes);
  }
  if (!size) throw new RecoveryIdentityError();
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
}

export async function runRecoveryAuthenticationWorker(args: readonly string[]) {
  const operation = recoveryAuthenticationArguments(args);
  if (operation.mode === 'capability') return recoveryAuthenticationCapability;
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw new RecoveryIdentityError();
  if (operation.mode === 'describe-identity')
    return withProtectedIdentity(async (identityBytes) => describeRecoveryIdentity(identityBytes, operation.identitySha256));
  if (operation.mode === 'describe-content')
    return withProtectedIdentity(async (identityBytes) => describeRecoveryIdentityContent(identityBytes, operation.identitySha256));
  const request: unknown = await readRequest();
  if (operation.mode === 'describe-effective-content') {
    if (!exactRecoveryObject(request, ['counters'])) throw new RecoveryIdentityError();
    return withProtectedIdentity(async (identityBytes) =>
      describeRecoveryEffectiveIdentityContent(identityBytes, operation.identitySha256, request.counters),
    );
  }
  if (operation.mode === 'verify-counter')
    return withProtectedIdentity((identityBytes) =>
      verifyRecoveryPasskeyCounter({ identityBytes, expectedIdentitySha256: operation.identitySha256, challenge: operation.challenge, request }),
    );
  return withProtectedIdentity((identityBytes) =>
    verifyRecoveryCredentials({
      identityBytes,
      expectedIdentitySha256: operation.identitySha256,
      challenge: operation.challenge,
      request,
    }),
  );
}
