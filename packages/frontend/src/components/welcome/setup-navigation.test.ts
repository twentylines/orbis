import { expect, test } from 'bun:test';
import { freshSetupSteps, nextSetupStep, previousSetupStep, setupCanFinish, setupPosition, setupStepCopy, type SetupStep } from './setup-navigation';
import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SetupCustomisation } from './welcome';
import { defaultDesktopPreferences, type DesktopPreferences } from '@/desktop/preferences';

test('entry requires an explicit fresh or restore choice', () => {
  expect(nextSetupStep('choose', null)).toBeNull();
  expect(nextSetupStep('choose', 'fresh')).toBe('server');
  expect(nextSetupStep('choose', 'restore')).toBe('restore');
  expect(nextSetupStep('choose', 'transfer')).toBe('transfer');
});

test('fresh setup combines colour and wallpaper in one customisation step and retains performance and updates', () => {
  const visited: SetupStep[] = ['choose'];
  let next = nextSetupStep('choose', 'fresh');
  while (next) {
    visited.push(next);
    next = nextSetupStep(next, 'fresh');
  }
  expect(visited).toEqual(['choose', 'server', 'customisation', 'performance', 'updates', 'ready']);
  expect(visited).toEqual([...freshSetupSteps]);
  expect(visited.slice(1).map(previousSetupStep)).toEqual(visited.slice(0, -1));
});

test('back from restore returns to the choice and never skips into the fresh completion step', () => {
  expect(previousSetupStep('restore')).toBe('choose');
  expect(previousSetupStep('transfer')).toBe('choose');
  expect(nextSetupStep('transfer', 'transfer')).toBeNull();
  expect(nextSetupStep('restore', 'restore')).toBeNull();
  expect(previousSetupStep('choose')).toBeNull();
  expect(previousSetupStep('server')).toBe('choose');
  expect(previousSetupStep('ready')).toBe('updates');
});

test('restore and failed or incomplete setup cannot acknowledge fresh onboarding', () => {
  for (const step of [...freshSetupSteps, 'restore', 'transfer'] as const) {
    expect(setupCanFinish(step, 'restore')).toBe(false);
    expect(setupCanFinish(step, null)).toBe(false);
    expect(setupCanFinish(step, 'transfer')).toBe(false);
    expect(setupCanFinish(step, 'fresh')).toBe(step === 'ready');
  }
});

test('every fresh step has copy and a stable bounded position for directional transitions', () => {
  for (const [index, step] of freshSetupSteps.entries()) {
    expect(setupPosition(step)).toEqual({ current: index + 1, total: 6 });
    expect(setupStepCopy[step].title.length).toBeGreaterThan(0);
    expect(setupStepCopy[step].description.length).toBeGreaterThan(0);
  }
  expect(setupPosition('restore')).toEqual({ current: 2, total: 2 });
  expect(setupPosition('transfer')).toEqual({ current: 2, total: 2 });
  expect(setupStepCopy.restore.title).not.toContain('Ready');
  expect(setupStepCopy.transfer.title).toBe('Transfer a server');
  expect(setupStepCopy.transfer.description).toContain('Orbis to Orbis');
});

test('the customisation panel presents colour, display mode and wallpaper together with the Settings note', () => {
  const html = renderToStaticMarkup(createElement(SetupCustomisation, { draft: defaultDesktopPreferences, onChange: () => undefined }));
  for (const label of ['Colour', 'Display mode', 'Wallpaper']) expect(html).toContain(`<legend>${label}</legend>`);
  expect(html).toContain('You can add custom images later in Settings.');
  expect(html).toContain('Match wallpaper to colour preset');
  expect(html).not.toContain('type="file"');
});

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  return Children.toArray(node).flatMap((child) =>
    isValidElement<Record<string, unknown>>(child) ? [child, ...elements(child.props.children as ReactNode)] : [],
  );
}

test('actual customisation handlers preserve the same draft across palette, mode and explicit wallpaper choices', () => {
  const draft: DesktopPreferences = {
    ...defaultDesktopPreferences,
    mode: 'dark',
    wallpaperMode: 'custom',
    wallpaperPreset: 'ocean',
    appearance: {
      ...defaultDesktopPreferences.appearance,
      wallpaperImage: '/api/desktop-preferences/wallpaper',
      accent: '#214f40',
      lowEffects: true,
    },
  };
  let changed: DesktopPreferences | undefined;
  const controls = elements(
    SetupCustomisation({
      draft,
      onChange: (next) => {
        changed = next;
      },
    }),
  );
  const palette = controls.find((control) => control.props['data-palette'] === 'forest');
  if (typeof palette?.props.onClick !== 'function') throw new Error('Palette control missing');
  palette.props.onClick();
  expect(changed).toEqual({ ...draft, preset: 'forest', appearance: { ...draft.appearance, accent: null } });
  expect(draft.appearance.wallpaperImage).toBe('/api/desktop-preferences/wallpaper');
  const light = controls.find((control) => control.type === 'button' && Children.toArray(control.props.children as ReactNode).includes('Light'));
  if (typeof light?.props.onClick !== 'function') throw new Error('Display mode control missing');
  light.props.onClick();
  expect(changed).toEqual({ ...draft, mode: 'light' });
  const wallpaper = controls.find((control) => control.props['data-wallpaper'] === 'frost');
  if (typeof wallpaper?.props.onClick !== 'function') throw new Error('Wallpaper control missing');
  wallpaper.props.onClick();
  expect(changed).toEqual({ ...draft, wallpaperMode: 'custom', wallpaperPreset: 'frost', appearance: { ...draft.appearance, wallpaperImage: null } });
});
