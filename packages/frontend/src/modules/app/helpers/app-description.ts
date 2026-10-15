export const appDescriptionText = (description: string) => description.replace(/^---\s*\n([\s\S]*?)\n---\s*(?=\n|$)/m, '').trim();
