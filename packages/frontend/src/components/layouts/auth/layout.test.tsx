import { expect, test } from 'bun:test';
import { isValidElement } from 'react';
import { DepthTravel } from '@/components/recovery-progress/depth-travel';
import { DesktopWallpaper } from '@/desktop/wallpaper';
import { authLayoutScene } from './layout';

test('setup auth uses the existing onboarding space while ordinary auth keeps the wallpaper', () => {
  const setup = authLayoutScene(true);
  expect(isValidElement(setup)).toBe(true);
  if (!isValidElement(setup)) throw new Error('Setup background missing');
  expect(setup.type).toBe(DepthTravel);
  expect(setup.props).toMatchObject({ mode: 'ambient', variant: 'onboarding', className: 'orbis-setup-space' });

  const login = authLayoutScene(false);
  expect(isValidElement(login)).toBe(true);
  if (!isValidElement(login)) throw new Error('Login background missing');
  expect(login.type).toBe(DesktopWallpaper);
});

test('explicit setup scenes remain intact', () => {
  const scene = <div data-scene="provided" />;
  expect(authLayoutScene(true, scene)).toBe(scene);
});
