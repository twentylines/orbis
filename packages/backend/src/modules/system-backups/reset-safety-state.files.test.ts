import { afterEach, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import type { AuthService } from '../auth/auth.service';
import type { PasskeyService } from '../auth/passkey.service';
import { setBackupRecoveryRequired } from '../../common/backup-maintenance';
import { withBackupMaintenanceLease, type BackupMaintenanceLease } from '../../common/backup-maintenance-lease';
import { defaultTimeMachinePreferences } from '@runtipi/common/schemas/time-machine';
import {
  authorizeSettingsPasswordExport,
  withSettingsExportAccess,
  verifyResetExportProof,
  withResetExportAccess,
  resetExportPlanSha256,
  type SettingsExportAccess,
  type ResetExportPlan,
} from './settings-export-authorization';
import { planResetSafetyExports } from './reset-safety-plan';
import { decodeResetSafetyState, encodeResetSafetyState, resetSafetyStatePayload, type ResetSafetyState } from './reset-safety-state';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const passphrase = 'synthetic archive secret phrase';
const request = {} as Request;
const signal = () => new AbortController().signal;
function plan(accounts: 'keep' | 'remove' = 'keep') {
  let n = 10;
  return planResetSafetyExports({ resetId: id(1), accounts, users: [2, 1], captures: [] }, () => id(n++)).plan;
}
function fixture(value: ResetExportPlan): ResetSafetyState {
  const settings = { orbis: { enabled: true, mode: 'scheduled' as const }, apps: { enabled: false }, schedule: { time: '03:00', timezone: 'UTC' } };
  const attempt = { slot: 'old-slot', state: 'accepted' as const, at: 1, message: 'Synthetic historical attempt', jobId: 'old-job' };
  return {
    format: 'orbis-reset-state',
    version: 1,
    resetId: value.resetId,
    accounts: value.accounts,
    selectionSha256: resetExportPlanSha256(value),
    users: [2, 1].map((id) => ({
      id,
      username: `synthetic-${id}`,
      operator: id === 1,
      locale: 'en',
      hasSeenWelcome: true,
      createdAt: 1,
      updatedAt: 2,
    })),
    links: [
      {
        id: 1,
        userId: 2,
        title: 'Synthetic link',
        url: 'https://example.invalid',
        iconUrl: null,
        description: null,
        isVisibleOnGuestDashboard: false,
        createdAt: 1,
        updatedAt: 2,
      },
    ],
    preferences: {
      server: {
        advancedSettings: true,
        allowAutoThemes: false,
        allowErrorMonitoring: false,
        guestDashboard: false,
        themeBase: 'dark',
        themeColor: 'purple',
      },
      automatic: {
        settings,
        systemEnabled: true,
        policy: { version: 1, orbis: { revision: 1, enabled: true, time: '04:00' }, system: { revision: 1, enabled: true, time: '02:00' } },
      },
      timeMachine: defaultTimeMachinePreferences(),
    },
    credentials:
      value.accounts === 'keep'
        ? null
        : {
            version: 1,
            users: [1, 2].map((userId) => ({
              userId,
              password: {
                format: 'argon2-phc' as const,
                encoded: '$argon2id$v=19$m=65536,t=3,p=4$YWJjZGVmZ2hpamtsbW5vcA$YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo',
              },
              totp: { enabled: userId === 1, secret: userId === 1 ? 'ABCDEFGHIJKLMNOP' : null },
            })),
            passkeys: {
              policy: 'reenroll',
              state: {
                version: 1,
                users: {
                  '1': {
                    handle: 'synthetic_handle',
                    credentials: [
                      {
                        id: 'synthetic_key',
                        publicKey: 'synthetic_public_key',
                        counter: 9,
                        name: 'Synthetic key',
                        rpID: 'example.invalid',
                        createdAt: 1,
                        lastUsedAt: null,
                        transports: ['internal'],
                      },
                    ],
                  },
                },
              },
            },
          },
    evidence: {
      automatic: {
        state: { version: 1, revision: 1, settings, rules: {}, apps: {}, orbis: attempt, pauseReason: null },
        system: { version: 1, revision: 1, enabled: true, phase: 'install', settingsRevision: 1, policyRevision: 1, attempt, pauseReason: null },
      },
      cluster: { hostId: id(5), invite: { hash: 'a'.repeat(64), expiresAt: 1000, ownerId: 1, authVersion: 2 }, sync: null },
    },
  };
}
function services() {
  let securityBinding = 'synthetic-security';
  return {
    auth: {
      operatorActionContext: vi.fn(async () => ({ userId: 1, sessionBinding: 'synthetic-session', securityBinding })),
      verifySensitiveAction: vi.fn(async () => ({})),
    },
    passkeys: { verifySensitive: vi.fn(async () => ({})) },
    revoke: () => {
      securityBinding = 'changed';
    },
  };
}
async function scope<T>(
  value: ResetExportPlan,
  work: (
    context: {
      access: SettingsExportAccess;
      lease: BackupMaintenanceLease;
      plan: ResetExportPlan;
      signal: AbortSignal;
      value: ResetSafetyState;
      passphrase: string;
    },
    sessionServices: ReturnType<typeof services>,
  ) => Promise<T>,
) {
  const s = services();
  const proof = await verifyResetExportProof(s.auth as unknown as AuthService, s.passkeys as unknown as PasskeyService, request, value.accounts, {
    method: 'password',
    password: 'synthetic-proof',
  });
  const active = signal();
  return withBackupMaintenanceLease(active, (lease) =>
    withResetExportAccess(proof, value, lease, active, (access) =>
      work({ access, lease, plan: value, signal: active, value: fixture(value), passphrase }, s),
    ),
  );
}
afterEach(() => setBackupRecoveryRequired(false));

it('retains all global settings, account profiles, links and isolated evidence without mutating its input', () => {
  const source = fixture(plan());
  const before = JSON.stringify(source);
  const result = resetSafetyStatePayload(source);
  expect(result.users.map((user) => user.id)).toEqual([1, 2]);
  expect(result.preferences).toEqual(source.preferences);
  expect(result.evidence.automatic.system.attempt?.jobId).toBe('old-job');
  expect(result.preferences.automatic).not.toHaveProperty('attempt');
  expect(JSON.stringify(source)).toBe(before);
  const firstLink = source.links[0];
  if (!firstLink) throw new Error('Missing synthetic link');
  expect(() => result.links.push(firstLink)).toThrow();
});

it.each(['keep', 'remove'] as const)('round trips a fully bound encrypted %s-account payload', async (accounts) => {
  await scope(plan(accounts), async (options, s) => {
    const encoded = await encodeResetSafetyState(options);
    expect(encoded.ciphertext.includes(Buffer.from('synthetic-1'))).toBe(false);
    expect(encoded.ciphertext.includes(Buffer.from('ABCDEFGHIJKLMNOP'))).toBe(false);
    const result = await decodeResetSafetyState({ ...encoded, plan: options.plan, passphrase, signal: options.signal });
    expect(result).toEqual(resetSafetyStatePayload(options.value));
    if (accounts === 'remove') {
      expect(result.credentials?.users[0]?.totp.secret).toBe('ABCDEFGHIJKLMNOP');
      expect(result.credentials?.passkeys.policy).toBe('reenroll');
      expect(result.credentials?.passkeys.state.users['1']?.credentials[0]?.counter).toBe(9);
    }
    expect(s.auth.verifySensitiveAction).toHaveBeenCalledTimes(1);
  });
});

it('rejects incomplete coverage, foreign links or credentials, duplicate IDs and host/session fields with sanitized errors', () => {
  const keep = fixture(plan());
  const remove = fixture(plan('remove'));
  const changed = structuredClone(remove);
  const firstCredential = changed.credentials?.users[0];
  if (!firstCredential || !remove.credentials) throw new Error('Missing synthetic credentials');
  firstCredential.totp.secret = 'host:encrypted:ciphertext';
  const { server: _server, ...preferences } = keep.preferences;
  for (const value of [
    { ...keep, preferences },
    { ...keep, users: [keep.users[0], keep.users[0]] },
    { ...keep, links: [{ ...keep.links[0], userId: 99 }] },
    { ...keep, credentials: remove.credentials },
    { ...remove, credentials: null },
    { ...remove, credentials: { ...remove.credentials, users: remove.credentials.users.slice(1) } },
    { ...remove, jwtSecret: 'synthetic-forbidden-host-secret' },
    { ...remove, sessions: ['synthetic-forbidden-session'] },
    changed,
    { ...keep, evidence: { ...keep.evidence, cluster: { ...keep.evidence.cluster, sync: JSON.stringify({ secret: 'synthetic-forbidden-trust' }) } } },
  ]) {
    try {
      resetSafetyStatePayload(value);
      throw new Error('Fixture unexpectedly accepted');
    } catch (error) {
      expect((error as Error).message).toBe('The reset safety backup state could not be verified.');
    }
  }
});

it('rejects altered ciphertext, wrong keys, commitments and reset bindings', async () => {
  await scope(plan('remove'), async (options) => {
    const encoded = await encodeResetSafetyState(options);
    const read = { ...encoded, plan: options.plan, passphrase, signal: options.signal };
    const corrupt = Buffer.from(encoded.ciphertext);
    corrupt[corrupt.length - 1] = (corrupt[corrupt.length - 1] ?? 0) ^ 1;
    for (const value of [
      { ...read, ciphertext: corrupt },
      { ...read, passphrase: 'wrong synthetic secret' },
      { ...read, bytes: read.bytes + 1 },
      { ...read, payloadSha256: 'f'.repeat(64) },
      { ...read, plan: { ...options.plan, resetId: id(999) } },
      { ...read, plan: { ...options.plan, accounts: 'keep' as const } },
    ])
      await expect(decodeResetSafetyState(value)).rejects.toThrow('could not be verified');
  });
});

it('requires real borrowed reset authority and rejects wrong actions before encoding sensitive state', async () => {
  await scope(plan('remove'), async (options) => {
    for (const changed of [
      { ...options, access: { ...options.access } },
      { ...options, lease: {} as BackupMaintenanceLease },
      { ...options, plan: { ...options.plan, resetId: id(999) } },
      { ...options, value: { ...options.value, resetId: id(999) } },
    ])
      await expect(encodeResetSafetyState(changed)).rejects.toThrow();
  });
  const value = plan();
  const item = value.exports[0];
  if (!item) throw new Error('Missing synthetic export');
  const s = services();
  const ticket = await authorizeSettingsPasswordExport(s.auth as unknown as AuthService, request, { password: 'synthetic-proof' }, item);
  await withBackupMaintenanceLease(signal(), (lease) =>
    withSettingsExportAccess(ticket, item, signal(), (access) =>
      expect(encodeResetSafetyState({ value: fixture(value), plan: value, lease, access, passphrase, signal: signal() })).rejects.toThrow(),
    ),
  );
});

it('preserves legacy username conflicts and orphaned invite evidence for explicit destination review', () => {
  const value = fixture(plan());
  const first = value.users[0];
  const second = value.users[1];
  if (!first || !second || !value.evidence.cluster.invite) throw new Error('Missing synthetic account evidence');
  second.username = first.username;
  value.evidence.cluster.invite.ownerId = 99;
  const decoded = resetSafetyStatePayload(value);
  expect(decoded.users.map((user) => user.username)).toEqual([first.username, first.username]);
  expect(decoded.evidence.cluster.invite?.ownerId).toBe(99);
});

it('does not publish ciphertext when the actor changes or cancellation arrives during encryption', async () => {
  await scope(plan(), async (options, s) => {
    const controller = new AbortController();
    const before = s.auth.operatorActionContext.mock.calls.length;
    const encoding = encodeResetSafetyState({ ...options, signal: controller.signal });
    const rejection = expect(encoding).rejects.toThrow();
    await vi.waitFor(() => expect(s.auth.operatorActionContext.mock.calls.length).toBeGreaterThan(before));
    controller.abort();
    await rejection;
  });
  await expect(
    scope(plan(), async (options, s) => {
      s.revoke();
      await encodeResetSafetyState(options);
    }),
  ).rejects.toThrow();
});
