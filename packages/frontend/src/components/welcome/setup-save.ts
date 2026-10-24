export type SetupSaveStep = { id: string; label?: string; value: unknown; save: () => Promise<unknown> };

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
