import { expect, test } from 'bun:test';
import {
  freshSetupSteps,
  migrationSetupSteps,
  nextSetupStep,
  previousSetupStep,
  setupCanFinish,
  setupPosition,
  setupStepCopy,
  type SetupStep,
} from './setup-navigation';
import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ColourModeChoice } from '@/desktop/colour-mode-choice';
import { SetupCustomisation, SetupTimeMachineStep } from './welcome';
import { Switch } from '@/components/ui/Switch';
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
  expect(visited).toEqual(['choose', 'server', 'customisation', 'performance', 'updates', 'time-machine', 'ready']);
  expect(visited).toEqual([...freshSetupSteps]);
  expect(visited.slice(1).map((step) => previousSetupStep(step))).toEqual(visited.slice(0, -1));
});

test('installer-detected Runtipi migration starts at customisation and never returns to fresh setup choices', () => {
  expect(migrationSetupSteps).toEqual(['customisation', 'performance', 'updates', 'time-machine', 'ready']);
  expect(previousSetupStep('customisation', 'migration')).toBeNull();
  for (const [index, step] of migrationSetupSteps.entries()) {
    expect(setupPosition(step, 'migration')).toEqual({ current: index + 1, total: 5 });
    expect(nextSetupStep(step, 'migration')).toBe(migrationSetupSteps[index + 1] ?? null);
    expect(setupCanFinish(step, 'migration')).toBe(step === 'ready');
  }
  expect(setupCanFinish('ready', null)).toBe(false);
});

test('back from restore returns to the choice and never skips into the fresh completion step', () => {
  expect(previousSetupStep('restore')).toBe('choose');
  expect(previousSetupStep('transfer')).toBe('choose');
  expect(nextSetupStep('transfer', 'transfer')).toBeNull();
  expect(nextSetupStep('restore', 'restore')).toBeNull();
  expect(previousSetupStep('choose')).toBeNull();
  expect(previousSetupStep('server')).toBe('choose');
  expect(previousSetupStep('ready')).toBe('time-machine');
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
    expect(setupPosition(step)).toEqual({ current: index + 1, total: 7 });
    expect(setupStepCopy[step].title.length).toBeGreaterThan(0);
    if (step !== 'ready') expect(setupStepCopy[step].description.length).toBeGreaterThan(0);
  }
  expect(setupPosition('restore')).toEqual({ current: 2, total: 2 });
  expect(setupPosition('transfer')).toEqual({ current: 2, total: 2 });
  expect(setupStepCopy.restore.title).not.toContain('Ready');
  expect(setupStepCopy.transfer.title).toBe('Transfer a server');
  expect(setupStepCopy.transfer.description).toContain('Orbis to Orbis');
  expect(setupStepCopy.ready).toEqual({ title: 'Ready', description: '' });
});

test('customisation offers colour and display controls while custom wallpaper stays in Settings', () => {
  const html = renderToStaticMarkup(createElement(SetupCustomisation, { draft: defaultDesktopPreferences, onChange: () => undefined }));
  for (const label of ['Colour', 'Display mode']) expect(html).toContain(`<legend>${label}</legend>`);
  expect(html).toContain('You can add custom wallpapers later in Settings.');
  expect(html).not.toContain('Match wallpaper to colour preset');
  expect(defaultDesktopPreferences.wallpaperMode).toBe('theme');
  expect(html).not.toContain('type="file"');
});

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  return Children.toArray(node).flatMap((child) =>
    isValidElement<Record<string, unknown>>(child) ? [child, ...elements(child.props.children as ReactNode)] : [],
  );
}

test('the separate Time Machine step uses one shared switch, keeps its draft callback and offers no password or acknowledgement fields', () => {
  let enabled = false;
  const props = {
    enabled,
    canManage: true,
    disabled: false,
    unavailable: false,
    onChange: (value: boolean) => {
      enabled = value;
    },
    onRetry: () => undefined,
  };
  const control = elements(SetupTimeMachineStep(props)).find((element) => element.type === Switch);
  expect(control?.props).toMatchObject({ label: 'Enable Time Machine', checked: false, disabled: false });
  if (typeof control?.props.onCheckedChange !== 'function') throw new Error('Shared Time Machine switch missing');
  control.props.onCheckedChange(true);
  expect(enabled).toBe(true);
  const html = renderToStaticMarkup(createElement(SetupTimeMachineStep, { ...props, enabled }));
  expect(html.match(/role="switch"/g)).toHaveLength(1);
  expect(html).toContain('aria-checked="true"');
  expect(html).toContain('Experimental.');
  expect(html).not.toContain('type="password"');
  expect(html).not.toContain('Authentication code');
  expect(html).not.toContain('acknowledge');
  expect(nextSetupStep('updates', 'fresh')).toBe('time-machine');
  expect(nextSetupStep('time-machine', 'fresh')).toBe('ready');
  expect(previousSetupStep('ready', 'fresh')).toBe('time-machine');
});

test('actual customisation handlers preserve the saved draft and leave custom wallpaper controls in Settings', () => {
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
  const modeControls = elements(
    ColourModeChoice({
      mode: draft.mode,
      oledDark: draft.appearance.oledDark,
      onChange: ({ mode, oledDark }) => {
        changed = { ...draft, mode, appearance: { ...draft.appearance, oledDark } };
      },
    }),
  );
  expect(
    modeControls.filter((control) => control.props['data-setting-value'] !== undefined).map((control) => control.props['data-setting-value']),
  ).toEqual(['light', 'dark', 'system']);
  const light = modeControls.find((control) => control.props['data-setting-value'] === 'light');
  if (typeof light?.props.onClick !== 'function') throw new Error('Display mode control missing');
  light.props.onClick();
  expect(changed).toEqual({ ...draft, mode: 'light', appearance: { ...draft.appearance, oledDark: draft.appearance.oledDark } });
  const oled = modeControls.find((control) => control.type === Switch && control.props.label === 'Use OLED blacks');
  expect(oled?.props.checked).toBe(draft.appearance.oledDark);
  if (typeof oled?.props.onCheckedChange !== 'function') throw new Error('OLED switch missing');
  oled.props.onCheckedChange(!draft.appearance.oledDark);
  expect(changed).toEqual({ ...draft, mode: 'dark', appearance: { ...draft.appearance, oledDark: !draft.appearance.oledDark } });
  expect(controls.some((control) => control.props['data-wallpaper'] !== undefined)).toBe(false);
});

test('display modes preserve the OLED preference and the separate switch changes only that preference', () => {
  for (const mode of ['system', 'light', 'dark'] as const) {
    let changed: { mode: string; oledDark: boolean } | undefined;
    const controls = elements(
      ColourModeChoice({
        mode: 'dark',
        oledDark: true,
        onChange: (next) => {
          changed = next;
        },
      }),
    );
    const control = controls.find((item) => item.props['data-setting-value'] === mode);
    if (typeof control?.props.onClick !== 'function') throw new Error('Display mode missing');
    control.props.onClick();
    expect(changed).toEqual({ mode, oledDark: true });
  }
  let changed: { mode: string; oledDark: boolean } | undefined;
  const controls = elements(
    ColourModeChoice({
      mode: 'system',
      oledDark: false,
      onChange: (next) => {
        changed = next;
      },
    }),
  );
  const oled = controls.find((item) => item.type === Switch && item.props.label === 'Use OLED blacks');
  if (typeof oled?.props.onCheckedChange !== 'function') throw new Error('OLED switch missing');
  oled.props.onCheckedChange(true);
  expect(changed).toEqual({ mode: 'system', oledDark: true });
});
