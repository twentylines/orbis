import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Injectable, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { metricHistoryRanges, type HostDeviceHistory, type HostHistorySelection, type MetricHistoryRange } from '@runtipi/common/schemas';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { HostTelemetryService } from './host-telemetry.service';
import { installationHeld } from '@/common/installation-mode';
import {
  decodeHostHistory,
  encodeHostHistory,
  hostHistoryBucket,
  hostHistoryKey,
  hostHistoryPoint,
  hostHistorySample,
  hostHistoryTiers,
  mergeHostHistory,
  type HostHistoryBucket,
  type HostHistoryTier,
} from './host-device-history.model';

const fileLimit = 32 * 1024 * 1024;
const recordLimit = 4096;
const seriesLimit = 64;
type Device = HostHistorySelection & { lastSeenAt: number };
const bucketKey = (bucket: HostHistoryBucket) => `${bucket.seconds}:${bucket.bucketAt}`;

@Injectable()
export class HostDeviceHistoryService implements OnModuleInit, OnModuleDestroy {
  private readonly buckets = new Map(hostHistoryTiers.map(({ seconds }) => [seconds, new Map<number, HostHistoryBucket>()]));
  private readonly devices = new Map<string, Device>();
  private readonly current = new Map<HostHistoryTier, number>();
  private readonly queued = new Map<string, HostHistoryBucket>();
  private present = new Set<string>();
  private recent: HostHistoryBucket[] = [];
  private restoredPartial?: HostHistoryBucket;
  private timer?: ReturnType<typeof setInterval>;
  private loading?: Promise<void>;
  private pending?: Promise<void>;
  private writer?: Promise<void>;
  private writerStartedAt: number | null = null;
  private lastSampleAt: number | null = null;
  private persistedThrough: number | null = null;
  private storage: HostDeviceHistory['storage'] = 'persistent';
  private collectorAvailable = false;
  private reason: string | null = 'Waiting for host readings.';
  private unidentifiedDevices = 0;
  private omittedDevices = 0;
  private evictedDevices = 0;
  private unreadable = false;
  private needsCompact = false;
  private writesSinceCompact = 0;
  private closed = false;

  constructor(
    private readonly host: HostTelemetryService,
    private readonly config: ConfigurationService,
    private readonly logger: LoggerService,
  ) {}

  async onModuleInit() {
    if (installationHeld()) return;
    await this.load();
    this.timer = setInterval(() => void this.collect(), 10000);
    this.timer.unref();
    void this.collect();
  }

  async onModuleDestroy() {
    this.closed = true;
    clearInterval(this.timer);
    await this.pending;
    this.queueCurrent();
    await this.writer;
  }

  private file() {
    return path.join(this.config.get('directories').dataDir, 'state', 'orbis-host-history', 'devices-v1.jsonl');
  }

  private async privateDirectory(create: boolean) {
    const directory = path.dirname(this.file());
    if (create) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077) throw new Error('History directory is not private');
  }

  private load() {
    this.loading ??= this.readStored();
    return this.loading;
  }

  private async readStored() {
    try {
      await this.privateDirectory(false);
      const handle = await fs.open(this.file(), constants.O_RDONLY | constants.O_NOFOLLOW);
      let contents: string;
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.mode & 0o077 || stat.size > fileLimit) throw new Error('History file is not a bounded private file');
        contents = await handle.readFile('utf8');
      } finally {
        await handle.close();
      }
      const lines = contents.split('\n').filter(Boolean);
      if (lines.length > recordLimit) throw new Error('History record count exceeds its bound');
      let records = 0;
      for (const line of lines) {
        if (Buffer.byteLength(line) > 256 * 1024) throw new Error('History record exceeds its bound');
        const { bucket, evictedDevices } = decodeHostHistory(JSON.parse(line), Date.now());
        const tier = this.buckets.get(bucket.seconds);
        if (!tier) throw new Error('Unknown history tier');
        const previous = tier.get(bucket.bucketAt);
        if (previous && previous.lastAt > bucket.lastAt) throw new Error('History record moved backwards');
        tier.set(bucket.bucketAt, bucket);
        this.register(bucket);
        this.enforceSeriesLimit(false);
        this.evictedDevices = Math.max(this.evictedDevices, evictedDevices);
        this.persistedThrough = Math.max(this.persistedThrough ?? 0, bucket.lastAt);
        records++;
      }
      this.lastSampleAt = this.persistedThrough;
      this.prune();
      this.needsCompact ||= records !== this.allBuckets().length;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      this.unreadable = true;
      this.storage = 'unavailable';
      this.lastSampleAt = this.persistedThrough;
      this.prune();
      this.logger.warn('Host device history could not be loaded. Existing data is preserved; collection continues in memory.');
    }
  }

  private register(bucket: HostHistoryBucket) {
    for (const [key, row] of bucket.rows) {
      const prior = this.devices.get(key);
      if (!prior || prior.lastSeenAt < row.lastAt) this.devices.set(key, { kind: row.kind, name: row.name, lastSeenAt: row.lastAt });
    }
  }

  private forget(keys: string[]) {
    if (!keys.length) return;
    for (const key of keys) this.devices.delete(key);
    for (const bucket of [...this.allBuckets(), ...this.recent, ...(this.restoredPartial ? [this.restoredPartial] : [])])
      for (const key of keys) bucket.rows.delete(key);
    for (const bucket of this.queued.values()) for (const key of keys) bucket.rows.delete(key);
  }

  private enforceSeriesLimit(countEvictions: boolean) {
    if (this.devices.size <= seriesLimit) return;
    const oldest = [...this.devices.entries()]
      .sort(([a, left], [b, right]) => left.lastSeenAt - right.lastSeenAt || a.localeCompare(b))
      .slice(0, this.devices.size - seriesLimit)
      .map(([key]) => key);
    this.forget(oldest);
    if (countEvictions) this.evictedDevices = Math.min(Number.MAX_SAFE_INTEGER, this.evictedDevices + oldest.length);
    this.needsCompact = true;
  }

  private allBuckets() {
    return [...this.buckets.values()].flatMap((tier) => [...tier.values()]);
  }

  private prune() {
    const now = Date.now();
    for (const { seconds, retentionMs } of hostHistoryTiers) {
      const tier = this.buckets.get(seconds);
      if (!tier) continue;
      for (const [key, bucket] of tier) if (bucket.lastAt < now - retentionMs) tier.delete(key);
      const limit = Math.ceil(retentionMs / (seconds * 1000)) + 1;
      for (const key of [...tier.keys()].sort((a, b) => a - b).slice(0, Math.max(0, tier.size - limit))) tier.delete(key);
    }
    this.recent = this.recent.filter((bucket) => bucket.lastAt >= now - 300000).slice(-31);
    if (this.restoredPartial && this.restoredPartial.lastAt < now - 300000) this.restoredPartial = undefined;
    this.forget([...this.devices].filter(([, device]) => device.lastSeenAt < now - 604800000).map(([key]) => key));
    for (const [key, bucket] of this.queued) if (!this.buckets.get(bucket.seconds)?.has(bucket.bucketAt)) this.queued.delete(key);
  }

  private queueCurrent() {
    if (this.unreadable) return;
    for (const [seconds, at] of this.current) {
      const bucket = this.buckets.get(seconds)?.get(at);
      if (bucket) this.queued.set(bucketKey(bucket), bucket);
    }
    if (this.queued.size && !this.writer) {
      this.writerStartedAt = Date.now();
      this.writer = this.drain().finally(() => {
        this.writer = undefined;
        this.writerStartedAt = null;
      });
    }
  }

  private async drain() {
    while (this.queued.size) {
      const batch = new Map(this.queued);
      const temporary = `${this.file()}.${randomUUID()}.tmp`;
      try {
        await this.privateDirectory(true);
        let bytes = 0;
        try {
          const stat = await fs.lstat(this.file());
          if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077 || stat.size > fileLimit)
            throw new Error('History file is not a bounded private file');
          bytes = stat.size;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        let written = [...batch.values()];
        let contents = written.map((bucket) => `${encodeHostHistory(bucket, this.evictedDevices)}\n`).join('');
        const compact = this.needsCompact || this.writesSinceCompact >= 60 || bytes + Buffer.byteLength(contents) > fileLimit;
        if (compact) {
          written = this.allBuckets().sort((a, b) => a.seconds - b.seconds || a.bucketAt - b.bucketAt);
          contents = written.map((bucket) => `${encodeHostHistory(bucket, this.evictedDevices)}\n`).join('');
        }
        if (Buffer.byteLength(contents) > fileLimit) throw new Error('History retention exceeds its storage bound');
        const through = written.length ? Math.max(...written.map((bucket) => bucket.lastAt)) : null;
        if (compact) {
          await fs.writeFile(temporary, contents, { mode: 0o600, flag: 'wx' });
          await fs.rename(temporary, this.file());
          this.writesSinceCompact = 0;
          this.needsCompact = false;
        } else {
          const handle = await fs.open(this.file(), constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
          try {
            await handle.writeFile(contents);
          } finally {
            await handle.close();
          }
          this.writesSinceCompact++;
        }
        if (through !== null) this.persistedThrough = Math.max(this.persistedThrough ?? 0, through);
        this.storage = 'persistent';
        for (const [key, bucket] of batch) if (this.queued.get(key) === bucket) this.queued.delete(key);
      } catch {
        if (this.storage !== 'unavailable') this.logger.warn('Host device history could not be saved. Recent readings remain in memory.');
        this.storage = 'unavailable';
        this.needsCompact = true;
        return;
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => undefined);
      }
    }
  }

  collect(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.pending ??= this.sample().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async sample() {
    await this.load();
    try {
      const data = await this.host.read();
      if (this.closed) return;
      const sample = hostHistorySample(data, Date.now());
      if (!sample) {
        this.collectorAvailable = false;
        this.reason = data.available ? 'Host readings are delayed.' : data.reason;
        return;
      }
      this.unidentifiedDevices = sample.unidentified;
      this.omittedDevices = data.available ? Math.min(Number.MAX_SAFE_INTEGER, data.omitted.network + data.omitted.disks) : 0;
      const missing = data.available ? [...new Set(data.unavailable.filter((group) => group === 'network' || group === 'disks'))] : [];
      this.collectorAvailable = Boolean(sample.rows.length || (sample.unidentified === 0 && missing.length === 0));
      const issues: string[] = [];
      if (missing.length) issues.push(`Host ${missing.map((group) => (group === 'disks' ? 'disk' : group)).join(' and ')} readings are unavailable.`);
      if (sample.unidentified) issues.push('Some devices need an updated host service or a readable kernel identity before history can be recorded.');
      this.reason = issues.length ? issues.join(' ') : null;
      this.present = new Set(sample.rows.map(hostHistoryKey));
      if (this.lastSampleAt !== null && sample.at - this.lastSampleAt < 2000) return;
      this.prune();
      const minuteAt = Math.floor(sample.at / 60000) * 60000;
      if (this.current.has(60) && this.current.get(60) !== minuteAt) this.queueCurrent();
      const priorMinute = this.buckets.get(60)?.get(minuteAt);
      if (!this.recent.length && priorMinute && priorMinute.lastAt < sample.at) this.restoredPartial = priorMinute;
      const recent = hostHistoryBucket(sample, 60);
      this.register(recent);
      this.enforceSeriesLimit(true);
      for (const { seconds } of hostHistoryTiers) {
        const bucket = hostHistoryBucket(sample, seconds);
        const tier = this.buckets.get(seconds);
        if (!tier) throw new Error('Unknown host history tier');
        const prior = tier.get(bucket.bucketAt);
        tier.set(bucket.bucketAt, prior ? mergeHostHistory(prior, bucket) : bucket);
        this.current.set(seconds, bucket.bucketAt);
      }
      this.recent.push(recent);
      this.lastSampleAt = sample.at;
      this.prune();
    } catch {
      this.collectorAvailable = false;
      this.reason = 'Host device history collection is interrupted. Missing readings remain gaps.';
    }
  }

  async read(range: MetricHistoryRange, selection: HostHistorySelection | null = null): Promise<HostDeviceHistory> {
    await this.load();
    this.prune();
    const now = Date.now();
    const { seconds, resolutionSeconds } = metricHistoryRanges[range];
    const from = now - seconds * 1000;
    const devices = [...this.devices.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
    const selected = selection ?? (devices[0] ? { kind: devices[0].kind, name: devices[0].name } : null);
    const key = selected ? hostHistoryKey(selected) : null;
    let buckets: { bucket: HostHistoryBucket; interval: number }[];
    if (range === '5m') {
      const first = this.recent[0]?.bucketAt ?? Number.POSITIVE_INFINITY;
      buckets = [...(this.buckets.get(60)?.values() ?? [])].filter((bucket) => bucket.bucketAt < first).map((bucket) => ({ bucket, interval: 60 }));
      if (this.restoredPartial?.bucketAt === first) buckets.push({ bucket: this.restoredPartial, interval: 60 });
      buckets.push(...this.recent.map((bucket) => ({ bucket, interval: 10 })));
    } else {
      buckets = [...(this.buckets.get(resolutionSeconds as HostHistoryTier)?.values() ?? [])].map((bucket) => ({
        bucket,
        interval: resolutionSeconds,
      }));
    }
    const collectorAvailable =
      this.collectorAvailable && this.lastSampleAt !== null && now - this.lastSampleAt >= 0 && now - this.lastSampleAt < 30000;
    return {
      range,
      from: new Date(from).toISOString(),
      to: new Date(now).toISOString(),
      resolutionSeconds,
      sampledEverySeconds: 10,
      retentionDays: 7,
      seriesLimit: 64,
      storage: this.writerStartedAt !== null && now - this.writerStartedAt > 10000 ? 'unavailable' : this.storage,
      collectorAvailable,
      reason: collectorAvailable ? this.reason : (this.reason ?? 'Host readings are delayed.'),
      unidentifiedDevices: this.unidentifiedDevices,
      omittedDevices: this.omittedDevices,
      evictedDevices: this.evictedDevices,
      lastSampleAt: this.lastSampleAt === null ? null : new Date(this.lastSampleAt).toISOString(),
      persistedThrough: this.persistedThrough === null ? null : new Date(this.persistedThrough).toISOString(),
      devices: devices.map((device) => ({
        ...device,
        lastSeenAt: new Date(device.lastSeenAt).toISOString(),
        present: collectorAvailable && this.present.has(hostHistoryKey(device)),
      })),
      selected,
      points: buckets
        .filter(({ bucket }) => bucket.lastAt >= from && bucket.firstAt <= now)
        .sort((a, b) => a.bucket.firstAt - b.bucket.firstAt)
        .flatMap(({ bucket, interval }) => {
          const row = key ? bucket.rows.get(key) : undefined;
          return row ? [hostHistoryPoint(row, interval)] : [];
        })
        .slice(-720),
    };
  }
}
