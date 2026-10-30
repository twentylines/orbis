import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { automaticUpdateStateSchema, systemUpdateStateSchema, type AutomaticUpdateState, type SystemUpdateState } from './automatic-updates.model';
import {
  legacyScheduleProjection,
  readAutomaticSchedulePolicy,
  schedulePolicyFor,
  beginAutomaticScheduleSave,
  finishAutomaticScheduleSave,
  readAutomaticSchedulePending,
} from './automatic-schedule-policy';
let directory: string;
let file: string;
const state: AutomaticUpdateState = {
  version: 1,
  revision: 3,
  settings: { orbis: { enabled: true, mode: 'scheduled' }, apps: { enabled: true }, schedule: { time: '04:00', timezone: 'UTC' } },
  rules: { 'manual:store': { mode: 'disabled' }, 'custom:store': { mode: 'custom', time: '06:00' } },
  apps: { 'custom:store': { slot: 'retained', state: 'accepted', at: 1, message: 'Retained attempt', jobId: 'owned-job', targetVersion: 2 } },
  orbis: null,
  pauseReason: null,
};
const system: SystemUpdateState = {
  version: 1,
  revision: 4,
  enabled: true,
  phase: null,
  settingsRevision: null,
  policyRevision: null,
  attempt: null,
  pauseReason: null,
};
const policy = () => schedulePolicyFor(state, system, null, { orbisTime: '03:00', systemTime: '05:00' });
beforeEach(async () => {
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-schedule-policy-')));
  file = path.join(directory, 'schedule-policy.json');
});
afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});
it('projects OFF flags into unchanged strict legacy schemas without losing app rules/history or mutating memory', () => {
  const result = legacyScheduleProjection(state, system);
  expect(automaticUpdateStateSchema.allows(result.apps)).toBe(true);
  expect(systemUpdateStateSchema.allows(result.system)).toBe(true);
  expect(result.apps.settings.orbis.enabled).toBe(false);
  expect(result.system.enabled).toBe(false);
  expect(result.apps.rules).toEqual(state.rules);
  expect(result.apps.apps).toEqual(state.apps);
  expect(result.apps.settings.apps).toEqual({ enabled: true });
  expect(state.settings.orbis.enabled).toBe(true);
  expect(system.enabled).toBe(true);
});
it('reads a bounded private canonical policy and keeps three intended times distinct', async () => {
  const value = policy();
  await fs.writeFile(file, JSON.stringify(value), { mode: 0o600 });
  expect(await readAutomaticSchedulePolicy(file)).toEqual(value);
  expect(value.orbis.time).toBe('03:00');
  expect(state.settings.schedule.time).toBe('04:00');
  expect(value.system.time).toBe('05:00');
  expect(schedulePolicyFor({ ...state, revision: 5 }, { ...system, revision: 6 }, value)).toMatchObject({
    orbis: { revision: 5, time: '03:00' },
    system: { revision: 6, time: '05:00' },
  });
});
it('refuses enabled system policy without explicit time and unsafe revision overflow', () => {
  expect(() => schedulePolicyFor(state, system, null)).toThrow();
  expect(() => schedulePolicyFor({ ...state, revision: Number.MAX_SAFE_INTEGER + 1 }, system, null, { systemTime: '05:00' })).toThrow();
});
it.each([
  '{"version":2}',
  '{"version":1,"orbis":{},"system":{},"unknown":true}',
  'x'.repeat(4097),
  '{"version":1,"version":1,"orbis":{"revision":3,"enabled":true,"time":"03:00"},"system":{"revision":4,"enabled":true,"time":"05:00"}}',
])('rejects unknown/future/oversized/duplicate policy without modifying its bytes', async (raw) => {
  await fs.writeFile(file, raw, { mode: 0o600 });
  await expect(readAutomaticSchedulePolicy(file)).rejects.toThrow();
  expect(await fs.readFile(file, 'utf8')).toBe(raw);
});
it('rejects mode, symlink, hardlink and aliased-parent policies on the real filesystem', async () => {
  await fs.writeFile(file, JSON.stringify(policy()), { mode: 0o600 });
  await fs.chmod(file, 0o644);
  await expect(readAutomaticSchedulePolicy(file)).rejects.toThrow();
  await fs.chmod(file, 0o600);
  const link = path.join(directory, 'hardlink');
  await fs.link(file, link);
  await expect(readAutomaticSchedulePolicy(file)).rejects.toThrow();
  await fs.unlink(link);
  const symlink = path.join(directory, 'symlink');
  await fs.symlink(file, symlink);
  await expect(readAutomaticSchedulePolicy(symlink)).rejects.toThrow();
  const alias = `${directory}-alias`;
  await fs.symlink(directory, alias);
  try {
    await expect(readAutomaticSchedulePolicy(path.join(alias, 'schedule-policy.json'))).rejects.toThrow();
  } finally {
    await fs.unlink(alias);
  }
});

it('pending-save guards are exact-owned, reject replay, and release only their bound inode/content', async () => {
  const pending = `${file}.pending`;
  const proof = await beginAutomaticScheduleSave(pending, policy());
  expect((await readAutomaticSchedulePending(pending))?.sha256).toBe(proof.sha256);
  await expect(beginAutomaticScheduleSave(pending, policy())).rejects.toThrow('earlier schedule');
  await expect(finishAutomaticScheduleSave(pending, { ...proof, ino: proof.ino + 1 })).rejects.toThrow('changed');
  expect(await finishAutomaticScheduleSave(pending, proof)).toBe(true);
  expect(await readAutomaticSchedulePending(pending)).toBeNull();
});

it.each([JSON.stringify({ version: 2, sha256: 'a'.repeat(64) }), JSON.stringify({ version: 1, sha256: ['a'.repeat(64)] })])(
  'never clears or accepts an unknown pending-save record',
  async (raw) => {
    const pending = `${file}.pending`;
    await fs.writeFile(pending, raw, { mode: 0o600 });
    await expect(readAutomaticSchedulePending(pending)).rejects.toThrow();
    expect(await fs.readFile(pending, 'utf8')).toBe(raw);
  },
);
