import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { privateBackupDirectory } from './backup-files';

export type ResetBackupKeyBinding = { resetId: string; backupId: string; selectionSha256: string; users: number[] };
export type ResetBackupKeyCommitment = { archiveSha256: string; archiveBytes: number };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hash = /^[a-f0-9]{64}$/;
const fail = () => new Error('Reset backup key custody requires local review.');
const queues = new Map<string, Promise<unknown>>();
const json = (value: unknown) => JSON.stringify(value);
const parse = (value: string) => {
  try {
    return JSON.parse(value);
  } catch {
    throw fail();
  }
};
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
function binding(value: ResetBackupKeyBinding): ResetBackupKeyBinding {
  if (
    !value ||
    Object.keys(value).sort().join() !== 'backupId,resetId,selectionSha256,users' ||
    typeof value.resetId !== 'string' ||
    !uuid.test(value.resetId) ||
    typeof value.backupId !== 'string' ||
    !uuid.test(value.backupId) ||
    typeof value.selectionSha256 !== 'string' ||
    !hash.test(value.selectionSha256) ||
    !Array.isArray(value.users) ||
    !value.users.length ||
    value.users.length > 256 ||
    value.users.some((id, i) => !Number.isSafeInteger(id) || id <= 0 || (i > 0 && id <= (value.users[i - 1] ?? 0)))
  )
    throw fail();
  return { resetId: value.resetId, backupId: value.backupId, selectionSha256: value.selectionSha256, users: [...value.users] };
}
function commitment(value: ResetBackupKeyCommitment) {
  if (
    !value ||
    Object.keys(value).sort().join() !== 'archiveBytes,archiveSha256' ||
    typeof value.archiveSha256 !== 'string' ||
    !hash.test(value.archiveSha256) ||
    !Number.isSafeInteger(value.archiveBytes) ||
    value.archiveBytes <= 0
  )
    throw fail();
  return { archiveSha256: value.archiveSha256, archiveBytes: value.archiveBytes };
}
async function sync(directory: string) {
  const handle = await fs.open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function read(file: string): Promise<string> {
  const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      (before.mode & 0o777) !== 0o600 ||
      before.uid !== process.getuid?.() ||
      before.size < 1 ||
      before.size > 8192
    )
      throw fail();
    const bytes = Buffer.alloc(before.size + 1);
    try {
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      const after = await handle.stat();
      const current = await fs.lstat(file);
      if (
        bytesRead !== before.size ||
        [after, current].some(
          (s) =>
            s.dev !== before.dev || s.ino !== before.ino || s.size !== before.size || s.ctimeMs !== before.ctimeMs || s.mtimeMs !== before.mtimeMs,
        )
      )
        throw fail();
      return bytes.subarray(0, bytesRead).toString('utf8');
    } finally {
      bytes.fill(0);
    }
  } finally {
    await handle.close();
  }
}
async function directory(directory: string, allowed?: string[]) {
  await fs.lstat(directory);
  await privateBackupDirectory(directory);
  const names: string[] = [];
  for await (const entry of await fs.opendir(directory)) {
    if (names.length >= (allowed?.length ?? 4097) || (allowed && !allowed.includes(entry.name))) throw fail();
    names.push(entry.name);
  }
  return names;
}

/** Internal storage only: callers own authorization, archive verification and reset receipts. */
export class ResetBackupKeyCustody {
  private readonly root: string;
  constructor(dataDir: string) {
    if (!path.isAbsolute(dataDir) || path.resolve(dataDir) !== dataDir) throw fail();
    this.root = path.join(dataDir, 'backups', 'reset-keys');
  }
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const previous = queues.get(this.root) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    queues.set(this.root, next);
    void next
      .finally(() => {
        if (queues.get(this.root) === next) queues.delete(this.root);
      })
      .catch(() => undefined);
    return next;
  }
  private async publish(parent: string, name: string, value: unknown) {
    const target = path.join(parent, name);
    const exists = await fs.lstat(target).then(
      () => true,
      (error) => {
        if (missing(error)) return false;
        throw error;
      },
    );
    if (exists) {
      await directory(target);
      await read(path.join(target, 'record.json'));
      return;
    }
    const temporary = path.join(parent, `.pending-${randomUUID()}`);
    await fs.mkdir(temporary, { mode: 0o700 });
    const handle = await fs.open(path.join(temporary, 'record.json'), 'wx', 0o600);
    try {
      await handle.writeFile(json(value));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await sync(temporary);
    try {
      await fs.rename(temporary, target);
    } catch (error) {
      if (!['ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      await fs.unlink(path.join(temporary, 'record.json'));
      await fs.rmdir(temporary);
    }
    await sync(parent);
  }
  private async key() {
    let ancestor = this.root;
    for (;;) {
      try {
        if ((await fs.realpath(ancestor)) !== ancestor) throw fail();
        break;
      } catch (error) {
        if (!missing(error)) throw error;
        ancestor = path.dirname(ancestor);
      }
    }
    const dataDir = path.dirname(path.dirname(this.root));
    if (!(await fs.lstat(dataDir)).isDirectory() || (await fs.realpath(dataDir)) !== dataDir) throw fail();
    await privateBackupDirectory(this.root);
    await sync(path.dirname(this.root));
    await sync(dataDir);
    const names = await directory(this.root);
    if (names.length > 4097 || names.some((name) => name !== 'key' && !uuid.test(name))) throw fail();
    if (!names.includes('key')) {
      if (names.length) throw fail();
      const key = randomBytes(32);
      try {
        await this.publish(this.root, 'key', { version: 1, key: key.toString('base64url') });
      } finally {
        key.fill(0);
      }
    }
    await directory(path.join(this.root, 'key'), ['record.json']);
    const raw = await read(path.join(this.root, 'key', 'record.json'));
    const value = parse(raw);
    if (
      Object.keys(value).sort().join() !== 'key,version' ||
      value.version !== 1 ||
      typeof value.key !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(value.key)
    )
      throw fail();
    const key = Buffer.from(value.key, 'base64url');
    if (key.length !== 32 || key.toString('base64url') !== value.key) {
      key.fill(0);
      throw fail();
    }
    try {
      for (const name of names.filter((name) => name !== 'key')) {
        const record = parse(await read(path.join(this.root, name, 'record.json')));
        const b = binding(record.binding);
        if (b.backupId !== name) throw fail();
        const verified = await this.load(b, key);
        verified.secret.fill(0);
      }
      return key;
    } catch (error) {
      key.fill(0);
      throw error;
    }
  }
  private async load(b: ResetBackupKeyBinding, key: Buffer) {
    const location = path.join(this.root, b.backupId);
    await directory(location, ['record.json', 'sealed']);
    const raw = await read(path.join(location, 'record.json'));
    const record = parse(raw);
    if (
      Object.keys(record).sort().join() !== 'binding,ciphertext,keyId,nonce,tag,version' ||
      record.version !== 1 ||
      json(binding(record.binding)) !== json(b) ||
      record.keyId !== digest(key.toString('base64url')) ||
      !/^[A-Za-z0-9_-]{16}$/.test(record.nonce) ||
      !/^[A-Za-z0-9_-]{22}$/.test(record.tag) ||
      !/^[A-Za-z0-9_-]{58}$/.test(record.ciphertext)
    )
      throw fail();
    const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(record.nonce, 'base64url'));
    cipher.setAAD(Buffer.from(json({ version: 1, binding: b, keyId: record.keyId })));
    cipher.setAuthTag(Buffer.from(record.tag, 'base64url'));
    const secret = Buffer.concat([cipher.update(Buffer.from(record.ciphertext, 'base64url')), cipher.final()]);
    if (secret.length !== 43 || !/^[A-Za-z0-9_-]{43}$/.test(secret.toString())) {
      secret.fill(0);
      throw fail();
    }
    return { secret, keyId: record.keyId as string, envelopeSha256: digest(raw) };
  }
  async reserve(input: ResetBackupKeyBinding): Promise<{ keyId: string }> {
    const b = binding(input);
    return this.exclusive(async () => {
      const key = await this.key();
      try {
        const exists = await fs.lstat(path.join(this.root, b.backupId)).then(
          () => true,
          (error) => {
            if (missing(error)) return false;
            throw error;
          },
        );
        if (!exists) {
          if ((await directory(this.root)).length >= 4097) throw fail();
          const random = randomBytes(32);
          const secret = Buffer.from(random.toString('base64url'));
          random.fill(0);
          try {
            const keyId = digest(key.toString('base64url'));
            const nonce = randomBytes(12);
            const cipher = createCipheriv('aes-256-gcm', key, nonce);
            cipher.setAAD(Buffer.from(json({ version: 1, binding: b, keyId })));
            const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
            await this.publish(this.root, b.backupId, {
              version: 1,
              binding: b,
              keyId,
              nonce: nonce.toString('base64url'),
              ciphertext: ciphertext.toString('base64url'),
              tag: cipher.getAuthTag().toString('base64url'),
            });
          } finally {
            secret.fill(0);
          }
        }
        const record = await this.load(b, key);
        try {
          return { keyId: record.keyId };
        } finally {
          record.secret.fill(0);
        }
      } finally {
        key.fill(0);
      }
    });
  }
  async withReserved<T>(input: ResetBackupKeyBinding, consume: (secret: string) => Promise<T>): Promise<T> {
    const b = binding(input);
    const record = await this.exclusive(async () => {
      const key = await this.existingKey();
      try {
        return await this.load(b, key);
      } finally {
        key.fill(0);
      }
    });
    // The callback may seal its completed archive; never retain the storage queue across it.
    try {
      return await consume(record.secret.toString());
    } finally {
      record.secret.fill(0);
    }
  }
  private async existingKey() {
    // Reads must never create a missing host key, even in an otherwise empty store.
    await fs.lstat(path.join(this.root, 'key'));
    return this.key();
  }
  private async sealed(b: ResetBackupKeyBinding, c: ResetBackupKeyCommitment, key: Buffer, envelopeSha256: string) {
    const location = path.join(this.root, b.backupId, 'sealed');
    await directory(location, ['record.json']);
    const raw = parse(await read(path.join(location, 'record.json')));
    const payload = { version: 1, binding: b, commitment: c, envelopeSha256 };
    const mac = createHmac('sha256', key).update(json(payload)).digest();
    if (
      Object.keys(raw).sort().join() !== 'binding,commitment,envelopeSha256,mac,version' ||
      json(raw) !== json({ ...payload, mac: mac.toString('hex') }) ||
      !hash.test(raw.mac) ||
      !timingSafeEqual(Buffer.from(raw.mac, 'hex'), mac)
    )
      throw fail();
  }
  async seal(input: ResetBackupKeyBinding, expected: ResetBackupKeyCommitment): Promise<void> {
    const b = binding(input);
    const c = commitment(expected);
    return this.exclusive(async () => {
      const key = await this.existingKey();
      try {
        const record = await this.load(b, key);
        record.secret.fill(0);
        const payload = { version: 1, binding: b, commitment: c, envelopeSha256: record.envelopeSha256 };
        await this.publish(path.join(this.root, b.backupId), 'sealed', {
          ...payload,
          mac: createHmac('sha256', key).update(json(payload)).digest('hex'),
        });
        await this.sealed(b, c, key, record.envelopeSha256);
      } finally {
        key.fill(0);
      }
    });
  }
  async withSealed<T>(input: ResetBackupKeyBinding, expected: ResetBackupKeyCommitment, consume: (secret: string) => Promise<T>): Promise<T> {
    const b = binding(input);
    const c = commitment(expected);
    const record = await this.exclusive(async () => {
      const key = await this.existingKey();
      try {
        const record = await this.load(b, key);
        try {
          await this.sealed(b, c, key, record.envelopeSha256);
          return record;
        } catch (error) {
          record.secret.fill(0);
          throw error;
        }
      } finally {
        key.fill(0);
      }
    });
    try {
      return await consume(record.secret.toString());
    } finally {
      record.secret.fill(0);
    }
  }
}
