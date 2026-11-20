import type { SettingEntry } from './settings-catalogue';

const controls = 'input:not([type="hidden"]):not([disabled]), button:not([disabled]), textarea:not([disabled]), [tabindex="0"]';

export function openSettingReview(root: HTMLElement, entry: SettingEntry, action: string): boolean {
  if (entry.review?.id !== action) return false;
  const target = root.querySelector<HTMLElement>(`[id="${entry.anchor}"]`);
  if (!target || target.closest('[hidden]')) return false;
  const section = target.matches('h1,h2,h3') ? (target.closest('section') ?? target.parentElement ?? target) : target;
  const button = section.querySelector<HTMLButtonElement>(`button[data-setting-review="${entry.review.id}"]`);
  if (!button || button.disabled || button.closest('[hidden]')) return false;
  button.click();
  return true;
}

export function revealSetting(root: HTMLElement, entry: SettingEntry, reduced: boolean): boolean {
  const target = root.querySelector<HTMLElement>(`[id="${entry.anchor}"]`);
  if (!target || target.closest('[hidden]')) return false;
  const section = target.matches('h1,h2,h3') ? (target.closest('section') ?? target.parentElement ?? target) : target;
  const findLabel = (text: string) => [...section.querySelectorAll('label')].find((label) => label.textContent?.trim().startsWith(text))?.control;
  const labelled = entry.controlLabel
    ? (findLabel(entry.controlLabel) ?? (entry.fallbackControlLabel ? findLabel(entry.fallbackControlLabel) : null))
    : null;
  if (entry.controlLabel && !labelled) return false;
  const focus =
    labelled ??
    (entry.focus
      ? section.querySelector<HTMLElement>(entry.focus)
      : section.matches('input,button,textarea')
        ? section
        : section.querySelector<HTMLElement>(controls));
  if (entry.focus && !focus) return false;
  const surface = (entry.focus || entry.controlLabel) && focus ? (focus.closest<HTMLElement>('.appearance-range') ?? focus) : section;
  for (let parent = focus?.parentElement; parent && section.contains(parent); parent = parent.parentElement) {
    if (parent.tagName === 'DETAILS') (parent as HTMLDetailsElement).open = true;
  }
  surface.scrollIntoView({ block: 'start', behavior: reduced ? 'instant' : 'smooth' });
  if (focus) focus.focus({ preventScroll: true });
  else {
    target.tabIndex = -1;
    target.focus({ preventScroll: true });
  }
  return true;
}
