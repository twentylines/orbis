import { createContext, useContext, useEffect, useLayoutEffect, useRef, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import { AnimatePresence, motion, useAnimationControls, usePresence } from 'framer-motion';
import { IconChevronDown, IconChevronUp, IconHistory, IconTrash } from '@tabler/icons-react';
import type { TimeMachinePoint } from '@runtipi/common/schemas/time-machine';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { DialogOpenContext } from '@/components/ui/Dialog/Dialog';
import { DepthTravel } from '@/components/recovery-progress/depth-travel';
import { useReducedMotion, useReducedTransparency } from '@/desktop/motion-preferences';
import { useWindowVisible } from '@/desktop/window-visibility';
import { chronologicalPoints, orderedPoints, visiblePointCards } from './contracts';
import { useHistoricalWallpaper } from './historical-home';
import { HistoricalHomePreview as HistoricalHome } from './historical-home-preview';
import { pointCardPose, pointMotionEnabled, pointMotionSeconds, pointPreviewAdmitted, timelineTarget } from './timeline-state';
import './time-machine.css';

export const pointDate = (point: Pick<TimeMachinePoint, 'createdAt'>) =>
  new Date(point.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const subscribeEffects = (change: () => void) => {
  const observer = new MutationObserver(change);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-orbis-effects'] });
  return () => observer.disconnect();
};
const lowEffectsSnapshot = () => document.documentElement.dataset.orbisEffects === 'low';
const serverLowEffects = () => false;
function usePointMotion() {
  const reduced = useReducedMotion();
  const lowEffects = useSyncExternalStore(subscribeEffects, lowEffectsSnapshot, serverLowEffects);
  return pointMotionEnabled(Boolean(reduced), lowEffects);
}
const compactQuery = '(max-width: 620px)';
const subscribeCompact = (change: () => void) => {
  const query = matchMedia(compactQuery);
  query.addEventListener('change', change);
  return () => query.removeEventListener('change', change);
};
const compactSnapshot = () => matchMedia(compactQuery).matches;
const serverCompact = () => false;

function TimelineGalaxy({ distance }: { distance: number }) {
  const open = useContext(DialogOpenContext);
  const visible = useWindowVisible();
  return <DepthTravel active={visible} distance={open ? distance : 0} variant="timeline" mode="ambient" className="tm-galaxy" />;
}

type StackScene = {
  selected: string | null;
  previousFront: string | null;
  selectedIndex: number;
  previousIndex: number;
  indices: Map<string, number>;
  exiting: Set<string>;
  opening: boolean;
  open: boolean;
  visible: boolean;
  moving: boolean;
  compact: boolean;
};
const StackSceneContext = createContext<StackScene | undefined>(undefined);
type PreviewAssets = { wallpaper?: string | null; assetFailed?: boolean; assetLoading?: boolean };
function HistoricalPointCard({ point, scene: initialScene, assets }: { point: TimeMachinePoint; scene: StackScene; assets: PreviewAssets }) {
  const scene = useContext(StackSceneContext) ?? initialScene;
  const [present, remove] = usePresence();
  const controls = useAnimationControls();
  const removeCurrent = useRef(remove);
  removeCurrent.current = remove;
  const retired = !present && !scene.exiting.has(point.id);
  const depth = (scene.indices.get(point.id) ?? scene.selectedIndex + 10) - scene.selectedIndex;
  const front = present && depth === 0;
  const previewAdmitted = pointPreviewAdmitted(point.id, scene.selected, scene.previousFront);
  const captured = useRef({ point, ...assets });
  const previousFront = useRef(front);
  if (front) {
    captured.current = { point, ...assets };
  }
  const keepExitingPreview = !present && !retired && previousFront.current;
  if (present) previousFront.current = front;
  const origin = useRef(
    scene.moving
      ? pointCardPose(
          scene.opening ? Math.max(0, depth) : (scene.indices.get(point.id) ?? 10) - scene.previousIndex,
          scene.opening ? 'folded' : 'spread',
          scene.compact,
        )
      : pointCardPose(depth, 'spread', scene.compact),
  );
  const firstMotion = useRef(true);
  useEffect(() => {
    if (present) return;
    // New input can interrupt travel; an exit's lifetime never restarts with it.
    const deadline = setTimeout(
      () => {
        controls.stop();
        controls.set({ opacity: 0 });
        removeCurrent.current?.();
      },
      pointMotionSeconds.travel * 1000 + 80,
    );
    return () => clearTimeout(deadline);
  }, [controls, present]);
  useLayoutEffect(() => {
    if (retired) {
      controls.set({ opacity: 0 });
      remove?.();
      return;
    }
    if (!scene.visible) {
      controls.stop();
      return;
    }
    const pose = pointCardPose(depth, scene.open ? 'spread' : 'folded', scene.compact);
    if (front) controls.set({ opacity: 1 });
    if (!scene.moving) {
      controls.set(pose);
      if (!present) remove?.();
      return;
    }
    let current = true;
    const duration = scene.open
      ? firstMotion.current && scene.opening
        ? pointMotionSeconds.unfold
        : pointMotionSeconds.travel
      : pointMotionSeconds.fold;
    const openingDelay = firstMotion.current && scene.opening && scene.open ? 0.08 : 0;
    firstMotion.current = false;
    void controls.start({ ...pose, transition: { duration, delay: openingDelay, ease: [0.22, 0.72, 0.18, 1] } }).then(() => {
      if (current && !present) remove?.();
    });
    return () => {
      current = false;
      controls.stop();
    };
  }, [controls, depth, front, present, remove, retired, scene.compact, scene.moving, scene.open, scene.opening, scene.visible]);
  const showPreview = front || keepExitingPreview;
  const preview = captured.current;
  return (
    <motion.article
      className="tm-home-layer"
      aria-hidden={!front}
      data-point-card={point.id}
      data-depth={Math.max(0, depth)}
      data-front={front || undefined}
      data-retired={retired || undefined}
      style={{ '--tm-depth': Math.max(0, depth), zIndex: 20 - depth, visibility: retired ? 'hidden' : undefined } as CSSProperties}
      initial={origin.current}
      animate={controls}
    >
      {front ? null : (
        <div className="tm-point-silhouette" aria-hidden="true">
          <span />
          <div />
          <div />
        </div>
      )}
      {retired || !previewAdmitted ? null : (
        <AnimatePresence initial={false}>
          {showPreview ? (
            <motion.div
              key={point.id}
              className="tm-point-preview"
              initial={{ opacity: 1 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: scene.moving && scene.visible ? 0.32 : 0 }}
            >
              <div className="tm-home-date">
                <time dateTime={new Date(preview.point.createdAt).toISOString()}>{pointDate(preview.point)}</time>
                <strong>{preview.point.metadata?.label || (preview.point.status === 'sealed' ? 'Saved point' : preview.point.status)}</strong>
              </div>
              <HistoricalHome
                point={preview.point}
                wallpaper={preview.wallpaper}
                assetFailed={preview.assetFailed}
                assetLoading={preview.assetLoading}
              />
            </motion.div>
          ) : null}
        </AnimatePresence>
      )}
    </motion.article>
  );
}

export function HistoricalPointStack({
  points,
  selected,
  wallpaper,
  assetFailed = false,
  assetLoading = false,
}: { points: readonly TimeMachinePoint[]; selected: string | null } & PreviewAssets) {
  // Dialog retains its last children on close; this live context starts their fold.
  const open = useContext(DialogOpenContext);
  const visible = useWindowVisible();
  const moving = usePointMotion();
  const compact = useSyncExternalStore(subscribeCompact, compactSnapshot, serverCompact);
  const ordered = orderedPoints(points);
  const cards = visiblePointCards(ordered, selected);
  const selectedIndex = ordered.findIndex((point) => point.id === selected);
  const previous = useRef({
    selected,
    previousFront: null as string | null,
    index: selectedIndex,
    cards: new Set(cards.map((point) => point.id)),
    exiting: new Set<string>(),
  });
  const mounted = useRef(false);
  const changed = selected !== previous.current.selected;
  const scene: StackScene = {
    selected,
    previousFront: changed ? previous.current.selected : previous.current.previousFront,
    selectedIndex,
    previousIndex: changed ? previous.current.index : selectedIndex,
    indices: new Map(ordered.map((point, index) => [point.id, index])),
    exiting: changed ? previous.current.cards : previous.current.exiting,
    opening: !mounted.current,
    open,
    visible,
    moving,
    compact,
  };
  useEffect(() => {
    mounted.current = true;
    previous.current = {
      selected,
      previousFront: scene.previousFront,
      index: selectedIndex,
      cards: new Set(cards.map((point) => point.id)),
      exiting: scene.exiting,
    };
  });
  return (
    <section className="tm-stage" aria-label="Captured Home previews" data-stack-state={open ? 'spread' : 'folded'}>
      <StackSceneContext.Provider value={scene}>
        <AnimatePresence>
          {cards.map((point) => (
            <HistoricalPointCard key={point.id} point={point} scene={scene} assets={{ wallpaper, assetFailed, assetLoading }} />
          ))}
        </AnimatePresence>
      </StackSceneContext.Provider>
      {points.length ? null : (
        <div className="tm-empty">
          <h2>No saved points</h2>
          <p>Capture this server to begin its timeline.</p>
        </div>
      )}
    </section>
  );
}

function revealRulerDate(ruler: HTMLElement, active: HTMLElement) {
  const viewport = ruler.getBoundingClientRect();
  const target = active.getBoundingClientRect();
  const inset = 8;
  if (target.top < viewport.top + inset) ruler.scrollTop += target.top - viewport.top - inset;
  else if (target.bottom > viewport.bottom - inset) ruler.scrollTop += target.bottom - viewport.bottom + inset;
  if (target.left < viewport.left + inset) ruler.scrollLeft += target.left - viewport.left - inset;
  else if (target.right > viewport.right - inset) ruler.scrollLeft += target.right - viewport.right + inset;
}

export function HistoricalDateRuler({
  points,
  selected,
  onSelect,
  dates,
}: {
  points: readonly TimeMachinePoint[];
  selected: string | null;
  onSelect: (id: string) => void;
  dates?: React.RefObject<HTMLElement | null>;
}) {
  const ruler = useRef<HTMLElement>(null);
  useEffect(() => {
    const element = ruler.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      const active = element.querySelector<HTMLElement>('[aria-current="date"]');
      if (active) revealRulerDate(element, active);
    });
    observer.observe(element);
    const list = element.querySelector('ol');
    if (list) observer.observe(list);
    return () => observer.disconnect();
  }, []);
  return (
    <nav
      ref={(element) => {
        ruler.current = element;
        if (dates) dates.current = element;
      }}
      className="tm-timeline"
      aria-label="Saved dates"
    >
      <ol>
        {chronologicalPoints(points).map((item) => (
          <li key={item.id}>
            <button
              type="button"
              data-point-id={item.id}
              aria-current={item.id === selected ? 'date' : undefined}
              tabIndex={item.id === selected ? 0 : -1}
              onClick={() => onSelect(item.id)}
            >
              <i className="tm-ruler-tick" aria-hidden="true" />
              <time dateTime={new Date(item.createdAt).toISOString()}>{pointDate(item)}</time>
              <span>{item.metadata?.label || item.status}</span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function TimeMachineJourney({
  open,
  onOpenChange,
  onClosed,
  points,
  selected,
  onSelect,
  onInspect,
  onRestore,
  onRemove,
  onCapture,
  session,
  busy,
  toolbar,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onClosed?: () => void;
  points: readonly TimeMachinePoint[];
  selected: string | null;
  onSelect: (id: string) => void;
  onInspect: () => void;
  onRestore?: () => void;
  onRemove: () => void;
  onCapture?: () => void;
  session: AbortSignal;
  busy: boolean;
  toolbar?: ReactNode;
}) {
  const visible = useWindowVisible();
  const moving = usePointMotion();
  const solid = useReducedTransparency();
  const dates = useRef<HTMLElement>(null);
  const ordered = orderedPoints(points);
  const point = ordered.find((item) => item.id === selected);
  const index = ordered.findIndex((item) => item.id === selected);
  const wallpaper = useHistoricalWallpaper(point, open && visible, session);
  const choose = (id: string | null, focus = false) => {
    if (!id) return;
    if (id !== selected) onSelect(id);
    if (focus) dates.current?.querySelector<HTMLButtonElement>(`[data-point-id="${id}"]`)?.focus({ preventScroll: true });
  };
  const move = (older: boolean) => choose(timelineTarget(ordered, selected, older ? 'ArrowUp' : 'ArrowDown'));
  useEffect(() => {
    if (!open || !visible) return;
    const active = dates.current?.querySelector<HTMLButtonElement>(`[data-point-id="${selected}"]`);
    if (dates.current && active) revealRulerDate(dates.current, active);
  }, [open, selected, visible]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        presentation="scene"
        className="tm-journey"
        style={
          {
            '--tm-scene-open-duration': `${pointMotionSeconds.unfold}s`,
            '--tm-scene-close-duration': `${pointMotionSeconds.sceneExit}s`,
          } as CSSProperties
        }
        data-motion={visible && moving}
        data-solid={solid || undefined}
        onOpenAutoFocus={() => {
          const latest = ordered[0];
          if (latest && latest.id !== selected) onSelect(latest.id);
        }}
        onCloseAutoFocus={() => {
          const latest = ordered[0];
          if (latest && latest.id !== selected) onSelect(latest.id);
          if (!open) onClosed?.();
        }}
        aria-describedby="tm-journey-description"
        onKeyDown={(event) => {
          if (
            event.defaultPrevented ||
            event.altKey ||
            event.metaKey ||
            event.ctrlKey ||
            (event.target instanceof Element && event.target.closest('input,textarea,select,[role="combobox"],[role="listbox"]'))
          )
            return;
          if (['ArrowUp', 'ArrowLeft', 'PageUp', 'ArrowDown', 'ArrowRight', 'PageDown', 'Home', 'End'].includes(event.key)) {
            event.preventDefault();
            choose(timelineTarget(ordered, selected, event.key), true);
          }
        }}
      >
        <TimelineGalaxy distance={Math.max(0, index) + 1} />
        <div className="tm-nebula" aria-hidden="true" />
        <DialogHeader className="tm-journey-heading">
          <DialogTitle>
            <span className="tm-heading-content">
              <IconHistory size="1em" aria-hidden="true" />
              Time Machine
            </span>
          </DialogTitle>
        </DialogHeader>
        <DialogDescription className="visually-hidden" id="tm-journey-description">
          Saved Home projections. Browsing changes no server data. Use older and newer controls or the dated timeline to choose a point.
        </DialogDescription>
        {toolbar || onCapture ? (
          <div className="tm-journey-toolbar">
            {toolbar}
            {onCapture ? (
              <Button variant="outline" onClick={onCapture} disabled={busy}>
                Capture
              </Button>
            ) : null}
          </div>
        ) : null}
        <div className="tm-journey-layout">
          <HistoricalPointStack
            points={ordered}
            selected={selected}
            wallpaper={wallpaper.url}
            assetFailed={wallpaper.failed}
            assetLoading={wallpaper.loading}
          />
          <HistoricalDateRuler points={ordered} selected={selected} onSelect={onSelect} dates={dates} />
        </div>
        <div className="tm-controls">
          <div className="tm-travel-buttons">
            <Button
              variant="outline"
              className="btn-icon"
              onClick={() => move(true)}
              disabled={index < 0 || index >= ordered.length - 1}
              aria-label="Older point"
            >
              <IconChevronUp size={20} aria-hidden="true" />
            </Button>
            <Button variant="outline" className="btn-icon" onClick={() => move(false)} disabled={index <= 0} aria-label="Newer point">
              <IconChevronDown size={20} aria-hidden="true" />
            </Button>
          </div>
          <output className="tm-selected-date" aria-live="polite">
            <span>{point ? pointDate(point) : 'No saved point selected'}</span>
            <span className="tm-keyboard-hint" aria-hidden="true">
              <kbd>↑</kbd> Older <kbd>↓</kbd> Newer
            </span>
          </output>
          <div className="tm-point-actions">
            <Button variant="outline" disabled={!point || busy || (Boolean(onRestore) && point.status !== 'sealed')} onClick={onRestore ?? onInspect}>
              {onRestore ? 'Restore' : 'Details'}
            </Button>
            <Button variant="outline" disabled={!point || busy || point.status === 'capturing'} onClick={onRemove}>
              <IconTrash size={18} className="tm-trash" aria-hidden="true" />
              Remove
            </Button>
          </div>
        </div>
        {wallpaper.failed ? (
          <div className="tm-asset-retry">
            <span>Captured wallpaper is unavailable.</span>
            <Button variant="outline" onClick={wallpaper.retry}>
              Retry
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
