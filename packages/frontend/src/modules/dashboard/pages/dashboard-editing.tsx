import { useRef } from 'react';
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
type EditingProps = {
  workspace: WorkspacePreferences;
  capabilities?: WorkspaceCapabilities;
  save: (next: WorkspacePreferences) => void;
};

export function DashboardEditing({ workspace, capabilities, save, syncState }: EditingProps & { syncState: string }) {
  return (
    <section className="workspace-editor workspace-editor-compact" id="workspace-editor" aria-label="Workspace controls">
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
        <p>Drag a widget or toolbar control to move it. Keyboard: Space, arrows, Enter. Escape cancels.</p>
      </div>
      {!capabilities?.workspaceLayout || !capabilities?.toolbarOrder ? (
        <p className="workspace-editor-sync">This server supports widget order and pins. Icon view and toolbar order need a newer server.</p>
      ) : null}
      <p className="workspace-editor-sync" role={syncState === 'error' ? 'alert' : 'status'}>
        {syncState === 'saving'
          ? 'Saving layout…'
          : syncState === 'saved'
            ? 'Saved to your account.'
            : syncState === 'error'
              ? 'Could not save this layout. Select Save to retry.'
              : syncState === 'local'
                ? 'Saved on this device.'
                : 'Waiting for account sync.'}
      </p>
    </section>
  );
}

export function ApplicationEditing({
  workspace,
  capabilities,
  apps,
  appsReady,
  appsFailed,
  search,
  setSearch,
  chooserOpen,
  setChooserOpen,
  canResize,
  save,
}: EditingProps & {
  apps: { info: { urn: string; name: string } }[];
  appsReady: boolean;
  appsFailed: boolean;
  search: string;
  setSearch: (search: string) => void;
  chooserOpen: boolean;
  setChooserOpen: (open: boolean) => void;
  canResize: boolean;
}) {
  const searchInput = useRef<HTMLInputElement>(null);
  const chooser = useRef<HTMLDetailsElement>(null);
  const layout = workspace.layout ?? defaultWorkspaceLayout;
  const query = search.trim().toLocaleLowerCase();
  const choices = apps.filter(({ info }) => !workspace.pinnedApps.includes(info.urn) && info.name.toLocaleLowerCase().includes(query));
  const installed = new Set(apps.map(({ info }) => info.urn));
  const missingPins = appsReady ? workspace.pinnedApps.filter((urn) => !installed.has(urn)) : [];
  return (
    <div className="workspace-app-editing workspace-editor-options">
      <details ref={chooser} className="workspace-app-chooser" open={chooserOpen} onToggle={(event) => setChooserOpen(event.currentTarget.open)}>
        <summary>Add apps</summary>
        <div className="workspace-app-chooser-content" aria-busy={!appsReady && !appsFailed}>
          <label htmlFor="workspace-add-app-search">Find an installed app</label>
          <input
            id="workspace-add-app-search"
            ref={searchInput}
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
                onClick={() => {
                  save({ ...workspace, pinnedApps: [...workspace.pinnedApps, info.urn] });
                  searchInput.current?.focus({ preventScroll: true });
                }}
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
                {query
                  ? 'No unpinned apps match this search.'
                  : apps.length
                    ? 'All installed apps are pinned.'
                    : 'Install an app from the App Store before pinning it.'}
              </p>
            ) : null
          ) : (
            <p>Loading installed apps…</p>
          )}
          {workspace.pinnedApps.length >= maximumHomePins ? <p>The saved layout supports up to 512 pins. Unpin an app to add another.</p> : null}
        </div>
      </details>
      {missingPins.length ? (
        <button
          type="button"
          onClick={() => {
            save({ ...workspace, pinnedApps: workspace.pinnedApps.filter((urn) => installed.has(urn)) });
            chooser.current?.querySelector('summary')?.focus({ preventScroll: true });
          }}
        >
          Remove {missingPins.length} unavailable pin{missingPins.length === 1 ? '' : 's'}
        </button>
      ) : null}
      {canResize && layout.widgets.applications ? (
        <button
          type="button"
          onClick={(event) => {
            const widget = event.currentTarget.closest('.workspace-widget');
            const { applications: _applications, ...widgets } = layout.widgets;
            save({ ...workspace, layout: { ...layout, widgets } });
            requestAnimationFrame(() =>
              (
                widget?.querySelector<HTMLElement>('.workspace-app-resize') ?? widget?.querySelector<HTMLElement>('.workspace-app-chooser summary')
              )?.focus({ preventScroll: true }),
            );
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
  );
}
