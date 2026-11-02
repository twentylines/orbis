import { useHistoricalAppIcons } from './historical-app-icons';
import { useState, type CSSProperties } from 'react';
import type { TimeMachinePoint, TimeMachinePreview } from '@runtipi/common/schemas/time-machine';
import { normaliseDesktopAppearance } from '@runtipi/common/schemas/desktop-appearance';
import { homeApps, workspaceRows } from '@/desktop/workspace-apps';
import { themePackAppearance } from '@/modules/theme-packs/theme-pack-runtime';
import { IconApps, IconClock, IconDeviceDesktopAnalytics, IconAlertCircle } from '@tabler/icons-react';
import './historical-home-preview.css';

type SavedPreview = Extract<TimeMachinePreview, { available: true }>;
type Widget = SavedPreview['desktop']['workspace']['order'][number];
const sectionNames = { applications: 'Applications', activity: 'System status', storage: 'Recent operations', attention: 'Needs attention' } as const;
const sectionIcons = { applications: IconApps, activity: IconDeviceDesktopAnalytics, storage: IconClock, attention: IconAlertCircle };

export function historicalHomeLayout(preview: SavedPreview) {
  const { workspace } = preview.desktop;
  const visible = workspace.order.filter((widget) => !workspace.hidden.includes(widget));
  return {
    apps: homeApps(
      preview.apps.map((app) => ({ info: { urn: app.urn }, app })),
      workspace.pinnedApps,
      workspace.showAllApps,
    ).map(({ app }) => app),
    visible,
    rows: workspaceRows(visible, workspace.wide),
    defaultColumns:
      workspace.order.join(',') === 'applications,activity,storage,attention' && workspace.wide.length === 1 && workspace.wide[0] === 'applications',
  };
}

export function historicalHomeStyle(preview: SavedPreview): CSSProperties {
  const { desktop, theme } = preview;
  const appearance = themePackAppearance(theme, normaliseDesktopAppearance(desktop.appearance));
  const palette = desktop.mode === 'system' ? null : theme?.[desktop.mode];
  const solid = appearance.transparency === 'solid' || appearance.lowEffects || (desktop.mode === 'dark' && appearance.oledDark);
  const style: Record<string, string | number> = {
    '--tm-saved-scale': (appearance.textScale ?? 100) / 100,
    '--tm-saved-opacity': solid ? 1 : (appearance.surfaceOpacity ?? 97) / 100,
    '--tm-saved-tint-amount': `${appearance.glassTint ?? 0}%`,
    '--tm-saved-blur': solid ? 'none' : `blur(${appearance.glassBlur ?? 28}px) saturate(1.2)`,
    '--tm-saved-wallpaper-fit': appearance.wallpaperFit ?? 'cover',
    '--tm-saved-wallpaper-position': `${appearance.wallpaperX ?? 50}% ${appearance.wallpaperY ?? 0}%`,
    '--tm-saved-wallpaper-blur': `${appearance.wallpaperBlur ?? 0}px`,
    '--tm-saved-wallpaper-dim': (appearance.wallpaperDim ?? 0) / 100,
  };
  if (palette) {
    for (const name of ['ink', 'muted', 'surface', 'tint', 'accent', 'chrome'] as const) style[`--tm-saved-${name}`] = palette[name];
    style['--tm-saved-font'] = theme?.treatment.typography === 'system' ? 'system-ui, sans-serif' : '"Source Sans 3", system-ui, sans-serif';
    style['--tm-saved-radius'] = theme?.treatment.corners === 'crisp' ? '8px' : '16px';
  }
  if (appearance.accent) style['--tm-saved-custom-accent'] = appearance.accent;
  if (desktop.mode === 'dark' && appearance.oledDark) style['--tm-saved-surface'] = '#000000';
  return style as CSSProperties;
}

function CapturedAppIcon({ url, name }: { url?: string; name: string }) {
  const [failed, setFailed] = useState<string | undefined>();
  return url && failed !== url ? (
    <img className="tm-saved-app-icon" src={url} alt="" loading="lazy" decoding="async" onError={() => setFailed(url)} />
  ) : (
    <span className="tm-saved-app-initial" aria-hidden="true">
      {Array.from(name)[0]}
    </span>
  );
}

export type HistoricalHomeProps = {
  point: TimeMachinePoint;
  wallpaper?: string | null;
  assetFailed?: boolean;
  assetLoading?: boolean;
};
export function HistoricalHomePreview({ point, wallpaper, assetFailed = false, assetLoading = false }: HistoricalHomeProps) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const icons = useHistoricalAppIcons(point);
  const preview = point.metadata?.preview;
  if (!preview?.available)
    return (
      <div className="tm-preview-missing">
        <h3>No captured Home preview</h3>
        <p>{preview?.reason.message ?? 'This point has no sealed historical Home projection.'}</p>
      </div>
    );
  const { desktop } = preview;
  const layout = historicalHomeLayout(preview);
  const displayWallpaper = preview.wallpaperAsset.available && !assetFailed && wallpaper && failedUrl !== wallpaper ? wallpaper : null;
  const widgets = (widget: Widget) => {
    const Icon = sectionIcons[widget];
    return (
      <section className="tm-saved-widget" key={widget} data-saved-section={widget} data-wide={desktop.workspace.wide.includes(widget)}>
        <h4>
          {widget === 'applications' ? null : <Icon size={20} aria-hidden="true" />}
          {sectionNames[widget]}
        </h4>
        {widget === 'applications' ? (
          layout.apps.length ? (
            <ul
              className="tm-saved-apps"
              aria-label={preview.appIcons ? 'Captured applications' : 'Captured applications; app icons were not captured'}
            >
              {layout.apps.map((app) => (
                <li className="tm-saved-app" key={app.urn}>
                  <CapturedAppIcon url={icons[app.urn]} name={app.name} />
                  <span className="tm-saved-app-copy">
                    <strong>{app.name}</strong>
                    <small>{app.running ? 'Running at capture' : 'Stopped at capture'}</small>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p>No apps shown in this saved workspace.</p>
          )
        ) : (
          <div className="tm-saved-unrecorded">
            <strong>
              {widget === 'activity'
                ? 'Readings were not captured'
                : widget === 'storage'
                  ? 'Operation history was not captured'
                  : 'Attention details were not captured'}
            </strong>
          </div>
        )}
      </section>
    );
  };
  const main = (['applications', 'storage', 'attention'] as const).filter((id) => layout.visible.includes(id));
  const activity = layout.visible.includes('activity');
  return (
    <div
      className="tm-historical-home"
      style={historicalHomeStyle(preview)}
      data-captured-mode={desktop.mode}
      data-captured-preset={desktop.preset}
      data-captured-density={desktop.density}
    >
      <div className="tm-saved-stage">
        {displayWallpaper ? (
          <img className="tm-saved-wallpaper" src={displayWallpaper} alt="" onError={() => setFailedUrl(displayWallpaper)} />
        ) : null}
        <div className="tm-saved-tone" />
        <div className="tm-saved-dim" />
        <div className="tm-saved-workspace">
          <header className="tm-saved-heading">
            <h3>{desktop.serverName}</h3>
            <p>
              {preview.apps.length} {preview.apps.length === 1 ? 'app' : 'apps'} captured, {preview.apps.filter((app) => app.running).length} running
            </p>
          </header>
          <div
            className="tm-saved-grid"
            data-default-columns={layout.defaultColumns}
            data-two-columns={layout.defaultColumns && main.length > 0 && activity}
          >
            {layout.defaultColumns ? (
              <>
                {main.length ? (
                  <div className="tm-saved-main">
                    {layout.visible.includes('applications') ? widgets('applications') : null}
                    {main.some((id) => id !== 'applications') ? (
                      <div className="tm-saved-auxiliary">{main.filter((id) => id !== 'applications').map(widgets)}</div>
                    ) : null}
                  </div>
                ) : null}
                {activity ? widgets('activity') : null}
              </>
            ) : (
              layout.rows.map((row) => (
                <div className="tm-saved-row" key={row.join(',')}>
                  {row.map(widgets)}
                </div>
              ))
            )}
            {layout.visible.length === 0 ? <p className="tm-saved-empty">This saved workspace has no visible Home sections.</p> : null}
          </div>
          <p className="tm-saved-caption">
            <span>Historical layout projection, not a screenshot.</span>{' '}
            {desktop.mode === 'system' ? <span>Saved System mode uses neutral colours. </span> : null}
            {preview.wallpaperAsset.available ? (
              assetFailed || (failedUrl === wallpaper && wallpaper) ? (
                <span>Captured wallpaper could not be displayed.</span>
              ) : displayWallpaper ? null : (
                <span>{assetLoading ? 'Loading captured wallpaper…' : 'Select this point to load its captured wallpaper.'}</span>
              )
            ) : (
              <span>{preview.wallpaperAsset.reason.message}</span>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}
