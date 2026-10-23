/* biome-ignore-all lint/a11y/noNoninteractiveTabindex: The bounded activity list needs native keyboard scrolling. */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import * as Dialog from '@radix-ui/react-dialog';
import { IconApps, IconChevronDown, IconChevronUp, IconPackage, IconServerCog } from '@tabler/icons-react';
import { Link } from 'react-router';
import { AppLogo } from '@/components/app-logo/app-logo';
import { useAppContext } from '@/context/app-context';
import { useReducedMotion } from './motion-preferences';
import { useHostUpdateWatch } from './host-update-watch';
import { useTasks } from './tasks';
import { useDesktopWindows } from './window-viewport';
import { desktopActivity, type DesktopActivityItem } from './desktop-activity-state';
import { DockCompanion } from './dock-companion';
import './desktop-activity.css';

function focusDock() {
  const target =
    document.querySelector<HTMLElement>('.desktop-dock-item[aria-current="page"]') ?? document.querySelector<HTMLElement>('.desktop-dock-item');
  target?.focus({ preventScroll: true });
}

function ActivityIcon({ kind, appUrn }: Pick<DesktopActivityItem, 'kind' | 'appUrn'>) {
  if (kind === 'app' && appUrn) return <AppLogo urn={appUrn} size={28} alt="" />;
  const Icon = kind === 'core' ? IconServerCog : kind === 'packages' ? IconPackage : IconApps;
  return <Icon size={22} stroke={1.7} aria-hidden="true" />;
}

export function DockActivity() {
  const { apps } = useAppContext();
  const tasks = useTasks();
  const { watch, packageJob } = useHostUpdateWatch();
  const reduced = useReducedMotion();
  const desktop = useDesktopWindows();
  const names = useMemo(() => new Map(apps.map((app) => [app.urn, app.name])), [apps]);
  const activity = desktopActivity(tasks.data?.tasks ?? [], names, watch, packageJob);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const focusWithin = useRef(false);
  const [shape, setShape] = useState({ width: 360, height: 280, triggerWidth: 210, triggerHeight: 68 });
  const hasActivity = Boolean(activity) && desktop;
  const lastActivity = useRef(activity);
  if (activity) lastActivity.current = activity;
  const displayed = activity ?? lastActivity.current;
  useEffect(() => {
    if (hasActivity) return;
    setOpen(false);
    if (focusWithin.current) {
      focusDock();
      focusWithin.current = false;
    }
  }, [hasActivity]);
  useLayoutEffect(() => {
    if (!open || !trigger.current || !panel.current) return;
    const measure = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      const content = panel.current;
      if (!anchor || !content) return;
      setShape({
        width: Math.min(400, window.innerWidth - 32),
        height: Math.ceil(content.getBoundingClientRect().height) + 2,
        triggerWidth: anchor.width,
        triggerHeight: anchor.height,
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(panel.current);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [open]);
  const transition = reduced ? { duration: 0 } : { type: 'spring' as const, stiffness: 330, damping: 34, mass: 0.8 };
  return (
    <DockCompanion visible={hasActivity} side="left">
      {displayed ? (
        <div
          className="desktop-activity"
          key="desktop-activity"
          onFocusCapture={() => {
            focusWithin.current = true;
          }}
          onBlurCapture={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) focusWithin.current = false;
          }}
        >
          <Dialog.Root
            open={open && hasActivity}
            onOpenChange={(next) => {
              if (next) {
                const anchor = trigger.current?.getBoundingClientRect();
                if (anchor) setShape((previous) => ({ ...previous, triggerWidth: anchor.width, triggerHeight: anchor.height }));
              }
              setOpen(next);
            }}
            modal={false}
          >
            <Dialog.Trigger asChild>
              <button
                ref={trigger}
                type="button"
                className="desktop-activity-trigger"
                aria-label={`${displayed.title}. Open activity details.`}
                title={displayed.title}
              >
                <span className="desktop-activity-icon">
                  <ActivityIcon kind={displayed.kind} appUrn={displayed.appUrn} />
                </span>
                <span className="desktop-activity-summary">
                  <strong>{displayed.kind === 'packages' ? 'System updates' : displayed.title}</strong>
                  <small>{displayed.detail}</small>
                </span>
                <IconChevronUp size={16} aria-hidden="true" />
              </button>
            </Dialog.Trigger>
            <AnimatePresence>
              {open ? (
                <Dialog.Content
                  asChild
                  forceMount
                  onCloseAutoFocus={(event) => {
                    if (!trigger.current?.isConnected || trigger.current.getClientRects().length === 0) {
                      event.preventDefault();
                      focusDock();
                    }
                  }}
                >
                  <motion.section
                    className="desktop-activity-flyover"
                    initial={{ width: shape.triggerWidth, height: shape.triggerHeight, y: shape.triggerHeight + 12, borderRadius: 24 }}
                    animate={{ width: shape.width, height: shape.height, y: 0, borderRadius: 22 }}
                    exit={{ width: shape.triggerWidth, height: shape.triggerHeight, y: shape.triggerHeight + 12, borderRadius: 24 }}
                    transition={transition}
                  >
                    <motion.div
                      ref={panel}
                      className="desktop-activity-panel"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: reduced ? 0 : 0.12, delay: reduced ? 0 : 0.16 }}
                    >
                      <div className="desktop-activity-heading">
                        <Dialog.Title>Activity</Dialog.Title>
                        <Dialog.Close asChild>
                          <button type="button" aria-label="Collapse activity details">
                            <IconChevronDown size={20} aria-hidden="true" />
                          </button>
                        </Dialog.Close>
                      </div>
                      <Dialog.Description className="desktop-activity-description">
                        {displayed.count} ongoing operation{displayed.count === 1 ? '' : 's'}
                      </Dialog.Description>
                      <ul className="desktop-activity-list" tabIndex={0} aria-label="Ongoing operations">
                        {displayed.items.slice(0, 50).map((item) => (
                          <li key={`${item.kind}-${item.id}`}>
                            <span className="desktop-activity-icon">
                              <ActivityIcon kind={item.kind} appUrn={item.appUrn} />
                            </span>
                            <span>
                              <strong>{item.title}</strong>
                              <small>{item.detail}</small>
                            </span>
                          </li>
                        ))}
                      </ul>
                      <div className="desktop-activity-links">
                        <Link to="/tasks" onClick={() => setOpen(false)}>
                          Task centre
                        </Link>
                        {displayed.items.some((item) => item.kind !== 'app') ? (
                          <Link to="/updates" onClick={() => setOpen(false)}>
                            Updates
                          </Link>
                        ) : null}
                      </div>
                    </motion.div>
                  </motion.section>
                </Dialog.Content>
              ) : null}
            </AnimatePresence>
          </Dialog.Root>
        </div>
      ) : null}
    </DockCompanion>
  );
}
