import type { HostBattery, HostTelemetry } from '@runtipi/common/schemas';
import { useQuery } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { IconBolt, IconBoltFilled, IconClock, IconHeart } from '@tabler/icons-react';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import '../components/ui/dropdown.css';
import './host-battery.css';

const path = '/api/system/host-telemetry';

type BatterySample = { battery: HostBattery; receivedAt: number };

export function visibleHostBattery(
  reading: HostTelemetry | undefined,
  failed: boolean,
  previous: BatterySample | null,
  receivedAt: number,
  now: number,
): BatterySample | null {
  if (failed || !reading) return null;
  const recent = (time: number) => Number.isFinite(time) && now >= time && now - time <= 90_000;
  if (reading.available && !reading.stale) {
    // Host freshness is checked on the server; client and host clocks can differ.
    return reading.battery && recent(receivedAt) ? { battery: reading.battery, receivedAt } : null;
  }
  const retrying = reading.available ? reading.stale : reading.reason === 'Collecting host readings.';
  return retrying && previous && recent(previous.receivedAt) ? previous : null;
}

export function BatteryGlyph({ battery, variant = 'toolbar' }: { battery: HostBattery; variant?: 'toolbar' | 'panel' }) {
  const { percent, charging } = battery;
  const label = `Host battery ${percent}%${charging === true ? ', charging' : charging === false ? ', not charging' : ''}`;
  return (
    <span
      className="desktop-battery"
      role="img"
      aria-label={label}
      title={label}
      data-state={charging ? 'charging' : percent <= 10 ? 'critical' : percent <= 20 ? 'low' : 'normal'}
      data-variant={variant}
    >
      <span className="desktop-battery-body" style={{ '--battery-level': `${percent}%` } as CSSProperties}>
        <span className="desktop-battery-fill" />
        <span className="desktop-battery-number" aria-hidden="true">
          {percent}
        </span>
        {variant === 'panel' ? (
          <span className="desktop-battery-number desktop-battery-panel-number" aria-hidden="true">
            {percent}
          </span>
        ) : null}
      </span>
      {charging ? <IconBoltFilled className="desktop-battery-charging" aria-hidden="true" /> : null}
    </span>
  );
}

const availableNumber = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const wattHours = (value: number) => `${Number(value.toFixed(1))} Wh`;

export function batteryStateLabel(battery: HostBattery) {
  switch (battery.state) {
    case 'charging':
      return 'Charging';
    case 'discharging':
      return 'On battery';
    case 'full':
      return 'Fully charged';
    case 'idle':
      return 'Not charging';
    case 'unknown':
      return 'Power state unavailable';
    default:
      return battery.charging === true ? 'Charging' : battery.charging === false ? 'Not charging' : 'Power state unavailable';
  }
}

export function batteryTimeLabel(battery: HostBattery) {
  const state = battery.state ?? (battery.charging === true ? 'charging' : 'unknown');
  const label = state === 'charging' ? 'Time to full' : state === 'discharging' ? 'Time remaining' : 'Time estimate';
  const seconds = battery.timeRemainingSeconds;
  if (!availableNumber(seconds) || (state !== 'charging' && state !== 'discharging')) return { label, value: 'Unavailable' };
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 1) return { label, value: 'Less than a minute' };
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return { label, value: `${hours ? `${hours}h` : ''}${hours && rest ? ' ' : ''}${rest ? `${rest}m` : ''} estimated` };
}

export function batteryPanelPosition(anchor: { left: number; right: number; bottom: number }, width: number, viewportWidth: number) {
  return { left: Math.max(16, Math.min((anchor.left + anchor.right - width) / 2, viewportWidth - width - 16)), top: anchor.bottom + 8 };
}

export function BatteryDetails({ battery }: { battery: HostBattery }) {
  const time = batteryTimeLabel(battery);
  const estimated = time.value.endsWith(' estimated');
  const health = availableNumber(battery.healthPercent) ? Math.min(100, battery.healthPercent) : null;
  const capacity = availableNumber(battery.energyFullWh)
    ? `${wattHours(battery.energyFullWh)}${availableNumber(battery.energyDesignWh) ? ` / ${wattHours(battery.energyDesignWh)} design` : ''}`
    : 'Unavailable';
  const powerLabel =
    battery.state === 'discharging' ? 'Discharge rate' : battery.state === 'charging' || battery.charging === true ? 'Charging power' : 'Power draw';
  return (
    <>
      <div className="desktop-battery-heading">
        <span className="desktop-battery-hero" aria-hidden="true">
          <BatteryGlyph battery={battery} variant="panel" />
        </span>
        <span>
          <strong>{batteryStateLabel(battery)}</strong>
          {availableNumber(battery.energyNowWh) ? <small>{wattHours(battery.energyNowWh)} stored</small> : null}
        </span>
      </div>
      <dl className="desktop-battery-metrics">
        <div>
          <dt>
            <IconClock size={16} aria-hidden="true" />
            {time.label}
          </dt>
          <dd data-unavailable={time.value === 'Unavailable'}>
            {estimated ? time.value.slice(0, -10) : time.value}
            {estimated ? <small>Estimated</small> : null}
          </dd>
        </div>
        <div>
          <dt>
            <IconBolt size={16} aria-hidden="true" />
            {powerLabel}
          </dt>
          <dd data-unavailable={!availableNumber(battery.powerWatts)}>
            {availableNumber(battery.powerWatts) ? `${Number(battery.powerWatts.toFixed(1))} W` : 'Unavailable'}
          </dd>
        </div>
      </dl>
      <div className="desktop-battery-health">
        <div className="desktop-battery-health-heading">
          <span>
            <IconHeart size={16} aria-hidden="true" />
            Battery health
          </span>
          <strong>{health !== null ? `${Number(health.toFixed(1))}%` : 'Unavailable'}</strong>
        </div>
        {health !== null ? (
          <div className="desktop-battery-health-track" aria-hidden="true">
            <span style={{ width: `${health}%` }} />
          </div>
        ) : null}
      </div>
      <dl className="desktop-battery-details">
        <div>
          <dt>Full charge capacity</dt>
          <dd>{capacity}</dd>
        </div>
        {availableNumber(battery.cycleCount) ? (
          <div>
            <dt>Charge cycles</dt>
            <dd>{battery.cycleCount}</dd>
          </div>
        ) : null}
      </dl>
      {battery.model || battery.manufacturer || (battery.batteryCount ?? 0) > 1 ? (
        <p className="desktop-battery-device">
          {[battery.manufacturer, battery.model, (battery.batteryCount ?? 0) > 1 ? `${battery.batteryCount} batteries` : null]
            .filter(Boolean)
            .join(' · ')}
        </p>
      ) : null}
    </>
  );
}

export function HostBatteryButton({ battery }: { battery: HostBattery }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 16, top: 72 });
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      if (!trigger.current || !panel.current) return;
      setPosition(batteryPanelPosition(trigger.current.getBoundingClientRect(), panel.current.offsetWidth, window.innerWidth));
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (panel.current) observer.observe(panel.current);
    if (trigger.current) observer.observe(trigger.current);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [open]);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen} modal={false}>
      <Dialog.Trigger asChild>
        <button
          ref={trigger}
          type="button"
          className="desktop-battery-trigger"
          aria-label={`Host battery ${battery.percent}%, ${batteryStateLabel(battery).toLowerCase()}. Battery details`}
          title="Battery details"
        >
          <BatteryGlyph battery={battery} />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Content
          ref={panel}
          className="orbis-dropdown-menu desktop-battery-panel"
          style={{ ...position, maxHeight: `calc(100dvh - ${position.top}px - 16px)` }}
          aria-describedby={undefined}
        >
          <Dialog.Title className="desktop-battery-title">Battery details</Dialog.Title>
          <BatteryDetails battery={battery} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function HostBatteryIndicator() {
  const previous = useRef<BatterySample | null>(null);
  const [now, setNow] = useState(Date.now);
  const query = useQuery<HostTelemetry>({
    queryKey: ['host-telemetry', path],
    queryFn: async ({ signal }) => {
      const response = await fetch(path, { credentials: 'include', signal });
      if (!response.ok) throw new Error('Unable to read host devices');
      return response.json() as Promise<HostTelemetry>;
    },
    refetchInterval: (query) => {
      const reading = query.state.data;
      return reading?.available ? (reading.stale ? 2000 : 60_000) : reading?.reason === 'Collecting host readings.' ? 2000 : 60_000;
    },
    refetchIntervalInBackground: false,
    retry: false,
  });
  previous.current = visibleHostBattery(query.data, query.isError, previous.current, query.dataUpdatedAt, Math.max(now, Date.now()));
  const expiresAt = previous.current ? previous.current.receivedAt + 90_001 : null;
  useEffect(() => {
    if (expiresAt === null) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [expiresAt]);
  return previous.current ? <HostBatteryButton battery={previous.current.battery} /> : null;
}
