import type { SettingsSection } from './settings-catalogue';

export type SettingsSaveEntry = {
  section: SettingsSection;
  dirty: boolean;
  pending: boolean;
  prepare: () => Promise<(() => Promise<void>) | null>;
};

export type SettingsSaveResult = { saved: number; failed?: SettingsSection; invalid?: boolean; cancelled?: boolean };

export async function saveSettingsPlan(entries: SettingsSaveEntry[], signal?: AbortSignal): Promise<SettingsSaveResult> {
  if (signal?.aborted) return { saved: 0, cancelled: true };
  const dirty = entries.filter((entry) => entry.dirty);
  if (entries.some((entry) => entry.pending)) return { saved: 0 };
  const prepared: Array<{ section: SettingsSection; commit: () => Promise<void> }> = [];
  for (const entry of dirty) {
    if (signal?.aborted) return { saved: 0, cancelled: true };
    try {
      const commit = await entry.prepare();
      if (signal?.aborted) return { saved: 0, cancelled: true };
      if (!commit) return { saved: 0, failed: entry.section, invalid: true };
      prepared.push({ section: entry.section, commit });
    } catch {
      if (signal?.aborted) return { saved: 0, cancelled: true };
      return { saved: 0, failed: entry.section, invalid: true };
    }
  }
  let saved = 0;
  for (const entry of prepared) {
    if (signal?.aborted) return { saved, cancelled: true };
    try {
      await entry.commit();
      saved++;
      if (signal?.aborted) return { saved, cancelled: true };
    } catch {
      if (signal?.aborted) return { saved, cancelled: true };
      return { saved, failed: entry.section };
    }
  }
  return { saved };
}
