import type { Telemetry } from '@/desktop/telemetry';

export type ProcessorSample = { at: number; identity: string; values: (number | null)[] };
export const processorWindowMs = 60_000;
export const percentReading = (value: number | null) => (value !== null && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null);
export const rateReading = (value: number | null) => (value !== null && Number.isFinite(value) && value >= 0 ? value : null);

export function appendProcessorSample(previous: ProcessorSample[], sample: Telemetry): ProcessorSample[] {
  const values = sample.cpu.perCorePercent.map((value) => (sample.cpu.scope === 'host-proc' ? percentReading(value) : null));
  return appendLiveSample(previous, sample.sampledAt, JSON.stringify([sample.cpu.scope, sample.cpu.model, values.length]), values);
}

export function appendLiveSample(previous: ProcessorSample[], sampledAt: string, identity: string, values: (number | null)[]): ProcessorSample[] {
  const at = Date.parse(sampledAt);
  if (!Number.isFinite(at)) return previous;
  const last = previous.at(-1);
  const sameSource = last?.identity === identity;
  if (sameSource && last.at >= at) return previous;
  const recent = sameSource ? previous.filter((point) => at - point.at <= processorWindowMs) : [];
  return [...recent, { at, identity, values }].slice(-61);
}

export function processorChartSegments(samples: ProcessorSample[], index: number, until: number, maximum = 100, gapMs = 2500): string[] {
  const lines: string[][] = [];
  let previous: ProcessorSample | undefined;
  for (const point of samples) {
    if (point.at < until - processorWindowMs || point.at > until) continue;
    const value = point.values[index];
    if (value == null) {
      previous = undefined;
      continue;
    }
    if (!previous || point.at - previous.at > gapMs || point.identity !== previous.identity) lines.push([]);
    const x = 200 * (1 - (until - point.at) / processorWindowMs);
    const y = 76 - (value / maximum) * 72;
    lines.at(-1)?.push(`${x.toFixed(2)},${y.toFixed(2)}`);
    previous = point;
  }
  return lines.map((line) => line.join(' '));
}
