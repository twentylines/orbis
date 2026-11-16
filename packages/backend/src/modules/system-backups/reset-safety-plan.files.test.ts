import { describe, expect, it } from 'vitest';
import { resetExportPlanSha256 } from './settings-export-authorization';
import { assertResetSafetyExportCoverage, planResetSafetyExports } from './reset-safety-plan';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const captures = (count: number, ownerId = 1, start = 1) => Array.from({ length: count }, (_, i) => ({ id: id(start + i), ownerId }));
const source = (count = 0) => ({ resetId: id(90_000), accounts: 'keep' as const, users: [1, 2], captures: captures(count) });
const generator = () => {
  let n = 100_000;
  return () => id(n++);
};

describe('reset safety export planning and coverage', () => {
  it.each(['keep', 'remove'] as const)('includes all four settings sections for every account when accounts=%s', (accounts) => {
    const input = { ...source(), accounts };
    const result = planResetSafetyExports(input, generator());
    expect(result.plan.users).toEqual([1, 2]);
    expect(result.plan.accounts).toBe(accounts);
    expect(result.plan.exports.map((item) => item.selection)).toEqual(
      [1, 2].map(() => ({ version: 1, settings: true, dashboard: true, wallpapers: true, themes: true, timeMachine: [] })),
    );
    expect(result.selectionSha256).toBe(resetExportPlanSha256(result.plan));
  });

  it.each([1, 16, 17, 32, 33])('includes all %i existing captures in bounded batches without re-exporting ordinary settings', (count) => {
    const input = source(count);
    const result = planResetSafetyExports(input, generator());
    const owned = result.plan.exports.filter((item) => item.ownerId === 1);
    expect(owned).toHaveLength(Math.ceil(count / 16));
    expect(owned.flatMap((item) => item.selection.timeMachine)).toEqual(input.captures.map((capture) => capture.id));
    expect(owned.every((item) => item.selection.timeMachine.length <= 16)).toBe(true);
    expect(
      owned.filter((item) => item.selection.settings && item.selection.dashboard && item.selection.wallpapers && item.selection.themes),
    ).toHaveLength(1);
    expect(
      owned.slice(1).every((item) => !item.selection.settings && !item.selection.dashboard && !item.selection.wallpapers && !item.selection.themes),
    ).toBe(true);
    expect(() => assertResetSafetyExportCoverage(result.plan, { users: input.users, captures: input.captures })).not.toThrow();
  });

  it('canonicalizes inventory ordering and does not mutate its inputs', () => {
    const input = { ...source(), users: [2, 1], captures: [...captures(17, 2, 30), ...captures(3)].reverse() };
    const before = JSON.stringify(input);
    const a = planResetSafetyExports(input, generator());
    const b = planResetSafetyExports({ ...input, users: [...input.users].reverse(), captures: [...input.captures].reverse() }, generator());
    expect(a).toEqual(b);
    expect(JSON.stringify(input)).toBe(before);
    expect(() => a.plan.users.push(3)).toThrow();
    expect(() => a.plan.exports[0]?.selection.timeMachine.push(id(9))).toThrow();
  });

  it('rejects changed users, removed/added captures and changed capture ownership during coverage recheck', () => {
    const input = source(17);
    const { plan } = planResetSafetyExports(input, generator());
    for (const current of [
      { users: [1], captures: input.captures },
      { users: [1, 2, 3], captures: input.captures },
      { users: input.users, captures: input.captures.slice(1) },
      { users: input.users, captures: [...input.captures, ...captures(1, 2, 99)] },
      { users: input.users, captures: input.captures.map((capture, index) => ({ ...capture, ownerId: index === 0 ? 2 : capture.ownerId })) },
    ])
      expect(() => assertResetSafetyExportCoverage(plan, current)).toThrow('needs review');
  });

  it('rejects missing sections, duplicate full-profile exports and omitted captures even if the authorization plan itself permits them', () => {
    const input = source(17);
    const { plan } = planResetSafetyExports(input, generator());
    const first = plan.exports[0];
    if (!first) throw new Error('Missing fixture export');
    for (const exports of [
      plan.exports.filter((item) => item.exportId !== first.exportId),
      [...plan.exports, { ...first, exportId: id(800_000), selection: { ...first.selection, timeMachine: [] } }],
      plan.exports.map((item) => ({ ...item, selection: { ...item.selection, timeMachine: [] } })),
      plan.exports.map((item) => ({ ...item, selection: { ...item.selection, themes: false } })),
    ])
      expect(() => assertResetSafetyExportCoverage({ ...plan, exports }, { users: input.users, captures: input.captures })).toThrow('needs review');
  });

  it('rejects invalid inventories and excessive batches before allocating export IDs', () => {
    for (const input of [
      { ...source(), users: [] },
      { ...source(), users: Array(1) },
      { ...source(), users: [1, 1] },
      { ...source(), users: [0] },
      { ...source(), users: [Number.MAX_SAFE_INTEGER + 1] },
      { ...source(), users: Array.from({ length: 257 }, (_, i) => i + 1) },
      { ...source(), captures: [{ id: id(1), ownerId: 3 }] },
      { ...source(), captures: [...captures(1), ...captures(1)] },
      { ...source(), captures: [{ id: '../escape', ownerId: 1 }] },
      { ...source(), captures: Array(1) },
      { ...source(), captures: [{ ...captures(1)[0], path: '/external' }] },
      { ...source(), captures: captures(65_536) },
      { ...source(), captures: captures(65_537) },
    ]) {
      let allocated = 0;
      expect(() =>
        planResetSafetyExports(input as ReturnType<typeof source>, () => {
          allocated++;
          return id(allocated);
        }),
      ).toThrow('needs review');
      expect(allocated).toBe(0);
    }
  });

  it('rejects invalid reset choices and undeclared metadata', () => {
    for (const input of [
      { ...source(), resetId: 'not-a-reset-id' },
      { ...source(), accounts: 'delete-apps' },
      { ...source(), path: '/external' },
      { ...source(), [Symbol('hidden')]: true },
    ])
      expect(() => planResetSafetyExports(input as ReturnType<typeof source>, generator())).toThrow('needs review');
  });

  it('accepts the 4096-export boundary and refuses invalid or reused export IDs', () => {
    const input = { ...source(), users: [1], captures: captures(65_536) };
    const result = planResetSafetyExports(input, generator());
    expect(result.plan.exports).toHaveLength(4096);
    expect(result.plan.exports.flatMap((item) => item.selection.timeMachine)).toHaveLength(65_536);
    expect(() => planResetSafetyExports(source(), () => 'invalid')).toThrow('needs review');
    expect(() => planResetSafetyExports(source(), () => id(7))).toThrow('needs review');
  });

  it('uses fresh UUIDs by default and binds the exact generated plan', () => {
    const a = planResetSafetyExports(source());
    const b = planResetSafetyExports(source());
    expect(a.plan.exports[0]?.exportId).not.toBe(b.plan.exports[0]?.exportId);
    expect(a.selectionSha256).not.toBe(b.selectionSha256);
    expect(a.inventorySha256).toBe(b.inventorySha256);
  });
});
