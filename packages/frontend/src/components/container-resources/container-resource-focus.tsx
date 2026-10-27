import { Component, type ReactNode, type RefObject } from 'react';

type Props = {
  list: RefObject<HTMLOListElement | null>;
  fallback: RefObject<HTMLHeadingElement | null>;
  scope?: RefObject<HTMLElement | null>;
  children: ReactNode;
};
type Snapshot = { control: HTMLElement; top: number; scroller: HTMLElement | Window };

function scrollContainer(element: HTMLElement): HTMLElement | Window {
  for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
    if (/^(auto|scroll|overlay)$/.test(getComputedStyle(parent).overflowY)) return parent;
  }
  return window;
}

function reveal(control: HTMLElement, scroller: HTMLElement | Window) {
  const bounds = control.getBoundingClientRect();
  const style = getComputedStyle(control);
  const marker = style.outlineStyle === 'none' ? 0 : Number.parseFloat(style.outlineWidth) + Math.max(0, Number.parseFloat(style.outlineOffset));
  const inset = 8 + marker;
  const clip = scroller instanceof HTMLElement ? scroller.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
  const top = Math.max(0, clip.top, document.querySelector('.desktop-system-bar')?.getBoundingClientRect().bottom ?? 0) + inset;
  const bottom =
    Math.min(window.innerHeight, clip.bottom, document.querySelector('.desktop-dock')?.getBoundingClientRect().top ?? window.innerHeight) - inset;
  if (bounds.height > bottom - top) return;
  const delta = bounds.top < top ? bounds.top - top : bounds.bottom > bottom ? bounds.bottom - bottom : 0;
  if (delta) scroller.scrollBy({ top: delta, behavior: 'instant' });
}

// This snapshot must precede React's keyed row moves; an effect would see only the moved control.
export class ContainerResourceFocus extends Component<Props, Record<string, never>, Snapshot | null> {
  override getSnapshotBeforeUpdate(): Snapshot | null {
    const control = document.activeElement;
    const scope = this.props.scope?.current ?? this.props.list.current;
    if (!(control instanceof HTMLElement) || !scope?.contains(control)) return null;
    return { control, top: control.getBoundingClientRect().top, scroller: scrollContainer(control) };
  }

  override componentDidUpdate(_previousProps: Props, _previousState: Record<string, never>, snapshot: Snapshot | null) {
    if (!snapshot) return;
    const active = document.activeElement;
    if (active !== snapshot.control && active !== document.body) return;
    const scope = this.props.scope?.current ?? this.props.list.current;
    const surviving =
      snapshot.control.isConnected && scope?.contains(snapshot.control) && !snapshot.control.matches(':disabled,[aria-disabled="true"]');
    const control = surviving ? snapshot.control : this.props.fallback.current;
    if (!control) return;
    if (active !== control) control.focus({ preventScroll: true });
    if (surviving) {
      const delta = control.getBoundingClientRect().top - snapshot.top;
      if (delta) snapshot.scroller.scrollBy({ top: delta, behavior: 'instant' });
    }
    reveal(control, snapshot.scroller);
  }

  override render() {
    return this.props.children;
  }
}
