import type { AppOpeningMode } from '@runtipi/common/schemas/app-launch';
import { IconWorld } from '@tabler/icons-react';
import { useId } from 'react';
import './app-launch-mode-choice.css';

const modes = [
  { value: 'window', title: 'Window layout', description: 'Resize apps and arrange them side by side.' },
  { value: 'tab', title: 'Open apps in new tabs', description: 'Open every app in its own browser tab.' },
] as const;

export function AppLaunchModeChoice({ value, onChange }: { value: AppOpeningMode; onChange: (mode: AppOpeningMode) => void }) {
  const id = useId();
  return (
    <fieldset className="app-launch-mode-choice" aria-describedby={`${id}-help`}>
      <legend>Open apps</legend>
      <div className="app-launch-mode-options">
        {modes.map(({ value: mode, title, description }) => (
          <label key={mode} className="app-launch-mode-option">
            <input
              type="radio"
              name={id}
              value={mode}
              checked={value === mode}
              aria-labelledby={`${id}-${mode}-title`}
              aria-describedby={`${id}-${mode}-description`}
              onChange={() => onChange(mode)}
            />
            {mode === 'window' ? (
              <svg className="app-launch-mode-preview" viewBox="0 0 210 96" aria-hidden="true" focusable="false">
                <rect className="app-launch-preview-screen" x="5" y="5" width="200" height="86" rx="8" />
                <rect className="app-launch-preview-chrome" x="12" y="11" width="186" height="9" rx="3" />
                <rect className="app-launch-preview-window" x="20" y="29" width="107" height="48" rx="5" />
                <path className="app-launch-preview-line" d="M25 39h97M25 46h36M25 53h59" />
                <rect className="app-launch-preview-window" x="109" y="43" width="78" height="34" rx="5" />
                <path className="app-launch-preview-line" d="M114 53h68M116 61h27" />
                <rect className="app-launch-preview-chrome" x="69" y="81" width="72" height="5" rx="2.5" />
              </svg>
            ) : (
              <span className="app-launch-mode-icon" aria-hidden="true">
                <IconWorld size={36} stroke={1.6} />
              </span>
            )}
            <span className="app-launch-mode-copy">
              <strong id={`${id}-${mode}-title`}>{title}</strong>
              <span id={`${id}-${mode}-description`}>{description}</span>
            </span>
          </label>
        ))}
      </div>
      <small id={`${id}-help`} className="app-launch-mode-help">
        {value === 'window'
          ? 'Windows are available on larger screens. Some apps need a tab for security or sign-in. Per-app choices apply in this mode.'
          : 'All apps will open in new tabs. Your per-app choices are kept for when Window layout is selected.'}
      </small>
    </fieldset>
  );
}
