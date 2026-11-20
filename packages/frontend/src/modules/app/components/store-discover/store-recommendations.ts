import type { AppCategory } from '@/types/app.types';

export const recommendationCategories = [
  { category: 'gaming', title: 'Game hosting' },
  { category: 'ai', title: 'AI tools' },
  { category: 'finance', title: 'Personal finance' },
  { category: 'development', title: 'Development' },
  { category: 'automation', title: 'Automation' },
  { category: 'utilities', title: 'Everyday tools' },
] as const satisfies readonly { category: AppCategory; title: string }[];

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
