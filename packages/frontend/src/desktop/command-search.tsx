import { getInstalledAppsOptions, searchAppsOptions } from '@/api-client/@tanstack/react-query.gen';
import { AppLogo } from '@/components/app-logo/app-logo';
import * as Dialog from '@radix-ui/react-dialog';
import { IconArrowUpRight, IconSearch, IconX } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { desktopSearchSections } from './navigation';
import './command-search.css';

type SearchResult = { id: string; path: string; label: string; detail: string; icon: ReactNode };
const appPath = (urn: string, catalogue = false) => {
  const [appId = '', storeId = ''] = urn.split(':');
  return `/${catalogue ? 'app-store' : 'apps'}/${encodeURIComponent(storeId)}/${encodeURIComponent(appId)}`;
};
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function CommandSearch() {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [panelElement, setPanelElement] = useState<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const animation = useRef<Animation | null>(null);
  const pendingPath = useRef<string | null>(null);
  const bindPanel = useCallback((element: HTMLDivElement | null) => {
    panel.current = element;
    setPanelElement(element);
  }, []);
  const navigate = useNavigate();
  const query = search.trim();
  const installed = useQuery({ ...getInstalledAppsOptions(), enabled: open && !closing, staleTime: 15000 });
  const catalogue = useQuery({
    ...searchAppsOptions({ query: { search: debounced, pageSize: 24 } }),
    enabled: open && !closing && debounced.length > 0,
    staleTime: 30000,
  });
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query), 220);
    return () => window.clearTimeout(timer);
  }, [query]);

  const finishClose = useCallback(() => {
    animation.current?.cancel();
    animation.current = null;
    setOpen(false);
    setClosing(false);
    setSearch('');
    setDebounced('');
    const path = pendingPath.current;
    pendingPath.current = null;
    if (path) void navigate(path, { viewTransition: !reducedMotion() && path.split('/')[1] !== window.location.pathname.split('/')[1] });
  }, [navigate]);

  const close = useCallback(
    (path?: string) => {
      if (closing) return;
      pendingPath.current = path ?? null;
      setClosing(true);
      const element = panel.current;
      const origin = trigger.current?.getBoundingClientRect();
      if (!element || !origin || reducedMotion()) {
        finishClose();
        return;
      }
      const bounds = { left: element.offsetLeft, top: element.offsetTop, width: element.offsetWidth, height: element.offsetHeight };
      const currentTransform = getComputedStyle(element).transform;
      const currentRadius = getComputedStyle(element).borderRadius;
      animation.current?.cancel();
      const exit = element.animate(
        [
          { transform: currentTransform, borderRadius: currentRadius },
          {
            transform: `translate(${origin.left - bounds.left}px, ${origin.top - bounds.top}px) scale(${origin.width / bounds.width}, ${origin.height / bounds.height})`,
            borderRadius: '16px',
          },
        ],
        { duration: 340, easing: 'cubic-bezier(.4, 0, .2, 1)', fill: 'forwards' },
      );
      animation.current = exit;
      void exit.finished.then(finishClose, () => undefined);
    },
    [closing, finishClose],
  );

  useLayoutEffect(() => {
    if (!open) return;
    const element = panelElement;
    const origin = trigger.current?.getBoundingClientRect();
    if (!element || !origin || reducedMotion()) return;
    const bounds = element.getBoundingClientRect();
    animation.current = element.animate(
      [
        {
          transform: `translate(${origin.left - bounds.left}px, ${origin.top - bounds.top}px) scale(${origin.width / bounds.width}, ${origin.height / bounds.height})`,
          borderRadius: '16px',
        },
        { transform: 'none', borderRadius: '24px' },
      ],
      { duration: 440, easing: 'cubic-bezier(.22, 1, .36, 1)' },
    );
    const resize = () => {
      animation.current?.cancel();
      if (pendingPath.current || panel.current?.dataset.closing === 'true') finishClose();
    };
    window.addEventListener('resize', resize);
    return () => {
      animation.current?.cancel();
      window.removeEventListener('resize', resize);
    };
  }, [open, finishClose, panelElement]);

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (open) close();
        else setOpen(true);
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [open, close]);

  const needle = query.toLocaleLowerCase();
  const sections: SearchResult[] = desktopSearchSections
    .filter((section) => `${section.label} ${section.keywords}`.toLocaleLowerCase().includes(needle))
    .map(({ path, label, Icon }) => ({ id: path, path, label, detail: 'Orbis', icon: <Icon size={22} aria-hidden="true" /> }));
  const installedResults: SearchResult[] = (installed.data?.installed ?? [])
    .filter(({ info }) => info.available && `${info.name} ${info.short_desc} ${info.urn}`.toLocaleLowerCase().includes(needle))
    .slice(0, 24)
    .map(({ info }) => ({
      id: info.urn,
      path: appPath(info.urn),
      label: info.name,
      detail: 'Installed',
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
  const groups = [
    { name: 'Sections', items: sections },
    { name: 'Installed apps', items: installedResults },
    { name: 'App Store', items: storeResults },
  ];
  const firstResult = groups.flatMap((group) => group.items)[0];
  const loadingStore = query.length > 0 && (debounced !== query || catalogue.isPending);

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
        if (next) setOpen(true);
        else close();
      }}
    >
      <Dialog.Trigger asChild>
        <button ref={trigger} type="button" className="desktop-search-trigger" aria-label="Search tools and settings" data-search-open={open}>
          <IconSearch size={20} aria-hidden="true" />
          <span>Search</span>
          <kbd>⌘/Ctrl K</kbd>
        </button>
      </Dialog.Trigger>
      {open ? (
        <Dialog.Portal>
          <Dialog.Overlay className="desktop-search-backdrop" data-closing={closing} />
          <Dialog.Content
            ref={bindPanel}
            className="desktop-search-surface"
            data-closing={closing}
            aria-describedby={undefined}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              input.current?.focus();
            }}
            onEscapeKeyDown={(event) => {
              event.preventDefault();
              close();
            }}
            onInteractOutside={(event) => {
              event.preventDefault();
              close();
            }}
          >
            <Dialog.Title className="visually-hidden">Search Orbis</Dialog.Title>
            <div className="desktop-search-content">
              <div className="desktop-search-input">
                <IconSearch size={24} aria-hidden="true" />
                <input
                  ref={input}
                  value={search}
                  type="search"
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search your server"
                  aria-label="Find a tool or application"
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
              <div id="desktop-search-results" className="desktop-search-results" aria-busy={loadingStore || installed.isPending}>
                <div className="desktop-search-intro">
                  <h2>{query ? 'Search results' : 'Where would you like to go?'}</h2>
                  <p>Apps, settings and everything on your server.</p>
                </div>
                {groups
                  .filter((group) => group.items.length)
                  .map(({ name, items }) => (
                    <section className="desktop-search-group" key={name} aria-label={name}>
                      <h3>
                        {name}
                        <span>{items.length}</span>
                      </h3>
                      <div className="desktop-search-grid">
                        {items.map((result) => (
                          <button data-search-result type="button" key={result.id} onKeyDown={handleResultKeyDown} onClick={() => close(result.path)}>
                            <span className="desktop-search-result-icon">{result.icon}</span>
                            <span className="desktop-search-result-text">
                              <strong>{result.label}</strong>
                              <small>{result.detail}</small>
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
                  {query && debounced === query && catalogue.isError ? (
                    <p>
                      The App Store could not be searched.{' '}
                      <button type="button" onClick={() => void catalogue.refetch()}>
                        Try again
                      </button>
                    </p>
                  ) : null}
                  {!firstResult && !loadingStore && !installed.isPending ? (
                    <p>No matches for “{query}”. Try an app name or a section such as Updates.</p>
                  ) : null}
                </div>
              </div>
              <footer className="desktop-search-footer">
                <span>↑ ↓ to move · Enter to open</span>
                <span>Esc to close</span>
              </footer>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      ) : null}
    </Dialog.Root>
  );
}
