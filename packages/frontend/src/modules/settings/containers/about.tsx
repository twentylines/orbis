import { useQuery } from '@tanstack/react-query';
import type { HostSensors, HostTelemetry } from '@runtipi/common/schemas';
import { IconArrowUpRight } from '@tabler/icons-react';
import { InstalledVersions } from '@/components/installed-versions/installed-versions';
import { useAppContext } from '@/context/app-context';
import { installedOrbisBuildOptions } from '@/desktop/orbis-release';
import { loadTelemetry, telemetryQueryKey } from '@/desktop/telemetry';
import { useWindowVisible } from '@/desktop/window-visibility';
import './about.css';

const entryOptions = { staleTime: 5 * 60_000, refetchOnWindowFocus: false, retry: false } as const;
async function readHardware<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(`/api/system/${path}`, { credentials: 'same-origin', signal });
  if (!response.ok) throw new Error('Hardware details are unavailable');
  return response.json();
}
function capacity(bytes: number | null | undefined) {
  if (!bytes || !Number.isFinite(bytes) || bytes < 0) return 'Not reported';
  const unit = bytes >= 1024 ** 4 ? 'TB' : 'GB';
  return `${(bytes / 1024 ** (unit === 'TB' ? 4 : 3)).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${unit}`;
}

export function About() {
  const visible = useWindowVisible();
  const { version } = useAppContext();
  const build = useQuery({ ...installedOrbisBuildOptions(), ...entryOptions, enabled: visible });
  const telemetry = useQuery({
    queryKey: [...telemetryQueryKey, '/api/system/telemetry'],
    queryFn: ({ signal }) => loadTelemetry(signal),
    ...entryOptions,
    enabled: visible,
  });
  const host = useQuery({
    queryKey: ['host-telemetry', '/api/system/host-telemetry'],
    queryFn: ({ signal }) => readHardware<HostTelemetry>('host-telemetry', signal),
    ...entryOptions,
    enabled: visible,
  });
  const sensors = useQuery({
    queryKey: ['host-sensors', '/api/system/host-sensors'],
    queryFn: ({ signal }) => readHardware<HostSensors>('host-sensors', signal),
    ...entryOptions,
    enabled: visible,
  });
  const sample = telemetry.isError ? undefined : telemetry.data;
  const devices = host.isError || !host.data?.available ? null : host.data;
  const graphics = sensors.isError || !sensors.data?.available ? null : sensors.data;
  const gpuNames = [...new Set(graphics?.gpus.map((gpu) => [gpu.vendor, gpu.label, gpu.driver].filter(Boolean).join(' · ')))];
  const loading = 'Reading…';
  const facts = [
    [
      'CPU',
      telemetry.isPending
        ? loading
        : sample?.cpu.model ||
          (sample?.cpu.scope === 'host-proc' && sample.cpu.perCorePercent.length
            ? `${sample.cpu.perCorePercent.length} logical processors`
            : 'Not reported'),
    ],
    ['Memory', telemetry.isPending ? loading : capacity(sample?.memory.totalBytes)],
    [
      'Graphics',
      sensors.isPending ? loading : gpuNames.slice(0, 2).join(', ') + (gpuNames.length > 2 ? ` +${gpuNames.length - 2} more` : '') || 'Not reported',
    ],
    ['System storage', host.isPending ? loading : capacity(devices?.filesystems.find((disk) => disk.mount === '/')?.sizeBytes)],
  ];

  return (
    <div className="settings-about">
      <header>
        <h2>About Orbis</h2>
        <p>Software and server details</p>
      </header>
      <div className="settings-about-sections">
        <section aria-labelledby="about-software-title">
          <h3 id="about-software-title">Installed software</h3>
          <InstalledVersions orbis={build.isPending ? loading : build.data?.version} runtipi={build.data?.runtipiCompatibility || version.current} />
        </section>
        <section aria-labelledby="about-hardware-title">
          <h3 id="about-hardware-title">Server</h3>
          <dl className="settings-about-facts">
            {facts.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
      <footer className="settings-about-links">
        <a href="https://github.com/twentylines" target="_blank" rel="noreferrer">
          twentylines <IconArrowUpRight size={16} aria-hidden="true" />
        </a>
        <a href="https://github.com/twentylines/orbis" target="_blank" rel="noreferrer">
          Orbis repository <IconArrowUpRight size={16} aria-hidden="true" />
        </a>
        <a href="https://github.com/runtipi/runtipi" target="_blank" rel="noreferrer">
          Built on Runtipi <IconArrowUpRight size={16} aria-hidden="true" />
        </a>
      </footer>
    </div>
  );
}
