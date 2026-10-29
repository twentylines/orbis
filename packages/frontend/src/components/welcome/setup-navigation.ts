export const freshSetupSteps = ['choose', 'server', 'colour', 'wallpaper', 'performance', 'updates', 'ready'] as const;
export type SetupStep = (typeof freshSetupSteps)[number] | 'restore' | 'transfer';
export type SetupEntry = 'fresh' | 'restore' | 'transfer' | null;

export const setupStepCopy: Record<SetupStep, { title: string; description: string }> = {
  choose: { title: 'Welcome to Orbis', description: 'Start fresh, restore an encrypted backup, or transfer from another server.' },
  server: { title: 'Your server', description: 'Give this server a name. You can change every choice later in Settings.' },
  colour: { title: 'Colour', description: 'Choose a palette and display mode. Preview your workspace as you go.' },
  wallpaper: { title: 'Wallpaper', description: 'Each palette has its own landscape. Keep them linked, or choose a favourite.' },
  performance: { title: 'Performance', description: 'Choose the balance that suits your devices. Your apps keep all their features.' },
  updates: { title: 'Updates', description: 'Keep updates manual, or choose what Orbis may update automatically.' },
  ready: { title: 'Ready when you are', description: 'Review your choices before opening your workspace.' },
  restore: {
    title: 'Restore your server',
    description:
      'Upload and verify an encrypted backup before replacing this server. Its saved configuration and managed app data are restored together.',
  },
  transfer: {
    title: 'Transfer your server',
    description: 'Receive an encrypted backup from your original server over a private HTTPS connection. Review it before replacing this server.',
  },
};

export function nextSetupStep(step: SetupStep, entry: SetupEntry): SetupStep | null {
  if (step === 'choose') return entry === 'restore' ? 'restore' : entry === 'transfer' ? 'transfer' : entry === 'fresh' ? 'server' : null;
  if (step === 'restore' || step === 'transfer' || step === 'ready') return null;
  return freshSetupSteps[freshSetupSteps.indexOf(step) + 1] ?? null;
}

export function previousSetupStep(step: SetupStep): SetupStep | null {
  if (step === 'restore' || step === 'transfer') return 'choose';
  return freshSetupSteps[freshSetupSteps.indexOf(step) - 1] ?? null;
}

export function setupPosition(step: SetupStep) {
  return step === 'restore' || step === 'transfer'
    ? { current: 2, total: 2 }
    : { current: freshSetupSteps.indexOf(step) + 1, total: freshSetupSteps.length };
}

export function setupCanFinish(step: SetupStep, entry: SetupEntry): boolean {
  return step === 'ready' && entry === 'fresh';
}
