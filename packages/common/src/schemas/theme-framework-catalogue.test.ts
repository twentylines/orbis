import { readFileSync } from 'node:fs';
import { expect, test } from 'bun:test';
import { themeFrameworkCatalogueJsonSchema, validateThemeFrameworkCatalogue } from './theme-framework-catalogue.js';

test('published catalogue schema remains identical to the implemented structural contract', () => {
  const published = JSON.parse(readFileSync(new URL('../../json-schemas/theme-framework-catalogue-v1.json', import.meta.url), 'utf8'));
  expect(published).toEqual(themeFrameworkCatalogueJsonSchema());
  expect(published.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
  expect(published.$id).toBe('urn:orbis:theme-framework-catalogue:v1');
  expect(published.additionalProperties).toBe(false);
});

test('a published empty catalogue is valid without manufacturing installable themes', () => {
  const empty = { schema: 'orbis.theme-framework-catalogue.v1', themes: [] };
  expect(validateThemeFrameworkCatalogue(empty)).toEqual(empty);
  expect(() => validateThemeFrameworkCatalogue({ ...empty, runtimeAvailable: true })).toThrow();
  expect(() => validateThemeFrameworkCatalogue({ ...empty, schema: 'orbis.theme-framework-catalogue.v2' })).toThrow();
});
