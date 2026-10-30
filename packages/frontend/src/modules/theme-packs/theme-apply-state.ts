import { themePackSnapshotSchema, type ThemePackReference, type ThemePackSnapshot } from '@runtipi/common/schemas/theme-pack';

export type ThemeApplyAction = {
  kind: 'select' | 'update' | 'rollback' | 'remove';
  source: ThemePackReference | null;
  target: ThemePackReference | null;
  name: string;
  id?: string;
};
export type ThemeApplyStage = 'checking' | 'applying' | 'reconciling' | 'reloading';
export function sameTheme(left: ThemePackReference | null | undefined, right: ThemePackReference | null | undefined) {
  return (left ?? null) === (right ?? null) || Boolean(left && right && left.id === right.id && left.version === right.version);
}
export function themeApplyAcknowledged(snapshot: ThemePackSnapshot, action: Pick<ThemeApplyAction, 'target' | 'kind' | 'id'>) {
  return (
    themePackSnapshotSchema.allows(snapshot) &&
    sameTheme(snapshot.state.selected, action.target) &&
    (action.target === null || snapshot.state.installed.some(({ manifest }) => sameTheme(manifest, action.target))) &&
    (action.kind !== 'remove' || !snapshot.state.installed.some(({ manifest }) => manifest.id === action.id))
  );
}
export function themeApplyAvailable(snapshot: ThemePackSnapshot, action: ThemeApplyAction) {
  if (!themePackSnapshotSchema.allows(snapshot) || !sameTheme(snapshot.state.selected, action.source)) return false;
  if (action.kind === 'select') return action.target === null || snapshot.state.installed.some(({ manifest }) => sameTheme(manifest, action.target));
  const installed = snapshot.state.installed.find(({ manifest }) => manifest.id === action.id);
  if (!installed || installed.manifest.id !== action.source?.id) return false;
  if (action.kind === 'remove') return action.target === null;
  if (action.kind === 'rollback') return Boolean(installed.previous && sameTheme(installed.previous.manifest, action.target));
  return snapshot.catalogue.some((manifest) => sameTheme(manifest, action.target));
}

export async function runThemeApply(
  action: ThemeApplyAction,
  dependencies: {
    signal: AbortSignal;
    current: () => boolean;
    cover: () => Promise<void>;
    read: () => Promise<ThemePackSnapshot>;
    execute: () => Promise<ThemePackSnapshot>;
    persist: (snapshot: ThemePackSnapshot) => boolean;
    reload: () => void;
    stage: (stage: ThemeApplyStage) => void;
  },
) {
  const assert = () => {
    dependencies.signal.throwIfAborted();
    if (!dependencies.current()) throw new Error('Your session changed. Cancel and choose a theme again.');
  };
  assert();
  await dependencies.cover();
  assert();
  dependencies.stage('checking');
  let snapshot = await dependencies.read();
  assert();
  if (!themeApplyAcknowledged(snapshot, action)) {
    if (!themeApplyAvailable(snapshot, action)) throw new Error('This theme selection changed. Cancel and choose a theme again.');
    dependencies.stage('applying');
    try {
      snapshot = await dependencies.execute();
      assert();
      if (!themeApplyAcknowledged(snapshot, action)) throw new Error('Theme acknowledgement did not match.');
    } catch {
      assert();
      dependencies.stage('reconciling');
      snapshot = await dependencies.read();
      assert();
      if (!themeApplyAcknowledged(snapshot, action)) throw new Error('The theme could not be confirmed. Retry or cancel.');
    }
  }
  assert();
  if (!themeApplyAcknowledged(snapshot, action) || !dependencies.persist(snapshot))
    throw new Error('The theme is saved, but this browser could not prepare the reload. Retry or cancel.');
  assert();
  dependencies.stage('reloading');
  dependencies.reload();
}
