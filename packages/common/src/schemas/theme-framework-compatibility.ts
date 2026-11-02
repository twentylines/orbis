import { type } from 'arktype';
import { frameworkIdSchema, type ThemeFrameworkDocument } from './theme-framework-contract.js';
import { themeFrameworkRuntimeAvailable, type FrameworkSoundEventId } from './theme-framework-registry.js';
import { validateThemeFrameworkDocument } from './theme-framework-validation.js';
import { orbisVersionOrder, parseOrbisVersion } from './orbis-release-channel.js';

const revision = type('1 <= number.integer <= 9007199254740991');
export const themeFrameworkUiStateSchema = type({
  schema: "'orbis.theme-ui-support.v1'",
  themeId: frameworkIdSchema,
  installedVersion: type('string <= 32').and(/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/),
  pending: revision.array().atMostLength(64),
  dismissed: revision.array().atMostLength(64),
}).onUndeclaredKey('reject');
export type ThemeFrameworkUiState = typeof themeFrameworkUiStateSchema.infer;
function checked(document: ThemeFrameworkDocument): ThemeFrameworkDocument {
  const result = validateThemeFrameworkDocument(document);
  if (!result.valid) throw new TypeError('Invalid theme framework document.');
  return result.document;
}
export function evaluateThemeFrameworkCompatibility(document: ThemeFrameworkDocument, host: { api: number; release: string }) {
  checked(document);
  const reasons: Array<'host-api' | 'host-release'> = [];
  if (host.api !== document.requires.api) reasons.push('host-api');
  if (!parseOrbisVersion(host.release) || !document.requires.releases.some((release) => orbisVersionOrder(release, host.release) === 0))
    reasons.push('host-release');
  return { hostRequirementsMet: reasons.length === 0, runtimeAvailable: themeFrameworkRuntimeAvailable, reasons };
}
function checkedState(state: unknown): ThemeFrameworkUiState {
  const result = themeFrameworkUiStateSchema(state);
  if (
    result instanceof type.errors ||
    new Set(result.pending).size !== result.pending.length ||
    new Set(result.dismissed).size !== result.dismissed.length ||
    result.dismissed.some((item) => !result.pending.includes(item))
  )
    throw new TypeError('Invalid theme UI support state.');
  return result;
}
export function reconcileThemeFrameworkUiSupport(
  document: ThemeFrameworkDocument,
  previous: unknown,
  markedUiRevision: number | null,
): ThemeFrameworkUiState {
  checked(document);
  if (markedUiRevision !== null && !revision.allows(markedUiRevision)) throw new TypeError('Invalid marked UI revision.');
  const old = previous === null ? null : checkedState(previous);
  if (old && old.themeId !== document.id) throw new TypeError('Theme namespaces must remain separate.');
  const pending = new Set(old?.pending ?? []);
  if (markedUiRevision !== null) pending.add(markedUiRevision);
  for (const supported of document.supportsUiRevisions) pending.delete(supported);
  if (pending.size > 64) throw new RangeError('Theme UI support history requires explicit migration.');
  return {
    schema: 'orbis.theme-ui-support.v1',
    themeId: document.id,
    installedVersion: document.version,
    pending: [...pending].sort((a, b) => a - b),
    dismissed: old?.installedVersion === document.version ? old.dismissed.filter((item) => pending.has(item)) : [],
  };
}
export function dismissThemeFrameworkUiNotice(state: unknown): ThemeFrameworkUiState {
  const current = checkedState(state);
  return { ...current, pending: [...current.pending], dismissed: [...current.pending] };
}
export function themeFrameworkUiNoticeVisible(state: unknown): boolean {
  const current = checkedState(state);
  return current.pending.some((item) => !current.dismissed.includes(item));
}
export function resolveThemeFrameworkSound(
  document: ThemeFrameworkDocument,
  event: FrameworkSoundEventId,
  host: { gestureUnlocked: boolean; muted: boolean; volume: number },
) {
  checked(document);
  if (!host.gestureUnlocked || host.muted || !Number.isFinite(host.volume) || host.volume <= 0 || host.volume > 1) return null;
  const binding = document.sounds.find((sound) => sound.event === event);
  if (!binding?.asset || binding.gain === 0) return null;
  const asset = document.assets.find((asset) => asset.id === binding.asset && asset.kind === 'audio');
  return asset ? { asset: structuredClone(asset), gain: binding.gain * host.volume } : null;
}
