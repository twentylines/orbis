import { presetLabels, visibleThemePresets } from './wallpaper-presets';

export type AppCommand = 'start' | 'stop' | 'restart';
export function appSearchIntent(query: string) {
  const match = query.trim().match(/^(open|launch|start|stop|restart|manage|configure|settings(?: for)?|turn on|turn off)(?:\s+(?:app\s+)?(.*))?$/i);
  if (!match) return null;
  const verb = match[1]?.toLowerCase();
  const action =
    verb === 'turn on'
      ? 'start'
      : verb === 'turn off'
        ? 'stop'
        : verb === 'launch'
          ? 'open'
          : verb === 'configure' || verb?.startsWith('settings')
            ? 'manage'
            : verb;
  return { action: action as AppCommand | 'open' | 'manage', query: match[2]?.trim() ?? '' };
}
export function availableAppCommands(status: string): AppCommand[] {
  return status === 'running' ? ['restart', 'stop'] : status === 'stopped' ? ['start'] : [];
}
const paletteAliases: Record<string, string> = {
  frost: 'green mint',
  graphite: 'grey gray neutral',
  forest: 'green sage',
  stone: 'brown beige warm',
  ocean: 'blue teal',
  blush: 'pink muted',
  burgundy: 'red wine',
  amber: 'yellow gold golden',
  orange: 'tangerine',
};
export function searchPalettePresets(query: string) {
  const normalized = query.toLowerCase().trim();
  const paletteIntent = /\b(themes?|colou?rs?|palettes?|presets?)\b/.test(normalized);
  const words = normalized
    .replace(/\b(themes?|colou?rs?|palettes?|presets?|set|apply|choose|change|use|to|a|the)\b/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const matches = visibleThemePresets.filter(
    (preset) => words.length > 0 && words.every((word) => `${presetLabels[preset]} ${paletteAliases[preset] ?? ''}`.toLowerCase().includes(word)),
  );
  return paletteIntent ? (words.length ? matches : visibleThemePresets) : matches;
}
