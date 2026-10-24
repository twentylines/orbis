import { prefersReducedMotion } from '@/desktop/motion-setting';
import { getInstalledAppsOptions, searchAppsOptions } from '@/api-client/@tanstack/react-query.gen';
import { AppLogo } from '@/components/app-logo/app-logo';
import { WrapWords } from '@/components/wrap-words/wrap-words';
import * as Dialog from '@radix-ui/react-dialog';
import { IconArrowUpRight, IconSearch, IconX } from '@tabler/icons-react';
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
import './command-search.css';

type SearchResult = { id: string; path: string; label: string; detail: string; icon: ReactNode };
const appPath = (urn: string, catalogue = false) => {
  const [appId = '', storeId = ''] = urn.split(':');
  return `/${catalogue ? 'app-store' : 'apps'}/${encodeURIComponent(storeId)}/${encodeURIComponent(appId)}`;
};
const reducedMotion = () => prefersReducedMotion();

export function CommandSearch() {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [bar, setBar] = useState({ left: 24, top: 24, width: 600, height: 64, available: 600 });
  const [panelElement, setPanelElement] = useState<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
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
    enabled: open && !closing && debounced.length > 0,
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
      const options = { duration: 420, easing: 'cubic-bezier(.32, 0, .18, 1)', fill: 'forwards' as const };
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
        { duration: 520, easing: 'cubic-bezier(.32, 0, .18, 1)' },
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
            duration: 380,
            delay: 100,
            easing: 'cubic-bezier(.32, 0, .18, 1)',
            fill: 'backwards',
          },
        );
        results.id = 'orbis-search-results-open';
        motions.current.push(results);
      }
      if (backdrop.current) motions.current.push(backdrop.current.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300 }));
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
  const terms = needle.split(/\s+/).filter(Boolean);
  const sections: SearchResult[] = desktopSearchSections
    .filter((section) => terms.every((term) => `${section.label} ${section.keywords}`.toLocaleLowerCase().includes(term)))
    .map(({ path, label, Icon }) => ({ id: path, path, label, detail: '', icon: <Icon size={22} aria-hidden="true" /> }));
  const installedResults: SearchResult[] = (installed.data?.installed ?? [])
    .filter(({ info }) => info.available && `${info.name} ${info.short_desc} ${info.urn}`.toLocaleLowerCase().includes(needle))
    .slice(0, 24)
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
        if (next) openSearch();
        else close();
      }}
    >
      <Dialog.Trigger asChild>
        <button ref={trigger} type="button" className="desktop-search-trigger" aria-label="Search apps and settings" data-search-open={open}>
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
            aria-describedby={undefined}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              input.current?.focus({ preventScroll: true });
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              trigger.current?.focus({ preventScroll: true });
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
                  value={closing ? '' : search}
                  type="search"
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search"
                  aria-label="Search apps and settings"
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
              <div ref={dropdown} className="desktop-search-dropdown">
                <div id="desktop-search-results" className="desktop-search-results" aria-busy={loadingStore || installed.isPending}>
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
                    {query && debounced === query && catalogue.isError ? (
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
