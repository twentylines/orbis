import { useEffect, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { ContainerResources } from '@/components/container-resources/container-resources';
import { HostProcessesView } from './host-processes';

export function MonitorUsage() {
  const location = useLocation();
  const [source, setSource] = useState<'containers' | 'processes'>(() => (location.hash === '#processes' ? 'processes' : 'containers'));
  const [allContainers, setAllContainers] = useState(true);
  useEffect(() => {
    if (location.hash === '#processes') setSource('processes');
    if (location.hash === '#containers') {
      setSource('containers');
      setAllContainers(true);
    }
  }, [location.hash]);
  return (
    <div className="monitor-usage-panel">
      <fieldset className="monitor-usage-source">
        <legend className="visually-hidden">Resource usage</legend>
        <button type="button" aria-pressed={source === 'containers'} onClick={() => setSource('containers')}>
          Containers
        </button>
        <button type="button" aria-pressed={source === 'processes'} onClick={() => setSource('processes')}>
          Host processes
        </button>
      </fieldset>
      {source === 'processes' ? <p className="monitor-usage-scope">CPU: 100% is one core. Host process and container readings overlap.</p> : null}
      {source === 'containers' ? (
        <>
          <ContainerResources compact={!allContainers} />
          <button className="monitor-detail-action" type="button" aria-expanded={allContainers} onClick={() => setAllContainers((value) => !value)}>
            {allContainers ? 'Show top running containers' : 'Browse containers and health'}
          </button>
          {allContainers ? null : <p className="monitor-usage-scope">Top four running containers, ordered by the selected metric.</p>}
        </>
      ) : (
        <HostProcessesView limit={6} />
      )}
    </div>
  );
}

export function MonitorDisclosure({ title, openRequest, children }: { title: string; openRequest?: string; children: ReactNode }) {
  const [open, setOpen] = useState(Boolean(openRequest));
  useEffect(() => {
    if (openRequest) setOpen(true);
  }, [openRequest]);
  return (
    <details className="monitor-detail-disclosure" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{title}</summary>
      {open ? <div className="monitor-disclosure-content">{children}</div> : null}
    </details>
  );
}
