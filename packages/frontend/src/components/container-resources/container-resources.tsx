import { useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { getInstalledAppsOptions } from '@/api-client/@tanstack/react-query.gen';
import { useContainerTelemetry } from '@/desktop/containers';
import { appDockerHealth, containerHealthReason } from '@/desktop/container-health';
import { useAppContext } from '@/context/app-context';
import { useServerPath } from '@/desktop/cluster-data';
import { RestartDialog } from '@/modules/app/components/dialogs/restart-dialog/restart-dialog';
import { IconBrandDocker, IconChevronRight } from '@tabler/icons-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
import { ContainerResourceFocus } from './container-resource-focus';
import { useResourceRanking } from '@/desktop/resource-ranking';
import * as Accordion from '@radix-ui/react-accordion';
import { AnimatePresence, motion, useIsPresent } from 'framer-motion';
import { prefersReducedMotion } from '@/desktop/motion-setting';
import { revealPageFocus } from '@/desktop/window-viewport';
import './container-resources.css';
import '../docker-health/docker-health.css';

export const resourceBytes = (value: number | null) => {
  if (value === null || !Number.isFinite(value)) return 'Unavailable';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log2(Math.max(1, value)) / 10));
  return `${(value / 1024 ** index).toFixed(index > 0 ? 1 : 0)} ${units[index]}`;
};

function ResourceDetailsMotion({ children }: { children: ReactNode }) {
  const present = useIsPresent();
  const body = useRef<HTMLDivElement>(null);
  const reduced = prefersReducedMotion();
  return (
    <motion.div
      ref={body}
      inert={!present}
      aria-hidden={!present}
      style={{ overflow: 'hidden' }}
      initial={reduced ? false : { height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0, transition: { duration: reduced ? 0 : 0.2 } }}
      transition={{ duration: reduced ? 0 : 0.24, ease: [0.32, 0.08, 0.24, 1] }}
      onAnimationComplete={() => {
        const active = document.activeElement;
        if (present && active instanceof HTMLElement && body.current?.contains(active)) revealPageFocus(active);
      }}
    >
      {children}
    </motion.div>
  );
}

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
  const [expanded, setExpanded] = useState<string[]>([]);
  const restartApp = apps.data?.installed.find(({ info }) => info.urn === restartUrn);
  const [sort, setSort] = useState<'cpuPercent' | 'memoryBytes'>('cpuPercent');
  const list = useRef<HTMLOListElement>(null);
  const panel = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const names = new Map(apps.data?.installed.map(({ info }) => [info.urn, info.name]));
  const containers = (telemetry.data?.containers ?? []).filter((item) => !appUrn || item.appUrn === appUrn);
  const searchTerm = search.trim().toLocaleLowerCase();
  const ordered = containers
    .filter(
      (item) =>
        compact ||
        ((filter === 'all' ||
          (filter === 'attention'
            ? ['unhealthy', 'starting', 'partial'].includes(appDockerHealth([item]).state)
            : filter === 'running'
              ? item.state === 'running'
              : item.state !== 'running')) &&
          `${item.name} ${item.appUrn ? (names.get(item.appUrn) ?? '') : ''}`.toLocaleLowerCase().includes(searchTerm)),
    )
    .sort((left, right) => (right[sort] ?? -1) - (left[sort] ?? -1) || left.name.localeCompare(right.name));
  const ranking = useResourceRanking(ordered, list);
  const visible = compact ? ranking.items.filter((item) => item.state === 'running').slice(0, 4) : ranking.items.slice(0, limit);
  const maximum = Math.max(1, ...visible.map((item) => item[sort] ?? 0));
  const unavailable = telemetry.isError || telemetry.data?.available === false;
  const counts = containers.reduce(
    (counts, item) => {
      if (['unhealthy', 'starting', 'partial'].includes(appDockerHealth([item]).state)) counts.attention++;
      if (item.state === 'running') counts.running++;
      else counts.stopped++;
      return counts;
    },
    { attention: 0, running: 0, stopped: 0 },
  );

  return (
    <section
      ref={panel}
      tabIndex={-1}
      data-dialog-focus-fallback
      className={`container-resources ${compact ? 'is-compact' : ''}`}
      id={compact ? undefined : 'containers'}
      aria-label="Docker resource usage"
    >
      <div className="container-resources-toolbar">
        <div className="container-resources-heading">
          <h2 ref={heading} tabIndex={-1}>
            <IconBrandDocker size={20} aria-hidden="true" />
            {compact ? 'Usage' : 'Container health and usage'}
          </h2>
        </div>
        <SelectionGroup as="fieldset" className="container-resources-sort">
          <legend className="visually-hidden">Sort containers by</legend>
          <span className="container-resources-sort-label" aria-hidden="true">
            Sort by
          </span>
          <button type="button" aria-pressed={sort === 'cpuPercent'} onClick={() => setSort('cpuPercent')}>
            CPU
          </button>
          <button type="button" aria-pressed={sort === 'memoryBytes'} onClick={() => setSort('memoryBytes')}>
            Memory
          </button>
        </SelectionGroup>
      </div>
      {compact ? null : (
        <section className="container-health-overview" aria-label="Container status summary">
          <button
            type="button"
            aria-pressed={filter === 'attention'}
            onClick={() => {
              setFilter('attention');
              setLimit(12);
            }}
          >
            <span>Needs attention</span>
            <strong>{counts.attention}</strong>
          </button>
          <button
            type="button"
            aria-pressed={filter === 'running'}
            onClick={() => {
              setFilter('running');
              setLimit(12);
            }}
          >
            <span>Running</span>
            <strong>{counts.running}</strong>
          </button>
          <button
            type="button"
            aria-pressed={filter === 'stopped'}
            onClick={() => {
              setFilter('stopped');
              setLimit(12);
            }}
          >
            <span>Stopped</span>
            <strong>{counts.stopped}</strong>
          </button>
        </section>
      )}
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
          <Select
            value={filter}
            onValueChange={(value) => {
              setFilter(value);
              setLimit(12);
            }}
          >
            <SelectTrigger fitContent className="container-health-select" value={filter} aria-label="Container status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All containers</SelectItem>
              <SelectItem value="attention">Needs attention</SelectItem>
              <SelectItem value="running">Running</SelectItem>
              <SelectItem value="stopped">Stopped</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}
      {compact ? null : (
        <details className="container-resources-note">
          <summary>
            <IconChevronRight size={16} aria-hidden="true" />
            About these readings
          </summary>
          <p>
            CPU: 100% is one core. Memory excludes reclaimable file cache. Bars compare containers within this list. Host process and container
            readings overlap; this list covers Docker containers only.
          </p>
          <p>Readings stay live while you use this list. Rows keep their positions until you leave it.</p>
        </details>
      )}
      {unavailable ? (
        <div className="container-resources-notice">
          <p role="alert">Docker readings are unavailable. {telemetry.data?.containers.length ? 'Previous readings may be stale.' : ''}</p>
          <button
            type="button"
            className="container-resource-action container-resource-retry"
            aria-busy={telemetry.isFetching}
            onClick={() => telemetry.refetch({ cancelRefetch: false })}
          >
            {telemetry.isFetching ? 'Checking…' : 'Retry'}
          </button>
        </div>
      ) : null}
      {telemetry.isPending ? <p>Reading Docker containers…</p> : null}
      {!telemetry.isPending && !unavailable && !visible.length ? (
        <output className="container-resources-empty">
          {searchTerm
            ? 'No containers match your search and status filter.'
            : filter === 'attention' && !compact
              ? 'No containers need attention.'
              : filter === 'running' || compact
                ? 'No running containers.'
                : filter === 'stopped'
                  ? 'No stopped containers.'
                  : appUrn
                    ? 'No containers found for this app.'
                    : 'No Docker containers found.'}
        </output>
      ) : null}
      <ContainerResourceFocus list={list} fallback={heading} scope={panel}>
        <Accordion.Root type="multiple" value={expanded} onValueChange={setExpanded} asChild>
          <ol className="container-resource-list" ref={list} {...ranking.interaction}>
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
              const urn = item.appUrn;
              const canOpen = !appUrn && urn && names.has(urn);
              const needsAttention = ['unhealthy', 'starting'].includes(health.state);
              const canRestart = !unavailable && local && user.operator && urn && names.has(urn) && needsAttention;
              const reading = (
                <>
                  <span className="container-resource-name">
                    <strong title={label}>{label}</strong>
                    <span className="container-resource-meta">
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
                    </span>
                  </span>
                  <span className="container-resource-values">
                    <span>
                      <small>CPU</small>
                      <b>{cpu}</b>
                    </span>
                    <span>
                      <small>Memory</small>
                      <b>{memory}</b>
                    </span>
                  </span>
                  <span className="container-resource-bar" aria-hidden="true">
                    <i style={{ width: `${(Math.max(0, item[sort] ?? 0) / maximum) * 100}%` }} />
                  </span>
                </>
              );
              return compact ? (
                <li key={item.id} data-container={item.name}>
                  {reading}
                </li>
              ) : (
                <Accordion.Item key={item.id} value={item.id} asChild>
                  <li className="container-resource-entry" data-container={item.name}>
                    <Accordion.Header className="container-resource-row-heading" aria-label={label}>
                      <Accordion.Trigger className="container-resource-toggle">
                        {reading}
                        <IconChevronRight className="container-resource-chevron" size={18} aria-hidden="true" />
                        <span className="visually-hidden">Container details</span>
                      </Accordion.Trigger>
                    </Accordion.Header>
                    <AnimatePresence initial={false}>
                      {expanded.includes(item.id) ? (
                        <Accordion.Content key={item.id} className="container-resource-expanded" forceMount>
                          <ResourceDetailsMotion>
                            <div className="container-resource-detail-body">
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
                              {canOpen || canRestart ? (
                                <div className="container-resource-actions">
                                  {canOpen ? (
                                    <Link
                                      className="container-resource-action"
                                      to={`/apps/${encodeURIComponent(urn.split(':')[1] ?? '')}/${encodeURIComponent(urn.split(':')[0] ?? '')}`}
                                    >
                                      Open application
                                    </Link>
                                  ) : null}
                                  {canOpen && needsAttention ? (
                                    <Link
                                      className="container-resource-action"
                                      to={`/apps/${encodeURIComponent(urn.split(':')[1] ?? '')}/${encodeURIComponent(urn.split(':')[0] ?? '')}?tab=logs`}
                                    >
                                      View logs
                                    </Link>
                                  ) : null}
                                  {canRestart ? (
                                    <button type="button" className="container-resource-action" onClick={() => setRestartUrn(urn)}>
                                      Restart app…
                                    </button>
                                  ) : null}
                                </div>
                              ) : null}
                            </div>
                          </ResourceDetailsMotion>
                        </Accordion.Content>
                      ) : null}
                    </AnimatePresence>
                  </li>
                </Accordion.Item>
              );
            })}
          </ol>
        </Accordion.Root>
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
import { SelectionGroup } from '@/components/ui/SelectionGroup/SelectionGroup';
