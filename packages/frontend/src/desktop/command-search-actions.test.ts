import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SearchAppCommandControls } from './command-search-app-controls';
import type { SearchAppAction } from './command-search-app-action';
import { activateSearchResult, defaultSearchResult } from './command-search-actions';
import { toolbarActionIds } from './workspace-layout';

const page = { label: 'Apps', detail: 'Manage installed apps, settings and external links', path: '/apps' };
const settings = { label: 'Jellyfin notifications', detail: 'Settings', path: '/settings?tab=notifications' };
const app = {
  label: 'Jellyfin',
  detail: 'Stream your media',
  path: '/apps/main/jellyfin',
  launch: { urn: 'jellyfin:main', name: 'Jellyfin', launchUrl: 'http://media.example.test:8096/' },
};

test('input Enter chooses the first displayed result even when a later app matches exactly', () => {
  expect(defaultSearchResult([settings, page, app])).toBe(settings);
});

test('displayed order is preserved and an empty result list has no default', () => {
  expect(defaultSearchResult([page, app])).toBe(page);
  expect(defaultSearchResult([page, { ...page, path: '/other' }])).toBe(page);
  expect(defaultSearchResult([])).toBeUndefined();
});

test('input Enter launches the first displayed app and closes without page navigation', () => {
  const openApp = mock(() => true);
  const close = mock();
  const result = defaultSearchResult([app, settings, page]);
  if (result) activateSearchResult(result, openApp, close);
  expect(openApp).toHaveBeenCalledWith(app.launch);
  expect(close.mock.calls).toEqual([[]]);
});

test('input Enter navigates to the first displayed setting instead of launching a later exact app match', () => {
  const openApp = mock(() => true);
  const close = mock();
  const result = defaultSearchResult([settings, app]);
  if (result) activateSearchResult(result, openApp, close);
  expect(openApp).not.toHaveBeenCalled();
  expect(close.mock.calls).toEqual([[settings.path]]);
});

test('activating a keyboard-selected app launches that app even when it is not the default result', () => {
  const selected = { ...app, label: 'Audiobookshelf', launch: { ...app.launch, urn: 'audiobookshelf:main', name: 'Audiobookshelf' } };
  const openApp = mock(() => true);
  const close = mock();
  activateSearchResult(selected, openApp, close);
  expect(openApp).toHaveBeenCalledWith(selected.launch);
  expect(close.mock.calls).toEqual([[]]);
});

test('pages and nonlaunchable apps retain their management destination', () => {
  const openApp = mock(() => true);
  const close = mock();
  activateSearchResult(page, openApp, close);
  activateSearchResult({ path: '/apps/main/stopped-app' }, openApp, close);
  expect(openApp).not.toHaveBeenCalled();
  expect(close.mock.calls).toEqual([['/apps'], ['/apps/main/stopped-app']]);
});

test('an unhandled launch leaves search open rather than silently navigating to a details page', () => {
  const close = mock();
  activateSearchResult(app, () => false, close);
  expect(close).not.toHaveBeenCalled();
});

test('input and native result activation share the launcher action without intercepting composing Enter', async () => {
  const source = await Bun.file(new URL('./command-search.tsx', import.meta.url)).text();
  expect(source).toContain("event.key === 'Enter' && !event.nativeEvent.isComposing && firstResult");
  expect(source).toContain('activateResult(firstResult)');
  expect(source).toContain('onClick={() => activateResult(result)}');
  expect(source).toContain('onKeyDown={handleResultKeyDown}');
});

test('the toolbar supplies mode, tasks, battery, search, address and logoff to its ordered action slots', async () => {
  expect(toolbarActionIds).toEqual(['mode', 'tasks', 'battery', 'search', 'connection', 'logout']);
  const source = await Bun.file(new URL('../components/layouts/dashboard/layout.tsx', import.meta.url)).text();
  const bar = source.slice(source.indexOf('<SystemToolbar'), source.indexOf('</SystemToolbar>'));
  const controls = [
    'className="desktop-mode-toggle"',
    '<DesktopTaskLink',
    '<HostBatteryIndicator',
    '<CommandSearch',
    '<ClusterConnection',
    '<DesktopLogoutButton',
  ];
  const positions = controls.map((control) => bar.indexOf(control));
  expect(positions.every((position) => position >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
});

test('queried running apps group lifecycle controls once with readable names and no mutation on render', () => {
  const onCommand = mock();
  const commands: SearchAppAction[] = [
    { action: 'restart', urn: 'beszel:main', name: 'Beszel' },
    { action: 'stop', urn: 'beszel:main', name: 'Beszel' },
  ];
  const html = renderToStaticMarkup(createElement(SearchAppCommandControls, { commands, onCommand, onKeyDown: () => {} }));
  expect(html).toContain('>Beszel actions</legend>');
  expect(html).toContain('aria-label="Restart Beszel"');
  expect(html).toContain('aria-label="Stop Beszel"');
  expect(html).toContain('data-app-command="stop"');
  expect(html.match(/<button/g)).toHaveLength(2);
  expect(html).not.toContain('aria-label="Start Beszel"');
  expect(onCommand).not.toHaveBeenCalled();
});

test('a queried stopped app offers Start without unavailable Stop or Restart controls', () => {
  const html = renderToStaticMarkup(
    createElement(SearchAppCommandControls, {
      commands: [{ action: 'start', urn: 'beszel:main', name: 'Beszel' }],
      onCommand: () => {},
      onKeyDown: () => {},
    }),
  );
  expect(html.match(/<button/g)).toHaveLength(1);
  expect(html).toContain('aria-label="Start Beszel"');
  expect(html).toContain('data-app-command="start"');
  expect(html).not.toContain('aria-label="Stop Beszel"');
  expect(html).not.toContain('aria-label="Restart Beszel"');
});
