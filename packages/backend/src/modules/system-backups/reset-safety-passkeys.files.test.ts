import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { SESSION_COOKIE_NAME } from '@/common/constants';
import { AuthService } from '../auth/auth.service';
import { PasskeyStore, type PasskeyState } from '../auth/passkey.store';
import { credentialWriters } from '../sentinel-recovery/writer-gate';

let root: string;
let store: PasskeyStore;
const file = () => path.join(root, 'state/auth/passkeys.json');
const mutate = (state: PasskeyState) => {
  state.users[7] = { handle: 'synthetic_modified', credentials: [] };
};
function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(async () => {
  if (!process.env.TMPDIR) throw new Error('Project-scoped TMPDIR required');
  root = await fs.realpath(await fs.mkdtemp(path.join(process.env.TMPDIR, 'reset-passkey-')));
  store = new PasskeyStore({ get: () => ({ dataDir: root }) } as never);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});
async function seed() {
  await store.change((state) => {
    state.users[7] = { handle: 'synthetic_original', credentials: [] };
  });
  return fs.readFile(file());
}

it('keeps reads available, rejects new and nested writers and releases after a successful snapshot', async () => {
  const bytes = await seed();
  const write = vi.fn(mutate);
  await store.withReadFence(async () => {
    expect((await store.snapshot()).users[7]?.handle).toBe('synthetic_original');
    await expect(store.change(write)).rejects.toThrow('snapshot');
    await expect(store.withReadFence(async () => undefined)).rejects.toThrow('snapshot');
    expect(await fs.readFile(file())).toEqual(bytes);
  });
  expect(write).not.toHaveBeenCalled();
  await store.change(write);
  expect(write).toHaveBeenCalledOnce();
  expect((await store.snapshot()).users[7]?.handle).toBe('synthetic_modified');
});

it('keeps the actual operator binding reader available while credential writers are held', async () => {
  await seed();
  const account = {
    id: 7,
    username: 'test',
    password: 'synthetic-hash',
    operator: true,
    totpEnabled: false,
    totpSecret: null,
    salt: null,
    createdAt: 1,
    updatedAt: 1,
    locale: 'en',
    hasSeenWelcome: true,
  };
  const auth = new AuthService(
    { getUserById: async () => account } as never,
    { isSessionForUser: () => true } as never,
    { get: () => false } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    store,
  );
  const request = {
    authMethod: 'session',
    user: { id: 7, operator: true },
    cookies: { [SESSION_COOKIE_NAME]: 'synthetic-session' },
  } as unknown as Request;
  const before = await auth.operatorActionContext(request);
  await store.withReadFence(async () => {
    expect(await auth.operatorActionContext(request)).toEqual(before);
    await expect(store.change(mutate)).rejects.toThrow('snapshot');
  });
  expect(await auth.operatorActionContext(request)).toEqual(before);
});

it('drains an admitted writer before entry and does not queue rejected work for later', async () => {
  await seed();
  const writing = deferred();
  const finish = deferred();
  const prior = store.change(async (state) => {
    writing.resolve();
    await finish.promise;
    mutate(state);
  });
  await writing.promise;
  const entered = vi.fn();
  const snapshot = store.withReadFence(async () => {
    entered();
    expect((await store.snapshot()).users[7]?.handle).toBe('synthetic_modified');
  });
  const rejected = vi.fn();
  await expect(store.change(rejected)).rejects.toThrow('snapshot');
  expect(entered).not.toHaveBeenCalled();
  finish.resolve();
  await prior;
  await snapshot;
  expect(entered).toHaveBeenCalledOnce();
  expect(rejected).not.toHaveBeenCalled();
});

it('reserves snapshot admission while an unrelated credential writer owns the shared gate', async () => {
  await seed();
  const entered = deferred();
  const finish = deferred();
  const holder = credentialWriters.run(async () => {
    entered.resolve();
    await finish.promise;
  });
  await entered.promise;
  const read = vi.fn(async () => undefined);
  const snapshot = store.withReadFence(read);
  const write = vi.fn(mutate);
  try {
    await expect(store.change(write)).rejects.toThrow('snapshot');
    await expect(store.withReadFence(async () => undefined)).rejects.toThrow('snapshot');
    expect(read).not.toHaveBeenCalled();
  } finally {
    finish.resolve();
    await holder;
    await snapshot;
  }
  expect(read).toHaveBeenCalledOnce();
  expect(write).not.toHaveBeenCalled();
  await store.change(write);
  expect(write).toHaveBeenCalledOnce();
});

it('drains an admitted outer credential writer that has not reached the passkey queue yet', async () => {
  await seed();
  const entered = deferred();
  const finish = deferred();
  const prior = credentialWriters.run(async () => {
    entered.resolve();
    await finish.promise;
    await store.change(mutate);
  });
  await entered.promise;
  const snapshot = store.withReadFence(async () => {
    expect((await store.snapshot()).users[7]?.handle).toBe('synthetic_modified');
  });
  const rejected = vi.fn(mutate);
  try {
    await expect(store.change(rejected)).rejects.toThrow('snapshot');
  } finally {
    finish.resolve();
    await prior;
    await snapshot;
  }
  expect(rejected).not.toHaveBeenCalled();
  expect((await store.snapshot()).users[7]?.handle).toBe('synthetic_modified');
});

it('releases the reserved local fence when shared read admission rejects', async () => {
  await seed();
  const read = vi.fn(async () => undefined);
  const refusal = new Error('synthetic admission refusal');
  vi.spyOn(credentialWriters, 'read').mockRejectedValueOnce(refusal);
  await expect(store.withReadFence(read)).rejects.toBe(refusal);
  expect(read).not.toHaveBeenCalled();
  await store.change(mutate);
  expect((await store.snapshot()).users[7]?.handle).toBe('synthetic_modified');
});

it('keeps the fence until cancelled callback work settles, then preserves its original error', async () => {
  await seed();
  const entered = deferred();
  const finish = deferred();
  const controller = new AbortController();
  const failure = new Error('synthetic cancellation');
  const snapshot = store.withReadFence(async () => {
    entered.resolve();
    await finish.promise;
    controller.signal.throwIfAborted();
  });
  const rejected = expect(snapshot).rejects.toBe(failure);
  await entered.promise;
  controller.abort(failure);
  await expect(store.change(mutate)).rejects.toThrow('snapshot');
  finish.resolve();
  await rejected;
  await store.change(mutate);
  expect((await store.snapshot()).users[7]?.handle).toBe('synthetic_modified');
});

it('preserves an empty absent store without creating authentication files', async () => {
  await store.withReadFence(async () => {
    await fs.mkdir(path.join(root, 'state'), { mode: 0o700 });
    expect(await store.snapshot()).toEqual({ version: 1, users: {} });
    await expect(store.change(mutate)).rejects.toThrow('snapshot');
  });
  await expect(fs.lstat(path.join(root, 'state/auth'))).rejects.toMatchObject({ code: 'ENOENT' });
  await store.change(mutate);
});

it('rejects stale cached credentials before invoking snapshot work and preserves the independent writer', async () => {
  await seed();
  const other = new PasskeyStore({ get: () => ({ dataDir: root }) } as never);
  await other.change(mutate);
  const bytes = await fs.readFile(file());
  const work = vi.fn(async () => undefined);
  await expect(store.withReadFence(work)).rejects.toThrow('snapshot');
  expect(work).not.toHaveBeenCalled();
  await expect(store.change(() => undefined)).rejects.toThrow('unavailable');
  expect(await fs.readFile(file())).toEqual(bytes);
});

it.each(['replacement', 'content', 'removed', 'permissions', 'hardlink', 'parent', 'parent-mode', 'symlink'])(
  'withholds the snapshot and future writes after a %s storage change',
  async (change) => {
    const bytes = await seed();
    await expect(
      store.withReadFence(async () => {
        if (change === 'replacement' || change === 'symlink') {
          await fs.rename(file(), `${file()}.retained`);
          if (change === 'symlink') await fs.symlink(`${file()}.retained`, file());
          else await fs.writeFile(file(), bytes, { mode: 0o600 });
        } else if (change === 'content') await fs.writeFile(file(), bytes.toString().replace('original', 'modified'));
        else if (change === 'removed') await fs.rename(file(), `${file()}.retained`);
        else if (change === 'permissions') await fs.chmod(file(), 0o644);
        else if (change === 'hardlink') await fs.link(file(), `${file()}.alias`);
        else if (change === 'parent-mode') await fs.chmod(path.dirname(file()), 0o750);
        else {
          await fs.rename(path.dirname(file()), `${path.dirname(file())}.retained`);
          await fs.mkdir(path.dirname(file()), { mode: 0o700 });
          await fs.writeFile(file(), bytes, { mode: 0o600 });
        }
        return { mustNotEscape: true };
      }),
    ).rejects.toThrow('snapshot');
    await expect(store.change(mutate)).rejects.toThrow('unavailable');
  },
);

it('preserves callback failure while holding future writes after concurrent file drift', async () => {
  const bytes = await seed();
  const failure = new Error('synthetic profile failure');
  await expect(
    store.withReadFence(async () => {
      await fs.rename(file(), `${file()}.retained`);
      await fs.writeFile(file(), bytes, { mode: 0o600 });
      throw failure;
    }),
  ).rejects.toBe(failure);
  await expect(store.change(mutate)).rejects.toThrow('unavailable');
  expect(await fs.readFile(file())).toEqual(bytes);
});

it('rejects oversized storage before invoking work', async () => {
  await seed();
  await fs.writeFile(file(), Buffer.alloc(512 * 1024 + 1));
  const work = vi.fn(async () => undefined);
  await expect(store.withReadFence(work)).rejects.toThrow('snapshot');
  expect(work).not.toHaveBeenCalled();
});

it('detaches retained mutation references from the pinned in-memory source', async () => {
  let retained: PasskeyState | undefined;
  await store.change((state) => {
    retained = state;
    state.users[7] = { handle: 'synthetic_original', credentials: [] };
  });
  const bytes = await fs.readFile(file());
  await store.withReadFence(async () => {
    if (!retained) throw new Error('Missing synthetic state');
    mutate(retained);
    expect((await store.snapshot()).users[7]?.handle).toBe('synthetic_original');
    expect(await fs.readFile(file())).toEqual(bytes);
  });
  expect((await store.snapshot()).users[7]?.handle).toBe('synthetic_original');
  await store.change(mutate);
  expect((await store.snapshot()).users[7]?.handle).toBe('synthetic_modified');
});
