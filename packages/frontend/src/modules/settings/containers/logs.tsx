import { useSSE } from '@/lib/hooks/use-sse';
import { Suspense, lazy, useRef, useState } from 'react';

const LogsTerminal = lazy(() => import('@/components/logs-terminal/logs-terminal').then((module) => ({ default: module.LogsTerminal })));

export const LogsContainer = () => {
  const nextId = useRef(0);
  const [logs, setLogs] = useState<{ id: number; text: string }[]>([]);
  const maxLines = useRef(300);

  useSSE({
    topic: 'runtipi-logs',
    params: new URLSearchParams({ maxLines: maxLines.current.toString() }),
    onOpen: () => setLogs([]),
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
    <Suspense>
      <LogsTerminal logs={logs} maxLines={maxLines.current} onMaxLinesChange={updateMaxLines} />
    </Suspense>
  );
};
