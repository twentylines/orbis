import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { resetTargetNames } from '../system-reset/reset-contract';
import { planResetSafetyExports } from './reset-safety-plan';
import { resetExportPlanSha256 } from './settings-export-authorization';
import {
  parseResetSafetyJson,
  resetSafetyArchiveLimits,
  resetSafetyExportInventorySha256,
  resetSafetyFullScopeSha256,
  resetSafetyIndexSha256,
  resetSafetyJson,
  validateResetSafetyIndex,
  validateResetSafetyManifest,
  type ResetSafetyArchiveIndex,
  type ResetSafetyArchiveManifest,
  type ResetSafetyArchivePart,
} from './reset-safety-archive-contract';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const failure = 'The reset safety archive contents could not be verified.';
const part = (label: string, bytes = 100): ResetSafetyArchivePart => ({ name: `parts/${randomUUID()}.orbis`, bytes, sha256: digest(label) });
type Fixture = { index: ResetSafetyArchiveIndex; manifest: ResetSafetyArchiveManifest };

function targetDigest(targets: ResetSafetyArchiveManifest['targets']['targets']) {
  return createHash('sha256')
    .update('orbis-reset-safety-targets-v1\n')
    .update(
      JSON.stringify(
        [...targets]
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
          .map((item) =>
            item.type === 'file'
              ? { name: item.name, type: item.type, plaintextBytes: item.plaintextBytes, plaintextSha256: item.plaintextSha256 }
              : { name: item.name, type: item.type },
          ),
      ),
    )
    .digest('hex');
}

function commit(value: Fixture) {
  value.manifest.indexSha256 = resetSafetyIndexSha256(value.index);
  value.manifest.exportInventorySha256 = resetSafetyExportInventorySha256(value.manifest.plan);
  value.manifest.targets.inventorySha256 = targetDigest(value.manifest.targets.targets);
  value.manifest.fullScopeSha256 = resetSafetyFullScopeSha256(value.manifest);
  return value;
}

function fixture(): Fixture {
  const plan = structuredClone(
    planResetSafetyExports({
      resetId: randomUUID(),
      accounts: 'remove',
      users: [1, 2],
      captures: Array.from({ length: 17 }, () => ({ id: randomUUID(), ownerId: 1 })),
    }).plan,
  );
  const backupId = randomUUID();
  const state = { part: part('state'), payloadSha256: digest('state plaintext') };
  const targets: ResetSafetyArchiveManifest['targets']['targets'] = resetTargetNames({
    version: 1,
    id: plan.resetId,
    controller: 'synthetic',
    accounts: plan.accounts,
    users: plan.users,
    phase: 'prepared',
    createdAt: 1,
  }).map((name) => ({ name, type: name === 'theme-packs/1' ? 'directory' : 'absent' }));
  const file = part('theme', 55);
  targets.push(
    { name: 'theme-packs/1/é', type: 'directory' },
    { name: 'theme-packs/1/é/config.json', type: 'file', part: file, plaintextBytes: 3, plaintextSha256: digest('raw') },
  );
  const profiles = plan.exports.map((item) => ({ ...structuredClone(item), bundleId: randomUUID(), part: part(item.exportId) }));
  return commit({
    index: {
      format: 'orbis-reset-safety-index',
      version: 1,
      backupId,
      manifest: { bytes: 128, sha256: digest('encrypted manifest') },
      parts: [state.part, file, ...profiles.map((item) => item.part)],
    },
    manifest: {
      format: 'orbis-reset-safety',
      version: 1,
      backupId,
      createdAt: '2026-11-13T00:00:00.000Z',
      orbisVersion: '0.8.0-beta.1',
      indexSha256: '',
      fullScopeSha256: '',
      exportInventorySha256: '',
      plan,
      state,
      targets: {
        version: 1,
        resetId: plan.resetId,
        accounts: plan.accounts,
        users: plan.users,
        selectionSha256: resetExportPlanSha256(plan),
        inventorySha256: '',
        targets,
      },
      profiles,
    },
  });
}

function reject(value: Fixture) {
  expect(() => validateResetSafetyManifest(value.manifest, validateResetSafetyIndex(value.index))).toThrow(failure);
}

describe('complete reset safety archive contract', () => {
  it('binds every user, segmented capture export and exact target while freezing admitted metadata', () => {
    const value = fixture();
    const accepted = validateResetSafetyManifest(value.manifest, validateResetSafetyIndex(value.index));
    expect(accepted.profiles).toHaveLength(3);
    expect(accepted.profiles.flatMap((profile) => profile.selection.timeMachine)).toHaveLength(17);
    expect(Object.isFrozen(accepted)).toBe(true);
    expect(Object.isFrozen(accepted.targets.targets)).toBe(true);
    expect(Object.isFrozen(accepted.profiles[0]?.selection)).toBe(true);
  });

  it('uses deterministic binary target ordering, including Unicode, independent of inventory enumeration', () => {
    const first = fixture();
    const reversed = structuredClone(first);
    reversed.manifest.targets.targets.reverse();
    commit(reversed);
    expect(reversed.manifest.targets.inventorySha256).toBe(first.manifest.targets.inventorySha256);
    expect(reversed.manifest.fullScopeSha256).toBe(first.manifest.fullScopeSha256);
    validateResetSafetyManifest(reversed.manifest, validateResetSafetyIndex(reversed.index));
  });

  it('rejects unsupported versions, duplicate and unsafe part names and unbounded encrypted members', () => {
    for (const mutate of [
      (value: Fixture) => {
        Object.assign(value.index, { version: 2 });
      },
      (value: Fixture) => {
        Object.assign(value.manifest, { version: 2 });
      },
      (value: Fixture) => {
        value.index.parts.push(value.index.parts[0] as ResetSafetyArchivePart);
      },
      (value: Fixture) => {
        (value.index.parts[0] as ResetSafetyArchivePart).name = '../outside';
      },
      (value: Fixture) => {
        value.index.manifest.bytes = resetSafetyArchiveLimits.manifestBytes + 53;
      },
      (value: Fixture) => {
        (value.index.parts[0] as ResetSafetyArchivePart).bytes = resetSafetyArchiveLimits.profileBytes + 1;
      },
      (value: Fixture) => {
        Object.assign(value.manifest, { privatePath: '/synthetic/private' });
      },
    ]) {
      const value = fixture();
      mutate(value);
      reject(value);
    }
  });

  it('refuses missing roots, orphan descendants and paths outside the admitted target roots even with recomputed digests', () => {
    for (const mutate of [
      (value: Fixture) => {
        value.manifest.targets.targets.shift();
      },
      (value: Fixture) => {
        value.manifest.targets.targets = value.manifest.targets.targets.filter((target) => target.name !== 'theme-packs/1/é');
      },
      (value: Fixture) => {
        value.manifest.targets.targets.push({ name: 'unrelated/config', type: 'absent' });
      },
      (value: Fixture) => {
        value.manifest.targets.targets.push({ name: 'theme-packs/1/../outside', type: 'absent' });
      },
      (value: Fixture) => {
        value.manifest.targets.targets.push({ name: 'theme-packs/1/\ud800', type: 'absent' });
      },
    ]) {
      const value = fixture();
      mutate(value);
      reject(commit(value));
    }
  });

  it('refuses missing, reused, misowned and partially selected profile exports', () => {
    for (const mutate of [
      (value: Fixture) => {
        value.manifest.profiles.pop();
      },
      (value: Fixture) => {
        (value.manifest.profiles[0] as ResetSafetyArchiveManifest['profiles'][number]).ownerId = 2;
      },
      (value: Fixture) => {
        (value.manifest.profiles[0] as ResetSafetyArchiveManifest['profiles'][number]).selection.themes = false;
      },
      (value: Fixture) => {
        (value.manifest.profiles[1] as ResetSafetyArchiveManifest['profiles'][number]).bundleId = value.manifest.profiles[0]?.bundleId ?? '';
      },
      (value: Fixture) => {
        (value.manifest.profiles[1] as ResetSafetyArchiveManifest['profiles'][number]).exportId = value.manifest.profiles[0]?.exportId ?? '';
      },
    ]) {
      const value = fixture();
      mutate(value);
      reject(commit(value));
    }
  });

  it('refuses unreferenced parts, cross-role reuse, digest mismatches and inconsistent plaintext sizes', () => {
    for (const mutate of [
      (value: Fixture) => {
        value.index.parts.push(part('extra'));
      },
      (value: Fixture) => {
        value.manifest.state.part = value.manifest.profiles[0]?.part as ResetSafetyArchivePart;
      },
      (value: Fixture) => {
        value.manifest.state.part = { ...value.manifest.state.part, sha256: digest('different') };
      },
      (value: Fixture) => {
        const file = value.manifest.targets.targets.find((target) => target.type === 'file');
        if (file?.type !== 'file') throw new Error('missing synthetic file');
        file.plaintextBytes += 1;
      },
    ]) {
      const value = fixture();
      mutate(value);
      reject(commit(value));
    }
  });

  it('binds account choice, cohort and full scope to the original reset plan', () => {
    for (const mutate of [
      (value: Fixture) => {
        value.manifest.targets.accounts = 'keep';
      },
      (value: Fixture) => {
        value.manifest.targets.users = [1];
      },
      (value: Fixture) => {
        value.manifest.targets.selectionSha256 = digest('other plan');
      },
      (value: Fixture) => {
        value.manifest.fullScopeSha256 = digest('other scope');
      },
    ]) {
      const value = fixture();
      mutate(value);
      reject(value);
    }
  });

  it('requires exact UTF-8 JSON and rejects duplicate keys, whitespace aliases and invalid encoding', () => {
    expect(parseResetSafetyJson(resetSafetyJson({ version: 1 }))).toEqual({ version: 1 });
    for (const bytes of [Buffer.from('{"version":1,"version":1}'), Buffer.from('{ "version": 1 }'), Buffer.from([0x22, 0xff, 0x22])])
      expect(() => parseResetSafetyJson(bytes)).toThrow(failure);
  });
});
