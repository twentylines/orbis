import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { BadRequestException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { type } from 'arktype';
import { ConfigurationService } from '@/core/config/configuration.service';
import { PasskeySnapshotError, pinPasskeySnapshot } from './passkey-snapshot';
import { credentialWriters } from '../sentinel-recovery/writer-gate';

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
export { schema as passkeyStateSchema };
export type PasskeyState = typeof schema.infer;
export type StoredPasskey = typeof credentialSchema.infer;
type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;
export type PreparedPasskeyChange<T> = {
  readonly before: Immutable<PasskeyState>;
  readonly after: Immutable<PasskeyState>;
  readonly value: T;
  readonly changed: boolean;
  readonly committed: boolean;
  readonly outcome: 'uncommitted' | 'committed' | 'uncertain';
  commit(): Promise<void>;
};
const freeze = <T>(value: T): Immutable<T> => {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value as Immutable<T>;
};

@Injectable()
export class PasskeyStore {
  private state: PasskeyState = { version: 1, users: {} };
  private loaded?: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private unavailable = false;
  private readFence: 'waiting' | 'active' | null = null;
  private readonly operation = new AsyncLocalStorage<{ active: boolean }>();
  constructor(@Inject(ConfigurationService) private readonly config: { get(key: 'directories'): { dataDir: string } }) {}
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
    this.assertOutsidePrepared();
    await this.load();
    await this.queue.catch(() => undefined);
    if (this.unavailable) throw new ServiceUnavailableException('Passkeys could not be read safely. Use your password to sign in.');
    return structuredClone(this.state);
  }
  async withReadFence<T>(work: () => Promise<T>): Promise<T> {
    this.assertOutsidePrepared();
    if (this.readFence) throw new ServiceUnavailableException('A passkey snapshot is already active. Try again shortly.');
    // Reserve before waiting for the shared gate: admitted writes can drain,
    // while new writers must fail rather than queue behind the snapshot.
    this.readFence = 'waiting';
    try {
      return await credentialWriters.read(() => this.readFenced(work));
    } finally {
      this.readFence = null;
    }
  }
  private async readFenced<T>(work: () => Promise<T>): Promise<T> {
    this.readFence = 'active';
    let pinned: Awaited<ReturnType<typeof pinPasskeySnapshot>> | undefined;
    let check: (() => Promise<void>) | undefined;
    let checked = false;
    try {
      const dataDir = this.config.get('directories').dataDir;
      const file = path.join(dataDir, 'state', 'auth', 'passkeys.json');
      await this.load();
      await this.queue.catch(() => undefined);
      if (this.unavailable) throw new ServiceUnavailableException('Passkey storage is unavailable. Use your password to sign in.');
      const expected = JSON.stringify(this.state);
      const snapshot = await pinPasskeySnapshot(dataDir, this.state);
      pinned = snapshot;
      check = async () => {
        try {
          if (this.file() !== file || JSON.stringify(this.state) !== expected) throw new PasskeySnapshotError();
          await snapshot.check();
        } catch {
          throw new PasskeySnapshotError();
        }
      };
      await check();
      const value = await work();
      checked = true;
      await check();
      return value;
    } catch (error) {
      if (error instanceof PasskeySnapshotError) this.unavailable = true;
      throw error;
    } finally {
      if (check && !checked)
        await check().catch(() => {
          this.unavailable = true;
        });
      await pinned?.close();
    }
  }
  change<T>(mutate: (state: PasskeyState) => T | Promise<T>): Promise<T>;
  change<T, R>(mutate: (state: PasskeyState) => T | Promise<T>, afterSave: (value: T) => R | Promise<R>): Promise<R>;
  change<T, R>(mutate: (state: PasskeyState) => T | Promise<T>, afterSave?: (value: T) => R | Promise<R>): Promise<T | R> {
    return this.withPreparedChange(mutate, async (plan) => {
      await plan.commit();
      return afterSave ? afterSave(plan.value) : plan.value;
    });
  }
  private assertOutsidePrepared() {
    if (this.operation.getStore()) throw new ServiceUnavailableException('Use the prepared passkey state inside this operation.');
  }
  /** The caller must coordinate SQL and recovery separately; this is not a distributed transaction. */
  withPreparedChange<T, R>(mutate: (state: PasskeyState) => T | Promise<T>, work: (plan: PreparedPasskeyChange<T>) => R | Promise<R>): Promise<R> {
    try {
      this.assertOutsidePrepared();
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.readFence) {
      if (this.readFence === 'active') return Promise.reject(new ServiceUnavailableException('A passkey snapshot is active. Try again shortly.'));
      // A writer already holding the shared lease must finish before the queued
      // snapshot. New callers cannot acquire that privilege while it is queued.
      try {
        credentialWriters.assertWrite();
      } catch {
        return Promise.reject(new ServiceUnavailableException('A passkey snapshot is active. Try again shortly.'));
      }
    }
    // Own the common gate BEFORE queue admission. A source read must not wait for
    // a queued passkey writer that is itself waiting for that read's gate.
    return credentialWriters.run(async () => {
      const task = this.queue
        .catch(() => undefined)
        .then(async () => {
          const scope = { active: true };
          return this.operation.run(scope, async () => {
            await this.load();
            if (this.unavailable) throw new ServiceUnavailableException('Passkey storage is unavailable. Use your password to sign in.');
            const dataDir = this.config.get('directories').dataDir;
            const file = this.file();
            const directory = path.dirname(file);
            const before = structuredClone(this.state);
            let pinned: Awaited<ReturnType<typeof pinPasskeySnapshot>> | undefined;
            let commitTask: Promise<void> | undefined;
            let attempted = false;
            let workActive = true;
            let outcome: PreparedPasskeyChange<T>['outcome'] = 'uncommitted';
            const checkScope = () => {
              credentialWriters.assertWrite();
              if (!scope.active || this.file() !== file) throw new PasskeySnapshotError();
            };
            try {
              const sourcePin = await pinPasskeySnapshot(dataDir, before);
              pinned = sourcePin;
              checkScope();
              const parents = await Promise.all(
                [dataDir, path.join(dataDir, 'state'), directory].map(async (name) => {
                  try {
                    const info = await fs.lstat(name, { bigint: true });
                    return { name, seal: [info.dev, info.ino, info.uid, info.gid, info.mode].join(':') };
                  } catch (error) {
                    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
                    throw error;
                  }
                }),
              );
              const checkParents = async () => {
                for (const parent of parents) {
                  if (!parent) continue;
                  const info = await fs.lstat(parent.name, { bigint: true });
                  if ([info.dev, info.ino, info.uid, info.gid, info.mode].join(':') !== parent.seal) throw new PasskeySnapshotError();
                  checkScope();
                }
              };
              const draft = structuredClone(before);
              const value = await mutate(draft);
              checkScope();
              const serialized = JSON.stringify(draft);
              if (schema(draft) instanceof type.errors || Buffer.byteLength(serialized) > 512 * 1024)
                throw new BadRequestException('Passkey storage limit reached. Remove an unused passkey first.');
              const ids = Object.values(draft.users).flatMap((item) => item.credentials.map((key) => key.id));
              if (new Set(ids).size !== ids.length) throw new BadRequestException('Passkey storage limit reached. Remove an unused passkey first.');
              // Detach from references retained or returned by the mutator.
              const next = JSON.parse(serialized) as PasskeyState;
              const changed = serialized !== JSON.stringify(before);
              await sourcePin.check();
              checkScope();
              const persist = async () => {
                checkScope();
                await sourcePin.check();
                checkScope();
                if (!changed) {
                  outcome = 'committed';
                  return;
                }
                const temporary = `${file}.${randomUUID()}.tmp`;
                let finalPin: Awaited<ReturnType<typeof pinPasskeySnapshot>> | undefined;
                // Any persistence failure may have crossed rename/fsync. A caller
                // must never treat it as a guaranteed rollback.
                outcome = 'uncertain';
                try {
                  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
                  checkScope();
                  await checkParents();
                  finalPin = await pinPasskeySnapshot(dataDir, before);
                  checkScope();
                  const parent = await fs.lstat(directory);
                  checkScope();
                  if (
                    !parent.isDirectory() ||
                    parent.isSymbolicLink() ||
                    (parent.mode & 0o077) !== 0 ||
                    (process.getuid && parent.uid !== process.getuid())
                  )
                    throw new Error();
                  const handle = await fs.open(temporary, 'wx', 0o600);
                  try {
                    checkScope();
                    await handle.writeFile(`${serialized}\n`);
                    checkScope();
                    await handle.sync();
                    checkScope();
                  } finally {
                    await handle.close();
                  }
                  await finalPin.check();
                  checkScope();
                  await checkParents();
                  await fs.rename(temporary, file);
                  checkScope();
                  const parentHandle = await fs.open(directory, 'r');
                  try {
                    checkScope();
                    await parentHandle.sync();
                    checkScope();
                  } finally {
                    await parentHandle.close();
                  }
                  const published = await pinPasskeySnapshot(dataDir, next);
                  try {
                    checkScope();
                    await published.check();
                    checkScope();
                    await checkParents();
                  } finally {
                    await published.close();
                  }
                  this.state = next;
                  outcome = 'committed';
                } catch {
                  this.unavailable = true;
                  throw new ServiceUnavailableException('Passkeys could not be saved safely. Use your password to sign in.');
                } finally {
                  await finalPin?.close();
                  await fs.rm(temporary, { force: true }).catch(() => undefined);
                }
              };
              const plan: PreparedPasskeyChange<T> = Object.freeze({
                before: freeze(structuredClone(before)),
                after: freeze(structuredClone(next)),
                value,
                changed,
                get committed() {
                  return outcome === 'committed';
                },
                get outcome() {
                  return outcome;
                },
                commit: () => {
                  try {
                    if (!workActive) throw new ServiceUnavailableException('The prepared passkey work has ended.');
                    checkScope();
                    if (attempted) throw new ServiceUnavailableException('The prepared passkey change was already committed.');
                    attempted = true;
                    commitTask = credentialWriters.run(persist);
                    void commitTask.catch(() => undefined);
                    return commitTask;
                  } catch (error) {
                    return Promise.reject(error);
                  }
                },
              });
              try {
                let result: R;
                try {
                  result = await work(plan);
                } finally {
                  // Stop NEW commit admission before post-work checks/drain.
                  // Already admitted commits keep their scope until they settle.
                  workActive = false;
                }
                if (commitTask) await commitTask;
                else {
                  await sourcePin.check();
                  checkScope();
                }
                return result;
              } catch (error) {
                // Drain a started commit even when the callback did not await it.
                await commitTask?.catch(() => undefined);
                if (outcome === 'uncommitted') await sourcePin.check();
                throw error;
              }
            } catch (error) {
              if (error instanceof PasskeySnapshotError) this.unavailable = true;
              throw error;
            } finally {
              scope.active = false;
              await pinned?.close();
            }
          });
        });
      this.queue = task;
      return task;
    });
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
