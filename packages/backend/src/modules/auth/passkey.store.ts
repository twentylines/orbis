import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { type } from 'arktype';
import { ConfigurationService } from '@/core/config/configuration.service';

const base64 = type('string > 0 & string <= 2048').narrow((v) => /^[A-Za-z0-9_-]+$/.test(v));
const credentialSchema = type({
  id: base64,
  publicKey: base64,
  counter: 'number.integer >= 0',
  name: 'string > 0 & string <= 60',
  rpID: 'string > 0 & string <= 253',
  createdAt: 'number.integer >= 0',
  lastUsedAt: 'number.integer >= 0 | null',
  transports: type("'ble' | 'cable' | 'hybrid' | 'internal' | 'nfc' | 'smart-card' | 'usb'")
    .array()
    .narrow((v) => v.length <= 8),
}).onUndeclaredKey('reject');
const userKeys = type({
  handle: base64,
  credentials: credentialSchema.array().narrow((v) => v.length <= 10),
  'totpAfterPasskey?': type('string').narrow((v) => /^[a-f0-9]{64}$/.test(v)),
}).onUndeclaredKey('reject');
const schema = type({
  version: '1',
  users: type({ '[string]': userKeys }).narrow((v) => Object.keys(v).length <= 256 && Object.keys(v).every((k) => /^[1-9][0-9]{0,9}$/.test(k))),
}).onUndeclaredKey('reject');
export type PasskeyState = typeof schema.infer;
export type StoredPasskey = typeof credentialSchema.infer;

@Injectable()
export class PasskeyStore {
  private state: PasskeyState = { version: 1, users: {} };
  private loaded?: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private unavailable = false;
  constructor(private readonly config: ConfigurationService) {}
  private file() {
    return path.join(this.config.get('directories').dataDir, 'state', 'auth', 'passkeys.json');
  }
  private load() {
    this.loaded ??= this.read();
    return this.loaded;
  }
  private async read() {
    try {
      const parent = await fs.lstat(path.dirname(this.file()));
      if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0 || (process.getuid && parent.uid !== process.getuid()))
        throw new Error();
      const stat = await fs.lstat(this.file());
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > 512 * 1024 ||
        (stat.mode & 0o077) !== 0 ||
        (process.getuid && stat.uid !== process.getuid())
      )
        throw new Error();
      const value = schema(JSON.parse(await fs.readFile(this.file(), 'utf8')));
      if (value instanceof type.errors) throw new Error();
      const ids = Object.values(value.users).flatMap((u) => u.credentials.map((c) => c.id));
      if (new Set(ids).size !== ids.length) throw new Error();
      this.state = value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.unavailable = true;
    }
  }
  async snapshot() {
    await this.load();
    await this.queue.catch(() => undefined);
    if (this.unavailable) throw new ServiceUnavailableException('Passkeys could not be read safely. Use your password to sign in.');
    return structuredClone(this.state);
  }
  change<T>(mutate: (state: PasskeyState) => T | Promise<T>): Promise<T>;
  change<T, R>(mutate: (state: PasskeyState) => T | Promise<T>, afterSave: (value: T) => R | Promise<R>): Promise<R>;
  change<T, R>(mutate: (state: PasskeyState) => T | Promise<T>, afterSave?: (value: T) => R | Promise<R>): Promise<T | R> {
    const task = this.queue
      .catch(() => undefined)
      .then(async () => {
        await this.load();
        if (this.unavailable) throw new ServiceUnavailableException('Passkey storage is unavailable. Use your password to sign in.');
        const next = structuredClone(this.state);
        const result = await mutate(next);
        if (JSON.stringify(next) !== JSON.stringify(this.state)) {
          const serialized = JSON.stringify(next);
          if (schema(next) instanceof type.errors || Buffer.byteLength(serialized) > 512 * 1024)
            throw new BadRequestException('Passkey storage limit reached. Remove an unused passkey first.');
          const file = this.file();
          const directory = path.dirname(file);
          const temporary = `${file}.${randomUUID()}.tmp`;
          try {
            await fs.mkdir(directory, { recursive: true, mode: 0o700 });
            const parent = await fs.lstat(directory);
            if (
              !parent.isDirectory() ||
              parent.isSymbolicLink() ||
              (parent.mode & 0o077) !== 0 ||
              (process.getuid && parent.uid !== process.getuid())
            )
              throw new Error();
            const handle = await fs.open(temporary, 'wx', 0o600);
            try {
              await handle.writeFile(`${serialized}\n`);
              await handle.sync();
            } finally {
              await handle.close();
            }
            await fs.rename(temporary, file);
            const parentHandle = await fs.open(directory, 'r');
            try {
              await parentHandle.sync();
            } finally {
              await parentHandle.close();
            }
            this.state = next;
          } catch {
            this.unavailable = true;
            throw new ServiceUnavailableException('Passkeys could not be saved safely. Use your password to sign in.');
          } finally {
            await fs.rm(temporary, { force: true }).catch(() => undefined);
          }
        }
        return afterSave ? afterSave(result) : result;
      });
    this.queue = task;
    return task;
  }
  removeAll(userId: number) {
    return this.change((next) => {
      if (next.users[userId]) {
        next.users[userId].credentials = [];
        delete next.users[userId].totpAfterPasskey;
      }
    });
  }
  clearTotpAfterPasskey(userId: number) {
    return this.change((next) => {
      if (next.users[userId]) delete next.users[userId].totpAfterPasskey;
    });
  }
}
