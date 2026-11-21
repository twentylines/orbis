import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import {
  dockCollapseForMonitorChart,
  dockScrollMinExtent,
  dockScrollNearEnd,
  dockScrollProgress,
  dockScrollRoute,
  sampleDockScroll,
  type DockScrollDirection,
  type DockScrollSample,
} from './dock-scroll-state';
import { useDesktopWindows } from './window-viewport';
import { prefersReducedMotion } from './motion-setting';

const scrollSettleDelay = 160;
const scrollTopDistance = 64;
const isPastPaneStart = (pane: Element) => pane.scrollTop > 1;

export function useDockScroll(dock: RefObject<HTMLElement | null>, route: string, enabled: boolean) {
  const [collapsed, setCollapsed] = useState(false);
  const [canScrollToTop, setCanScrollToTop] = useState(false);
  const expand = useRef(() => setCollapsed(false));
  const scrollToTop = useRef<(() => void) | null>(null);
  const pointerTarget = useRef<Element | null>(null);
  const monitorDestination = useRef<string | null>(null);
  const scrollRoute = dockScrollRoute(route, useDesktopWindows());

  useLayoutEffect(() => {
    const nav = dock.current;
    if (!enabled || !nav) return;
    // Pointer activation may leave the route link focused after navigation.
    // Track it across routes so that focus does not prevent the first scroll.
    const notePointer = (event: PointerEvent) => {
      if (event.target instanceof Element) pointerTarget.current = event.target;
    };
    const noteKeyboard = () => {
      pointerTarget.current = null;
    };
    nav.addEventListener('pointerdown', notePointer, true);
    document.addEventListener('keydown', noteKeyboard, true);
    return () => {
      nav.removeEventListener('pointerdown', notePointer, true);
      document.removeEventListener('keydown', noteKeyboard, true);
      pointerTarget.current = null;
    };
  }, [dock, enabled]);

  useLayoutEffect(() => {
    const nav = dock.current;
    const content = document.getElementById('desktop-content');
    if (!enabled || !scrollRoute || !nav || !content) {
      monitorDestination.current = null;
      return;
    }
    let chartEntry = monitorDestination.current === scrollRoute;
    let manualChartScroll = false;
    monitorDestination.current = null;
    const states = new Map<Element, DockScrollSample>();
    const pending = new Set<Element>();
    const scrolling = document.scrollingElement ?? document.documentElement;
    let activeSource: Element | null = null;
    let focusedSource: Element | null = null;
    // Intentional input selects a pane; passive layout clamps do not.
    let selectedPane: Element | null = null;
    let coveredRail: Element | null = null;
    let pointerInside = false;
    let hidden = false;
    let frame = 0;
    let settleTimer: number | undefined;
    let settledSource: Element | null = null;
    let wheel: { target: Element; direction: DockScrollDirection; time: number } | undefined;
    let sizes: ResizeObserver | undefined;
    const openControl = () => nav.querySelector('[data-state="open"], [aria-expanded="true"]:not(.desktop-dock-reveal)');
    const held = () => {
      const active = document.activeElement;
      const focused =
        active?.matches(':focus-visible') &&
        nav.contains(active) &&
        !active.matches('.desktop-dock-scroll-top') &&
        !active.contains(pointerTarget.current);
      return pointerInside || focused || Boolean(openControl());
    };
    const commit = (next: boolean) => {
      if (next === hidden) return;
      if (!next) chartEntry = false;
      hidden = next;
      setCollapsed(next);
    };
    const scrollSurface = (element: Element) =>
      element === scrolling ||
      (element instanceof HTMLElement &&
        !element.closest('[hidden], [inert]') &&
        /^(auto|scroll|overlay)$/.test(getComputedStyle(element).overflowY));
    const scrollable = (element: Element) =>
      element.clientHeight > 0 && element.scrollHeight - element.clientHeight >= dockScrollMinExtent && scrollSurface(element);
    const syncScrollTop = (immediate = false) => {
      window.clearTimeout(settleTimer);
      const source = activeSource;
      const pastStart = source && (source === selectedPane ? isPastPaneStart(source) : source.scrollTop >= scrollTopDistance);
      if (!hidden || !source?.isConnected || !scrollable(source) || !pastStart) {
        settledSource = null;
        setCanScrollToTop(false);
        return;
      }
      if (settledSource === source) return;
      if (immediate || dockScrollNearEnd(source.scrollTop, source.scrollHeight - source.clientHeight, source.clientHeight)) {
        settledSource = source;
        setCanScrollToTop(true);
        return;
      }
      settledSource = null;
      setCanScrollToTop(false);
      settleTimer = window.setTimeout(() => {
        settledSource = source;
        setCanScrollToTop(true);
      }, scrollSettleDelay);
    };
    scrollToTop.current = () => {
      if (!hidden || settledSource !== activeSource || !settledSource?.isConnected || !scrollable(settledSource)) return;
      // An explicit Go up also leaves chart-entry mode, which ignores automatic chart alignment.
      chartEntry = false;
      manualChartScroll = false;
      monitorDestination.current = null;
      wheel = undefined;
      settledSource.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'instant' : 'smooth' });
    };
    // Update the button without rendering the dashboard on every scroll frame.
    const syncProgress = (immediate = false) => {
      const source = activeSource;
      const progress =
        source?.isConnected && scrollable(source) ? dockScrollProgress(source.scrollTop, source.scrollHeight - source.clientHeight) : null;
      const rail = hidden && progress !== null ? source : null;
      if (coveredRail !== rail) {
        coveredRail?.removeAttribute('data-dock-scroll-ring');
        rail?.setAttribute('data-dock-scroll-ring', '');
        coveredRail = rail;
      }
      nav.toggleAttribute('data-scroll-progress', progress !== null);
      nav.style.setProperty('--orbis-dock-scroll-remaining', String(1 - (progress ?? 0)));
      syncScrollTop(immediate);
    };
    const register = (element: Element) => {
      if (states.has(element) || !scrollSurface(element)) return;
      // An empty catalogue can fill without resizing its scroll viewport.
      states.set(element, sampleDockScroll(undefined, element.scrollTop, element.scrollHeight - element.clientHeight, hidden));
      sizes?.observe(element);
    };
    const registerTree = (element: Element) => {
      register(element);
      for (const child of element.querySelectorAll('*')) register(child);
    };
    const splitPaneFor = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return null;
      const pane = target.closest('.store-catalogue-pane, .store-preview-content');
      return pane?.closest('.store-split-desktop[data-preview-open="true"]') && content.contains(pane) && scrollSurface(pane) ? pane : null;
    };
    const selectPane = (target: EventTarget | null) => {
      const pane = splitPaneFor(target);
      if (!pane) return false;
      selectedPane = pane;
      activeSource = pane;
      const next = scrollable(pane) && isPastPaneStart(pane);
      states.set(pane, sampleDockScroll(undefined, pane.scrollTop, pane.scrollHeight - pane.clientHeight, next));
      commit(next);
      syncProgress(true);
      return true;
    };
    const reset = (next = false) => {
      hidden = next;
      setCollapsed(next);
      pending.clear();
      states.clear();
      sizes?.disconnect();
      sizes?.observe(content);
      register(scrolling);
      registerTree(content);
      syncProgress();
    };
    const refresh = () => {
      if (selectedPane && !splitPaneFor(selectedPane)) {
        if (activeSource === selectedPane && !scrollable(selectedPane)) activeSource = null;
        selectedPane = null;
      }
      for (const [element, previous] of states) {
        if (element.isConnected) {
          const extent = element.scrollHeight - element.clientHeight;
          // Leave a moving position to the scroll frame, which can tell
          // whether the browser is applying input or just clamping layout.
          if (Math.abs(extent - previous.extent) > 1 && Math.abs(element.scrollTop - previous.travel.top) <= 1) {
            states.set(element, { ...previous, extent });
          }
        } else {
          states.delete(element);
          sizes?.unobserve(element);
        }
      }
      register(scrolling);
      register(content);
      if (hidden && !chartEntry && ![...states.keys()].some(scrollable)) reset();
      else syncProgress();
    };
    const reveal = () => {
      chartEntry = false;
      manualChartScroll = false;
      monitorDestination.current = null;
      reset();
    };
    expand.current = reveal;
    reset(chartEntry);
    sizes = new ResizeObserver(refresh);
    sizes.observe(content);
    for (const element of states.keys()) sizes.observe(element);
    const noteWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.shiftKey || Math.abs(event.deltaY) <= Math.abs(event.deltaX) || !(event.target instanceof Element)) return;
      focusedSource = null;
      selectPane(event.target);
      wheel = { target: event.target, direction: event.deltaY > 0 ? 1 : -1, time: event.timeStamp };
      if (chartEntry && wheel.direction === -1 && content.contains(wheel.target)) reveal();
    };
    const clearWheel = () => {
      wheel = undefined;
    };
    const receive = (event: Event) => {
      const target = event.target === document ? scrolling : event.target;
      if (!(target instanceof Element) || (target !== scrolling && !content.contains(target))) return;
      if (!scrollable(target)) {
        if (target === activeSource) refresh();
        return;
      }
      pending.add(target);
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        // Correlate native scrolling with the latest wheel event. The browser
        // has no portable wheel momentum phase and can deliver scroll a frame
        // or two later. A later wheel in either direction takes over immediately.
        const input = wheel && performance.now() - wheel.time <= 120 ? wheel : undefined;
        const engaged = held();
        let nextHidden = hidden;
        let descending = false;
        let movedSource: Element | null = null;
        for (const source of pending) {
          if (!source.isConnected) {
            states.delete(source);
            continue;
          }
          const previous = states.get(source);
          // A split pane can restore or clamp its position during a gesture in
          // its sibling. Update its baseline without borrowing that gesture.
          const matchesInput = scrollable(source) && (!input || source.contains(input.target));
          const matchesSelection = !selectedPane || source === selectedPane;
          const relevant = (!chartEntry || manualChartScroll) && matchesInput && matchesSelection;
          const extent = source.scrollHeight - source.clientHeight;
          const moved = !previous || Math.abs(source.scrollTop - previous.travel.top) > 1;
          // Layout clamps and a previously focused pane's remaining scroll must not claim the ring.
          const matchesFocus = !focusedSource?.isConnected || !scrollable(focusedSource) || source.contains(focusedSource);
          const stable = !previous || Math.abs(extent - previous.extent) <= 1;
          if (
            matchesInput &&
            matchesSelection &&
            matchesFocus &&
            moved &&
            (stable || input || source === activeSource || chartEntry) &&
            (!movedSource || movedSource.contains(source))
          ) {
            movedSource = source;
          }
          const next = sampleDockScroll(relevant ? previous : undefined, source.scrollTop, extent, hidden, engaged && !chartEntry, input?.direction);
          states.set(source, next);
          if (next.travel.collapsed !== hidden) nextHidden = next.travel.collapsed;
          if (relevant && previous && next.travel.direction === 1 && next.travel.top - previous.travel.top > 1) descending = true;
        }
        pending.clear();
        if (movedSource) activeSource = movedSource;
        commit(!engaged && hidden && descending ? true : nextHidden);
        syncProgress();
      });
    };
    const hover = (event: PointerEvent) => {
      // A boundary event can be produced by the folding hit area moving
      // underneath a stationary pointer. Only pointer movement reveals it.
      if (event.pointerType === 'touch' || !(event.target instanceof Element)) return;
      if (!event.target.closest('.desktop-dock-main, .desktop-dock-reveal, .orbis-app-tray, .desktop-activity-trigger')) {
        pointerInside = false;
        return;
      }
      if (pointerInside) return;
      pointerInside = true;
      reveal();
    };
    const leave = () => {
      pointerInside = false;
    };
    const focus = (event: FocusEvent) => {
      if (event.target instanceof Element && event.target.closest('.desktop-dock-main')) reveal();
    };
    const focusScrollSurface = (event: Event) => {
      focusedSource = null;
      if (!(event.target instanceof Element) || !content.contains(event.target)) return;
      if (selectPane(event.target) || selectedPane) return;
      for (let node: Element | null = event.target; node; node = node.parentElement) {
        if ((node !== scrolling && !content.contains(node)) || !scrollable(node)) continue;
        focusedSource = node;
        activeSource = node;
        syncProgress();
        return;
      }
    };
    const collapseForChart = (event: Event) => {
      if (!/^\/monitor(?:[/?]|$)/.test(scrollRoute)) return;
      monitorDestination.current = (event as CustomEvent<string>).detail;
      chartEntry = true;
      manualChartScroll = false;
      activeSource = null;
      focusedSource = null;
      reset(true);
    };
    // Chart alignment is programmatic. Subsequent pointer/keyboard gestures
    // can establish a new scroll baseline on this same destination.
    const manualScroll = (event: Event) => {
      clearWheel();
      if (event instanceof PointerEvent && event.target instanceof Node && content.contains(event.target)) {
        focusedSource = null;
        selectPane(event.target);
      }
      if (event instanceof KeyboardEvent && event.target instanceof Element && !selectedPane) focusScrollSurface(event);
      if (!chartEntry || !(event.target instanceof Element) || !content.contains(event.target)) return;
      if (event instanceof KeyboardEvent && !['ArrowUp', 'PageUp', 'Home'].includes(event.key)) return;
      if (event instanceof PointerEvent && event.pointerType !== 'touch' && event.target !== scrolling && !states.has(event.target)) return;
      manualChartScroll = true;
    };
    const activatePane = (event: MouseEvent) => {
      // Keyboard and assistive-technology clicks can arrive without a pointerdown.
      if (event.detail === 0) selectPane(event.target);
    };
    // Pane creation gets a baseline without changing visibility. In particular,
    // Store's selected app can mount/resize beside an already scrolled catalogue.
    const changes = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) if (node instanceof Element) registerTree(node);
        for (let node = record.target instanceof Element ? record.target : null; node && content.contains(node); node = node.parentElement)
          register(node);
      }
      refresh();
    });
    changes.observe(content, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'inert'] });
    document.addEventListener('focusin', focusScrollSurface);
    document.addEventListener('click', activatePane, true);
    document.addEventListener('scroll', receive, { capture: true, passive: true });
    document.addEventListener('wheel', noteWheel, { capture: true, passive: true });
    document.addEventListener('pointerdown', manualScroll, true);
    document.addEventListener('keydown', manualScroll, true);
    nav.addEventListener('pointermove', hover);
    nav.addEventListener('pointerleave', leave);
    nav.addEventListener('focusin', focus);
    window.addEventListener('resize', reveal);
    window.addEventListener(dockCollapseForMonitorChart, collapseForChart);
    return () => {
      window.clearTimeout(settleTimer);
      cancelAnimationFrame(frame);
      sizes?.disconnect();
      changes.disconnect();
      coveredRail?.removeAttribute('data-dock-scroll-ring');
      nav.removeAttribute('data-scroll-progress');
      nav.style.removeProperty('--orbis-dock-scroll-remaining');
      document.removeEventListener('focusin', focusScrollSurface);
      document.removeEventListener('click', activatePane, true);
      document.removeEventListener('scroll', receive, true);
      document.removeEventListener('wheel', noteWheel, true);
      document.removeEventListener('pointerdown', manualScroll, true);
      document.removeEventListener('keydown', manualScroll, true);
      nav.removeEventListener('pointermove', hover);
      nav.removeEventListener('pointerleave', leave);
      nav.removeEventListener('focusin', focus);
      window.removeEventListener('resize', reveal);
      window.removeEventListener(dockCollapseForMonitorChart, collapseForChart);
      expand.current = () => setCollapsed(false);
      scrollToTop.current = null;
    };
  }, [dock, scrollRoute, enabled]);

  const isCollapsed = enabled && Boolean(scrollRoute) && collapsed;
  return {
    collapsed: isCollapsed,
    canScrollToTop: isCollapsed && canScrollToTop,
    expand: () => expand.current(),
    scrollToTop: () => scrollToTop.current?.(),
  };
}
