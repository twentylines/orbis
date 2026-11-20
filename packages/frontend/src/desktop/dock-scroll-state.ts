export const dockScrollMinExtent = 48;

export function dockScrollProgress(top: number, extent: number): number | null {
  if (!Number.isFinite(extent) || extent < dockScrollMinExtent) return null;
  return Math.max(0, Math.min(1, (Number.isFinite(top) ? top : 0) / extent));
}

export type DockScrollDirection = -1 | 1;
export const dockCollapseForMonitorChart = 'orbis-dock-collapse-for-monitor-chart';

export function dockScrollRoute(route: string, split: boolean): string | null {
  if (/^\/dashboard(?:[/?]|$)/.test(route)) return null;
  // App selection keeps the catalogue and its scroll gesture mounted on desktop.
  return (split && route.match(/^\/(?:app-store|apps)(?=[/?]|$)/)?.[0]) || route;
}

export type DockScrollState = { top: number; direction: DockScrollDirection | 0; distance: number; collapsed: boolean };

export const initialDockScroll = (top = 0): DockScrollState => ({ top, direction: 0, distance: 0, collapsed: false });

export type DockScrollSample = { travel: DockScrollState; extent: number };

// Scroll position belongs to each pane; visibility belongs to the whole dock.
// Newly mounted, resized or nonmoving siblings must not reopen a hidden dock.
export function sampleDockScroll(
  previous: DockScrollSample | undefined,
  top: number,
  extent: number,
  collapsed: boolean,
  held = false,
  wheelDirection?: DockScrollDirection,
): DockScrollSample {
  const position = Math.max(0, Math.min(Number.isFinite(top) ? top : 0, Math.max(0, Number.isFinite(extent) ? extent : 0)));
  const baseline = { ...initialDockScroll(position), collapsed: held ? false : collapsed };
  if (held || !previous || !Number.isFinite(extent) || extent < dockScrollMinExtent) return { travel: baseline, extent };
  const resized = Math.abs(previous.extent - extent) > 1;
  if (resized && !wheelDirection) return { travel: baseline, extent };
  // The first wheel can arrive while content still changes the extent. Start
  // from the previous position, accounting for any clamp imposed by the resize.
  const travel = resized && previous.travel.top > extent ? initialDockScroll(extent) : previous.travel;
  const delta = position - travel.top;
  if (wheelDirection && Math.abs(delta) > 1 && Math.sign(delta) !== wheelDirection) return { travel: baseline, extent };
  return { travel: advanceDockScroll({ ...travel, collapsed }, position, extent), extent };
}

// Actual travelled distance, rather than wheel intent, keeps short pages and
// overscroll inert. Ignore subpixel/one-pixel rounding and direction chatter.
export function advanceDockScroll(state: DockScrollState, top: number, extent: number, held = false): DockScrollState {
  const position = Math.max(0, Math.min(Number.isFinite(top) ? top : 0, Math.max(0, extent)));
  if (!Number.isFinite(extent) || extent < dockScrollMinExtent || held) return initialDockScroll(position);
  const delta = position - state.top;
  if (Math.abs(delta) <= 1) return state;
  if (position <= 12 && delta < 0) return initialDockScroll(position);
  const direction = delta > 0 ? 1 : -1;
  const distance = (direction === state.direction ? state.distance : 0) + Math.abs(delta);
  const collapsed = direction === -1 && distance >= 12 ? false : direction === 1 && distance >= 48 && position >= 64 ? true : state.collapsed;
  return { top: position, direction, distance, collapsed };
}

export type DockFoldBox = { left: number; top: number; width: number; height: number; radius: number };

export function dockSideWidth(count: number, item: number, gap: number, padding: number, available: number) {
  if (count === 0) return 0;
  const slots = Math.max(1, Math.floor((available - padding + gap) / (item + gap)));
  return Math.min(count, slots) * (item + gap) - gap + padding;
}

export function advanceDockFold(value: number, velocity: number, target: number, seconds: number, reduced = false) {
  if (reduced) return { value: target, velocity: 0 };
  const elapsed = Math.max(0, Math.min(0.064, seconds));
  const frequency = target === 1 ? 20 : 18;
  const offset = value - target;
  const carry = velocity + frequency * offset;
  const decay = Math.exp(-frequency * elapsed);
  const next = target + (offset + carry * elapsed) * decay;
  const speed = (velocity - frequency * carry * elapsed) * decay;
  if (Math.abs(next - target) < 0.0004 && Math.abs(speed) < 0.01) return { value: target, velocity: 0 };
  return next < 0 || next > 1 ? { value: Math.max(0, Math.min(1, next)), velocity: 0 } : { value: next, velocity: speed };
}

export function foldDockClip(original: DockFoldBox, folded: DockFoldBox) {
  const position = (value: number) => `${Math.round(value * 1000) / 1000}px`;
  return `inset(${position(folded.top - original.top)} ${position(original.left + original.width - folded.left - folded.width)} ${position(original.top + original.height - folded.top - folded.height)} ${position(folded.left - original.left)} round ${position(folded.radius)})`;
}

export function foldDockBox(box: DockFoldBox, target: DockFoldBox, progress: number): DockFoldBox {
  const p = Math.max(0, Math.min(1, progress));
  const mix = (from: number, to: number) => from + (to - from) * p;
  return {
    left: mix(box.left, target.left),
    top: mix(box.top, target.top),
    width: mix(box.width, target.width),
    height: mix(box.height, target.height),
    radius: mix(box.radius, target.radius),
  };
}
