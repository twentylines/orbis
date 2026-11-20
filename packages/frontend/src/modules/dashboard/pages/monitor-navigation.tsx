import { useLayoutEffect, useRef, type PropsWithChildren, type RefObject } from 'react';
import { Link, useLocation, useNavigationType } from 'react-router';
import * as Tabs from '@radix-ui/react-tabs';
import { IconActivity, IconCpu, IconDatabase, IconDeviceDesktopAnalytics, IconNetwork, IconTemperature } from '@tabler/icons-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
import { SelectionGroup } from '@/components/ui/SelectionGroup/SelectionGroup';
import { dockCollapseForMonitorChart } from '@/desktop/dock-scroll-state';
import { revealPageFocus } from '@/desktop/window-viewport';

export const monitorSections = [
  { value: 'overview', label: 'Overview', Icon: IconDeviceDesktopAnalytics },
  { value: 'usage', label: 'Usage', Icon: IconActivity },
  { value: 'performance', label: 'Performance', Icon: IconCpu },
  { value: 'devices', label: 'Devices', Icon: IconNetwork },
  { value: 'drives', label: 'Drive health', Icon: IconDatabase },
  { value: 'sensors', label: 'Sensors', Icon: IconTemperature },
] as const;
export type MonitorSection = (typeof monitorSections)[number]['value'];

const chartHashes = {
  cpu: '#telemetry-cpu-title',
  memory: '#telemetry-memory-title',
  network: '#monitor-network-history-title',
  storage: '#host-storage-title',
} as const;
const coreStorageHash = '#telemetry-disks-title';
type OverviewResource = keyof typeof chartHashes;
type OverviewOrigin = { key: string; resource: OverviewResource };

export function monitorMetricForHash(hash: string): Exclude<OverviewResource, 'storage'> | null {
  if (hash === chartHashes.cpu) return 'cpu';
  if (hash === chartHashes.memory) return 'memory';
  if (hash === chartHashes.network || hash === '#monitor-network-title') return 'network';
  return null;
}

export function sectionForHash(hash: string): MonitorSection | null {
  if (hash === '#drive-health-title') return 'drives';
  if (monitorMetricForHash(hash)) return 'performance';
  if (
    [
      '#host-storage-title',
      '#host-network-title',
      '#host-disk-activity-title',
      '#device-history',
      '#telemetry-disks-title',
      '#telemetry-network-title',
    ].includes(hash)
  )
    return 'devices';
  if (['#sensors', '#host-temperatures-title', '#host-fans-title', '#host-gpus-title'].includes(hash)) return 'sensors';
  if (['#containers', '#processes'].includes(hash)) return 'usage';
  return null;
}

export function monitorSection(requested: string | null, hash: string): MonitorSection {
  return sectionForHash(hash) ?? monitorSections.find(({ value }) => value === requested)?.value ?? 'overview';
}

export function MonitorChartLink({
  resource,
  coreStorage = false,
  children,
}: PropsWithChildren<{ resource: OverviewResource; coreStorage?: boolean }>) {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  params.set('section', resource === 'storage' ? 'devices' : 'performance');
  if (resource !== 'storage') params.set('metric', resource);
  return (
    <Link
      to={{ search: params.toString(), hash: resource === 'storage' && coreStorage ? coreStorageHash : chartHashes[resource] }}
      preventScrollReset
      state={{ monitorOverviewOrigin: { key: location.key, resource } satisfies OverviewOrigin }}
      className="monitor-summary-target"
      data-monitor-resource={resource}
      onClick={(event) => {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        const { pathname, search } = event.currentTarget;
        window.dispatchEvent(new CustomEvent(dockCollapseForMonitorChart, { detail: pathname + search }));
      }}
    >
      {children}
    </Link>
  );
}

function positionChart(target: HTMLElement) {
  const document = target.ownerDocument;
  const panel = target.closest<HTMLElement>('[role="tabpanel"]');
  const pane = panel?.parentElement;
  const inner = pane && ['auto', 'scroll'].includes(getComputedStyle(pane).overflowY) ? pane : null;
  const scroller = inner ?? document.scrollingElement;
  scroller?.scrollTo({ top: 0, behavior: 'instant' });
  const paneBounds = inner?.getBoundingClientRect();
  const systemBottom = document.querySelector('.desktop-system-bar')?.getBoundingClientRect().bottom ?? 0;
  const dockTop = document.querySelector('.desktop-dock')?.getBoundingClientRect().top ?? window.innerHeight;
  const top = Math.max(paneBounds?.top ?? 0, systemBottom) + 4;
  const bottom = Math.min(paneBounds?.bottom ?? window.innerHeight, dockTop) - 4;
  // The tab panel includes recorded history and excludes the pane's dock clearance.
  const panelBounds = panel?.getBoundingClientRect();
  const fits = !panelBounds || (panelBounds.top >= top - 1 && panelBounds.bottom <= bottom + 1);
  target.toggleAttribute('data-monitor-anchor-top', fits);
  if (!fits) target.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'instant' });
}

export function useMonitorChartFocus(
  scope: RefObject<HTMLElement | null>,
  section: MonitorSection,
  hostPending: boolean,
  cpuPreferencePending = false,
) {
  const { hash, key, state } = useLocation();
  const navigationType = useNavigationType();
  const opener = useRef<OverviewOrigin | null>(null);
  const revealed = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (state?.monitorOverviewOrigin) opener.current = state.monitorOverviewOrigin;
    const root = scope.current;
    if (!root) return;
    if (!hash || (section !== 'performance' && section !== 'devices')) revealed.current = null;
    const isChart = monitorMetricForHash(hash) || hash === chartHashes.storage || hash === coreStorageHash;
    const backResource = section === 'overview' && navigationType === 'POP' && opener.current?.key === key ? opener.current.resource : null;
    if (!isChart && !backResource) return;
    if (hash === chartHashes.cpu && cpuPreferencePending) return;
    let observer: MutationObserver | undefined;
    let disposed = false;
    const reveal = () => {
      const document = root.ownerDocument;
      const target = backResource
        ? [...root.querySelectorAll<HTMLAnchorElement>('a[data-monitor-resource]')].find((link) => link.dataset.monitorResource === backResource)
        : (document.getElementById(hash.slice(1)) ??
          (hash === chartHashes.storage && !hostPending ? document.getElementById('host-devices-title') : null));
      if (!target || !root.contains(target) || !target.getClientRects().length) return false;
      if (target !== revealed.current) {
        if (!backResource) {
          target.tabIndex = -1;
          target.dataset.pageFocusAlign = 'managed';
          positionChart(target);
        }
        target.focus({ preventScroll: true });
        if (backResource) revealPageFocus(target);
        revealed.current = target;
      }
      return true;
    };
    // React Router restores hashes in a layout effect. Reconcile that scroll before paint.
    queueMicrotask(() => {
      if (disposed || reveal()) return;
      observer = new MutationObserver(() => {
        if (reveal()) observer?.disconnect();
      });
      observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'open'] });
    });
    return () => {
      disposed = true;
      observer?.disconnect();
    };
  }, [hash, key, state, navigationType, scope, section, hostPending, cpuPreferencePending]);
}

export function MonitorWorkspace({
  section,
  onSection,
  children,
}: PropsWithChildren<{ section: MonitorSection; onSection: (value: string) => void }>) {
  return (
    <Tabs.Root className="monitor-sections" orientation="vertical" value={section} onValueChange={onSection}>
      <div className="monitor-section-navigation">
        <div className="monitor-section-compact">
          <Select value={section} onValueChange={onSection}>
            <SelectTrigger className="monitor-section-select" aria-label="Monitor section">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="monitor-section-menu">
              {monitorSections.map(({ value, label }) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Tabs.List className="monitor-section-tabs" aria-label="Monitor sections">
          <SelectionGroup className="monitor-section-tab-track">
            {monitorSections.map(({ value, label, Icon }) => (
              <Tabs.Trigger className="monitor-section-tab" key={value} value={value}>
                <Icon size={20} aria-hidden="true" />
                <span>{label}</span>
              </Tabs.Trigger>
            ))}
          </SelectionGroup>
        </Tabs.List>
      </div>
      <div className="monitor-section-panels">{children}</div>
    </Tabs.Root>
  );
}
