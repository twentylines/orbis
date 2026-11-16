import { useEffect, useLayoutEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { desktopNavigation } from './navigation';

export function escapeBackDestination(path: string) {
  const section = desktopNavigation.find(({ path: base }) => path === base || path.startsWith(`${base}/`));
  if (!section || section.path === '/dashboard') return null;
  return path === section.path ? '/dashboard' : section.path;
}

export function useEscapeBack(enabled: boolean) {
  const location = useLocation();
  const navigate = useNavigate();
  const current = useRef({ enabled, path: location.pathname, navigate });
  current.current = { enabled, path: location.pathname, navigate };
  const visits = useRef<string[]>([]);
  useLayoutEffect(() => {
    const known = visits.current.indexOf(location.key);
    if (known >= 0) visits.current.splice(known + 1);
    else visits.current = [...visits.current.slice(-31), location.key];
  }, [location.key]);
  useEffect(() => {
    const root = document.documentElement;
    let forwarding = false;
    const modality = (event: KeyboardEvent) => {
      if (event.key === 'Escape') root.dataset.orbisKeyboardDismiss = 'true';
      else delete root.dataset.orbisKeyboardDismiss;
    };
    const pointer = () => {
      delete root.dataset.orbisKeyboardDismiss;
    };
    const back = (event: KeyboardEvent) => {
      if (
        !current.current.enabled ||
        forwarding ||
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        event.isComposing ||
        event.repeat ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey
      )
        return;
      // Local dismiss handlers run first; an open protected layer must never send its page Home.
      const visible = (layer: HTMLElement) =>
        !layer.hidden &&
        layer.getAttribute('aria-hidden') !== 'true' &&
        layer.dataset.state !== 'closed' &&
        layer.getClientRects().length > 0 &&
        getComputedStyle(layer).visibility !== 'hidden';
      if (
        [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"][data-state="open"]')].some(
          visible,
        )
      )
        return;
      const app = document.querySelector<HTMLElement>('.orbis-app-launcher[data-active="true"]:not([hidden])');
      if (app && event.target instanceof Node && !app.contains(event.target)) {
        event.preventDefault();
        forwarding = true;
        try {
          app.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        } finally {
          forwarding = false;
        }
        return;
      }
      if ([...document.querySelectorAll<HTMLElement>('dialog[open]')].some(visible)) return;
      const editor = document.querySelector<HTMLButtonElement>('.workspace-edit-toggle[aria-label="Save workspace"]');
      if (editor) {
        event.preventDefault();
        if (!editor.disabled) editor.click();
        return;
      }
      const details = [...document.querySelectorAll<HTMLDetailsElement>('details[open]')].at(-1);
      if (details) {
        event.preventDefault();
        details.open = false;
        details.querySelector<HTMLElement>('summary')?.focus({ preventScroll: true });
        return;
      }
      event.preventDefault();
      const destination = escapeBackDestination(current.current.path);
      if (destination) {
        if (destination !== '/dashboard' && visits.current.length > 1) void current.current.navigate(-1);
        else void current.current.navigate(destination);
      }
    };
    window.addEventListener('keydown', modality, true);
    window.addEventListener('pointerdown', pointer, true);
    window.addEventListener('keydown', back);
    return () => {
      window.removeEventListener('keydown', modality, true);
      window.removeEventListener('pointerdown', pointer, true);
      window.removeEventListener('keydown', back);
      delete root.dataset.orbisKeyboardDismiss;
    };
  }, []);
}
