import type { SettingToggle } from './use-autosaved-toggle';
import { useGeneralSettingToggles } from './use-general-setting-toggles';
import { useUpdateSettingToggles } from './use-update-setting-toggles';
import { useTimeMachineEnabledToggle } from '@/modules/time-machine/use-time-machine-enabled-toggle';
import { useNearbyVisibilityToggle } from '@/components/nearby-servers/nearby-visibility';
import { useAppearanceSettingToggles } from './use-appearance-setting-toggles';

export type { SettingToggle } from './use-autosaved-toggle';

export function useSettingToggles(ids: readonly string[], enabled = true): Partial<Record<string, SettingToggle>> {
  const general = useGeneralSettingToggles(enabled);
  const updates = useUpdateSettingToggles(ids, enabled);
  const timeMachine = useTimeMachineEnabledToggle(enabled && ids.includes('time-machine'));
  const nearby = useNearbyVisibilityToggle(enabled && ids.includes('nearby-visibility'));
  const appearance = useAppearanceSettingToggles(ids, enabled);
  const controls = { ...general, ...updates, ...appearance, 'time-machine': timeMachine, 'nearby-visibility': nearby.toggle };
  return Object.fromEntries(Object.entries(controls).filter(([id]) => ids.includes(id)));
}
