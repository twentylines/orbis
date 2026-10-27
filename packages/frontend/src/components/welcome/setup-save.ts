import type { AppUpdateRule } from '@/desktop/automatic-updates-api';

export type SetupSaveStep = { id: string; label?: string; value: unknown; save: () => Promise<unknown> };
export type SetupAppChoices = Map<string, { name: string; previous: AppUpdateRule }>;

export function setupAppUpdateSteps(
  selected: Array<{ urn: string; name: string }>,
  touched: SetupAppChoices,
  api: { read: (urn: string) => Promise<{ rule: AppUpdateRule }>; save: (urn: string, rule: AppUpdateRule) => Promise<unknown> },
): SetupSaveStep[] {
  const apps = new Map([...touched].map(([urn, app]) => [urn, app.name]));
  const selectedUrns = new Set(selected.map(({ urn }) => urn));
  for (const { urn, name } of selected) apps.set(urn, name);
  return [...apps].map(([urn, name]) => {
    const rule: AppUpdateRule = selectedUrns.has(urn) ? { mode: 'global' } : (touched.get(urn)?.previous ?? { mode: 'disabled' });
    return {
      id: `app:${urn}`,
      label: `Saving updates for ${name}`,
      value: { urn, rule },
      save: async () => {
        // Preserve the previous rule before writing, including when the save response is lost.
        if (!touched.has(urn)) touched.set(urn, { name, previous: { ...(await api.read(urn)).rule } });
        await api.save(urn, rule);
      },
    };
  });
}

// Successful steps are retained when a later request fails; changed choices get a new receipt.
export async function saveSetupSteps(steps: SetupSaveStep[], receipts: Map<string, string>, onProgress: (label: string) => void) {
  for (const step of steps) {
    const fingerprint = JSON.stringify(step.value);
    if (receipts.get(step.id) === fingerprint) continue;
    onProgress(step.label ?? step.id);
    await step.save();
    receipts.set(step.id, fingerprint);
  }
}
