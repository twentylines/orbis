export const freshSetupSteps = ['choose', 'server', 'colour', 'wallpaper', 'performance', 'updates', 'ready'] as const;
export type SetupStep = (typeof freshSetupSteps)[number] | 'restore';
export type SetupEntry = 'fresh' | 'restore' | null;

export const setupStepCopy: Record<SetupStep, { title: string; description: string }> = {
  choose: { title: 'Welcome to Orbis', description: 'Start with a new workspace, or restore configuration and app data from an encrypted backup.' },
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
};

export function nextSetupStep(step: SetupStep, entry: SetupEntry): SetupStep | null {
  if (step === 'choose') return entry === 'restore' ? 'restore' : entry === 'fresh' ? 'server' : null;
  if (step === 'restore' || step === 'ready') return null;
  return freshSetupSteps[freshSetupSteps.indexOf(step) + 1] ?? null;
}

export function previousSetupStep(step: SetupStep): SetupStep | null {
  if (step === 'restore') return 'choose';
  return freshSetupSteps[freshSetupSteps.indexOf(step) - 1] ?? null;
}

export function setupPosition(step: SetupStep) {
  return step === 'restore' ? { current: 2, total: 2 } : { current: freshSetupSteps.indexOf(step) + 1, total: freshSetupSteps.length };
}

export function setupCanFinish(step: SetupStep, entry: SetupEntry): boolean {
  return step === 'ready' && entry === 'fresh';
}
