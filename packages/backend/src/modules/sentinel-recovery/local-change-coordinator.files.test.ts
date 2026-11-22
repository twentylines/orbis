import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { User } from '@/core/database/drizzle/types';
import { PasskeyStore, type PasskeyState } from '../auth/passkey.store';
import type { UserRepository } from '../user/user.repository';
import type { OwnershipGrant } from './host-broker';
import { LocalCredentialChangeCoordinator } from './local-change-coordinator';
import { RecoveryChangeError } from './change-coordinator';

let root: string;
const key = (draft: PasskeyState) => {
  const value = draft.users[1]?.credentials[0];
  if (!value) throw new Error('Expected fixture credential.');
  return value;
};
beforeEach(async () => {
  if (!process.env.TMPDIR) throw new Error('Project-scoped TMPDIR required.');
  root = await fs.realpath(await fs.mkdtemp(path.join(process.env.TMPDIR, 'lc-')));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  let account: User = {
    id: 1,
    username: 'original',
    password: 'synthetic-local-hash',
    operator: true,
    totpEnabled: false,
    totpSecret: null,
    salt: null,
    locale: 'en',
    hasSeenWelcome: true,
    createdAt: 1,
    updatedAt: 1,
  };
  const config = { get: vi.fn((key: string) => (key === 'directories' ? { dataDir: root } : 'synthetic-local-context')) };
  const passkeys = new PasskeyStore(config as never);
  await passkeys.change((draft) => {
    draft.users[1] = {
      handle: 'YQ',
      credentials: [
        { id: 'Yg', publicKey: 'Yw', counter: 7, rpID: 'orbis.example', name: 'Fixture', createdAt: 1, lastUsedAt: null, transports: [] },
      ],
    };
  });
  const behavior: { rewrite?: Partial<User>; failCommitAfter?: boolean; beforeFresh?: () => Promise<void> } = {};
  const events: string[] = [];
  let calls = 0;
  // SQL transport port. The Auth suite separately uses actual UserRepository.
  const users = {
    withCredentialTransaction: vi.fn(async (work: (repository: UserRepository) => Promise<unknown>) => {
      if (++calls === 2) await behavior.beforeFresh?.();
      const draft = { row: structuredClone(account), written: false };
      const repository = {
        getOperators: async () => (draft.row.operator ? [structuredClone(draft.row)] : []),
        getUserById: async () => structuredClone(draft.row),
        updateUser: async (_id: number, patch: Partial<User>) => {
          events.push('write');
          draft.written = true;
          draft.row = { ...draft.row, ...patch, ...behavior.rewrite };
        },
      };
      const result = await work(repository as unknown as UserRepository);
      account = draft.row;
      if (draft.written && behavior.failCommitAfter) throw new Error('Synthetic committed reply loss');
      events.push('sql-commit');
      return result;
    }),
  };
  let grant: OwnershipGrant;
  const broker = {
    ownershipPrepare: vi.fn(async (options: { requestId: string; purpose: OwnershipGrant['purpose'] }) => {
      events.push('prepare');
      grant = { ...options, operationId: 'b'.repeat(64), admissionBinding: 'a'.repeat(64), state: 'pending' };
      return grant;
    }),
    ownershipCheck: vi.fn(async () => {
      events.push('check');
      return grant;
    }),
    ownershipComplete: vi.fn(async (_grant: OwnershipGrant, disposition: 'committed' | 'not-written') => {
      events.push(disposition);
      return { ...grant, state: 'completed' as const };
    }),
  };
  const coordinator = new LocalCredentialChangeCoordinator({
    users: users as never,
    passkeys,
    config: config as never,
    broker,
    admissionBinding: 'a'.repeat(64),
  });
  const request = () => ({
    accountId: 1,
    authorize: vi.fn(async () => {}),
    plan: vi.fn(async (_account: Readonly<User>, draft: PasskeyState) => {
      key(draft).name = 'Changed';
      return { patch: { username: 'changed' }, value: 'result' };
    }),
    afterSuccess: vi.fn(async (value: string) => value),
  });
  return { account: () => structuredClone(account), broker, behavior, passkeys, users, coordinator, request, events };
}

it('verifies fresh committed SQL and passkey state before releasing Root authority', async () => {
  const f = await fixture();
  const request = f.request();
  expect(await f.coordinator.change(request)).toBe('result');
  expect(f.account().username).toBe('changed');
  expect((await f.passkeys.snapshot()).users[1]?.credentials[0]?.name).toBe('Changed');
  expect(f.events).toEqual(['prepare', 'check', 'write', 'sql-commit', 'sql-commit', 'committed']);
  expect(request.afterSuccess).toHaveBeenCalledExactlyOnceWith('result');
  expect(f.broker.ownershipPrepare.mock.calls[0]?.[0].purpose).toBe('credential-change');
});

it.each(['another-account', 'counter', 'operator', 'invalid-patch'])(
  'rejects an out-of-scope %s plan before requesting a Root grant',
  async (kind) => {
    const f = await fixture();
    const request = f.request();
    request.plan.mockImplementation(async (_account, draft) => {
      if (kind === 'another-account') draft.users[2] = { handle: 'ZA', credentials: [] };
      if (kind === 'counter') key(draft).counter++;
      return {
        patch:
          kind === 'operator' ? ({ operator: false } as never) : kind === 'invalid-patch' ? ({ username: false } as never) : { username: 'changed' },
        value: 'result',
      };
    });
    await expect(f.coordinator.change(request)).rejects.toBeInstanceOf(RecoveryChangeError);
    expect(f.broker.ownershipPrepare).not.toHaveBeenCalled();
    expect(f.account().username).toBe('original');
    expect(request.afterSuccess).not.toHaveBeenCalled();
  },
);

it.each(['aborted', 'context'])('cancels an unwritten Root lease after %s changes', async (kind) => {
  const f = await fixture();
  const controller = new AbortController();
  const request = f.request();
  f.broker.ownershipPrepare.mockImplementationOnce(async (options) => {
    if (kind === 'aborted') controller.abort();
    else vi.stubEnv('ORBIS_SENTINEL_RECOVERY_ORIGIN', 'https://changed.example');
    return { ...options, operationId: 'b'.repeat(64), admissionBinding: 'a'.repeat(64), state: 'pending' };
  });
  await expect(f.coordinator.change({ ...request, signal: controller.signal })).rejects.toMatchObject({
    outcome: { sql: 'not-written', passkeys: 'uncommitted', recovery: 'completed' },
  });
  expect(f.broker.ownershipComplete.mock.calls[0]?.[1]).toBe('not-written');
  expect(f.account().username).toBe('original');
});

it('retains effective SQL and passkey writes after a lost COMMIT reply', async () => {
  const f = await fixture();
  const request = f.request();
  f.behavior.failCommitAfter = true;
  await expect(f.coordinator.change(request)).rejects.toMatchObject({
    outcome: { sql: 'uncertain', passkeys: 'committed', recovery: 'pending' },
  });
  expect(f.account().username).toBe('changed');
  expect(f.broker.ownershipComplete).not.toHaveBeenCalled();
  expect(request.afterSuccess).not.toHaveBeenCalled();
});

it('preserves the hold if SQL does not match the planned update before file commit', async () => {
  const f = await fixture();
  f.behavior.rewrite = { operator: false };
  await expect(f.coordinator.change(f.request())).rejects.toMatchObject({ outcome: { sql: 'uncertain', passkeys: 'uncommitted' } });
  expect(f.account().operator).toBe(true);
  expect(f.broker.ownershipComplete).not.toHaveBeenCalled();
  expect((await f.passkeys.snapshot()).users[1]?.credentials[0]?.name).toBe('Fixture');
});

it('does not complete Root when the committed passkey file changes before source verification', async () => {
  const f = await fixture();
  f.behavior.beforeFresh = async () => {
    const file = path.join(root, 'state/auth/passkeys.json');
    const snapshot = JSON.parse(await fs.readFile(file, 'utf8')) as PasskeyState;
    key(snapshot).name = 'External change';
    await fs.writeFile(file, JSON.stringify(snapshot));
  };
  await expect(f.coordinator.change(f.request())).rejects.toMatchObject({ outcome: { sql: 'committed', recovery: 'pending' } });
  expect(f.broker.ownershipComplete).not.toHaveBeenCalled();
});

it('retains committed/completed outcomes if post-success session work fails', async () => {
  const f = await fixture();
  const request = f.request();
  request.afterSuccess.mockRejectedValue(new Error('private session detail'));
  await expect(f.coordinator.change(request)).rejects.toMatchObject({
    outcome: { phase: 'after-success', sql: 'committed', passkeys: 'committed', recovery: 'completed' },
  });
  expect(f.broker.ownershipComplete).toHaveBeenCalledTimes(1);
  expect(f.account().username).toBe('changed');
});
