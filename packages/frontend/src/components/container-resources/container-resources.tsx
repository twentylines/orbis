import { useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { getInstalledAppsOptions } from '@/api-client/@tanstack/react-query.gen';
import { useContainerTelemetry } from '@/desktop/containers';
import { appDockerHealth, containerHealthReason } from '@/desktop/container-health';
import { useAppContext } from '@/context/app-context';
import { useServerPath } from '@/desktop/cluster-data';
import { RestartDialog } from '@/modules/app/components/dialogs/restart-dialog/restart-dialog';
import { IconBrandDocker, IconChevronRight } from '@tabler/icons-react';
import { ContainerResourceFocus } from './container-resource-focus';
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
  const { user } = useAppContext();
  const local = useServerPath()('/api/system/containers') === '/api/system/containers';
  const location = useLocation();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState(new URLSearchParams(location.search).get('health') === 'attention' ? 'attention' : 'all');
  const [limit, setLimit] = useState(12);
  const [restartUrn, setRestartUrn] = useState<string | null>(null);
  const restartApp = apps.data?.installed.find(({ info }) => info.urn === restartUrn);
  const [sort, setSort] = useState<'cpuPercent' | 'memoryBytes'>('cpuPercent');
  const list = useRef<HTMLOListElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const names = new Map(apps.data?.installed.map(({ info }) => [info.urn, info.name]));
  const ordered = (telemetry.data?.containers ?? [])
    .filter((item) => !appUrn || item.appUrn === appUrn)
    .filter(
      (item) =>
        compact ||
        ((filter === 'all' ||
          (filter === 'attention'
            ? ['unhealthy', 'starting', 'partial'].includes(appDockerHealth([item]).state)
            : filter === 'running'
              ? item.state === 'running'
              : item.state !== 'running')) &&
          `${item.name} ${item.appUrn ? (names.get(item.appUrn) ?? '') : ''}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())),
    )
    .sort((left, right) => (right[sort] ?? -1) - (left[sort] ?? -1) || left.name.localeCompare(right.name));
  const visible = compact ? ordered.filter((item) => item.state === 'running').slice(0, 4) : ordered.slice(0, limit);
  const maximum = Math.max(1, ...visible.map((item) => item[sort] ?? 0));
  const unavailable = telemetry.isError || telemetry.data?.available === false;

  return (
    <section
      className={`container-resources ${compact ? 'is-compact' : ''}`}
      id={compact ? undefined : 'containers'}
      aria-label="Docker resource usage"
    >
      <div className="container-resources-heading">
        <h2 ref={heading} tabIndex={-1}>
          <IconBrandDocker size={20} aria-hidden="true" />
          {compact ? 'Usage' : 'Container health and usage'}
        </h2>
      </div>
      <fieldset className="container-resources-sort">
        <legend>Sort by</legend>
        <button type="button" aria-pressed={sort === 'cpuPercent'} onClick={() => setSort('cpuPercent')}>
          CPU
        </button>
        <button type="button" aria-pressed={sort === 'memoryBytes'} onClick={() => setSort('memoryBytes')}>
          Memory
        </button>
      </fieldset>
      {compact ? null : (
        <div className="container-resource-filters">
          <input
            type="search"
            className="form-control"
            aria-label="Find a container"
            placeholder="Find a container"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setLimit(12);
            }}
          />
          <select
            className="form-select"
            aria-label="Container status"
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value);
              setLimit(12);
            }}
          >
            <option value="all">All containers</option>
            <option value="attention">Needs attention</option>
            <option value="running">Running</option>
            <option value="stopped">Stopped</option>
          </select>
        </div>
      )}
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
        <p>{appUrn ? 'No containers found for this app.' : compact ? 'No running containers.' : 'No Docker containers found.'}</p>
      ) : null}
      <ContainerResourceFocus list={list} fallback={heading}>
        <ol className="container-resource-list" ref={list}>
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
                  <strong title={label}>{label}</strong>
                  {label !== item.name ? <small title={item.name}>{item.name}</small> : null}
                  {compact ? null : (
                    <span
                      className="docker-health"
                      data-health={health.state}
                      title={item.health === 'not-configured' ? 'No Docker healthcheck is configured' : `Docker: ${health.label}`}
                    >
                      <i aria-hidden="true" />
                      <span>{health.label}</span>
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
                    <summary>
                      <IconChevronRight size={16} aria-hidden="true" />
                      <span>Container details</span>
                    </summary>
                    <p>{containerHealthReason(item)}</p>
                    {item.readiness?.lastCheckAt ? (
                      <p>
                        Last healthcheck:{' '}
                        <time dateTime={item.readiness.lastCheckAt}>{new Date(item.readiness.lastCheckAt).toLocaleTimeString()}</time>
                      </p>
                    ) : null}
                    <dl>
                      <div>
                        <dt>State</dt>
                        <dd>{item.state}</dd>
                      </div>
                      <div>
                        <dt>Healthcheck</dt>
                        <dd>{item.health === 'not-configured' ? 'Not configured' : health.label}</dd>
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
                      <Link
                        to={`/apps/${encodeURIComponent(item.appUrn.split(':')[1] ?? '')}/${encodeURIComponent(item.appUrn.split(':')[0] ?? '')}`}
                      >
                        Open application
                      </Link>
                    ) : null}
                    {local && user.operator && item.appUrn && names.has(item.appUrn) && ['unhealthy', 'starting'].includes(health.state) ? (
                      <button type="button" className="container-retry" onClick={() => setRestartUrn(item.appUrn)}>
                        Restart app…
                      </button>
                    ) : null}
                  </details>
                )}
              </li>
            );
          })}
        </ol>
      </ContainerResourceFocus>
      {!compact && ordered.length > visible.length ? (
        <button type="button" className="container-retry" onClick={() => setLimit((value) => value + 12)}>
          Show 12 more · {ordered.length - visible.length} remaining
        </button>
      ) : null}
      {restartApp ? <RestartDialog info={restartApp.info} isOpen onClose={() => setRestartUrn(null)} /> : null}
      {!compact && telemetry.data ? (
        <p className="container-resources-note">
          {visible.length} of {ordered.length} matching containers · Sampled {new Date(telemetry.data.sampledAt).toLocaleTimeString()}
          {telemetry.data.omitted > 0 ? ` · Showing 200 containers; ${telemetry.data.omitted} omitted` : ''}
          {unavailable ? ' · Stale' : ''}
        </p>
      ) : null}
    </section>
  );
}
