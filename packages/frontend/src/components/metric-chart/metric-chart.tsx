import { useMemo } from 'react';
import type { MetricHistory } from '@runtipi/common/schemas';
import { MetricPlot, formatPlotValue, type MetricPlotHistory } from './metric-plot';

type Field = 'cpu' | 'memory' | 'download' | 'upload';
export const formatMetricValue = (value: number | null, field: Field) =>
  formatPlotValue(value, field === 'cpu' || field === 'memory' ? 'percent' : 'bytesPerSecond');

export function MetricChart({
  history,
  field,
  label,
  color,
  loading = false,
}: {
  history?: MetricHistory;
  field: Field;
  label: string;
  color: string;
  loading?: boolean;
}) {
  const plot = useMemo<MetricPlotHistory | undefined>(
    () =>
      history
        ? {
            from: history.from,
            to: history.to,
            points: history.points.map((point) => ({
              at: point.at,
              until: point.until,
              intervalSeconds: point.intervalSeconds,
              samples: point.samples,
              value: point[field],
              ...(field === 'cpu'
                ? {
                    identity: point.cpuScope,
                    source: point.cpuScope === 'host-proc' ? 'Host CPU' : point.cpuScope === 'runtime' ? 'Core CPU' : 'CPU source changed',
                  }
                : {}),
            })),
          }
        : undefined,
    [history, field],
  );
  return (
    <MetricPlot
      history={plot}
      metricKey={field}
      unit={field === 'cpu' || field === 'memory' ? 'percent' : 'bytesPerSecond'}
      label={label}
      color={color}
      loading={loading}
    />
  );
}
