import { IconDeviceDesktop, IconMoon, IconSun } from '@tabler/icons-react';
import { Button } from '@/components/ui/Button';
import { Switch } from '@/components/ui/Switch/Switch';
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
  const choices = [
    { value: 'light', label: 'Light', Icon: IconSun },
    { value: 'dark', label: 'Dark', Icon: IconMoon },
    { value: 'system', label: 'System', Icon: IconDeviceDesktop },
  ] as const;
  return (
    <div className="orbis-colour-mode-setting" data-compact={compact || undefined}>
      <fieldset className="orbis-colour-mode-choice" aria-label="Display mode">
        {choices.map(({ value, label, Icon }) => (
          <Button
            key={value}
            type="button"
            variant="outline"
            aria-pressed={mode === value}
            data-setting-value={value}
            onClick={() => onChange({ mode: value, oledDark })}
          >
            <Icon size={compact ? 19 : 24} stroke={1.5} aria-hidden="true" />
            <span>{label}</span>
          </Button>
        ))}
      </fieldset>
      <div className="orbis-colour-mode-oled">
        <Switch data-setting-focus="oled" label="Use OLED blacks" checked={oledDark} onCheckedChange={(next) => onChange({ mode, oledDark: next })} />
        <small>Applies whenever the active colour mode is dark.</small>
      </div>
    </div>
  );
}
