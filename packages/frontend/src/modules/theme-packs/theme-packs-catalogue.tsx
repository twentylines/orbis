import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ThemePackSnapshot } from '@runtipi/common/schemas/theme-pack';
import { IconChevronDown, IconTrash } from '@tabler/icons-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
import { themePacksChanged, themePacksRequest } from './theme-packs-api';
import { themeCatalogue, themeVersions } from './theme-catalogue';
import { useWindowVisible } from '@/desktop/window-visibility';
import './theme-packs-catalogue.css';
import './theme-packs-store.css';
import { Link } from 'react-router';
import { useThemeApply } from './use-theme-apply';

export function ThemePacksCatalogue({ surface = 'appearance', search = '' }: { surface?: 'appearance' | 'store'; search?: string }) {
  const visible = useWindowVisible();
  const [snapshot, setSnapshot] = useState<ThemePackSnapshot | null>(null);
  const [changing, setBusy] = useState(false);
  const id = useId();
  const application = useThemeApply(`${id}-${surface === 'appearance' ? 'select' : 'refresh'}`);
  const busy = changing || application.busy;
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [review, setReview] = useState<string | null>(null);
  const [versions, setVersions] = useState<Record<string, string>>({});
  const [removing, setRemoving] = useState<string | null>(null);
  const revision = useRef(0);
  const focusAfterChange = useRef<string | null>(null);
  const keyboardAction = useRef(false);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const current = ++revision.current;
    try {
      const next = await themePacksRequest('', 'GET', undefined, signal);
      if (!signal?.aborted && current === revision.current) {
        setSnapshot(next);
        setError('');
      }
    } catch (failure) {
      if (!signal?.aborted && current === revision.current) setError(failure instanceof Error ? failure.message : 'Themes could not be loaded.');
    }
  }, []);
  // Catalogue data is account-scoped; do not reuse another account's cached installation state.
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    const changed = () => {
      void refresh(controller.signal);
    };
    window.addEventListener(themePacksChanged, changed);
    changed();
    return () => {
      controller.abort();
      window.removeEventListener(themePacksChanged, changed);
    };
  }, [refresh, visible]);

  useEffect(() => {
    if (busy || !focusAfterChange.current) return;
    document.getElementById(focusAfterChange.current)?.focus();
    focusAfterChange.current = null;
  }, [busy]);

  const perform = async (action: () => Promise<ThemePackSnapshot>, success: string) => {
    if (busy) return;
    focusAfterChange.current = keyboardAction.current
      ? (document.activeElement?.closest('[data-theme-card]')?.querySelector('[data-theme-review]')?.id ??
        `${id}-${surface === 'appearance' ? 'select' : 'refresh'}`)
      : null;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const next = await action();
      ++revision.current;
      setSnapshot(next);
      setMessage(success);
      setRemoving(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Theme change failed. Refresh and retry.');
    } finally {
      setBusy(false);
    }
  };
  const packs = themeCatalogue(snapshot?.catalogue ?? [], search);
  const selected = snapshot?.state.selected;
  if (surface === 'appearance') {
    const installed = snapshot?.state.installed ?? [];
    return (
      <>
        {application.confirmation}
        <section
          className="appearance-section"
          aria-labelledby={`${id}-heading`}
          onPointerDownCapture={() => {
            keyboardAction.current = false;
          }}
          onKeyDownCapture={() => {
            keyboardAction.current = true;
          }}
        >
          <div>
            <h2 id={`${id}-heading`}>Theme</h2>
          </div>
          <div className="theme-packs-settings" aria-busy={busy}>
            <Select
              value={selected?.id ?? 'orbis'}
              disabled={busy || !snapshot}
              onValueChange={(value) => {
                const choice = installed.find(({ manifest }) => manifest.id === value)?.manifest;
                if (value !== 'orbis' && !choice) return;
                application.stage({
                  kind: 'select',
                  source: selected ?? null,
                  target: choice ? { id: choice.id, version: choice.version } : null,
                  name: choice?.name ?? 'Default',
                });
              }}
            >
              <SelectTrigger id={`${id}-select`} aria-label="Theme">
                <SelectValue placeholder="Loading themes…" />
                <IconChevronDown size={16} aria-hidden="true" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="orbis">Default</SelectItem>
                {installed.map(({ manifest }) => (
                  <SelectItem key={manifest.id} value={manifest.id}>
                    {manifest.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Link className="theme-settings-store-link" to="/app-store?view=themes">
              Browse themes
            </Link>
            {error ? (
              <div className="theme-packs-feedback" role="alert">
                <p>{error}</p>
                <button id={`${id}-refresh`} type="button" disabled={busy} onClick={() => void refresh()}>
                  Retry
                </button>
              </div>
            ) : null}
          </div>
        </section>
      </>
    );
  }
  return (
    <>
      {application.confirmation}
      <section
        className={surface === 'store' ? 'theme-packs-section theme-packs-store' : 'appearance-section theme-packs-section'}
        aria-labelledby={`${id}-heading`}
        onPointerDownCapture={() => {
          keyboardAction.current = false;
        }}
        onKeyDownCapture={() => {
          keyboardAction.current = true;
        }}
      >
        {surface === 'store' ? (
          <h2 id={`${id}-heading`} className="visually-hidden">
            Themes
          </h2>
        ) : (
          <div>
            <h2 id={`${id}-heading`}>Theme packs</h2>
            <p>
              Install a photographed desktop with coordinated materials, typography and controls. Your personal appearance settings stay in place.
            </p>
            <p>These bundled packs use local images. Theme imports and remote catalogues are not supported.</p>
          </div>
        )}
        <div className="theme-packs-content" aria-busy={busy}>
          <div className="theme-packs-toolbar">
            <span>
              {snapshot ? (selected ? 'A theme pack is applied to your account.' : 'Using your colour preset.') : 'Loading theme catalogue…'}
            </span>
            <button
              id={`${id}-refresh`}
              type="button"
              disabled={busy}
              onClick={() => {
                void refresh();
              }}
            >
              Refresh
            </button>
            {selected ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => application.stage({ kind: 'select', source: selected ?? null, target: null, name: 'Default' })}
              >
                Use Default
              </button>
            ) : null}
          </div>
          {error ? (
            <div className="theme-packs-feedback" role="alert">
              <p>{error}</p>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  void refresh();
                }}
              >
                Retry
              </button>
            </div>
          ) : null}
          <output className="theme-packs-message" aria-live="polite">
            {busy ? 'Saving theme change…' : surface === 'store' ? message : null}
          </output>
          <div className="theme-packs-grid">
            {packs.map((latest) => {
              const available = themeVersions(snapshot?.catalogue ?? [], latest.id);
              const installed = snapshot?.state.installed.find((item) => item.manifest.id === latest.id);
              const version = installed?.manifest.version ?? versions[latest.id] ?? latest.version;
              const pack = available.find((item) => item.version === version) ?? latest;
              const active = selected?.id === pack.id;
              const asset = pack.assets[0];
              const showingReview = review === pack.id;
              return (
                <article className="theme-pack-card" data-theme-card key={pack.id} data-applied={active || undefined}>
                  {asset ? (
                    <img src={`/wallpapers/${asset.path}`} alt={`${pack.name} landscape photograph`} loading="lazy" width={480} height={270} />
                  ) : null}
                  <div className="theme-pack-body">
                    <div className="theme-pack-heading">
                      <h3>{pack.name}</h3>
                      <span>{active ? 'Applied' : installed ? 'Installed' : 'Available'}</span>
                    </div>
                    <p>{pack.description}</p>
                    <div className="theme-pack-swatches" role="img" aria-label="Light and dark colours">
                      {[pack.light.surface, pack.light.accent, pack.light.chrome, pack.dark.surface, pack.dark.accent].map((colour, index) => (
                        <span key={`${index}-${colour}`} style={{ backgroundColor: colour }} />
                      ))}
                    </div>
                    <p className="theme-pack-version">
                      {installed
                        ? `Installed ${installed.manifest.version} · Latest ${latest.version}`
                        : `Version ${latest.version} · ${Math.ceil((asset?.bytes ?? 0) / 1024)} KB`}
                    </p>
                    <div className="theme-pack-actions">
                      <button
                        type="button"
                        id={`${id}-${pack.id}-review`}
                        data-theme-review
                        aria-expanded={showingReview}
                        aria-controls={`${id}-${pack.id}`}
                        disabled={busy}
                        onClick={() => setReview(showingReview ? null : pack.id)}
                      >
                        {showingReview ? 'Close details' : 'Preview and details'}
                      </button>
                      {installed && !active ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            application.stage({
                              kind: 'select',
                              source: selected ?? null,
                              target: { id: pack.id, version: installed.manifest.version },
                              name: pack.name,
                            })
                          }
                        >
                          Apply
                        </button>
                      ) : null}
                      {installed && installed.manifest.version !== latest.version ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            active
                              ? application.stage({
                                  kind: 'update',
                                  source: selected ?? null,
                                  target: { id: pack.id, version: latest.version },
                                  name: pack.name,
                                  id: pack.id,
                                })
                              : void perform(() => themePacksRequest(`/${pack.id}/update`, 'POST'), `${pack.name} updated to ${latest.version}.`)
                          }
                        >
                          Update
                        </button>
                      ) : null}
                      {installed?.previous ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            active && installed.previous
                              ? application.stage({
                                  kind: 'rollback',
                                  source: selected ?? null,
                                  target: { id: pack.id, version: installed.previous.manifest.version },
                                  name: pack.name,
                                  id: pack.id,
                                })
                              : void perform(() => themePacksRequest(`/${pack.id}/rollback`, 'POST'), `${pack.name} previous version restored.`)
                          }
                        >
                          Roll back to {installed.previous.manifest.version}
                        </button>
                      ) : null}
                      {installed ? (
                        <button type="button" disabled={busy} onClick={() => setRemoving(pack.id)}>
                          <IconTrash className="orbis-remove-icon" size={18} aria-hidden="true" />
                          Remove
                        </button>
                      ) : null}
                    </div>
                    {showingReview ? (
                      <div id={`${id}-${pack.id}`} className="theme-pack-review">
                        <dl>
                          <div>
                            <dt>Photographer</dt>
                            <dd>{pack.author}</dd>
                          </div>
                          <div>
                            <dt>License</dt>
                            <dd>
                              <a href={pack.license.url} target="_blank" rel="noreferrer">
                                {pack.license.name}
                              </a>
                            </dd>
                          </div>
                          <div>
                            <dt>Source</dt>
                            <dd>
                              <a href={pack.source} target="_blank" rel="noreferrer">
                                Original photograph
                              </a>
                            </dd>
                          </div>
                          <div>
                            <dt>Includes</dt>
                            <dd>
                              Light and dark palettes, local wallpaper, {pack.treatment.typography === 'system' ? 'system' : 'Source Sans 3'} type,{' '}
                              {pack.treatment.corners} corners, Background blur: {pack.treatment.material === 'clear' ? 'Clear' : 'Soft'},{' '}
                              {pack.treatment.motion} transitions.
                            </dd>
                          </div>
                        </dl>
                        {installed ? null : (
                          <>
                            <Select
                              value={version}
                              disabled={busy}
                              onValueChange={(value) => setVersions((previous) => ({ ...previous, [pack.id]: value }))}
                            >
                              <SelectTrigger id={`${id}-${pack.id}-version`} label="Version" className="theme-pack-version-select">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {[...available].reverse().map((item) => (
                                  <SelectItem key={item.version} value={item.version}>
                                    {item.version}
                                    {item.version === latest.version ? ' (latest)' : ''}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <p>
                              Install adds this version to your account. Apply it when you are ready; custom wallpaper, colour and material choices
                              remain yours.
                            </p>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                void perform(
                                  () => themePacksRequest('/install', 'POST', { id: pack.id, version: pack.version }),
                                  `${pack.name} installed. Choose Apply to use it.`,
                                )
                              }
                            >
                              Install {pack.name} {pack.version}
                            </button>
                          </>
                        )}
                      </div>
                    ) : null}
                    {removing === pack.id ? (
                      <fieldset className="theme-pack-review">
                        <legend className="visually-hidden">Remove {pack.name}</legend>
                        <p>
                          Remove {pack.name} from your account? {active ? 'Default will return. ' : ''}Personal settings and uploaded wallpaper will
                          be kept.
                        </p>
                        <div className="theme-pack-actions">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              active
                                ? application.stage({ kind: 'remove', source: selected ?? null, target: null, name: 'Default', id: pack.id })
                                : void perform(() => themePacksRequest(`/${pack.id}`, 'DELETE'), `${pack.name} removed. Personal settings kept.`)
                            }
                          >
                            <IconTrash className="orbis-remove-icon" size={18} aria-hidden="true" />
                            Remove
                          </button>
                          <button type="button" disabled={busy} onClick={() => setRemoving(null)}>
                            Cancel
                          </button>
                        </div>
                      </fieldset>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
          {snapshot && !packs.length ? (
            <p className="theme-packs-empty">{search.trim() ? 'No theme packs match your search.' : 'No bundled theme packs are available.'}</p>
          ) : null}
          {surface === 'store' ? (
            <p className="theme-packs-scope">Bundled catalogue. Theme imports and remote catalogues are not supported.</p>
          ) : null}
        </div>
      </section>
    </>
  );
}
