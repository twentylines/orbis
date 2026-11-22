import { readHostSocket } from './host-socket';

const maximumAge = 3000;
const maximumLogicalProcessors = 256;

type SentinelSystemReadings = {
  sampledAt: number;
  cpu: {
    scope: 'host-proc';
    model: string;
    reportedClockGHz: number;
    totalPercent: number;
    perCorePercent: number[];
    uptimeSeconds: number;
  };
  memory: {
    scope: 'host-proc';
    totalBytes: number;
    availableBytes: number;
    swapTotalBytes: number;
    swapFreeBytes: number;
  };
};

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).length === keys.length &&
      keys.every((key) => Object.hasOwn(value, key)),
  );
}

const bounded = (value: unknown, maximum: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum;
const counter = (value: unknown): value is number => bounded(value, Number.MAX_SAFE_INTEGER) && Number.isInteger(value);
export const freshSentinelSample = (sampledAt: number, now = Date.now()) => sampledAt <= now && now - sampledAt <= maximumAge;

export function parseSentinelSystemReadings(value: unknown, now = Date.now()): SentinelSystemReadings | null {
  if (
    !exact(value, ['schema', 'state', 'ageMs', 'sample']) ||
    value.schema !== 'orbis-sentinel.system-readings.v1' ||
    value.state !== 'ready' ||
    !counter(value.ageMs) ||
    value.ageMs > maximumAge
  )
    return null;
  const sample = value.sample;
  if (
    !exact(sample, ['sampledAt', 'cpu', 'memory']) ||
    !counter(sample.sampledAt) ||
    sample.sampledAt === 0 ||
    !freshSentinelSample(sample.sampledAt, now)
  )
    return null;
  const { cpu, memory, sampledAt } = sample;
  if (
    !exact(cpu, ['model', 'reportedClockGHz', 'totalPercent', 'perCorePercent', 'uptimeSeconds']) ||
    !exact(memory, ['totalBytes', 'availableBytes', 'swapTotalBytes', 'swapFreeBytes'])
  )
    return null;
  const { model, reportedClockGHz, totalPercent, perCorePercent, uptimeSeconds } = cpu;
  const { totalBytes, availableBytes, swapTotalBytes, swapFreeBytes } = memory;
  if (
    typeof model !== 'string' ||
    model.length === 0 ||
    model.length > 200 ||
    model !== model.trim() ||
    Array.from(model).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
    !bounded(reportedClockGHz, 100) ||
    reportedClockGHz === 0 ||
    !bounded(totalPercent, 100) ||
    !bounded(uptimeSeconds, Number.MAX_SAFE_INTEGER) ||
    !Array.isArray(perCorePercent) ||
    perCorePercent.length === 0 ||
    perCorePercent.length > maximumLogicalProcessors ||
    !perCorePercent.every((value) => bounded(value, 100)) ||
    !counter(totalBytes) ||
    totalBytes === 0 ||
    !counter(availableBytes) ||
    availableBytes > totalBytes ||
    !counter(swapTotalBytes) ||
    !counter(swapFreeBytes) ||
    swapFreeBytes > swapTotalBytes
  )
    return null;
  return {
    sampledAt,
    cpu: { scope: 'host-proc', model, reportedClockGHz, totalPercent, perCorePercent: [...perCorePercent], uptimeSeconds },
    memory: { scope: 'host-proc', totalBytes, availableBytes, swapTotalBytes, swapFreeBytes },
  };
}

export async function readSentinelSystemReadings(socketPath = process.env.ORBIS_HOST_SOCKET): Promise<SentinelSystemReadings | null> {
  try {
    return await readHostSocket(socketPath, '/v1/sentinel/system-readings', parseSentinelSystemReadings, () => null);
  } catch {
    return null;
  }
}
