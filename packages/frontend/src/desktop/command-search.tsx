import { createSearchMatcher } from '@runtipi/common/types';
import { useAppContext } from '@/context/app-context';
import { searchSettings, settingsPath, settingsSections, resolveSettingsSection } from '@/modules/settings/helpers/settings-catalogue';
import { prefersReducedMotion } from '@/desktop/motion-setting';
import { getInstalledAppsOptions, searchAppsOptions } from '@/api-client/@tanstack/react-query.gen';
import { AppLogo } from '@/components/app-logo/app-logo';
import { WrapWords } from '@/components/wrap-words/wrap-words';
import * as Dialog from '@radix-ui/react-dialog';
import { IconArrowUpRight, IconSearch, IconSettings, IconX } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type CSSProperties,
} from 'react';
import { useNavigate } from 'react-router';
import { desktopSearchSections } from './navigation';
import { commandSearchEvent } from './command-search-event';
import './command-search.css';

type SearchResult = { id: string; path: string; label: string; detail: string; icon: ReactNode };
const searchScopes = [
  ['all', 'All'],
  ['apps', 'Apps'],
  ['settings', 'Settings'],
  ['monitor', 'Monitor'],
  ['store', 'Store'],
] as const;
type SearchScope = (typeof searchScopes)[number][0];
const destinationDetails: Record<string, string> = {
  Workspace: 'Launch apps and see current server status',
  Apps: 'Manage installed apps, settings and external links',
  'App Store': 'Find and install server apps',
  Monitor: 'CPU, memory, containers and host processes',
  Updates: 'Orbis, apps and operating system updates',
  Settings: 'Appearance, account and server preferences',
  'Task centre': 'Active operations and task history',
  'Device history': 'Storage activity and network history',
  'Drive health': 'SMART warnings, drive wear and disk self-tests',
  Customise: 'Colours, wallpaper, text size and workspace',
  Security: 'Password, passkeys and two-factor authentication',
  General: 'Server, time zone and network preferences',
  'App stores': 'Manage app repositories and sources',
  'System logs': 'Read Orbis and server diagnostics',
};
const appPath = (urn: string, catalogue = false) => {
  const [appId = '', storeId = ''] = urn.split(':');
  return `/${catalogue ? 'app-store' : 'apps'}/${encodeURIComponent(storeId)}/${encodeURIComponent(appId)}`;
};
const reducedMotion = () => prefersReducedMotion();

export function CommandSearch() {
  const { user, userSettings } = useAppContext();
  const settingsAccess = {
    operator: user.operator === true,
    advanced: userSettings.advancedSettings === true,
    http: typeof window !== 'undefined' && window.location.protocol === 'http:',
  };
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [scope, setScope] = useState<SearchScope>('all');
  const [bar, setBar] = useState({ left: 24, top: 24, width: 600, height: 64, available: 600 });
  const [panelElement, setPanelElement] = useState<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const header = useRef<HTMLDivElement>(null);
  const dropdown = useRef<HTMLDivElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const motions = useRef<Animation[]>([]);
  const pendingPath = useRef<string | null>(null);
  const closingRef = useRef(false);
  const bindPanel = useCallback((element: HTMLDivElement | null) => {
    panel.current = element;
    setPanelElement(element);
  }, []);
  const navigate = useNavigate();
  const query = search.trim();
  const installed = useQuery({ ...getInstalledAppsOptions(), enabled: open && !closing, staleTime: 15000 });
  const catalogue = useQuery({
    ...searchAppsOptions({ query: { search: debounced, pageSize: 24 } }),
    enabled: open && !closing && debounced.length > 0 && (scope === 'all' || scope === 'store'),
    staleTime: 30000,
  });
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query), 220);
    return () => window.clearTimeout(timer);
  }, [query]);

  const readBar = useCallback(() => {
    const bounds = trigger.current?.closest('.desktop-system-bar')?.getBoundingClientRect();
    if (!bounds) return null;
    const viewport = window.visualViewport;
    return {
      left: bounds.left,
      top: bounds.top,
      width: bounds.width,
      height: bounds.height,
      available: Math.max(120, (viewport ? viewport.offsetTop + viewport.height : window.innerHeight) - bounds.bottom - 30),
    };
  }, []);
  const cancelMotions = useCallback(() => {
    for (const motion of motions.current) motion.cancel();
    motions.current = [];
  }, []);
  const openSearch = useCallback(() => {
    if (!closingRef.current && !panel.current) returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const next = readBar();
    if (next) setBar(next);
    setOpen(true);
  }, [readBar]);
  const finishClose = useCallback(() => {
    if (!closingRef.current) return;
    closingRef.current = false;
    setOpen(false);
    setClosing(false);
    setSearch('');
    setDebounced('');
    setScope('all');
    const path = pendingPath.current;
    pendingPath.current = null;
    if (path) void navigate(path);
  }, [navigate]);

  const close = useCallback(
    (path?: string) => {
      if (closingRef.current) return;
      closingRef.current = true;
      pendingPath.current = path ?? null;
      setClosing(true);
      const element = header.current;
      const opener = trigger.current;
      const origin = opener?.getBoundingClientRect();
      const bounds = panel.current?.getBoundingClientRect();
      if (!element || !opener || !origin || !bounds || reducedMotion()) {
        finishClose();
        return;
      }
      const current = getComputedStyle(element);
      const pose = {
        left: current.left,
        top: current.top,
        width: current.width,
        height: current.height,
        borderRadius: current.borderRadius,
        backgroundColor: current.backgroundColor,
        borderColor: current.borderColor,
        paddingInline: current.paddingInline,
        columnGap: current.columnGap,
      };
      const originStyle = getComputedStyle(opener);
      const resultPose = dropdown.current ? getComputedStyle(dropdown.current) : null;
      const resultFrom = resultPose ? { opacity: resultPose.opacity, transform: resultPose.transform } : null;
      const backdropFrom = backdrop.current ? getComputedStyle(backdrop.current).opacity : '1';
      cancelMotions();
      const options = { duration: 360, easing: 'cubic-bezier(.32, 0, .18, 1)', fill: 'forwards' as const };
      const exit = element.animate(
        [
          pose,
          {
            left: `${origin.left - bounds.left}px`,
            top: `${origin.top - bounds.top}px`,
            width: `${origin.width}px`,
            height: `${origin.height}px`,
            borderRadius: originStyle.borderRadius,
            backgroundColor: originStyle.backgroundColor,
            borderColor: originStyle.borderColor,
            paddingInline: originStyle.paddingInline,
            columnGap: originStyle.columnGap,
          },
        ],
        options,
      );
      exit.id = 'orbis-search-bar-close';
      motions.current = [exit];
      if (dropdown.current && resultFrom) {
        motions.current.push(dropdown.current.animate([resultFrom, { opacity: 0, transform: 'translateY(-8px)' }], { ...options, duration: 180 }));
      }
      if (backdrop.current) motions.current.push(backdrop.current.animate([{ opacity: backdropFrom }, { opacity: 0 }], options));
      const started = document.timeline.currentTime;
      if (started !== null) for (const motion of motions.current) motion.startTime = started;
      void exit.finished.then(finishClose, () => undefined);
    },
    [cancelMotions, finishClose],
  );

  useLayoutEffect(() => {
    if (!open || !panelElement) return;
    const element = header.current;
    const opener = trigger.current;
    const origin = opener?.getBoundingClientRect();
    const bounds = readBar();
    if (!element || !opener || !origin || !bounds) return;
    setBar(bounds);
    if (!reducedMotion()) {
      const originStyle = getComputedStyle(opener);
      const targetStyle = getComputedStyle(element);
      const targetPadding = targetStyle.paddingInline;
      const targetGap = targetStyle.columnGap;
      const enter = element.animate(
        [
          {
            left: `${origin.left - bounds.left}px`,
            top: `${origin.top - bounds.top}px`,
            width: `${origin.width}px`,
            height: `${origin.height}px`,
            borderRadius: originStyle.borderRadius,
            backgroundColor: originStyle.backgroundColor,
            borderColor: originStyle.borderColor,
            paddingInline: originStyle.paddingInline,
            columnGap: originStyle.columnGap,
          },
          {
            left: '0px',
            top: '0px',
            width: `${bounds.width}px`,
            height: `${bounds.height}px`,
            borderRadius: '18px',
            backgroundColor: 'transparent',
            borderColor: 'transparent',
            paddingInline: targetPadding,
            columnGap: targetGap,
          },
        ],
        { duration: 460, easing: 'cubic-bezier(.32, 0, .18, 1)' },
      );
      enter.id = 'orbis-search-bar-open';
      motions.current = [enter];
      if (dropdown.current) {
        const results = dropdown.current.animate(
          [
            { opacity: 0, transform: 'translateY(-8px)' },
            { opacity: 1, transform: 'none' },
          ],
          {
            duration: 340,
            delay: 100,
            easing: 'cubic-bezier(.32, 0, .18, 1)',
            fill: 'backwards',
          },
        );
        results.id = 'orbis-search-results-open';
        motions.current.push(results);
      }
      if (backdrop.current) motions.current.push(backdrop.current.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260 }));
      const started = document.timeline.currentTime;
      if (started !== null) for (const motion of motions.current) motion.startTime = started;
    }
    const resize = () => {
      cancelMotions();
      const next = readBar();
      if (next) setBar(next);
      if (closingRef.current) finishClose();
    };
    window.addEventListener('resize', resize);
    window.visualViewport?.addEventListener('resize', resize);
    return () => {
      cancelMotions();
      window.removeEventListener('resize', resize);
      window.visualViewport?.removeEventListener('resize', resize);
    };
  }, [open, panelElement, readBar, cancelMotions, finishClose]);

  useEffect(() => {
    window.addEventListener(commandSearchEvent, openSearch);
    return () => window.removeEventListener(commandSearchEvent, openSearch);
  }, [openSearch]);

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (open) close();
        else openSearch();
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [open, close, openSearch]);

  const needle = query.toLocaleLowerCase();
  const match = createSearchMatcher(query);
  const sections: SearchResult[] = desktopSearchSections
    .filter(
      ({ path }) =>
        !path.startsWith('/settings?tab=') ||
        settingsAccess.operator ||
        !['general', 'updates', 'backups', 'cluster', 'logs'].includes(resolveSettingsSection(new URLSearchParams(path.split('?')[1]).get('tab'))),
    )
    .filter((section) => match(section.label, section.keywords) > 0)
    .sort((a, b) => match(b.label, b.keywords) - match(a.label, a.keywords))
    .filter(
      ({ path }) =>
        scope === 'all' ||
        (scope === 'settings' && path.startsWith('/settings')) ||
        (scope === 'monitor' && (path.startsWith('/monitor') || path === '/tasks')) ||
        (scope === 'apps' && path === '/apps') ||
        (scope === 'store' && path === '/app-store'),
    )
    .filter(({ path }) => query || scope !== 'all' || ['/dashboard', '/apps', '/app-store', '/monitor', '/updates', '/settings'].includes(path))
    .map(({ path, label, Icon }) => ({
      id: path,
      path,
      label,
      detail: destinationDetails[label] ?? '',
      icon: <Icon size={22} aria-hidden="true" />,
    }));
  const installedResults: SearchResult[] = (installed.data?.installed ?? [])
    .filter(({ info }) => info.available && match(info.name, `${info.short_desc} ${info.urn}`) > 0)
    .sort((a, b) => match(b.info.name, b.info.short_desc) - match(a.info.name, a.info.short_desc))
    .slice(0, query || scope === 'apps' ? 24 : 6)
    .map(({ info }) => ({
      id: info.urn,
      path: appPath(info.urn),
      label: info.name,
      detail: info.short_desc,
      icon: <AppLogo urn={info.urn} size={32} alt="" />,
    }));
  const storeResults: SearchResult[] =
    query && debounced === query
      ? (catalogue.data?.data ?? [])
          .filter((info) => info.available)
          .map((info) => ({
            id: info.urn,
            path: appPath(info.urn, true),
            label: info.name,
            detail: info.short_desc,
            icon: <AppLogo urn={info.urn} size={32} alt="" />,
          }))
      : [];
  const settingResults: SearchResult[] =
    query && (scope === 'all' || scope === 'settings')
      ? searchSettings(query, settingsAccess).map((entry) => ({
          id: `setting-${entry.id}`,
          path: settingsPath(entry),
          label: entry.label,
          detail: `Settings · ${settingsSections.find((section) => section.id === entry.section)?.label}`,
          icon: <IconSettings size={22} aria-hidden="true" />,
        }))
      : [];
  const destinationGroup = { name: query ? 'Pages and tools' : scope === 'all' ? 'Quick destinations' : 'Pages and tools', items: sections };
  const settingsGroup = { name: 'Settings', items: settingResults };
  const groups = [
    ...(sections.some((section) => section.label.toLocaleLowerCase() === needle)
      ? [destinationGroup, settingsGroup]
      : [settingsGroup, destinationGroup]),
    { name: 'Installed apps', items: scope === 'all' || scope === 'apps' ? installedResults : [] },
    { name: 'App Store', items: scope === 'all' || scope === 'store' ? storeResults : [] },
  ];
  const firstResult = groups.flatMap((group) => group.items)[0];
  const searchingStore = scope === 'all' || scope === 'store';
  const loadingStore = searchingStore && query.length > 0 && (debounced !== query || catalogue.isPending);

  const handleResultKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...(panel.current?.querySelectorAll<HTMLButtonElement>('[data-search-result]') ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : index + (event.key === 'ArrowDown' ? 1 : -1);
    if (next < 0) input.current?.focus();
    else buttons[Math.min(next, buttons.length - 1)]?.focus();
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (next) openSearch();
        else close();
      }}
    >
      <Dialog.Trigger asChild>
        <button ref={trigger} type="button" className="desktop-search-trigger" aria-label="Search Orbis" data-search-open={open}>
          <IconSearch size={20} aria-hidden="true" />
          <span>Search</span>
          <kbd>⌘/Ctrl K</kbd>
        </button>
      </Dialog.Trigger>
      {open ? (
        <Dialog.Portal>
          <Dialog.Overlay ref={backdrop} className="desktop-search-backdrop" style={{ top: bar.top + bar.height }} data-closing={closing} />
          <Dialog.Content
            ref={bindPanel}
            className="desktop-search-surface"
            style={
              {
                left: bar.left,
                top: bar.top,
                width: bar.width,
                '--desktop-search-bar-height': `${bar.height}px`,
                '--desktop-search-available': `${bar.available}px`,
              } as CSSProperties
            }
            data-closing={closing}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              input.current?.focus({ preventScroll: true });
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              const target = returnFocus.current;
              (target?.isConnected && target !== document.body && !target.closest('[inert], [hidden]') ? target : trigger.current)?.focus({
                preventScroll: true,
              });
            }}
            onEscapeKeyDown={(event) => {
              event.preventDefault();
              close();
            }}
            onInteractOutside={(event) => {
              event.preventDefault();
              if (event.target instanceof Element && event.target.closest('.orbis-notifications')) return;
              close();
            }}
          >
            <Dialog.Title className="visually-hidden">Search Orbis</Dialog.Title>
            <div className="desktop-search-content">
              <div ref={header} className="desktop-search-input">
                <IconSearch size={20} aria-hidden="true" />
                <input
                  ref={input}
                  id="orbis-command-query"
                  data-focus-surface="parent"
                  value={closing ? '' : search}
                  type="search"
                  autoComplete="off"
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search apps, settings and server tools"
                  aria-label="Search Orbis"
                  aria-controls="desktop-search-results"
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && firstResult) {
                      event.preventDefault();
                      close(firstResult.path);
                    }
                    if (event.key === 'ArrowDown') {
                      event.preventDefault();
                      panel.current?.querySelector<HTMLButtonElement>('[data-search-result]')?.focus();
                    }
                  }}
                />
                <button type="button" className="desktop-search-close" aria-label="Close search" onClick={() => close()}>
                  <IconX size={22} aria-hidden="true" />
                </button>
              </div>
              <div ref={dropdown} className="desktop-search-dropdown" data-compact={bar.available < 340}>
                <div className="desktop-search-discovery">
                  <Dialog.Description>Find apps, change settings, review updates and check your server.</Dialog.Description>
                  <SelectionGroup as="fieldset" aria-label="Search in">
                    <legend className="visually-hidden">Search in</legend>
                    {searchScopes.map(([value, label]) => (
                      <button
                        type="button"
                        key={value}
                        aria-pressed={scope === value}
                        onClick={() => {
                          setScope(value);
                          input.current?.focus({ preventScroll: true });
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </SelectionGroup>
                </div>
                <div id="desktop-search-results" className="desktop-search-results" aria-busy={loadingStore || installed.isPending}>
                  {groups
                    .filter((group) => group.items.length)
                    .map(({ name, items }) => (
                      <section className="desktop-search-group" key={name} aria-label={name}>
                        <h3>
                          {name}
                          <span>{items.length}</span>
                          {name === 'Installed apps' && !query && (installed.data?.installed.length ?? 0) > items.length ? (
                            <button type="button" className="desktop-search-browse" onClick={() => close('/apps')}>
                              Browse all apps
                            </button>
                          ) : null}
                        </h3>
                        <div className="desktop-search-grid">
                          {items.map((result) => (
                            <button
                              data-search-result
                              type="button"
                              key={result.id}
                              aria-label={`${result.label}${result.detail ? `, ${result.detail}` : ''}`}
                              onKeyDown={handleResultKeyDown}
                              onClick={() => close(result.path)}
                            >
                              <span className="desktop-search-result-icon">{result.icon}</span>
                              <span className="desktop-search-result-text">
                                <strong title={result.label}>
                                  <WrapWords text={result.label} />
                                </strong>
                                {result.detail ? <small>{result.detail}</small> : null}
                              </span>
                              <IconArrowUpRight size={18} aria-hidden="true" />
                            </button>
                          ))}
                        </div>
                      </section>
                    ))}
                  <div className="desktop-search-feedback" aria-live="polite">
                    {installed.isError ? (
                      <p>
                        Installed apps could not be loaded.{' '}
                        <button type="button" onClick={() => void installed.refetch()}>
                          Try again
                        </button>
                      </p>
                    ) : null}
                    {loadingStore ? <p>Searching the App Store…</p> : null}
                    {searchingStore && query && debounced === query && catalogue.isError ? (
                      <p>
                        The App Store could not be searched.{' '}
                        <button type="button" onClick={() => void catalogue.refetch()}>
                          Try again
                        </button>
                      </p>
                    ) : null}
                    {!firstResult && !loadingStore && !installed.isPending && !installed.isError && (!query || !catalogue.isError) ? (
                      <p>No matches for “{query}”. Try an app name or a section such as Updates.</p>
                    ) : null}
                  </div>
                </div>
                <footer className="desktop-search-footer">
                  <span>↑ ↓ to move · Enter to open</span>
                  <span>Esc to close</span>
                </footer>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      ) : null}
    </Dialog.Root>
  );
}
import { SelectionGroup } from '@/components/ui/SelectionGroup/SelectionGroup';
