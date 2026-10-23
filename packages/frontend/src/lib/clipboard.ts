type ClipboardEnvironment = { document?: Document | null; clipboard?: Pick<Clipboard, 'writeText'> | null };

export async function copyText(text: string, environment?: ClipboardEnvironment): Promise<boolean> {
  let clipboard: ClipboardEnvironment['clipboard'];
  try {
    clipboard = environment ? environment.clipboard : typeof navigator === 'undefined' ? null : navigator.clipboard;
    if (typeof clipboard?.writeText === 'function') {
      await clipboard.writeText(text);
      return true;
    }
  } catch {
    // Insecure origins and denied clipboard permissions can still allow a user-gesture copy.
  }
  const page = environment ? environment.document : typeof document === 'undefined' ? null : document;
  if (!page?.body || typeof page.execCommand !== 'function') return false;
  const previous = page.activeElement as HTMLElement | null;
  const input = previous as HTMLInputElement | HTMLTextAreaElement | null;
  let inputSelection: { start: number; end: number; direction: 'forward' | 'backward' | 'none' | null } | null = null;
  let selection: Selection | null = null;
  const ranges: Range[] = [];
  try {
    if (typeof input?.selectionStart === 'number' && typeof input.selectionEnd === 'number') {
      inputSelection = { start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection };
    }
    selection = page.getSelection();
    if (selection) for (let index = 0; index < selection.rangeCount; index += 1) ranges.push(selection.getRangeAt(index).cloneRange());
  } catch {
    // A selection from another browsing context may not be available.
  }
  let field: HTMLTextAreaElement | null = null;
  try {
    field = page.createElement('textarea');
    field.value = text;
    field.readOnly = true;
    field.tabIndex = -1;
    field.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;padding:0;border:0;opacity:0;font-size:16px';
    page.body.appendChild(field);
    field.focus({ preventScroll: true });
    field.select();
    field.setSelectionRange(0, text.length);
    return page.execCommand('copy') === true;
  } catch {
    return false;
  } finally {
    field?.remove();
    try {
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    } catch {
      /* A removed or disabled opener cannot regain focus. */
    }
    try {
      if (selection) {
        selection.removeAllRanges();
        for (const range of ranges) selection.addRange(range);
      }
      if (inputSelection && input?.isConnected)
        input.setSelectionRange(inputSelection.start, inputSelection.end, inputSelection.direction ?? undefined);
    } catch {
      /* The original selection may have been removed while a permission prompt was open. */
    }
  }
}
