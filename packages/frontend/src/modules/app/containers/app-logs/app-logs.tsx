import { useSSE } from '@/lib/hooks/use-sse';
import { Suspense, lazy, useRef, useState } from 'react';

const LogsTerminal = lazy(() => import('@/components/logs-terminal/logs-terminal').then((module) => ({ default: module.LogsTerminal })));

export const AppLogs = ({ appUrn }: { appUrn: string }) => {
  const nextId = useRef(0);
  const [logs, setLogs] = useState<{ id: number; text: string }[]>([]);
  const maxLines = useRef(300);

  const status = useSSE({
    topic: 'app-logs',
    params: new URLSearchParams({ appUrn, maxLines: maxLines.current.toString() }),
    onEvent: (data) => {
      setLogs((prevLogs) => {
        if (!data.lines) {
          return prevLogs;
        }
        const newLogs = [...prevLogs, ...data.lines.map((line) => ({ id: nextId.current++, text: line.trim() }))];
        if (newLogs.length > maxLines.current) {
          return newLogs.slice(newLogs.length - maxLines.current);
        }
        return newLogs;
      });
    },
  });

  const updateMaxLines = (lines: number) => {
    const linesToKeep = Math.min(1000, Math.max(1, Number.isFinite(lines) ? Math.floor(lines) : 300));
    maxLines.current = linesToKeep;
    setLogs((currentLogs) => currentLogs.slice(currentLogs.length - linesToKeep));
  };

  return (
    <Suspense fallback={<output>Loading container logs…</output>}>
      <div className="card">
        <div className="card-body">
          <output className="app-log-connection">
            {status === 'connected'
              ? 'Live container output'
              : status === 'reconnecting'
                ? 'Connection interrupted. Reconnecting…'
                : status === 'disconnected'
                  ? 'Container logs disconnected. Focus this window or reconnect to the network to retry.'
                  : 'Connecting to container logs…'}
          </output>
          {status === 'connected' && !logs.length ? <p className="app-panel-caption">Waiting for container output.</p> : null}
          <LogsTerminal logs={logs} maxLines={maxLines.current} onMaxLinesChange={updateMaxLines} />
        </div>
      </div>
    </Suspense>
  );
};
