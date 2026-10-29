/// <reference types="bun" />
import { expect, test } from 'bun:test';
import type { ThemePackManifest } from '@runtipi/common/schemas/theme-pack';
import { compareThemeVersions, themeCatalogue, themeVersions } from './theme-catalogue';

const pack = (id: string, version: string, name: string, description = '', author = 'Photographer') =>
  ({ id, version, name, description, author }) as ThemePackManifest;
test('Store groups versioned packs by identity and chooses the latest numeric version regardless of API order', () => {
  const catalogue = [pack('alpine', '1.10.0', 'Alpine'), pack('woodland', '1.0.0', 'Woodland'), pack('alpine', '1.2.0', 'Alpine')];
  expect(themeCatalogue(catalogue).map((item) => `${item.id}@${item.version}`)).toEqual(['alpine@1.10.0', 'woodland@1.0.0']);
  expect(themeVersions(catalogue, 'alpine').map((item) => item.version)).toEqual(['1.2.0', '1.10.0']);
  expect(catalogue.map((item) => item.version)).toEqual(['1.10.0', '1.0.0', '1.2.0']);
  expect(compareThemeVersions('2.0.0', '1.99.99')).toBeGreaterThan(0);
});
test('Theme search is local, case-insensitive and matches name, treatment description or photographer', () => {
  const catalogue = [
    pack('alpine', '1.1.0', 'Alpine', 'Pale stone surfaces', 'Willian'),
    pack('tideline', '1.1.0', 'Tideline', 'Quiet blue controls', 'Annie'),
  ];
  expect(themeCatalogue(catalogue, '  ALPINE stone ').map((item) => item.id)).toEqual(['alpine']);
  expect(themeCatalogue(catalogue, 'annie').map((item) => item.id)).toEqual(['tideline']);
  expect(themeCatalogue(catalogue, 'remote import')).toEqual([]);
  expect(themeCatalogue([], 'anything')).toEqual([]);
});
