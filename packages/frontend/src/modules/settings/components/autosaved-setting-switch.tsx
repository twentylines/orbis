import { Switch } from '@/components/ui/Switch';
import type { ReactNode } from 'react';
import type { SettingToggle } from '../hooks/use-autosaved-toggle';
import { useSettingsPreferenceActivity } from '../pages/settings-save';

export function AutosavedSettingSwitch({
  toggle,
  label,
  id,
  className,
  showStatus = false,
}: {
  toggle: SettingToggle;
  label: ReactNode;
  id?: string;
  className?: string;
  showStatus?: boolean;
}) {
  useSettingsPreferenceActivity(toggle.pending, toggle.saved, Boolean(toggle.error));
  return (
    <div>
      <Switch
        id={id}
        className={className}
        label={label}
        checked={toggle.checked}
        disabled={toggle.disabled}
        aria-busy={toggle.pending || undefined}
        onCheckedChange={toggle.setChecked}
      />
      {showStatus && (toggle.pending || toggle.saved) ? <output>{toggle.pending ? 'Saving…' : 'Saved'}</output> : null}
      {toggle.error ? (
        <p role="alert">
          {toggle.error}{' '}
          {toggle.retry ? (
            <button type="button" className="btn btn-outline-primary" onClick={toggle.retry}>
              Try again
            </button>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
