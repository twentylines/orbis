import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { getInstalledAppsOptions } from '@/api-client/@tanstack/react-query.gen';
import { appDockerHealth, useContainerTelemetry } from '@/desktop/containers';
import { IconArrowUpRight, IconBrandDocker } from '@tabler/icons-react';
import './container-resources.css';
import '../docker-health/docker-health.css';

export const resourceBytes = (value: number | null) => {
  if (value === null || !Number.isFinite(value)) return 'Unavailable';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log2(Math.max(1, value)) / 10));
  return `${(value / 1024 ** index).toFixed(index > 0 ? 1 : 0)} ${units[index]}`;
};

export function ContainerResources({ compact = false, appUrn }: { compact?: boolean; appUrn?: string }) {
  const telemetry = useContainerTelemetry();
  const apps = useQuery(getInstalledAppsOptions());
  const [sort, setSort] = useState<'cpuPercent' | 'memoryBytes'>('cpuPercent');
  const names = new Map(apps.data?.installed.map(({ info }) => [info.urn, info.name]));
  const ordered = (telemetry.data?.containers ?? [])
    .filter((item) => !appUrn || item.appUrn === appUrn)
    .sort((left, right) => (right[sort] ?? -1) - (left[sort] ?? -1) || left.name.localeCompare(right.name));
  const visible = compact ? ordered.filter((item) => item.state === 'running').slice(0, 3) : ordered;
  const maximum = Math.max(1, ...visible.map((item) => item[sort] ?? 0));
  const unavailable = telemetry.isError || telemetry.data?.available === false;

  return (
    <section
      className={`container-resources ${compact ? 'is-compact' : ''}`}
      id={compact ? undefined : 'containers'}
      aria-label="Docker resource usage"
    >
      <div className="container-resources-heading">
        <h2>
          <IconBrandDocker size={20} aria-hidden="true" />
          {compact ? 'Top consumers' : 'Docker resources'}
        </h2>
        {compact ? (
          <Link to="/monitor#containers" aria-label="Expand Docker resource usage">
            <IconArrowUpRight size={18} aria-hidden="true" />
          </Link>
        ) : null}
      </div>
      <fieldset className="container-resources-sort">
        <legend className="visually-hidden">Rank containers by</legend>
        <button type="button" aria-pressed={sort === 'cpuPercent'} onClick={() => setSort('cpuPercent')}>
          CPU
        </button>
        <button type="button" aria-pressed={sort === 'memoryBytes'} onClick={() => setSort('memoryBytes')}>
          Memory
        </button>
        <span>Highest first</span>
      </fieldset>
      {compact ? null : (
        <p className="container-resources-note">
          CPU: 100% is one core. Memory excludes reclaimable file cache. Bars compare containers within this list. These readings cover Docker
          containers; other host processes are outside this view.
        </p>
      )}
      {unavailable ? (
        <p role="alert">
          Docker readings are unavailable. {telemetry.data?.containers.length ? 'Previous readings may be stale.' : ''}{' '}
          <button type="button" className="container-retry" onClick={() => telemetry.refetch()}>
            Retry
          </button>
        </p>
      ) : null}
      {telemetry.isPending ? <p>Reading Docker containers…</p> : null}
      {!telemetry.isPending && !unavailable && !visible.length ? (
        <p>{appUrn ? 'No containers matched this application.' : compact ? 'No running containers.' : 'No containers were returned by Docker.'}</p>
      ) : null}
      <ol className="container-resource-list">
        {visible.map((item) => {
          const label = item.appUrn ? (names.get(item.appUrn) ?? item.name) : item.name;
          const health = appDockerHealth([item]);
          const cpu =
            item.cpuPercent === null
              ? item.state === 'running'
                ? item.statsAvailable
                  ? 'Sampling…'
                  : 'Unavailable'
                : '—'
              : `${item.cpuPercent.toFixed(1)}%`;
          const memory = item.memoryBytes === null ? '—' : resourceBytes(item.memoryBytes);
          return (
            <li key={item.id} data-container={item.name}>
              <div className="container-resource-name">
                <strong>{label}</strong>
                {label !== item.name ? <small>{item.name}</small> : null}
                {compact ? null : (
                  <span className="docker-health" data-health={health.state}>
                    <i aria-hidden="true" />
                    {health.label}
                  </span>
                )}
              </div>
              <div className="container-resource-values">
                <span>
                  <small>CPU</small>
                  <b>{cpu}</b>
                </span>
                <span>
                  <small>Memory</small>
                  <b>{memory}</b>
                </span>
              </div>
              <div className="container-resource-bar" aria-hidden="true">
                <i style={{ width: `${(Math.max(0, item[sort] ?? 0) / maximum) * 100}%` }} />
              </div>
              {compact ? null : (
                <details className="container-resource-details">
                  <summary>Container details</summary>
                  <dl>
                    <div>
                      <dt>State</dt>
                      <dd>{item.state}</dd>
                    </div>
                    <div>
                      <dt>Memory limit</dt>
                      <dd>{resourceBytes(item.memoryLimitBytes)}</dd>
                    </div>
                    <div>
                      <dt>Network received / sent</dt>
                      <dd>
                        {resourceBytes(item.receivedBytes)} / {resourceBytes(item.transmittedBytes)}
                      </dd>
                    </div>
                    <div>
                      <dt>Disk read / written</dt>
                      <dd>
                        {resourceBytes(item.blockReadBytes)} / {resourceBytes(item.blockWriteBytes)}
                      </dd>
                    </div>
                  </dl>
                  {!appUrn && item.appUrn && names.has(item.appUrn) ? (
                    <Link to={`/apps/${encodeURIComponent(item.appUrn.split(':')[1] ?? '')}/${encodeURIComponent(item.appUrn.split(':')[0] ?? '')}`}>
                      Open application
                    </Link>
                  ) : null}
                </details>
              )}
            </li>
          );
        })}
      </ol>
      {!compact && telemetry.data ? (
        <p className="container-resources-note">
          Sampled {new Date(telemetry.data.sampledAt).toLocaleTimeString()}
          {telemetry.data.omitted > 0 ? ` · Showing 200 containers; ${telemetry.data.omitted} omitted` : ''}
          {unavailable ? ' · Stale' : ''}
        </p>
      ) : null}
    </section>
  );
}
