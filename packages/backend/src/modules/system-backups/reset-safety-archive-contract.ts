import { createHash } from 'node:crypto';
import path from 'node:path';
import { type } from 'arktype';
import { settingsBackupSelectionSchema, type SettingsBackupSelection } from '@runtipi/common/schemas/settings-backup';
import { resetTargetNames } from '../system-reset/reset-contract';
import { resetExportPlanSha256, type ResetExportPlan } from './settings-export-authorization';
import { validateResetCaptureRecoveryManifest, type ResetCaptureRecoveryManifest } from './reset-capture-recovery-manifest';
import { resetSafetyArchiveLimits } from './reset-safety-archive-limits';

export { resetSafetyArchiveLimits };
const fail = () => new Error('The reset safety archive contents could not be verified.');
const uuid = type('string').narrow((value) => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value));
const hash = type('string').narrow((value) => /^[a-f0-9]{64}$/.test(value));
const bytes = type('number.integer > 0').narrow((value) => Number.isSafeInteger(value) && value <= resetSafetyArchiveLimits.archiveBytes);
const plainBytes = type('number.integer >= 0').narrow((value) => Number.isSafeInteger(value) && value <= resetSafetyArchiveLimits.fileBytes - 52);
const name = type('string').narrow((value) => /^parts\/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.orbis$/.test(value));
const part = type({ name, bytes, sha256: hash }).onUndeclaredKey('reject');
const user = type('number.integer > 0').narrow(Number.isSafeInteger);
const targetName = type('string <= 4096').narrow(
  (value) =>
    value.length > 0 &&
    Buffer.byteLength(value) <= 4096 &&
    Array.from(value).every((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point >= 32 && point !== 127 && point !== 92 && (point < 0xd800 || point > 0xdfff);
    }) &&
    value.split('/').every((component) => component !== '' && component !== '.' && component !== '..'),
);
const target = type({ name: targetName, type: "'absent' | 'directory'" }).or({
  name: targetName,
  type: "'file'",
  part,
  plaintextBytes: plainBytes,
  plaintextSha256: hash,
});
const profile = type({ exportId: uuid, ownerId: user, selection: settingsBackupSelectionSchema, bundleId: uuid, part });
const indexSchema = type({
  format: "'orbis-reset-safety-index'",
  version: '1 | 2',
  backupId: uuid,
  manifest: { bytes, sha256: hash },
  parts: part.array().atLeastLength(1).atMostLength(resetSafetyArchiveLimits.v2Parts),
}).onDeepUndeclaredKey('reject');
const manifestSchema = type({
  format: "'orbis-reset-safety'",
  version: '1 | 2',
  backupId: uuid,
  createdAt: type('string').narrow((value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value),
  orbisVersion: type('string').narrow((value) => /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(value)),
  indexSha256: hash,
  fullScopeSha256: hash,
  exportInventorySha256: hash,
  plan: 'unknown',
  state: { part, payloadSha256: hash },
  targets: {
    version: '1',
    resetId: uuid,
    accounts: "'keep' | 'remove'",
    users: user.array().atMostLength(256),
    selectionSha256: hash,
    inventorySha256: hash,
    targets: target.array().atMostLength(resetSafetyArchiveLimits.targets),
  },
  profiles: profile.array().atLeastLength(1).atMostLength(4096),
  'captures?': 'unknown',
}).onDeepUndeclaredKey('reject');
export type ResetSafetyArchivePart = typeof part.infer;
export type ResetSafetyArchiveIndex = typeof indexSchema.infer;
export type ResetSafetyArchiveManifest = Omit<typeof manifestSchema.infer, 'plan' | 'captures'> & {
  plan: ResetExportPlan;
  captures?: ResetCaptureRecoveryManifest;
};
export const resetSafetyJson = (value: unknown) => Buffer.from(JSON.stringify(value));
export const resetSafetyDigest = (value: unknown) => createHash('sha256').update(resetSafetyJson(value)).digest('hex');
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function parseResetSafetyJson(data: Buffer) {
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
    if (!resetSafetyJson(value).equals(data)) throw fail();
    return value;
  } catch {
    throw fail();
  }
}
export function resetSafetySelectionKey(value: SettingsBackupSelection) {
  settingsBackupSelectionSchema.assert(value);
  return JSON.stringify({
    version: 1,
    settings: value.settings,
    dashboard: value.dashboard,
    wallpapers: value.wallpapers,
    themes: value.themes,
    timeMachine: [...value.timeMachine].sort(),
  });
}
export function resetSafetyExportInventorySha256(plan: ResetExportPlan) {
  resetExportPlanSha256(plan);
  const captures = plan.exports
    .flatMap((item) => item.selection.timeMachine.map((id) => ({ id, ownerId: item.ownerId })))
    .sort((a, b) => a.ownerId - b.ownerId || a.id.localeCompare(b.id));
  return createHash('sha256')
    .update('orbis-reset-export-inventory-v1\n')
    .update(JSON.stringify({ users: [...plan.users].sort((a, b) => a - b), captures }))
    .digest('hex');
}
export function resetSafetyIndexSha256(index: Pick<ResetSafetyArchiveIndex, 'format' | 'version' | 'backupId' | 'parts'>) {
  return resetSafetyDigest({ format: index.format, version: index.version, backupId: index.backupId, parts: index.parts });
}
export function resetSafetyFullScopeSha256(manifest: Omit<ResetSafetyArchiveManifest, 'fullScopeSha256'> | ResetSafetyArchiveManifest) {
  return createHash('sha256')
    .update(manifest.version === 2 ? 'orbis-reset-safety-scope-v2\n' : 'orbis-reset-safety-scope-v1\n')
    .update(
      resetSafetyJson({
        selectionSha256: resetExportPlanSha256(manifest.plan),
        exportInventorySha256: manifest.exportInventorySha256,
        statePayloadSha256: manifest.state.payloadSha256,
        targetInventorySha256: manifest.targets.inventorySha256,
        profiles: [...manifest.profiles].sort((a, b) => a.exportId.localeCompare(b.exportId)),
        ...(manifest.version === 2 ? { captures: manifest.captures } : {}),
      }),
    )
    .digest('hex');
}
export function validateResetSafetyIndex(input: unknown): ResetSafetyArchiveIndex {
  try {
    const value = indexSchema.assert(input);
    if (
      value.manifest.bytes > (value.version === 2 ? resetSafetyArchiveLimits.v2ManifestBytes : resetSafetyArchiveLimits.manifestBytes) + 52 ||
      value.parts.length > (value.version === 2 ? resetSafetyArchiveLimits.v2Parts : resetSafetyArchiveLimits.parts) ||
      resetSafetyJson(value).length > (value.version === 2 ? resetSafetyArchiveLimits.v2IndexBytes : resetSafetyArchiveLimits.indexBytes) ||
      new Set(value.parts.map((item) => item.name)).size !== value.parts.length ||
      value.parts.some((item) => item.bytes > resetSafetyArchiveLimits.profileBytes) ||
      value.parts.reduce((sum, item) => sum + item.bytes, 0) > resetSafetyArchiveLimits.archiveBytes
    )
      throw fail();
    return freeze(value);
  } catch {
    throw fail();
  }
}
export function validateResetSafetyManifest(input: unknown, index: ResetSafetyArchiveIndex): ResetSafetyArchiveManifest {
  try {
    const value = { ...manifestSchema.assert(input) } as ResetSafetyArchiveManifest;
    if (value.version !== index.version) throw fail();
    if (value.version === 1) {
      if (Object.hasOwn(value, 'captures')) throw fail();
    } else {
      value.captures = validateResetCaptureRecoveryManifest(value.captures);
      if (
        value.captures.resetId !== value.plan.resetId ||
        value.captures.accounts !== value.plan.accounts ||
        value.plan.exports.some((item) => item.selection.timeMachine.length !== 0)
      )
        throw fail();
    }
    const { captures: _captures, ...ordinary } = value;
    if (
      resetSafetyJson(ordinary).length > resetSafetyArchiveLimits.manifestBytes ||
      resetSafetyJson(value).length > (value.version === 2 ? resetSafetyArchiveLimits.v2ManifestBytes : resetSafetyArchiveLimits.manifestBytes)
    )
      throw fail();
    const plan = value.plan;
    const selectionSha256 = resetExportPlanSha256(plan);
    if (
      value.backupId !== index.backupId ||
      value.indexSha256 !== resetSafetyIndexSha256(index) ||
      value.exportInventorySha256 !== resetSafetyExportInventorySha256(plan) ||
      value.fullScopeSha256 !== resetSafetyFullScopeSha256(value) ||
      value.state.part.bytes > resetSafetyArchiveLimits.stateBytes ||
      value.targets.resetId !== plan.resetId ||
      value.targets.accounts !== plan.accounts ||
      value.targets.selectionSha256 !== selectionSha256 ||
      JSON.stringify([...value.targets.users].sort((a, b) => a - b)) !== JSON.stringify([...plan.users].sort((a, b) => a - b))
    )
      throw fail();
    const indexed = new Map(index.parts.map((item) => [item.name, item]));
    const used = new Set<string>();
    const use = (item: ResetSafetyArchivePart) => {
      const expected = indexed.get(item.name);
      if (!expected || item.bytes !== expected.bytes || item.sha256 !== expected.sha256 || used.has(item.name)) throw fail();
      used.add(item.name);
    };
    use(value.state.part);
    const rootNames = resetTargetNames({
      version: 1,
      id: plan.resetId,
      controller: 'archive',
      accounts: plan.accounts,
      users: plan.users,
      phase: 'prepared',
      createdAt: 1,
    });
    const roots = new Set(rootNames);
    const targets = new Map(value.targets.targets.map((item) => [item.name, item]));
    if (targets.size !== value.targets.targets.length || rootNames.some((name) => !targets.has(name))) throw fail();
    let plainTotal = 0;
    for (const item of value.targets.targets) {
      const root = rootNames.find((root) => root === item.name || (root.startsWith('theme-packs/') && item.name.startsWith(`${root}/`)));
      if (
        !root ||
        (!roots.has(item.name) && targets.get(path.posix.dirname(item.name))?.type !== 'directory') ||
        (item.name === root && root.startsWith('theme-packs/') ? item.type === 'file' : roots.has(item.name) && item.type === 'directory')
      )
        throw fail();
      if (item.type === 'file') {
        if (item.part.bytes > resetSafetyArchiveLimits.fileBytes || item.part.bytes !== item.plaintextBytes + 52) throw fail();
        use(item.part);
        plainTotal += item.plaintextBytes;
      }
    }
    if (plainTotal > resetSafetyArchiveLimits.targetBytes) throw fail();
    const inventory = [...value.targets.targets]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((item) =>
        item.type === 'file'
          ? { name: item.name, type: item.type, plaintextBytes: item.plaintextBytes, plaintextSha256: item.plaintextSha256 }
          : { name: item.name, type: item.type },
      );
    if (
      createHash('sha256').update('orbis-reset-safety-targets-v1\n').update(JSON.stringify(inventory)).digest('hex') !== value.targets.inventorySha256
    )
      throw fail();
    const exports = new Map(plan.exports.map((item) => [item.exportId, item]));
    if (exports.size !== value.profiles.length || new Set(value.profiles.map((item) => item.bundleId)).size !== value.profiles.length) throw fail();
    const full = new Map(plan.users.map((id) => [id, 0]));
    for (const item of value.profiles) {
      const expected = exports.get(item.exportId);
      if (!expected || item.ownerId !== expected.ownerId || resetSafetySelectionKey(item.selection) !== resetSafetySelectionKey(expected.selection))
        throw fail();
      exports.delete(item.exportId);
      const ordinary = [item.selection.settings, item.selection.dashboard, item.selection.wallpapers, item.selection.themes];
      if (ordinary.every(Boolean)) full.set(item.ownerId, (full.get(item.ownerId) ?? 0) + 1);
      else if (ordinary.some(Boolean)) throw fail();
      if (item.part.bytes > resetSafetyArchiveLimits.profileBytes) throw fail();
      use(item.part);
    }
    const captureNames: string[] = [];
    for (const entry of value.captures?.entries ?? []) {
      if (entry.type !== 'file') continue;
      for (const chunk of entry.chunks) {
        const name = `parts/${chunk.part}`;
        use({ name, bytes: chunk.bytes, sha256: chunk.sha256 });
        captureNames.push(name);
      }
    }
    const captured = new Set(captureNames);
    if (JSON.stringify(index.parts.filter((part) => captured.has(part.name)).map((part) => part.name)) !== JSON.stringify(captureNames)) throw fail();
    if (full.size !== plan.users.length || [...full.values()].some((count) => count !== 1) || exports.size || used.size !== indexed.size)
      throw fail();
    return freeze(value);
  } catch {
    throw fail();
  }
}
