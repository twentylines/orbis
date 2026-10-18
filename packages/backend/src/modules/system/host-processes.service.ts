import { Injectable } from '@nestjs/common';
import type { HostProcess, HostProcesses } from '@runtipi/common/schemas';
import { readHostSocket } from './host-socket';

const unavailable = (reason = 'Process readings are unavailable. Check the Orbis host service.'): HostProcesses => ({ available: false, reason });

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid process reading');
  return value as Record<string, unknown>;
}
function count(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) throw new Error('Invalid process count');
  return value;
}

export function parseHostProcesses(value: unknown, now = Date.now()): HostProcesses {
  const data = record(value);
  if (data.available === false) return unavailable(data.reason === 'Collecting process readings.' ? data.reason : undefined);
  if (data.available !== true || typeof data.stale !== 'boolean' || typeof data.limited !== 'boolean') throw new Error('Invalid process sample');
  const sampledAt = data.sampledAt;
  const timestamp =
    typeof sampledAt === 'string' && sampledAt.length <= 40 && /^\d{4}-\d{2}-\d{2}T/.test(sampledAt) ? Date.parse(sampledAt) : Number.NaN;
  if (typeof sampledAt !== 'string' || !Number.isFinite(timestamp) || timestamp > now + 5000) throw new Error('Invalid process timestamp');
  const scanned = count(data.scanned, 8192);
  const readable = count(data.readable, scanned);
  const unreadable = count(data.unreadable, scanned);
  const compared = count(data.compared, readable);
  if (readable + unreadable !== scanned) throw new Error('Invalid process coverage');
  const shared = new Map<number, HostProcess>();
  const rows = (value: unknown, metric: 'cpuPercent' | 'memoryBytes', total: number): HostProcess[] => {
    if (!Array.isArray(value) || value.length !== Math.min(20, total)) throw new Error('Invalid process ranking size');
    const seen = new Set<number>();
    const parsed = value.map((value) => {
      const row = record(value);
      const pid = count(row.pid, 2 ** 31 - 1);
      const name = row.name;
      const cpuPercent = row.cpuPercent;
      if (
        !pid ||
        seen.has(pid) ||
        typeof name !== 'string' ||
        !name.length ||
        Array.from(name).length > 64 ||
        Array.from(name).some((character) => character !== ' ' && /[\p{C}\p{Z}]/u.test(character)) ||
        (cpuPercent !== null &&
          (typeof cpuPercent !== 'number' || !Number.isFinite(cpuPercent) || cpuPercent < 0 || cpuPercent > Number.MAX_SAFE_INTEGER)) ||
        (metric === 'cpuPercent' && cpuPercent === null)
      )
        throw new Error('Invalid process row');
      seen.add(pid);
      const result: HostProcess = { pid, name, cpuPercent: cpuPercent as number | null, memoryBytes: count(row.memoryBytes) };
      const prior = shared.get(pid);
      if (prior && JSON.stringify(prior) !== JSON.stringify(result)) throw new Error('Inconsistent process rankings');
      shared.set(pid, result);
      return result;
    });
    for (let index = 1; index < parsed.length; index++) {
      const prior = parsed[index - 1];
      const row = parsed[index];
      if (!prior || !row || (prior[metric] ?? -1) < (row[metric] ?? -1) || (prior[metric] === row[metric] && prior.pid > row.pid))
        throw new Error('Unordered process ranking');
    }
    return parsed;
  };
  const byCpu = rows(data.byCpu, 'cpuPercent', compared);
  const byMemory = rows(data.byMemory, 'memoryBytes', readable);
  if (shared.size > readable || [...shared.values()].filter((row) => row.cpuPercent !== null).length > compared)
    throw new Error('Inconsistent process coverage');
  return {
    available: true,
    sampledAt,
    stale: data.stale || now - timestamp > 30_000,
    scanned,
    readable,
    unreadable,
    compared,
    limited: data.limited,
    byCpu,
    byMemory,
  };
}

@Injectable()
export class HostProcessesService {
  private readonly socketPath = process.env.ORBIS_HOST_SOCKET;
  private cached: { expiresAt: number; result: HostProcesses } | null = null;
  private pending: Promise<HostProcesses> | null = null;

  read(): Promise<HostProcesses> {
    if (this.cached && this.cached.expiresAt > Date.now()) return Promise.resolve(this.cached.result);
    if (!this.pending) {
      this.pending = readHostSocket(this.socketPath, '/v1/processes', parseHostProcesses, (reason) =>
        unavailable(
          reason === 'missing'
            ? 'Connect the Orbis host service to see processes.'
            : reason === 'older'
              ? 'Update the Orbis host service to see processes.'
              : undefined,
        ),
      )
        .catch(() => unavailable())
        .then((result) => {
          const warming = !result.available || (result.readable > 0 && result.compared === 0);
          this.cached = { expiresAt: Date.now() + (warming ? 2000 : 10_000), result };
          return result;
        })
        .finally(() => {
          this.pending = null;
        });
    }
    return this.pending;
  }
}
