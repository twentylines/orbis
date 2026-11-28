import { useQuery } from '@tanstack/react-query';
import type { HostSensors, HostTelemetry } from '@runtipi/common/schemas';
import { IconBrandGithub } from '@tabler/icons-react';
import { useId } from 'react';
import { Button } from '@/components/ui/Button';
import { InstalledVersions } from '@/components/installed-versions/installed-versions';
import { OrbisLogo } from '@/components/orbis-logo/orbis-logo';
import { useAppContext } from '@/context/app-context';
import { installedOrbisBuildOptions } from '@/desktop/orbis-release';
import { loadTelemetry, telemetryQueryKey } from '@/desktop/telemetry';
import { useWindowVisible } from '@/desktop/window-visibility';
import { SystemResetPanel } from '@/modules/system-reset/system-reset';
import { SentinelControllerHandoff } from '@/modules/updates/pages/sentinel-controller-handoff';
import { SentinelKeyHandoff } from '@/modules/updates/pages/sentinel-key-handoff';
import {
  recoveryAccessNeedsSignIn,
  type SentinelEnrollmentStage,
  sentinelRecoveryAccessOptions,
  sentinelStatusOptions,
} from '@/modules/updates/sentinel-status';
import './about.css';

const entryOptions = { staleTime: 5 * 60_000, refetchOnWindowFocus: false, retry: false } as const;
type HostSoftware = { osName: string | null; osVersion: string | null; dockerVersion: string | null };

const enrollmentGuidance: Record<Exclude<SentinelEnrollmentStage, 'activated'>, [status: string, next: string]> = {
  'not-started': ['Enrollment has not started.', 'On the Orbis host, stage the operator account using the protected Sentinel bootstrap.'],
  staging: ['Operator setup is in progress.', 'Complete the staged setup on the Orbis host before preparing the emergency key.'],
  'operator-staged': ['Operator account staged.', 'Prepare and save the emergency key through the protected host setup.'],
  'key-prepared': ['Emergency key prepared.', 'Save the key somewhere you can reach while Orbis is offline, then confirm the saved file.'],
  'key-expired': ['The emergency key confirmation expired.', 'Review the existing host setup before continuing.'],
  'key-acknowledged': ['Host recorded a key acknowledgment.', 'Complete the reviewed activation on the Orbis host.'],
  'activation-pending': ['Activation is in progress.', 'Follow the host setup result before testing recovery sign-in.'],
};

function RecoveryAccess({ active, operator }: { active: boolean; operator: boolean }) {
  const heading = useId();
  const recovery = useQuery(sentinelRecoveryAccessOptions(active));
  const access = recovery.isError ? undefined : recovery.data;
  const configured = access?.state === 'configured' ? access : undefined;
  const stage = operator ? configured?.enrollment : undefined;
  const enrollment = stage && stage !== 'activated' ? enrollmentGuidance[stage] : undefined;
  const recoveryLabel = recoveryAccessNeedsSignIn(recovery.error)
    ? 'Sign in again to check recovery access.'
    : recovery.isPending
      ? 'Checking recovery access…'
      : configured
        ? {
            active: 'Portal configured. Recovery service active.',
            inactive: 'Portal configured. Recovery service inactive.',
            unknown: 'Portal configured. Recovery service status unknown.',
          }[configured.unitState]
        : access?.state === 'missing'
          ? 'Recovery portal setup required.'
          : 'Recovery access could not be verified.';

  return (
    <section className="settings-group settings-recovery-access" aria-labelledby={heading}>
      <div className="settings-recovery-summary">
        <div>
          <h3 id={heading}>Recovery</h3>
          <output>{recoveryLabel}</output>
        </div>
        {configured ? (
          <div className="settings-recovery-actions">
            <Button asChild variant="outline">
              <a href={configured.portalUrl} target="_blank" rel="noopener noreferrer">
                Open Sentinel
              </a>
            </Button>
            {stage === 'activated' && configured.unitState === 'active' ? (
              <SentinelControllerHandoff key={configured.portalUrl} active={active} portalUrl={configured.portalUrl} />
            ) : null}
          </div>
        ) : null}
      </div>
      {enrollment ? (
        <div className="settings-recovery-guidance">
          <output>{enrollment[0]}</output>
          <p>{enrollment[1]}</p>
        </div>
      ) : configured && stage !== 'activated' ? (
        <p className="settings-recovery-guidance">
          {operator && configured.unitState === 'active' ? 'Enrollment progress could not be verified. ' : null}
          Open the portal to check sign-in availability.
        </p>
      ) : null}
      {stage === 'key-prepared' ? <SentinelKeyHandoff active={active} onConfirmed={() => void recovery.refetch()} /> : null}
    </section>
  );
}

function operatingSystemLabel(software?: HostSoftware) {
  const { osName, osVersion } = software ?? {};
  if (osName === 'Docker Desktop') return osVersion ? `Docker Desktop (Docker host OS ${osVersion})` : 'Docker Desktop (Docker host)';
  if (!osName || !osVersion) return osName || osVersion;
  return osName.includes(osVersion) ? osName : `${osName} ${osVersion}`;
}

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
  const { version, user } = useAppContext();
  const build = useQuery({ ...installedOrbisBuildOptions(), ...entryOptions, enabled: visible });
  const sentinel = useQuery({ ...sentinelStatusOptions(visible), refetchInterval: false });
  const installedSoftware = useQuery({
    queryKey: ['orbis-installed-software'],
    queryFn: ({ signal }) => readHardware<HostSoftware>('installed-software', AbortSignal.any([signal, AbortSignal.timeout(5000)])),
    ...entryOptions,
    enabled: visible,
  });
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
  const software = installedSoftware.isError ? undefined : installedSoftware.data;
  const hostSoftware = {
    sentinel: sentinel.isPending ? loading : sentinel.isError ? null : sentinel.data?.installedVersion,
    operatingSystem: installedSoftware.isPending ? loading : operatingSystemLabel(software),
    docker: installedSoftware.isPending ? loading : software?.dockerVersion,
  };
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
      <div className="settings-about-sections">
        <section className="settings-group" aria-labelledby="about-software-title">
          <h3 id="about-software-title">Installed software</h3>
          <InstalledVersions
            orbis={build.isPending ? loading : build.data?.version}
            runtipi={build.data?.runtipiCompatibility || version.current}
            host={hostSoftware}
          />
        </section>
        <section className="settings-group" aria-labelledby="about-hardware-title">
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
        <Button asChild variant="outline">
          <a href="https://github.com/twentylines" target="_blank" rel="noreferrer">
            <span className="settings-about-link-icon" aria-hidden="true">
              <IconBrandGithub size={21} stroke={1.8} />
            </span>
            <span>twentylines</span>
          </a>
        </Button>
        <Button asChild variant="outline">
          <a href="https://github.com/twentylines/orbis" target="_blank" rel="noreferrer">
            <span className="settings-about-link-icon" aria-hidden="true">
              <OrbisLogo size={24} plain />
            </span>
            <span>Orbis repository</span>
          </a>
        </Button>
        <Button asChild variant="outline">
          <a href="https://github.com/runtipi/runtipi" target="_blank" rel="noreferrer">
            <span className="settings-about-link-icon" aria-hidden="true">
              <img src="/tipi.png" alt="" />
            </span>
            <span>Upstream Runtipi repository</span>
          </a>
        </Button>
      </footer>
      {user?.operator === true ? <SystemResetPanel /> : null}
      <RecoveryAccess active={visible} operator={user?.operator === true} />
    </div>
  );
}
