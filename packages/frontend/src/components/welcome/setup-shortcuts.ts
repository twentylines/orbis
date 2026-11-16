export function setupShortcut(
  event: Pick<KeyboardEvent, 'key' | 'defaultPrevented' | 'repeat' | 'isComposing' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>,
  controlFocused: boolean,
  blocked: boolean,
) {
  if (blocked || event.defaultPrevented || event.repeat || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
    return null;
  if (event.key === 'Escape') return 'back';
  return event.key === 'Enter' && !controlFocused ? 'next' : null;
}
