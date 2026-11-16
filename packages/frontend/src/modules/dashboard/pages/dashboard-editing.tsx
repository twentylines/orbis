import { useState } from 'react';
import { IconPin, IconLayoutGrid, IconList } from '@tabler/icons-react';
import { AppLogo } from '@/components/app-logo/app-logo';
import { Switch } from '@/components/ui/Switch';
import type { WorkspacePreferences, WidgetId } from '@/desktop/preferences';
import { defaultWorkspaceLayout, type WorkspaceCapabilities } from '@/desktop/workspace-layout';
import { maximumHomePins } from '@/desktop/workspace-apps';

const labels: Record<WidgetId, string> = {
  applications: 'Applications',
  activity: 'System status',
  storage: 'Recent operations',
  attention: 'Needs attention',
};
export default function DashboardEditing({
  workspace,
  capabilities,
  apps,
  appsReady,
  appsFailed,
  save,
  syncState,
}: {
  workspace: WorkspacePreferences;
  capabilities?: WorkspaceCapabilities;
  apps: { info: { urn: string; name: string } }[];
  appsReady: boolean;
  appsFailed: boolean;
  save: (next: WorkspacePreferences) => void;
  syncState: string;
}) {
  const [search, setSearch] = useState('');
  const layout = workspace.layout ?? defaultWorkspaceLayout;
  const choices = apps.filter(
    ({ info }) => !workspace.pinnedApps.includes(info.urn) && info.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );
  const installed = new Set(apps.map(({ info }) => info.urn));
  const missingPins = appsReady ? workspace.pinnedApps.filter((urn) => !installed.has(urn)) : [];
  return (
    <section className="workspace-editor workspace-editor-compact" id="workspace-editor" aria-label="Workspace controls">
      <div className="workspace-editor-controls">
        <p>Drag a widget or toolbar control to move it. Keyboard: Space, arrows, Enter. Escape cancels.</p>
      </div>
      <div className="workspace-editor-options">
        <details className="workspace-widget-chooser">
          <summary>Visible widgets</summary>
          <div>
            {workspace.order.map((id) => (
              <Switch
                key={id}
                label={labels[id]}
                checked={!workspace.hidden.includes(id)}
                onCheckedChange={(checked) =>
                  save({ ...workspace, hidden: checked ? workspace.hidden.filter((item) => item !== id) : [...workspace.hidden, id] })
                }
              />
            ))}
          </div>
        </details>
        <details className="workspace-app-chooser">
          <summary>Add apps</summary>
          <div className="workspace-app-chooser-content" aria-busy={!appsReady && !appsFailed}>
            <label htmlFor="workspace-add-app-search">Find an installed app</label>
            <input
              id="workspace-add-app-search"
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search apps"
            />
            <div className="workspace-pin-list">
              {choices.map(({ info }) => (
                <button
                  key={info.urn}
                  type="button"
                  disabled={workspace.pinnedApps.length >= maximumHomePins}
                  onClick={() => save({ ...workspace, pinnedApps: [...workspace.pinnedApps, info.urn] })}
                >
                  <AppLogo urn={info.urn} size={28} alt="" />
                  <span>{info.name}</span>
                  <IconPin size={16} aria-hidden="true" />
                </button>
              ))}
            </div>
            {appsFailed ? (
              <p role="alert">Installed apps could not be loaded. Reopen Home to retry.</p>
            ) : appsReady ? (
              choices.length === 0 ? (
                <p>
                  {search
                    ? 'No unpinned apps match this search.'
                    : apps.length
                      ? 'All installed apps are pinned.'
                      : 'Install an app from the App Store before pinning it.'}
                </p>
              ) : null
            ) : (
              <p>Loading installed apps…</p>
            )}
            {workspace.pinnedApps.length >= maximumHomePins ? <p>Remove a pin before adding another app.</p> : null}
          </div>
        </details>
        {missingPins.length ? (
          <button type="button" onClick={() => save({ ...workspace, pinnedApps: workspace.pinnedApps.filter((urn) => installed.has(urn)) })}>
            Remove {missingPins.length} unavailable pin{missingPins.length === 1 ? '' : 's'}
          </button>
        ) : null}
        {layout.widgets.applications ? (
          <button
            type="button"
            onClick={() => {
              const { applications: _applications, ...widgets } = layout.widgets;
              save({ ...workspace, layout: { ...layout, widgets } });
              requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.workspace-app-resize')?.focus({ preventScroll: true }));
            }}
          >
            Reset Applications height
          </button>
        ) : null}
        <Switch label="Show all apps" checked={workspace.showAllApps} onCheckedChange={(showAllApps) => save({ ...workspace, showAllApps })} />
        <button
          type="button"
          aria-pressed={layout.appView === 'icons'}
          disabled={!capabilities?.workspaceLayout}
          title={capabilities?.workspaceLayout ? 'Switch application view' : 'Requires a server with workspace layout support'}
          onClick={() => save({ ...workspace, layout: { ...layout, appView: layout.appView === 'icons' ? 'cards' : 'icons' } })}
        >
          {layout.appView === 'icons' ? <IconList size={18} aria-hidden="true" /> : <IconLayoutGrid size={18} aria-hidden="true" />} Icons only
        </button>
      </div>
      {!capabilities?.workspaceLayout || !capabilities?.toolbarOrder ? (
        <p className="workspace-editor-sync">This server supports widget order and pins. Icon view and toolbar order need a newer server.</p>
      ) : null}
      <p className="workspace-editor-sync" role={syncState === 'error' ? 'alert' : undefined}>
        {syncState === 'saving'
          ? 'Saving layout…'
          : syncState === 'saved'
            ? 'Saved to your account.'
            : syncState === 'error'
              ? 'Could not save this layout. Select Save to retry.'
              : 'Waiting for account sync.'}
      </p>
    </section>
  );
}
