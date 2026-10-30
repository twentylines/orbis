import type { AppCategory, AppInfoSimple } from '@/types/app.types';

export const recommendationCategories = [
  { category: 'gaming', title: 'Game hosting' },
  { category: 'ai', title: 'AI tools' },
  { category: 'finance', title: 'Personal finance' },
  { category: 'development', title: 'Development' },
  { category: 'automation', title: 'Automation' },
  { category: 'utilities', title: 'Everyday tools' },
] as const satisfies readonly { category: AppCategory; title: string }[];

// These identities describe hosting software, rather than every app in Gaming.
const gameHosts = new Set([
  'crafty',
  'pterodactyl',
  'pufferpanel',
  'pelican',
  'amp',
  'minecraft',
  'minecraft-server',
  'papermc',
  'terraria',
  'valheim',
  'palworld',
  'satisfactory',
  'factorio',
]);

export type RecommendationCategory = (typeof recommendationCategories)[number]['category'];
export const storeRecommendationCategoryIds = ['media', ...recommendationCategories.map((entry) => entry.category)] as const;
export type StoreRecommendationCategory = 'media' | RecommendationCategory;
export function validHiddenRecommendationCategories(value: unknown): value is StoreRecommendationCategory[] {
  return (
    Array.isArray(value) &&
    value.length <= storeRecommendationCategoryIds.length &&
    new Set(value).size === value.length &&
    value.every((category) => storeRecommendationCategoryIds.includes(category))
  );
}
export type StoreRecommendation = { category: RecommendationCategory; title: string; app: AppInfoSimple; choiceCount: number };

const complements: Record<string, readonly string[]> = {
  ollama: ['open-webui'],
  'open-webui': ['ollama'],
  gitea: ['code-server', 'woodpecker-ci'],
  forgejo: ['code-server', 'woodpecker-ci'],
  'code-server': ['gitea', 'forgejo'],
};

function rank(seed: string, identity: string) {
  let value = 2166136261;
  for (const character of `${seed}:${identity}`) value = Math.imul(value ^ character.charCodeAt(0), 16777619);
  return value >>> 0;
}

export function recommendStoreApps(
  catalogue: readonly AppInfoSimple[],
  installed: readonly Pick<AppInfoSimple, 'urn' | 'id'>[],
  seed: string,
  storeId?: string,
  rotation = 0,
  hiddenCategories: readonly StoreRecommendationCategory[] = [],
): StoreRecommendation[] {
  const installedIds = new Set(installed.map((app) => app.id));
  const installedUrns = new Set(installed.map((app) => app.urn));
  const related = new Set(installed.flatMap((app) => complements[app.id] ?? []));
  const choices = catalogue
    .filter(
      (app) =>
        app.available &&
        !app.deprecated &&
        !installedIds.has(app.id) &&
        !installedUrns.has(app.urn) &&
        (!storeId || app.urn.split(':')[1] === storeId),
    )
    .sort(
      (left, right) =>
        Number(related.has(right.id)) - Number(related.has(left.id)) ||
        rank(seed, left.urn) - rank(seed, right.urn) ||
        left.urn.localeCompare(right.urn),
    );
  const usedIds = new Set<string>();
  const groups = recommendationCategories
    .filter(
      ({ category }) =>
        !hiddenCategories.includes(category) &&
        choices.some((app) => app.categories.includes(category) && (category !== 'gaming' || gameHosts.has(app.id))),
    )
    .sort(
      (left, right) =>
        Number(choices.some((app) => related.has(app.id) && app.categories.includes(right.category))) -
          Number(choices.some((app) => related.has(app.id) && app.categories.includes(left.category))) ||
        rank(seed, left.category) - rank(seed, right.category) ||
        left.category.localeCompare(right.category),
    );
  if (!groups.length) return [];
  const offset = Number.isSafeInteger(rotation) && rotation >= 0 ? rotation : 0;
  const orderedGroups = [...groups.slice(offset % groups.length), ...groups.slice(0, offset % groups.length)];
  return orderedGroups.flatMap(({ category, title }) => {
    const matches = choices.filter(
      (item) => !usedIds.has(item.id) && item.categories.includes(category) && (category !== 'gaming' || gameHosts.has(item.id)),
    );
    const unique = matches.filter((item, index) => matches.findIndex((other) => other.id === item.id) === index);
    const app = unique[offset % unique.length];
    if (!app) return [];
    usedIds.add(app.id);
    return [{ category, title, app, choiceCount: unique.length }];
  });
}
