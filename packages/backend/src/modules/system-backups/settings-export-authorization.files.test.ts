import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import type { AuthService } from '../auth/auth.service';
import type { PasskeyService } from '../auth/passkey.service';
import { SESSION_COOKIE_NAME } from '../../common/constants';
import { enterBackupMutation, setBackupRecoveryRequired } from '../../common/backup-maintenance';
import { withBackupMaintenanceLease, type BackupMaintenanceLease } from '../../common/backup-maintenance-lease';
import {
  authorizeSettingsPasswordExport,
  withSettingsExportAccess,
  assertSettingsExportAccess,
  settingsExportBorrowsMaintenance,
  verifyResetExportProof,
  withResetExportAccess,
  resetExportPlanSha256,
  assertResetExportAccess,
  withResetInventoryAccess,
  assertResetInventoryAccess,
  withResetExportAccessFromInventory,
  type ResetInventoryAccess,
  type SettingsExportAccess,
  type SettingsExportTicket,
} from './settings-export-authorization';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const selection = { version: 1 as const, settings: true, dashboard: true, wallpapers: true, themes: true, timeMachine: [id(9)] };
const item = { exportId: id(1), ownerId: 1, selection };
const plan = {
  resetId: id(2),
  accounts: 'keep' as const,
  users: [1, 2],
  exports: [item, { exportId: id(3), ownerId: 2, selection: { ...selection, timeMachine: [] } }],
};
const request = {} as Request;
const signal = () => new AbortController().signal;
function services() {
  let securityBinding = 'security';
  const calls = {
    operatorActionContext: vi.fn(async () => ({ userId: 1, sessionBinding: 'session', securityBinding })),
    verifySensitiveAction: vi.fn(async () => ({})),
  };
  const pk = { verifySensitive: vi.fn(async () => ({})) };
  return {
    auth: calls as unknown as AuthService,
    passkeys: pk as unknown as PasskeyService,
    calls,
    pk,
    change: () => {
      securityBinding = 'changed';
    },
  };
}
afterEach(() => {
  vi.useRealTimers();
  setBackupRecoveryRequired(false);
});

it('binds supplemental reset reads to the exact admitted reset, account choice, cohort and export plan', async () => {
  const s = services();
  const proof = await verifyResetExportProof(s.auth, s.passkeys, request, 'keep', { method: 'password', password: 'secret' });
  await withBackupMaintenanceLease(signal(), async (lease) => {
    await withResetExportAccess(proof, plan, lease, signal(), async (access) => {
      await assertResetExportAccess(access, { ...plan, users: [2, 1], exports: [...plan.exports].reverse() });
      for (const bad of [
        { ...plan, resetId: id(8) },
        { ...plan, accounts: 'remove' as const },
        { ...plan, users: [1], exports: [item] },
        { ...plan, exports: plan.exports.map((entry) => ({ ...entry, selection: { ...entry.selection, timeMachine: [] } })) },
      ])
        await expect(assertResetExportAccess(access, bad)).rejects.toThrow();
      await expect(assertResetExportAccess({ ...access }, plan)).rejects.toThrow();
      await assertResetExportAccess(access, plan);
    });
  });
  expect(s.calls.verifySensitiveAction).toHaveBeenCalledTimes(1);
});

it('rejects ordinary profile tickets and settled, revoked or changed-session reset authority for supplemental reads', async () => {
  const s = services();
  const ticket = await authorizeSettingsPasswordExport(s.auth, request, { password: 'secret' }, item);
  await withSettingsExportAccess(ticket, item, signal(), async (access) => {
    await expect(assertResetExportAccess(access, plan)).rejects.toThrow();
  });
  let retained!: SettingsExportAccess;
  const proof = await verifyResetExportProof(s.auth, s.passkeys, request, 'keep', { method: 'password', password: 'secret' });
  await withBackupMaintenanceLease(signal(), async (lease) => {
    await expect(
      withResetExportAccess(proof, plan, lease, signal(), async (access) => {
        retained = access;
        await assertResetExportAccess(access, plan);
        s.change();
        await assertResetExportAccess(access, plan);
      }),
    ).rejects.toThrow();
  });
  await expect(assertResetExportAccess(retained, plan)).rejects.toThrow();
});
it('checks fresh identity and item boundaries, verifies once and revokes settled access', async () => {
  const s = services();
  const ticket = await authorizeSettingsPasswordExport(s.auth, request, { password: 'secret' }, item);
  expect(Object.keys(ticket)).toEqual([]);
  expect(Object.isFrozen(ticket)).toBe(true);
  let retained!: SettingsExportAccess;
  await withSettingsExportAccess(ticket, item, signal(), async (access) => {
    retained = access;
    expect(settingsExportBorrowsMaintenance(access)).toBe(false);
    await assertSettingsExportAccess(access, { ...item, pointId: id(9) });
    for (const bad of [
      { ...item, ownerId: 2 },
      { ...item, exportId: id(8) },
      { ...item, pointId: id(8) },
      { ...item, selection: { ...selection, themes: false } },
    ])
      await expect(assertSettingsExportAccess(access, bad)).rejects.toThrow();
    await expect(assertSettingsExportAccess({ ...access }, item)).rejects.toThrow();
  });
  expect(s.calls.verifySensitiveAction).toHaveBeenCalledTimes(1);
  await expect(assertSettingsExportAccess(retained, item)).rejects.toThrow();
  await expect(withSettingsExportAccess(ticket, item, signal(), async () => {})).rejects.toThrow();
});

it('retains only the fields required to recheck the original authenticated session', async () => {
  const s = services();
  const original = {
    authMethod: 'session',
    user: { id: 1, operator: true, privateProfileField: 'not retained' },
    cookies: { [SESSION_COOKIE_NAME]: 'session-cookie', unrelated: 'not retained' },
    body: { password: 'not retained' },
  } as unknown as Request;
  const ticket = await authorizeSettingsPasswordExport(s.auth, original, { password: 'secret' }, item);
  await withSettingsExportAccess(ticket, item, signal(), async (access) => assertSettingsExportAccess(access, item));
  for (const call of s.calls.operatorActionContext.mock.calls.slice(1))
    expect((call as unknown[])[0]).toEqual({
      authMethod: 'session',
      user: { id: 1, operator: true },
      cookies: { [SESSION_COOKIE_NAME]: 'session-cookie' },
    });
});
it('rejects copied authority, concurrent replay and failed invocation reuse', async () => {
  const s = services();
  const ticket = await authorizeSettingsPasswordExport(s.auth, request, { password: 'secret' }, item);
  await expect(withSettingsExportAccess({ ...ticket } as SettingsExportTicket, item, signal(), async () => {})).rejects.toThrow();
  let finish!: () => void;
  const started = withSettingsExportAccess(
    ticket,
    item,
    signal(),
    async () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  await expect(withSettingsExportAccess(ticket, item, signal(), async () => {})).rejects.toThrow();
  finish();
  await started;
  const invalid = await authorizeSettingsPasswordExport(s.auth, request, { password: 'secret' }, item);
  await expect(withSettingsExportAccess(invalid, { ...item, ownerId: 2 }, signal(), async () => {})).rejects.toThrow();
  await expect(withSettingsExportAccess(invalid, item, signal(), async () => {})).rejects.toThrow();
});
it('detects security changes during proof, before opening and during work', async () => {
  const s = services();
  s.calls.verifySensitiveAction.mockImplementationOnce(async () => {
    s.change();
    return {};
  });
  await expect(authorizeSettingsPasswordExport(s.auth, request, { password: 'secret' }, item)).rejects.toThrow();
  const a = services();
  const ticket = await authorizeSettingsPasswordExport(a.auth, request, { password: 'secret' }, item);
  a.change();
  await expect(withSettingsExportAccess(ticket, item, signal(), async () => {})).rejects.toThrow();
  const b = services();
  const inside = await authorizeSettingsPasswordExport(b.auth, request, { password: 'secret' }, item);
  await expect(
    withSettingsExportAccess(inside, item, signal(), async (access) => {
      b.change();
      await assertSettingsExportAccess(access, item);
    }),
  ).rejects.toThrow();
});
it('expires admission and access, and rejects aborted signals', async () => {
  vi.useFakeTimers();
  const s = services();
  const ticket = await authorizeSettingsPasswordExport(s.auth, request, { password: 'secret' }, item);
  vi.advanceTimersByTime(60_000);
  await expect(withSettingsExportAccess(ticket, item, signal(), async () => {})).rejects.toThrow();
  const active = await authorizeSettingsPasswordExport(s.auth, request, { password: 'secret' }, item);
  await expect(
    withSettingsExportAccess(active, item, signal(), async (access) => {
      vi.advanceTimersByTime(3_600_000);
      await assertSettingsExportAccess(access, item);
    }),
  ).rejects.toThrow();
  const cancelled = await authorizeSettingsPasswordExport(s.auth, request, { password: 'secret' }, item);
  const controller = new AbortController();
  controller.abort();
  await expect(withSettingsExportAccess(cancelled, item, controller.signal, async () => {})).rejects.toThrow();
});
it('never gives an ordinary export maintenance bypass', async () => {
  const s = services();
  const ticket = await authorizeSettingsPasswordExport(s.auth, request, { password: 'secret' }, item);
  await withBackupMaintenanceLease(signal(), async () =>
    withSettingsExportAccess(ticket, item, signal(), async (access) => {
      expect(settingsExportBorrowsMaintenance(access)).toBe(false);
      expect(enterBackupMutation()).toBeNull();
    }),
  );
});
it('uses the existing action-bound passkey verifier without password and admits cohort exports only with the real lease', async () => {
  const s = services();
  const proof = await verifyResetExportProof(s.auth, s.passkeys, request, 'keep', { method: 'passkey', challengeId: 'challenge', response: {} });
  expect(s.calls.verifySensitiveAction).not.toHaveBeenCalled();
  expect(s.pk.verifySensitive).toHaveBeenCalledWith(
    request,
    createHash('sha256').update('orbis-reset-v1\nkeep\napps-and-data-preserved').digest('hex'),
    { challengeId: 'challenge', response: {} },
  );
  await withBackupMaintenanceLease(signal(), async (lease) => {
    await withResetExportAccess(proof, plan, lease, signal(), async (access) => {
      expect(settingsExportBorrowsMaintenance(access)).toBe(true);
      await assertSettingsExportAccess(access, plan.exports[1] as typeof item);
    });
    await expect(withResetExportAccess(proof, plan, lease, signal(), async () => {})).rejects.toThrow();
  });
});
it('rejects forged and expired leases and independent recovery holds', async () => {
  const s = services();
  const make = () => verifyResetExportProof(s.auth, s.passkeys, request, 'keep', { method: 'password', password: 'secret' });
  await expect(withResetExportAccess(await make(), plan, {} as BackupMaintenanceLease, signal(), async () => {})).rejects.toThrow();
  let expired!: BackupMaintenanceLease;
  await withBackupMaintenanceLease(signal(), async (lease) => {
    expired = lease;
  });
  await withBackupMaintenanceLease(signal(), async (lease) => {
    await expect(withResetExportAccess(await make(), plan, expired, signal(), async () => {})).rejects.toThrow();
    setBackupRecoveryRequired(true);
    await expect(withResetExportAccess(await make(), plan, lease, signal(), async () => {})).rejects.toThrow();
    setBackupRecoveryRequired(false);
    await expect(
      withResetExportAccess(await make(), plan, lease, signal(), async (access) => {
        setBackupRecoveryRequired(true);
        expect(() => settingsExportBorrowsMaintenance(access)).toThrow();
      }),
    ).rejects.toThrow();
  });
});
it('canonicalizes complete plans and rejects missing owners, duplicate captures and extra fields', () => {
  expect(resetExportPlanSha256(plan)).toBe(resetExportPlanSha256({ ...plan, users: [2, 1], exports: [...plan.exports].reverse() }));
  for (const bad of [
    { ...plan, users: [1, 1] },
    { ...plan, exports: [item] },
    { ...plan, exports: [item, { ...(plan.exports[1] as typeof item), selection }] },
    { ...plan, extra: true },
  ])
    expect(() => resetExportPlanSha256(bad)).toThrow();
});
it('never revives expired active authority after clock rollback or a new maintenance lease', async () => {
  vi.useFakeTimers();
  const s = services();
  const proof = await verifyResetExportProof(s.auth, s.passkeys, request, 'keep', { method: 'password', password: 'secret' });
  await expect(
    withBackupMaintenanceLease(signal(), async (lease) =>
      withResetExportAccess(proof, plan, lease, signal(), async (access) => {
        const now = Date.now();
        vi.advanceTimersByTime(3_600_000);
        expect(() => settingsExportBorrowsMaintenance(access)).toThrow();
        vi.setSystemTime(now);
        expect(() => settingsExportBorrowsMaintenance(access)).toThrow();
      }),
    ),
  ).rejects.toThrow();
});
it('expires reset proofs before drain and detects actor changes across asynchronous assertions', async () => {
  vi.useFakeTimers();
  const s = services();
  const proof = await verifyResetExportProof(s.auth, s.passkeys, request, 'keep', { method: 'password', password: 'secret' });
  vi.advanceTimersByTime(300_000);
  await withBackupMaintenanceLease(signal(), async (lease) => {
    await expect(withResetExportAccess(proof, plan, lease, signal(), async () => {})).rejects.toThrow();
  });
  const a = services();
  const ticket = await authorizeSettingsPasswordExport(a.auth, request, { password: 'secret' }, item);
  await expect(
    withSettingsExportAccess(ticket, item, signal(), async (access) => {
      a.calls.operatorActionContext.mockImplementationOnce(async () => {
        a.change();
        return { userId: 2, sessionBinding: 'other', securityBinding: 'changed' };
      });
      await assertSettingsExportAccess(access, item);
    }),
  ).rejects.toThrow();
});
it('rejects malformed proofs before invoking verifiers while permitting legacy short passwords', async () => {
  const s = services();
  for (const credentials of [{ password: '' }, { password: 'x'.repeat(1025) }, { password: 'x', totpCode: '123' }, { password: 'x', extra: true }]) {
    await expect(authorizeSettingsPasswordExport(s.auth, request, credentials, item)).rejects.toThrow();
  }
  for (const proof of [
    { method: 'password', password: '' },
    { method: 'password', password: 'x', totpCode: 123456 },
    { method: 'passkey', challengeId: '', response: {} },
    { method: 'passkey', challengeId: 'x'.repeat(257), response: {} },
    { method: 'passkey', challengeId: 'x' },
    { method: 'passkey', challengeId: 'x', response: {}, password: 'x' },
  ])
    await expect(
      verifyResetExportProof(s.auth, s.passkeys, request, 'keep', proof as Parameters<typeof verifyResetExportProof>[4]),
    ).rejects.toThrow();
  expect(s.calls.verifySensitiveAction).not.toHaveBeenCalled();
  expect(s.pk.verifySensitive).not.toHaveBeenCalled();
  await authorizeSettingsPasswordExport(s.auth, request, { password: 'x' }, item);
  expect(s.calls.verifySensitiveAction).toHaveBeenCalledWith(1, 'x', undefined);
});

it.each(['password', 'passkey'] as const)('admits inventory then exactly one complete plan with one %s confirmation', async (method) => {
  const s = services();
  const proof = await verifyResetExportProof(
    s.auth,
    s.passkeys,
    request,
    'keep',
    method === 'password' ? { method, password: 'secret' } : { method, challengeId: 'challenge', response: {} },
  );
  const abort = signal();
  let escaped: ResetInventoryAccess | undefined;
  await withBackupMaintenanceLease(abort, async (lease) => {
    const context = { resetId: plan.resetId, accounts: plan.accounts, lease, signal: abort };
    const result = await withResetInventoryAccess(proof, context, async (access) => {
      escaped = access;
      expect(Object.isFrozen(access)).toBe(true);
      await assertResetInventoryAccess(access, context);
      await expect(assertResetExportAccess(access as unknown as SettingsExportAccess, plan)).rejects.toThrow();
      expect(
        await withResetExportAccessFromInventory(access, plan, async (exports) => {
          await assertResetExportAccess(exports, plan);
          await assertSettingsExportAccess(exports, plan.exports[1] as typeof item);
          return 'complete inventory and plan';
        }),
      ).toBe('complete inventory and plan');
      await expect(withResetExportAccessFromInventory(access, plan, async () => {})).rejects.toThrow();
      return 'observed';
    });
    expect(result).toBe('observed');
    if (!escaped) throw new Error('Missing synthetic inventory access');
    await expect(assertResetInventoryAccess(escaped, context)).rejects.toThrow();
    await expect(withResetInventoryAccess(proof, context, async () => {})).rejects.toThrow();
    await expect(withResetExportAccess(proof, plan, lease, abort, async () => {})).rejects.toThrow();
  });
  expect(s.calls.verifySensitiveAction).toHaveBeenCalledTimes(method === 'password' ? 1 : 0);
  expect(s.pk.verifySensitive).toHaveBeenCalledTimes(method === 'passkey' ? 1 : 0);
});

it('keeps pre-plan inventory authority bound to reset ID, account choice, exact lease and cancellation signal', async () => {
  const s = services();
  const abort = signal();
  const proof = await verifyResetExportProof(s.auth, s.passkeys, request, 'keep', { method: 'password', password: 'secret' });
  await withBackupMaintenanceLease(abort, (lease) =>
    withResetInventoryAccess(proof, { resetId: plan.resetId, accounts: 'keep', lease, signal: abort }, async (access) => {
      const context = { resetId: plan.resetId, accounts: plan.accounts, lease, signal: abort };
      for (const changed of [
        { ...context, resetId: id(99) },
        { ...context, accounts: 'remove' as const },
        { ...context, lease: {} as BackupMaintenanceLease },
        { ...context, signal: signal() },
      ])
        await expect(assertResetInventoryAccess(access, changed)).rejects.toThrow();
      await expect(assertResetInventoryAccess({ ...access } as ResetInventoryAccess, context)).rejects.toThrow();
      for (const changed of [
        { ...plan, resetId: id(99) },
        { ...plan, accounts: 'remove' as const },
        { ...plan, users: [2], exports: [plan.exports[1] as typeof item] },
      ])
        await expect(withResetExportAccessFromInventory(access, changed, async () => {})).rejects.toThrow();
      await assertResetInventoryAccess(access, context);
    }),
  );
});

it('never invokes inventory reads without a real live lease or during an independent recovery hold', async () => {
  const s = services();
  const read = vi.fn(async () => {});
  const make = () => verifyResetExportProof(s.auth, s.passkeys, request, 'keep', { method: 'password', password: 'secret' });
  for (const lease of [undefined, {}] as unknown as BackupMaintenanceLease[])
    await expect(
      withResetInventoryAccess(await make(), { resetId: plan.resetId, accounts: 'keep', lease, signal: signal() }, read),
    ).rejects.toThrow();
  await withBackupMaintenanceLease(signal(), async (lease) => {
    setBackupRecoveryRequired(true);
    await expect(
      withResetInventoryAccess(await make(), { resetId: plan.resetId, accounts: 'keep', lease, signal: signal() }, read),
    ).rejects.toThrow();
  });
  expect(read).not.toHaveBeenCalled();
});

it('revokes a child export that tries to outlive its inventory callback', async () => {
  const s = services();
  const abort = signal();
  const proof = await verifyResetExportProof(s.auth, s.passkeys, request, 'keep', { method: 'password', password: 'secret' });
  let entered = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let child: Promise<void> | undefined;
  let escaped: SettingsExportAccess | undefined;
  await withBackupMaintenanceLease(abort, async (lease) => {
    await withResetInventoryAccess(proof, { resetId: plan.resetId, accounts: 'keep', lease, signal: abort }, async (access) => {
      child = withResetExportAccessFromInventory(access, plan, async (exports) => {
        escaped = exports;
        entered();
        await pending;
        await assertResetExportAccess(exports, plan);
      });
      void child.catch(() => {});
      await started;
    });
    if (!escaped || !child) throw new Error('Missing synthetic child scope');
    await expect(assertResetExportAccess(escaped, plan)).rejects.toThrow();
    release();
    await expect(child).rejects.toThrow();
  });
});

it('rejects concurrent second plan admission before either can reuse the reset confirmation', async () => {
  const s = services();
  const abort = signal();
  const proof = await verifyResetExportProof(s.auth, s.passkeys, request, 'keep', { method: 'password', password: 'secret' });
  await withBackupMaintenanceLease(abort, (lease) =>
    withResetInventoryAccess(proof, { resetId: plan.resetId, accounts: 'keep', lease, signal: abort }, async (access) => {
      const first = withResetExportAccessFromInventory(access, plan, async () => 'first');
      await expect(withResetExportAccessFromInventory(access, plan, async () => 'second')).rejects.toThrow();
      expect(await first).toBe('first');
    }),
  );
});

it.each(['security', 'abort', 'expiry'] as const)('permanently revokes inventory after observed %s loss', async (change) => {
  if (change === 'expiry') vi.useFakeTimers();
  const s = services();
  const abort = new AbortController();
  const proof = await verifyResetExportProof(s.auth, s.passkeys, request, 'keep', { method: 'password', password: 'secret' });
  await expect(
    withBackupMaintenanceLease(abort.signal, (lease) =>
      withResetInventoryAccess(proof, { resetId: plan.resetId, accounts: 'keep', lease, signal: abort.signal }, async (access) => {
        const context = { resetId: plan.resetId, accounts: plan.accounts, lease, signal: abort.signal };
        const now = Date.now();
        if (change === 'security') s.change();
        else if (change === 'abort') abort.abort();
        else vi.advanceTimersByTime(3_600_000);
        await expect(assertResetInventoryAccess(access, context)).rejects.toThrow();
        if (change === 'expiry') vi.setSystemTime(now);
        await expect(assertResetInventoryAccess(access, context)).rejects.toThrow();
        await expect(withResetExportAccessFromInventory(access, plan, async () => {})).rejects.toThrow();
      }),
    ),
  ).rejects.toThrow();
});
