import { type } from 'arktype';
import { frameworkIdSchema } from './theme-framework-contract.js';
import { frameworkJsonDataAllows } from './theme-framework-validation.js';

const version = type('string <= 32').and(/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/);
const release = type('string <= 80').and(/^v?(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-(beta|rc)\.(0|[1-9]\d{0,8}))?$/);
// biome-ignore lint/suspicious/noControlCharactersInRegex: catalogue text must not contain control or bidi formatting characters.
const text = type('0 < string <= 160').and(/^[^<>\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]+$/);

const entry = type({
  id: frameworkIdSchema,
  version,
  name: text,
  description: text,
  author: text,
  repository: 'string <= 256',
  requires: type({ api: '1', releases: release.array().atLeastLength(1).atMostLength(32) }).onUndeclaredKey('reject'),
  supportsUiRevisions: type('1 <= number.integer <= 9007199254740991').array().atMostLength(64),
  package: type({ url: 'string <= 512', sha256: type('string').and(/^[a-f0-9]{64}$/), bytes: '1 <= number.integer <= 33554432' }).onUndeclaredKey(
    'reject',
  ),
}).onUndeclaredKey('reject');

export const themeFrameworkCatalogueSchema = type({
  schema: "'orbis.theme-framework-catalogue.v1'",
  themes: entry.array().atMostLength(256),
}).onUndeclaredKey('reject');
export type ThemeFrameworkCatalogue = typeof themeFrameworkCatalogueSchema.infer;

export function themeFrameworkCatalogueJsonSchema(): Record<string, unknown> {
  return {
    ...themeFrameworkCatalogueSchema.toJsonSchema(),
    $id: 'urn:orbis:theme-framework-catalogue:v1',
    $comment:
      'Structural constraints only. validateThemeFrameworkCatalogue also enforces reserved identities, repository and package URL binding, and unique versions and requirements. Catalogue metadata does not enable theme installation.',
  };
}

/** Structural validation alone is insufficient: bind each package URL to its declared repository and version. */
export function validateThemeFrameworkCatalogue(value: unknown): ThemeFrameworkCatalogue {
  if (!frameworkJsonDataAllows(value) || !themeFrameworkCatalogueSchema.allows(value)) throw new Error('Invalid theme catalogue');
  const seen = new Set<string>();
  const repositories = new Map<string, string>();
  for (const item of value.themes) {
    if (
      item.id === 'default' ||
      item.id.startsWith('orbis-') ||
      item.id.split(/[.-]/).some((part) => ['constructor', 'prototype', '__proto__'].includes(part)) ||
      [item.name, item.description, item.author].some((text) => !text.trim())
    )
      throw new Error('Invalid theme catalogue');
    const repo = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})$/.exec(item.repository);
    if (!repo || repo[2]?.includes('..') || repo[2]?.endsWith('.git')) throw new Error('Invalid theme catalogue');
    const prefixes = [`${item.repository}/releases/download/v${item.version}/`, `${item.repository}/releases/download/${item.version}/`];
    const prefix = prefixes.find((candidate) => item.package.url.startsWith(candidate));
    if (
      !prefix ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(?:zip|tar\.gz)$/.test(item.package.url.slice(prefix.length)) ||
      item.package.url.slice(prefix.length).includes('..')
    )
      throw new Error('Invalid theme catalogue');
    const key = `${item.id}@${item.version}`;
    const repository = item.repository.toLowerCase();
    if (repositories.has(item.id) && repositories.get(item.id) !== repository) throw new Error('Invalid theme catalogue');
    if (
      seen.has(key) ||
      new Set(item.requires.releases.map((release) => release.replace(/^v/, ''))).size !== item.requires.releases.length ||
      new Set(item.supportsUiRevisions).size !== item.supportsUiRevisions.length
    )
      throw new Error('Invalid theme catalogue');
    seen.add(key);
    repositories.set(item.id, repository);
  }
  return value;
}
