export const commandSearchEvent = 'orbis-open-command-search';

export function openCommandSearch() {
  window.dispatchEvent(new Event(commandSearchEvent));
}
