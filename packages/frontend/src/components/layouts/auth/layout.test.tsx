import { expect, test } from 'bun:test';
import { isValidElement } from 'react';
import { InterstellarBackdrop } from '@/components/startup/interstellar-backdrop';
import { DesktopWallpaper } from '@/desktop/wallpaper';
import { authLayoutScene } from './layout';

test('setup auth shares the startup image while ordinary auth keeps the selected wallpaper', () => {
  const setup = authLayoutScene(true);
  expect(isValidElement(setup)).toBe(true);
  if (!isValidElement(setup)) throw new Error('Setup background missing');
  expect(setup.type).toBe(InterstellarBackdrop);
  expect(setup.props).toMatchObject({ className: 'orbis-setup-space' });

  const login = authLayoutScene(false);
  expect(isValidElement(login)).toBe(true);
  if (!isValidElement(login)) throw new Error('Login background missing');
  expect(login.type).toBe(DesktopWallpaper);
});

test('explicit setup scenes remain intact', () => {
  const scene = <div data-scene="provided" />;
  expect(authLayoutScene(true, scene)).toBe(scene);
});
