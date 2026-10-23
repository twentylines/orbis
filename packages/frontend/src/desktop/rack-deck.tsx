import { useReducedMotion } from '@/desktop/motion-preferences';
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { motion, useMotionValue, useSpring } from 'framer-motion';
import { IconCheck, IconLayersLinked, IconServer } from '@tabler/icons-react';
import type { ClusterServer, ServerReading } from './cluster';

type RackItem = { id: string; name: string; server?: ClusterServer };
const spring = { type: 'spring' as const, stiffness: 270, damping: 30, mass: 0.85 };
const percent = (value: number | null | undefined) => (typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(1)}%` : '—');
const width = (value: number | null | undefined) => `${Math.max(0, Math.min(100, value ?? 0))}%`;

function Meter({ name, value }: { name: string; value: number | null | undefined }) {
  return (
    <span>
      <span>{name}</span>
      <b>{percent(value)}</b>
      <i aria-hidden="true">
        <span style={{ width: width(value) }} />
      </i>
    </span>
  );
}

function Machine({ children }: { children: ReactNode }) {
  return (
    <>
      <span className="cluster-module-top" aria-hidden="true" />
      <span className="cluster-module-side" aria-hidden="true" />
      <span className="cluster-module-left" aria-hidden="true" />
      <span className="cluster-module-bottom" aria-hidden="true" />
      <span className="cluster-module-front">{children}</span>
    </>
  );
}

export function RackDeck({
  servers,
  localName,
  selectedId,
  readings,
  onSelect,
  showMerged = false,
  entrance = false,
  standalone = false,
  onEngagedChange,
}: {
  servers: ClusterServer[];
  localName: string;
  selectedId: string;
  readings?: Partial<Record<string, ServerReading>>;
  onSelect: (id: string) => void;
  showMerged?: boolean;
  entrance?: boolean;
  standalone?: boolean;
  onEngagedChange?: (engaged: boolean) => void;
}) {
  const items: RackItem[] = servers.map((server) => ({ id: server.id, name: server.local ? localName : server.name, server }));
  if (showMerged && servers.length > 1) items.push({ id: 'all', name: 'All servers' });
  const [previewId, setPreviewId] = useState(selectedId);
  const [hovered, setHovered] = useState(false);
  const [keyboard, setKeyboard] = useState(false);
  const [size, setSize] = useState(360);
  const stage = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ pointer: number; x: number; y: number; dx: number; dragging: boolean } | null>(null);
  const suppressClick = useRef(false);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reduceMotion = useReducedMotion();
  const drag = useMotionValue(0);
  const dragSpring = useSpring(drag, spring);
  const id = useId();
  const selectedIndex = items.findIndex((item) => item.id === selectedId);
  const activeIndex = Math.max(
    0,
    items.findIndex((item) => item.id === previewId),
  );
  const active = items[activeIndex];
  const engaged = entrance || hovered || keyboard;
  const cardWidth = Math.min(272, Math.max(0, size - 48));
  const room = Math.max(0, (size - cardWidth) / 2 - 12);
  const step = engaged ? Math.min(112, Math.max(32, room * 0.85)) : Math.min(30, Math.max(16, room * 0.3));

  useLayoutEffect(() => setPreviewId(selectedId), [selectedId]);
  useLayoutEffect(() => {
    const element = stage.current;
    if (!element) return;
    const measure = () => {
      if (element.clientWidth) setSize(element.clientWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    onEngagedChange?.(engaged);
  }, [engaged, onEngagedChange]);
  useEffect(
    () => () => {
      if (clickTimer.current) clearTimeout(clickTimer.current);
    },
    [],
  );

  const browse = (index: number) => {
    const next = items[Math.max(0, Math.min(items.length - 1, index))];
    if (next) setPreviewId(next.id);
  };
  const choose = (item: RackItem) => {
    setPreviewId(item.id);
    onSelect(item.id);
    stage.current?.focus({ preventScroll: true });
  };
  const release = (cancelled = false) => {
    const current = gesture.current;
    gesture.current = null;
    drag.set(0);
    if (!current?.dragging) return;
    suppressClick.current = true;
    if (clickTimer.current) clearTimeout(clickTimer.current);
    clickTimer.current = setTimeout(() => {
      suppressClick.current = false;
    }, 180);
    if (!cancelled && Math.abs(current.dx) >= 36) browse(activeIndex + (current.dx < 0 ? 1 : -1));
  };
  return (
    <div className="cluster-deck">
      <div
        ref={stage}
        className="cluster-rack-stage"
        role="listbox"
        aria-label="Server rack"
        aria-roledescription="3D server rack"
        aria-activedescendant={active ? `${id}-${active.id}` : undefined}
        aria-describedby={`${id}-help`}
        tabIndex={items.length ? 0 : -1}
        data-engaged={engaged || undefined}
        data-wide={size >= 360 || undefined}
        data-count={items.length}
        data-active-id={active?.id}
        onPointerEnter={(event) => {
          if (event.pointerType === 'mouse') setHovered(true);
        }}
        onPointerLeave={() => setHovered(false)}
        onFocus={(event) => {
          if (event.target === event.currentTarget && event.currentTarget.matches(':focus-visible')) setKeyboard(true);
        }}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setKeyboard(false);
        }}
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' '].includes(event.key)) return;
          event.preventDefault();
          setKeyboard(true);
          if (event.key === 'ArrowLeft') browse(activeIndex - 1);
          else if (event.key === 'ArrowRight') browse(activeIndex + 1);
          else if (event.key === 'Home') browse(0);
          else if (event.key === 'End') browse(items.length - 1);
          else if (active) choose(active);
        }}
        onPointerDown={(event) => {
          if (!event.isPrimary || event.button !== 0 || items.length < 2) return;
          gesture.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, dx: 0, dragging: false };
        }}
        onPointerMove={(event) => {
          const current = gesture.current;
          if (!current || current.pointer !== event.pointerId) return;
          const dx = event.clientX - current.x;
          const dy = event.clientY - current.y;
          if (!current.dragging && Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.2) {
            current.dragging = true;
            event.currentTarget.setPointerCapture(event.pointerId);
          }
          if (current.dragging) {
            current.dx = dx;
            drag.set(Math.max(-65, Math.min(65, dx * 0.28)));
          }
        }}
        onPointerUp={(event) => {
          if (gesture.current?.pointer === event.pointerId) release();
        }}
        onPointerCancel={(event) => {
          if (gesture.current?.pointer === event.pointerId) release(true);
        }}
        onLostPointerCapture={(event) => {
          if (event.target === event.currentTarget && gesture.current?.pointer === event.pointerId) release(true);
        }}
        onClickCapture={(event) => {
          if (suppressClick.current) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
      >
        <span className="cluster-rack-shadow" aria-hidden="true" />
        <motion.div className="cluster-deck-track" style={{ x: reduceMotion ? drag : dragSpring }}>
          {items.map((item, index) => {
            const offset = index - activeIndex;
            const distance = Math.abs(offset);
            const visible = distance <= 1;
            const selected = selectedIndex === index;
            const reading = readings?.[item.id];
            let address = item.server?.local ? 'This server' : '';
            try {
              if (item.server && !item.server.local) address = new URL(item.server.url).host;
            } catch {
              address = 'Address unavailable';
            }
            const pose = {
              x: Math.max(-3, Math.min(3, offset)) * step,
              y: size >= 360 && engaged ? (distance ? -56 : 16) : distance ? -5 : 0,
              scale: 1 - Math.min(distance, 3) * (engaged ? 0.065 : 0.035),
              opacity: visible ? 1 : 0,
            };
            return (
              <motion.div
                key={item.id}
                className="cluster-deck-slot"
                data-rack-id={item.id}
                data-front={offset === 0 || undefined}
                data-side={offset < 0 ? 'before' : offset > 0 ? 'after' : undefined}
                aria-hidden={!visible || undefined}
                initial={entrance && !reduceMotion ? { ...pose, x: offset * 18, y: 16, scale: pose.scale * 0.96 } : false}
                animate={pose}
                transition={reduceMotion ? { duration: 0 } : spring}
                style={{
                  zIndex: items.length - distance,
                  display: visible ? 'flex' : 'none',
                  pointerEvents: 'none',
                }}
              >
                <motion.button
                  type="button"
                  className="cluster-module"
                  id={`${id}-${item.id}`}
                  role="option"
                  data-merged={!item.server || undefined}
                  aria-selected={selected}
                  aria-posinset={index + 1}
                  aria-setsize={items.length}
                  tabIndex={-1}
                  initial={false}
                  animate={{ rotateY: offset === 0 ? -14 : Math.sign(offset) * (engaged ? -34 : -18), rotateX: -7 }}
                  transition={reduceMotion ? { duration: 0 } : spring}
                  style={{ pointerEvents: visible && (size >= 360 || offset === 0) ? 'auto' : 'none' }}
                  aria-label={`${item.name}${item.server ? `, ${standalone ? 'local server' : item.server.role === 'admin' ? 'admin server' : 'paired server'}` : ', merged apps and status'}${selected ? ', selected' : ''}`}
                  onClick={() => choose(item)}
                >
                  <Machine>
                    <span className="cluster-module-heading">
                      {item.server ? <IconServer size={20} aria-hidden="true" /> : <IconLayersLinked size={20} aria-hidden="true" />}
                      <span title={item.name}>{item.name}</span>
                      {selected ? <IconCheck size={17} aria-hidden="true" /> : null}
                    </span>
                    <span className="cluster-module-address" title={address}>
                      {item.server ? address : `${servers.length} paired servers`}
                    </span>
                    <span className="cluster-module-meters">
                      {item.server ? (
                        <>
                          <Meter name="CPU" value={reading?.cpu} />
                          <Meter name="Memory" value={reading?.memory} />
                        </>
                      ) : (
                        <>
                          <span>
                            <span>Servers</span>
                            <b>{servers.length}</b>
                          </span>
                          <span>
                            <span>View</span>
                            <b>Merged</b>
                          </span>
                        </>
                      )}
                    </span>
                    <span className="cluster-module-footer">
                      <span>
                        {item.server
                          ? standalone
                            ? 'Local server'
                            : item.server.role === 'admin'
                              ? 'Admin server'
                              : 'Member server'
                          : 'Apps and updates'}
                      </span>
                      {reading?.online === false ? <span>Offline</span> : item.server?.local && !standalone ? <span>Local</span> : null}
                    </span>
                  </Machine>
                </motion.button>
              </motion.div>
            );
          })}
        </motion.div>
      </div>
      {items.length > 1 ? (
        <p id={`${id}-help`} className="cluster-deck-help">
          <span>Drag or swipe to browse</span>
          <span aria-hidden="true">
            {activeIndex + 1} / {items.length}
          </span>
          <span className="visually-hidden">Left and right arrows browse servers. Enter selects the displayed server.</span>
        </p>
      ) : (
        <span id={`${id}-help`} className="visually-hidden">
          Local server.
        </span>
      )}
    </div>
  );
}
