import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PasskeyStore, type PasskeyState, type PreparedPasskeyChange } from './passkey.store';
import { credentialWriters } from '../sentinel-recovery/writer-gate';
import * as passkeySnapshot from './passkey-snapshot';

let root: string;
let dataDir: string;
let store: PasskeyStore;
const required = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('Missing fixture value.');
  return value;
};
const initial = (): PasskeyState => ({ version: 1, users: { 1: { handle: 'YWJj', credentials: [] } } });
const file = () => path.join(root, 'state/auth/passkeys.json');
const config = { get: (key: string) => (key === 'directories' ? { dataDir } : 'synthetic-jwt') };
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

beforeEach(async () => {
  if (!process.env.TMPDIR) throw new Error('Project-scoped TMPDIR required.');
  root = await fs.realpath(await fs.mkdtemp(path.join(process.env.TMPDIR, 'prepared-passkeys-')));
  dataDir = root;
  await fs.mkdir(path.dirname(file()), { recursive: true, mode: 0o700 });
  await fs.writeFile(file(), `${JSON.stringify(initial())}\n`, { mode: 0o600 });
  store = new PasskeyStore(config as never);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

it('exposes immutable detached before/after plans without writing before explicit commit', async () => {
  const bytes = await fs.readFile(file());
  const inode = (await fs.stat(file())).ino;
  let retained: PreparedPasskeyChange<PasskeyState['users'][string]> | undefined;
  await store.withPreparedChange(
    (draft) => {
      const user = required(draft.users[1]);
      user.handle = 'ZGVm';
      return user;
    },
    async (plan) => {
      retained = plan;
      expect(plan.before.users[1]?.handle).toBe('YWJj');
      expect(plan.after.users[1]?.handle).toBe('ZGVm');
      expect(Object.isFrozen(plan.after.users[1])).toBe(true);
      plan.value.handle = 'bXV0YXRlZA';
      expect(plan.after.users[1]?.handle).toBe('ZGVm');
      expect(plan.changed).toBe(true);
      expect(plan.committed).toBe(false);
      expect(plan.outcome).toBe('uncommitted');
      expect(await fs.readFile(file())).toEqual(bytes);
    },
  );
  expect(await fs.readFile(file())).toEqual(bytes);
  expect((await fs.stat(file())).ino).toBe(inode);
  expect((await store.snapshot()).users[1]?.handle).toBe('YWJj');
  await expect(required(retained).commit()).rejects.toThrow();
});

it('commits once with private modes and returns the durable outcome', async () => {
  await store.withPreparedChange(
    (draft) => {
      required(draft.users[1]).handle = 'ZGVm';
    },
    async (plan) => {
      await plan.commit();
      expect(plan.committed).toBe(true);
      expect(plan.outcome).toBe('committed');
      await expect(plan.commit()).rejects.toThrow('already committed');
    },
  );
  expect((await store.snapshot()).users[1]?.handle).toBe('ZGVm');
  expect((await new PasskeyStore(config as never).snapshot()).users[1]?.handle).toBe('ZGVm');
  expect((await fs.stat(file())).mode & 0o777).toBe(0o600);
  expect((await fs.stat(path.dirname(file()))).mode & 0o777).toBe(0o700);
  expect(await fs.readdir(path.dirname(file()))).toEqual(['passkeys.json']);
});

it('does not create first-use directories or a file until commit', async () => {
  await fs.rm(path.join(root, 'state'), { recursive: true });
  store = new PasskeyStore(config as never);
  await store.withPreparedChange(
    (draft) => {
      draft.users[1] = required(initial().users[1]);
    },
    async () => {
      await expect(fs.lstat(path.join(root, 'state'))).rejects.toHaveProperty('code', 'ENOENT');
    },
  );
  await expect(fs.lstat(path.join(root, 'state'))).rejects.toHaveProperty('code', 'ENOENT');
  await store.change((draft) => {
    draft.users[1] = required(initial().users[1]);
  });
  expect((await new PasskeyStore(config as never).snapshot()).users[1]?.handle).toBe('YWJj');
});

it('leaves old persisted/cache state on a callback failure before commit', async () => {
  await expect(
    store.withPreparedChange(
      (draft) => {
        delete draft.users[1];
      },
      () => {
        throw new Error('Synthetic precommit refusal');
      },
    ),
  ).rejects.toThrow('precommit refusal');
  expect(JSON.parse(await fs.readFile(file(), 'utf8'))).toEqual(initial());
  expect(await store.snapshot()).toEqual(initial());
});

it('preserves a successful committed state when later work fails', async () => {
  let retained: PreparedPasskeyChange<void> | undefined;
  await expect(
    store.withPreparedChange(
      (draft) => {
        delete draft.users[1];
      },
      async (plan) => {
        retained = plan;
        await plan.commit();
        throw new Error('Synthetic postcommit failure');
      },
    ),
  ).rejects.toThrow('postcommit failure');
  expect(retained?.outcome).toBe('committed');
  expect(await store.snapshot()).toEqual({ version: 1, users: {} });
  expect(await new PasskeyStore(config as never).snapshot()).toEqual({ version: 1, users: {} });
});

it('reports uncertainty and disables cache use after an actual rename followed by failure', async () => {
  const rename = fs.rename;
  vi.spyOn(fs, 'rename').mockImplementation(async (...args) => {
    await rename(...args);
    throw new Error('Synthetic failure after real rename');
  });
  let retained: PreparedPasskeyChange<void> | undefined;
  await expect(
    store.withPreparedChange(
      (draft) => {
        delete draft.users[1];
      },
      async (plan) => {
        retained = plan;
        await plan.commit();
      },
    ),
  ).rejects.toThrow('saved safely');
  expect(retained?.outcome).toBe('uncertain');
  expect(retained?.committed).toBe(false);
  expect(JSON.parse(await fs.readFile(file(), 'utf8'))).toEqual({ version: 1, users: {} });
  await expect(store.snapshot()).rejects.toThrow('read safely');
});

it('verifies the actual published bytes before publishing the new cache', async () => {
  const rename = fs.rename;
  const external = initial();
  vi.spyOn(fs, 'rename').mockImplementation(async (...args) => {
    await rename(...args);
    await fs.writeFile(file(), JSON.stringify(external));
  });
  let retained: PreparedPasskeyChange<void> | undefined;
  await expect(
    store.withPreparedChange(
      (draft) => {
        delete draft.users[1];
      },
      async (plan) => {
        retained = plan;
        await plan.commit();
      },
    ),
  ).rejects.toThrow('saved safely');
  expect(retained?.outcome).toBe('uncertain');
  expect(JSON.parse(await fs.readFile(file(), 'utf8'))).toEqual(external);
  await expect(store.snapshot()).rejects.toThrow('read safely');
});

it('rejects an externally replaced source without overwriting its bytes', async () => {
  const external = { version: 1, users: { 2: { handle: 'ZGVm', credentials: [] } } };
  await expect(
    store.withPreparedChange(
      (draft) => {
        delete draft.users[1];
      },
      async (plan) => {
        const replacement = `${file()}.external`;
        await fs.writeFile(replacement, JSON.stringify(external), { mode: 0o600 });
        await fs.rename(replacement, file());
        await plan.commit();
      },
    ),
  ).rejects.toThrow('local review');
  expect(JSON.parse(await fs.readFile(file(), 'utf8'))).toEqual(external);
  await expect(store.snapshot()).rejects.toThrow('read safely');
});

it('rejects a changed configured directory before saving any candidate', async () => {
  const before = await fs.readFile(file());
  await expect(
    store.withPreparedChange(
      (draft) => {
        delete draft.users[1];
      },
      async (plan) => {
        dataDir = path.join(root, 'other');
        await plan.commit();
      },
    ),
  ).rejects.toThrow('local review');
  expect(await fs.readFile(file())).toEqual(before);
  await expect(fs.lstat(dataDir)).rejects.toHaveProperty('code', 'ENOENT');
});

it('refuses a retained plan in a later active gate and in a nested read-only scope', async () => {
  let retained: PreparedPasskeyChange<void> | undefined;
  await store.withPreparedChange(
    (draft) => {
      delete draft.users[1];
    },
    async (plan) => {
      retained = plan;
      await expect(credentialWriters.read(() => plan.commit())).rejects.toThrow();
    },
  );
  await expect(credentialWriters.run(() => required(retained).commit())).rejects.toThrow();
  expect(await store.snapshot()).toEqual(initial());
});

it('refuses own-queue snapshot, read fence and mutation instead of deadlocking', async () => {
  await store.withPreparedChange(
    () => undefined,
    async () => {
      await expect(store.snapshot()).rejects.toThrow('prepared passkey state');
      await expect(store.withReadFence(async () => undefined)).rejects.toThrow('prepared passkey state');
      await expect(store.change(() => undefined)).rejects.toThrow('prepared passkey state');
    },
  );
});

it('drains a started commit even if the trusted callback does not await it', async () => {
  let retained: PreparedPasskeyChange<void> | undefined;
  await store.withPreparedChange(
    (draft) => {
      delete draft.users[1];
    },
    (plan) => {
      retained = plan;
      void plan.commit();
    },
  );
  expect(retained?.outcome).toBe('committed');
  expect(await store.snapshot()).toEqual({ version: 1, users: {} });
});

it('closes commit admission before the final source check releases the operation', async () => {
  const finalCheck = deferred();
  const finishCheck = deferred();
  const attempt = deferred();
  const pin = passkeySnapshot.pinPasskeySnapshot;
  let checks = 0;
  vi.spyOn(passkeySnapshot, 'pinPasskeySnapshot').mockImplementation(async (...args) => {
    const pinned = await pin(...args);
    return {
      ...pinned,
      check: async () => {
        if (++checks === 2) {
          finalCheck.resolve();
          await finishCheck.promise;
        }
        await pinned.check();
      },
    };
  });
  let attempted: Promise<void> | undefined;
  const work = store.withPreparedChange(
    (draft) => {
      delete draft.users[1];
    },
    (plan) => {
      attempted = (async () => {
        await attempt.promise;
        await plan.commit();
      })();
      void attempted.catch(() => undefined);
      return 'work finished';
    },
  );
  void work.catch(() => undefined);
  await finalCheck.promise;
  attempt.resolve();
  try {
    await expect(required(attempted)).rejects.toThrow('work has ended');
  } finally {
    finishCheck.resolve();
    await work.catch(() => undefined);
  }
  expect(await work).toBe('work finished');
  expect(await store.snapshot()).toEqual(initial());
});

it('does not queue a writer ahead of a source read that already owns the common gate', async () => {
  const entered = deferred();
  const inspect = deferred();
  const reader = credentialWriters.read(async () => {
    entered.resolve();
    await inspect.promise;
    return store.withReadFence(async () => store.snapshot());
  });
  await entered.promise;
  const writer = store.change((draft) => {
    delete draft.users[1];
  });
  inspect.resolve();
  expect(await reader).toEqual(initial());
  await writer;
  expect(await store.snapshot()).toEqual({ version: 1, users: {} });
});

it('keeps post-save work before the next admitted mutation', async () => {
  const entered = deferred();
  const release = deferred();
  const events: string[] = [];
  const first = store.change(
    (draft) => {
      required(draft.users[1]).handle = 'ZGVm';
      return 'first';
    },
    async (value) => {
      entered.resolve();
      await release.promise;
      events.push(value);
      return 7;
    },
  );
  await entered.promise;
  const second = store.change((draft) => {
    events.push('second');
    expect(draft.users[1]?.handle).toBe('ZGVm');
  });
  expect(events).toEqual([]);
  release.resolve();
  expect(await first).toBe(7);
  await second;
  expect(events).toEqual(['first', 'second']);
});

it('does not save a candidate with duplicate credential identifiers across users', async () => {
  const key = { id: 'YWJj', publicKey: 'ZGVm', counter: 0, name: 'Key', rpID: 'orbis.test', createdAt: 1, lastUsedAt: null, transports: [] };
  await expect(
    store.withPreparedChange(
      (draft) => {
        required(draft.users[1]).credentials = [key];
        draft.users[2] = { handle: 'ZGVm', credentials: [key] };
      },
      (plan) => plan.commit(),
    ),
  ).rejects.toThrow('storage limit');
  expect(await store.snapshot()).toEqual(initial());
});
