export const normaliseSearch = (value: string) =>
  value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

function distance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previousPrevious: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let minimum = i;
    for (let j = 1; j <= b.length; j++) {
      let value = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, (previousPrevious[j - 2] ?? 0) + 1);
      current[j] = value;
      minimum = Math.min(minimum, value);
    }
    if (minimum > limit) return limit + 1;
    previousPrevious = previous;
    previous = current;
  }
  return previous[b.length] ?? limit + 1;
}

/** Compile once per query; cap fuzzy work per result and keep literal matches ahead of corrections. */
export function createSearchMatcher(query: string) {
  const needle = normaliseSearch(query.slice(0, 160)).slice(0, 80);
  const compact = needle.replaceAll(' ', '');
  const terms = needle.split(' ').filter(Boolean).slice(0, 8);
  return (label: string, details = ''): number => {
    if (!needle) return 1;
    const title = normaliseSearch(label.slice(0, 512));
    const text = `${title} ${normaliseSearch(details.slice(0, 4096))}`;
    const joinedTitle = title.replaceAll(' ', '');
    if (title === needle) return 1000;
    if (joinedTitle === compact) return 950;
    if (title.startsWith(needle) || joinedTitle.startsWith(compact)) return 850;
    if (title.includes(needle) || joinedTitle.includes(compact)) return 750;
    const words = text.split(' ').filter(Boolean).slice(0, 128);
    // Adjacent punctuation-separated name fragments also form one searchable identifier.
    const candidates = [...new Set([...words, joinedTitle])].filter((word) => word.length <= 32);
    const scores = terms.map((term) => {
      if (words.includes(term)) return 100;
      if (words.some((word) => word.startsWith(term))) return 75;
      if (text.includes(term)) return 60;
      if (term.length < 4 || term.length > 32) return 0;
      const limit = term.length >= 7 ? 2 : 1;
      let best = 0;
      for (const word of candidates) {
        const edits = distance(term, word, limit);
        if (edits <= limit) best = Math.max(best, 50 - edits * 10);
      }
      return best;
    });
    return scores.every((score) => score > 0) ? scores.reduce((sum, score) => sum + score, 0) / scores.length : 0;
  };
}
