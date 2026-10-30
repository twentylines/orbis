import { useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { IconArrowUpRight, IconSearch, IconX } from '@tabler/icons-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
import { SelectionGroup } from '@/components/ui/SelectionGroup/SelectionGroup';
import { DialogVisibilityContext } from '@/components/ui/Dialog/Dialog';
import { WindowVisibilityContext } from '@/desktop/window-visibility';
import { RouteHeaderToolbar } from '@/desktop/route-header-toolbar';
import { useReducedMotion } from '@/desktop/motion-preferences';
import {
  searchSettings,
  settingsSections,
  retainSettingsSections,
  type SettingEntry,
  type SettingsAccess,
  type SettingsSection,
} from '../helpers/settings-catalogue';
import './settings-page.css';
import { SettingsSaveButton, SettingsSaveFeedback, SettingsSaveStatus } from './settings-save';

export function SettingsPanel({ active, children, id, label }: { active: boolean; children: ReactNode; id: string; label: string }) {
  const parentVisible = useContext(WindowVisibilityContext);
  const reduced = useReducedMotion();
  return (
    <WindowVisibilityContext.Provider value={parentVisible && active}>
      <DialogVisibilityContext.Provider value={parentVisible && active}>
        <motion.section
          id={id}
          hidden={!active}
          aria-label={label}
          className="settings-category-panel"
          initial={reduced ? false : { opacity: 0, x: 12 }}
          animate={{ opacity: active ? 1 : 0, x: active || reduced ? 0 : 12 }}
          transition={{ duration: reduced ? 0 : 0.22, ease: [0.22, 0.68, 0.2, 1] }}
        >
          {children}
        </motion.section>
      </DialogVisibilityContext.Provider>
    </WindowVisibilityContext.Provider>
  );
}

export function SettingsWorkspace({
  current,
  access,
  onSection,
  onSetting,
  panels,
}: {
  current: SettingsSection;
  access: SettingsAccess;
  onSection: (section: SettingsSection) => void;
  onSetting: (entry: SettingEntry) => void;
  panels: Record<SettingsSection, ReactNode>;
}) {
  const id = useId();
  const reduced = useReducedMotion();
  const [query, setQuery] = useState('');
  const [pointerFocus, setPointerFocus] = useState(false);
  const [visited, setVisited] = useState<ReadonlySet<SettingsSection>>(() => new Set([current]));
  const search = useRef<HTMLInputElement>(null);
  const resultsRoot = useRef<HTMLUListElement>(null);
  const results = searchSettings(query, access);
  useEffect(() => {
    setVisited((previous) => retainSettingsSections(previous, current));
  }, [current]);
  const choose = (entry: SettingEntry) => {
    setQuery('');
    onSetting(entry);
  };
  const section = settingsSections.find((entry) => entry.id === current) ?? settingsSections[0];
  return (
    <div className="settings-workspace">
      <RouteHeaderToolbar>
        <SettingsSaveStatus />
      </RouteHeaderToolbar>
      <search
        className="settings-search"
        onPointerDownCapture={() => setPointerFocus(true)}
        onKeyDownCapture={(event) => {
          if (['Tab', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) setPointerFocus(false);
        }}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            setQuery('');
            setPointerFocus(false);
          }
        }}
      >
        <label data-pointer-focus={pointerFocus} className="settings-search-field" htmlFor={`${id}-search`}>
          <IconSearch size={20} aria-hidden="true" />
          <input
            ref={search}
            id={`${id}-search`}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a setting"
            aria-label="Find a setting"
            autoComplete="off"
            aria-controls={query.trim() ? `${id}-results` : undefined}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setQuery('');
              if (event.key === 'Enter' && results[0]) {
                event.preventDefault();
                choose(results[0]);
              }
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                resultsRoot.current?.querySelector('button')?.focus();
              }
            }}
          />
          {query ? (
            <button
              type="button"
              aria-label="Clear settings search"
              onClick={() => {
                setQuery('');
                search.current?.focus();
              }}
            >
              <IconX size={18} aria-hidden="true" />
            </button>
          ) : null}
        </label>
        <AnimatePresence initial={false}>
          {query.trim() ? (
            <motion.ul
              key="settings-search-results"
              initial={reduced ? false : { opacity: 0, y: 3 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: reduced ? 0 : 3 }}
              transition={{ duration: reduced ? 0 : 0.18, ease: [0.22, 0.68, 0.2, 1] }}
              ref={resultsRoot}
              id={`${id}-results`}
              className="settings-search-results"
              aria-label="Matching settings"
            >
              {results.map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    onClick={() => choose(entry)}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        setQuery('');
                        search.current?.focus();
                      }
                      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                        event.preventDefault();
                        const buttons = [...(resultsRoot.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
                        const index = buttons.indexOf(event.currentTarget);
                        const next =
                          event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : index + (event.key === 'ArrowDown' ? 1 : -1);
                        if (next < 0) search.current?.focus();
                        else buttons[Math.min(next, buttons.length - 1)]?.focus();
                      }
                    }}
                  >
                    <span>
                      <strong>{entry.label}</strong>
                      <small>{settingsSections.find((item) => item.id === entry.section)?.label}</small>
                    </span>
                    <IconArrowUpRight size={18} aria-hidden="true" />
                  </button>
                </li>
              ))}
              {results.length ? null : <li className="settings-search-empty">No matching settings.</li>}
            </motion.ul>
          ) : null}
        </AnimatePresence>
      </search>
      <div className="settings-layout">
        <nav className="settings-sidebar" aria-label="Settings categories">
          <SelectionGroup className="settings-category-list">
            {settingsSections.map((entry) => (
              <button key={entry.id} type="button" aria-pressed={current === entry.id} onClick={() => onSection(entry.id)}>
                <strong>{entry.label}</strong>
              </button>
            ))}
          </SelectionGroup>
        </nav>
        <div className="settings-mobile-navigation">
          <Select
            value={current}
            onValueChange={(value) => {
              const next = settingsSections.find((entry) => entry.id === value);
              if (next) onSection(next.id);
            }}
          >
            <SelectTrigger aria-label="Settings category">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {settingsSections.map((entry) => (
                <SelectItem key={entry.id} value={entry.id}>
                  {entry.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="settings-content">
          <header className="settings-content-heading">
            <h2>{section.label}</h2>
            <SettingsSaveButton />
          </header>
          <SettingsSaveFeedback />
          {settingsSections
            .filter((entry) => visited.has(entry.id) || entry.id === current)
            .map((entry) => (
              <SettingsPanel key={entry.id} id={`settings-panel-${entry.id}`} label={entry.label} active={current === entry.id}>
                {panels[entry.id]}
              </SettingsPanel>
            ))}
        </div>
      </div>
    </div>
  );
}
