import { getAppOptions } from '@/api-client/@tanstack/react-query.gen';
import { Button } from '@/components/ui/Button';
import { AppSettingsEditor } from '@/modules/app/components/dialogs/update-settings-dialog/app-settings-editor';
import { useQuery } from '@tanstack/react-query';
import { AppOpeningPreference } from './app-opening-settings';
import type { AppLaunchRequest } from './app-window-state';

export default function AppWindowSettings({ request, onSaved }: { request: AppLaunchRequest; onSaved: () => void }) {
  // Only remote URNs carry a server prefix; local cluster entries also have a manage URL.
  const remote = request.urn.includes('/');
  const app = useQuery({ ...getAppOptions({ path: { urn: request.urn } }), enabled: !remote });
  return (
    <div className="app-window-settings-content">
      <AppOpeningPreference urn={request.urn} name={request.name} label="Open this app" />
      {remote ? (
        <p>
          Manage this app on {request.serverName || 'its server'}.{' '}
          {request.manageUrl ? (
            <a href={request.manageUrl} target="_blank" rel="noopener noreferrer">
              Open app settings
            </a>
          ) : (
            'Open this server in Apps to manage its settings.'
          )}
        </p>
      ) : app.isPending ? (
        <output>Loading app settings…</output>
      ) : app.isError ? (
        <div role="alert">
          <p>App settings could not be loaded.</p>
          <Button onClick={() => void app.refetch()}>Retry</Button>
        </div>
      ) : app.data.app ? (
        <AppSettingsEditor info={app.data.info} config={app.data.app.config ?? {}} onSaved={onSaved} />
      ) : (
        <p>This app is no longer installed.</p>
      )}
    </div>
  );
}
