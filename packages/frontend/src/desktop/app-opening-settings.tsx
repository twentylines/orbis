import { useQuery } from '@tanstack/react-query';
import { useId } from 'react';
import { getInstalledAppsOptions } from '@/api-client/@tanstack/react-query.gen';
import type { AppOpeningMode } from '@runtipi/common/schemas';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
import { useDesktopPreferences } from './preferences';
import { AppLaunchModeChoice } from './app-launch-mode-choice';

export function AppOpeningPreference({ urn, name, label = name }: { urn: string; name: string; label?: string }) {
  const { preferences, update } = useDesktopPreferences();
  const triggerId = useId();
  const value = preferences.appLaunch.apps[urn]?.mode ?? 'default';
  return (
    <div className="app-opening-select">
      <label htmlFor={triggerId}>{label}</label>
      <Select
        value={value}
        disabled={preferences.appLaunch.mode === 'tab'}
        onValueChange={(nextValue) => {
          const apps = { ...preferences.appLaunch.apps };
          apps[urn] = { ...apps[urn] };
          if (nextValue === 'default') delete apps[urn].mode;
          else apps[urn].mode = nextValue as AppOpeningMode;
          update({ appLaunch: { ...preferences.appLaunch, apps } });
        }}
      >
        <SelectTrigger id={triggerId} aria-label={`Open ${name}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="default">Use account default</SelectItem>
          <SelectItem value="window">In Orbis</SelectItem>
          <SelectItem value="tab">In a new tab</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

export function AppOpeningSettings() {
  const { preferences, update } = useDesktopPreferences();
  const apps = useQuery(getInstalledAppsOptions());
  return (
    <section className="appearance-section" aria-labelledby="app-opening-heading">
      <div>
        <h2 id="app-opening-heading">Opening apps</h2>
        <p>Choose how apps open on this account.</p>
      </div>
      <div>
        <AppLaunchModeChoice value={preferences.appLaunch.mode} onChange={(mode) => update({ appLaunch: { ...preferences.appLaunch, mode } })} />
        <details className="app-opening-details">
          <summary>Choose for each app</summary>
          {apps.isError ? (
            <p>
              App preferences could not be loaded.{' '}
              <button type="button" onClick={() => void apps.refetch()}>
                Retry
              </button>
            </p>
          ) : null}
          {apps.isPending ? <p>Loading installed apps…</p> : null}
          <ul className="app-opening-overrides">
            {apps.data?.installed
              .filter(({ info }) => !info.no_gui)
              .map(({ info }) => (
                <li key={info.urn}>
                  <AppOpeningPreference urn={info.urn} name={info.name} />
                </li>
              ))}
          </ul>
        </details>
      </div>
    </section>
  );
}
