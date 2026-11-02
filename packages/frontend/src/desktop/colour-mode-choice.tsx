import { IconDeviceDesktop, IconMoon, IconSun, IconCircleHalf2 } from '@tabler/icons-react';
import { Button } from '@/components/ui/Button';
import type { ColourMode } from './colour-mode';
import './colour-mode-choice.css';

export function ColourModeChoice({
  mode,
  oledDark,
  onChange,
  compact = false,
}: {
  mode: ColourMode;
  oledDark: boolean;
  onChange: (value: { mode: ColourMode; oledDark: boolean }) => void;
  compact?: boolean;
}) {
  const selected = mode === 'dark' && oledDark ? 'oled' : mode;
  const choices = [
    { value: 'light', label: 'Light', Icon: IconSun },
    { value: 'dark', label: 'Dark', Icon: IconMoon },
    { value: 'oled', label: 'OLED', Icon: IconCircleHalf2 },
    { value: 'system', label: 'System', Icon: IconDeviceDesktop },
  ] as const;
  return (
    <fieldset className="orbis-colour-mode-choice" aria-label="Display mode" data-compact={compact || undefined}>
      {choices.map(({ value, label, Icon }) => (
        <Button
          key={value}
          type="button"
          variant="outline"
          aria-pressed={selected === value}
          data-setting-value={value}
          onClick={() =>
            onChange({ mode: value === 'oled' ? 'dark' : value, oledDark: value === 'oled' ? true : value === 'dark' ? false : oledDark })
          }
        >
          <Icon size={compact ? 19 : 24} stroke={1.5} aria-hidden="true" />
          <span>{label}</span>
        </Button>
      ))}
    </fieldset>
  );
}
