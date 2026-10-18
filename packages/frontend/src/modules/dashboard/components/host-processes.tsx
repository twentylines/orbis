import { useQuery } from '@tanstack/react-query';
import type { HostProcesses } from '@runtipi/common/schemas';
import { useEffect, useRef, useState } from 'react';
import { useWindowVisible } from '@/desktop/window-visibility';
import { resourceBytes } from '@/components/container-resources/container-resources';
import './host-processes.css';

async function loadProcesses(signal: AbortSignal): Promise<HostProcesses> {
  const response = await fetch('/api/system/host-processes', { credentials: 'include', signal });
  if (!response.ok) throw new Error('Unable to read host processes');
  return response.json();
}

export function HostProcessesView() {
  const visible = useWindowVisible();
  const [sort, setSort] = useState<'cpuPercent' | 'memoryBytes'>('cpuPercent');
  const query = useQuery({
    queryKey: ['host-processes'],
    queryFn: ({ signal }) => loadProcesses(signal),
    enabled: visible,
    refetchInterval: (query) => {
      const value = query.state.data;
      return (value?.available === false && value.reason === 'Collecting process readings.') ||
        (sort === 'cpuPercent' && value?.available && value.readable > 0 && value.compared === 0)
        ? 2000
        : 10_000;
    },
    refetchIntervalInBackground: false,
  });
  const data = query.data;
  const ready = data?.available ? data : null;
  const [lastCpuSample, setLastCpuSample] = useState<typeof ready>(null);
  useEffect(() => {
    if (ready && ready.compared > 0 && ready.byCpu.length > 0) setLastCpuSample(ready);
  }, [ready]);
  const waitingForCpu = sort === 'cpuPercent' && Boolean(ready && ready.readable > 0 && ready.compared === 0);
  const showingPreviousCpu = waitingForCpu && Boolean(lastCpuSample);
  const displayed = showingPreviousCpu ? lastCpuSample : ready;
  const stale = query.isError || Boolean(ready?.stale) || showingPreviousCpu;
  const rows = displayed ? (sort === 'cpuPercent' ? displayed.byCpu : displayed.byMemory) : [];
  const maximum = Math.max(1, ...rows.map((row) => row[sort] ?? 0));
  const heading = useRef<HTMLHeadingElement>(null);
  const retry = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (query.isFetching || !restoreFocus.current) return;
    restoreFocus.current = false;
    if (document.activeElement !== document.body && document.activeElement !== retry.current) return;
    (ready && !query.isError ? heading.current : retry.current)?.focus({ preventScroll: true });
  }, [query.isFetching, query.isError, ready]);

  return (
    <section className="host-processes" id="processes" aria-labelledby="host-processes-title">
      <header className="host-processes-heading">
        <h2 id="host-processes-title" tabIndex={-1} ref={heading}>
          Host processes
        </h2>
        <span className="host-processes-state" data-stale={stale}>
          {ready ? (stale ? 'Readings delayed' : 'Updates every 10 seconds') : 'CPU and resident memory'}
        </span>
      </header>
      <fieldset className="container-resources-sort host-processes-sort">
        <legend className="visually-hidden">Rank host processes by</legend>
        <button type="button" aria-pressed={sort === 'cpuPercent'} onClick={() => setSort('cpuPercent')}>
          CPU
        </button>
        <button type="button" aria-pressed={sort === 'memoryBytes'} onClick={() => setSort('memoryBytes')}>
          Memory
        </button>
        <span>Highest first</span>
      </fieldset>
      {query.isPending ? <output>Loading host processes…</output> : null}
      {query.isError || data?.available === false ? (
        <div className="host-processes-notice" role={query.isError ? 'alert' : 'status'}>
          <p>
            {query.isError ? 'Process readings could not be refreshed. Previous values may be stale.' : data?.available === false ? data.reason : ''}
          </p>
          <button
            type="button"
            className="btn btn-secondary"
            ref={retry}
            disabled={query.isFetching}
            onClick={() => {
              restoreFocus.current = document.activeElement === retry.current;
              void query.refetch();
            }}
          >
            {query.isFetching ? 'Checking…' : 'Retry'}
          </button>
        </div>
      ) : null}
      {displayed ? (
        <>
          {stale ? (
            <output className="host-processes-stale">
              {showingPreviousCpu ? 'CPU comparisons are pending. Previous sample: ' : 'Last process sample: '}
              <time dateTime={displayed.sampledAt}>{new Date(displayed.sampledAt).toLocaleString()}</time>.
              {showingPreviousCpu ? ' Select Memory for current memory readings.' : ' Values may be stale.'}
            </output>
          ) : null}
          {displayed.readable === 0 ? (
            <p>No readable host processes.</p>
          ) : rows.length === 0 ? (
            <output>Collecting CPU comparisons… Select Memory to see current readings.</output>
          ) : null}
          {displayed.limited || displayed.unreadable > 0 ? (
            <p className="host-processes-coverage">
              {displayed.limited ? `Scan limited to ${displayed.scanned.toLocaleString()} processes; this ranking may omit other processes. ` : ''}
              {displayed.unreadable
                ? `${displayed.unreadable.toLocaleString()} ${displayed.unreadable === 1 ? 'process could' : 'processes could'} not be read; they may have exited or be restricted.`
                : ''}
            </p>
          ) : null}
          <ol className="host-process-list">
            {rows.map((row) => (
              <li key={row.pid} data-process-pid={row.pid}>
                <div className="host-process-identity">
                  <strong title={row.name}>
                    <bdi>{row.name}</bdi>
                  </strong>
                  <span>PID {row.pid}</span>
                </div>
                <dl className="host-process-values">
                  <div>
                    <dt>CPU</dt>
                    <dd>{row.cpuPercent === null ? 'Pending' : `${row.cpuPercent.toFixed(1)}%`}</dd>
                  </div>
                  <div>
                    <dt>Memory</dt>
                    <dd>{resourceBytes(row.memoryBytes)}</dd>
                  </div>
                </dl>
                <div className="host-process-bar" aria-hidden="true">
                  <i style={{ width: `${((row[sort] ?? 0) / maximum) * 100}%` }} />
                </div>
              </li>
            ))}
          </ol>
          <p className="host-processes-coverage">
            {rows.length.toLocaleString()} shown · {displayed.readable.toLocaleString()} readable processes
            {sort === 'cpuPercent' ? ` · ${displayed.compared.toLocaleString()} CPU comparisons` : ''}
          </p>
        </>
      ) : null}
      <details className="host-processes-about">
        <summary>About these readings</summary>
        <p>CPU: 100% is one core. Rankings need two recent samples of the same process.</p>
        <p>
          Memory is resident memory (RSS). It is approximate and can include shared pages. Processes inside containers also appear here, so their
          readings overlap the Docker list.
        </p>
      </details>
    </section>
  );
}
