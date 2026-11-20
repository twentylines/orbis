import type { Telemetry } from '@/desktop/telemetry';

export type ProcessorSample = { at: number; identity: string; values: (number | null)[] };
export const processorWindowMs = 60_000;

export function appendProcessorSample(previous: ProcessorSample[], sample: Telemetry): ProcessorSample[] {
  const at = Date.parse(sample.sampledAt);
  if (!Number.isFinite(at)) return previous;
  const values = sample.cpu.perCorePercent.map((value) => (value !== null && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null));
  const identity = `${sample.cpu.scope}:${sample.cpu.model ?? ''}:${values.length}`;
  const last = previous.at(-1);
  const sameSource = last?.identity === identity;
  if (sameSource && last.at >= at) return previous;
  const recent = sameSource ? previous.filter((point) => at - point.at <= processorWindowMs) : [];
  return [...recent, { at, identity, values }].slice(-61);
}

export function processorChartSegments(samples: ProcessorSample[], index: number, until: number): string[] {
  const lines: string[][] = [];
  let previous: ProcessorSample | undefined;
  for (const point of samples) {
    if (point.at < until - processorWindowMs || point.at > until) continue;
    const value = point.values[index];
    if (value == null) {
      previous = undefined;
      continue;
    }
    if (!previous || point.at - previous.at > 2500 || point.identity !== previous.identity) lines.push([]);
    const x = 200 * (1 - (until - point.at) / processorWindowMs);
    const y = 76 - (value / 100) * 72;
    lines.at(-1)?.push(`${x.toFixed(2)},${y.toFixed(2)}`);
    previous = point;
  }
  return lines.map((line) => line.join(' '));
}
