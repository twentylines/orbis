import { useQuery } from '@tanstack/react-query';
import { getInstalledAppsOptions } from '@/api-client/@tanstack/react-query.gen';
import type { AppOpeningMode } from '@runtipi/common/schemas';
import { useDesktopPreferences } from './preferences';

export function AppOpeningPreference({ urn, name, label = name }: { urn: string; name: string; label?: string }) {
  const { preferences, update } = useDesktopPreferences();
  const value = preferences.appLaunch.apps[urn]?.mode ?? 'default';
  return (
    <label className="app-opening-select">
      <span>{label}</span>
      <select
        className="form-select"
        aria-label={`Open ${name}`}
        value={value}
        onChange={(event) => {
          const apps = { ...preferences.appLaunch.apps };
          apps[urn] = { ...apps[urn] };
          if (event.target.value === 'default') delete apps[urn].mode;
          else apps[urn].mode = event.target.value as AppOpeningMode;
          update({ appLaunch: { ...preferences.appLaunch, apps } });
        }}
      >
        <option value="default">Use account default</option>
        <option value="window">In Orbis</option>
        <option value="tab">In a new tab</option>
      </select>
    </label>
  );
}

export function AppOpeningSettings() {
  const { preferences, update } = useDesktopPreferences();
  const apps = useQuery(getInstalledAppsOptions());
  return (
    <section className="appearance-section" aria-labelledby="app-opening-heading">
      <div>
        <h2 id="app-opening-heading">Opening apps</h2>
        <p>
          Keep apps in resizable Orbis windows, or open a browser tab. Smaller screens use tabs. Some apps require a tab for their security or sign-in
          settings.
        </p>
      </div>
      <div>
        <label className="app-opening-select">
          <span>Account default</span>
          <select
            className="form-select"
            aria-label="Default app opening"
            value={preferences.appLaunch.mode}
            onChange={(event) => update({ appLaunch: { ...preferences.appLaunch, mode: event.target.value as AppOpeningMode } })}
          >
            <option value="window">In Orbis</option>
            <option value="tab">In a new tab</option>
          </select>
        </label>
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
