import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BadRequestException, Injectable, ServiceUnavailableException, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { type } from 'arktype';
import { gt, valid } from 'semver';
import { releaseAllowedOnChannel } from '@runtipi/common/schemas/orbis-release-channel';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { MonitoringActivityService } from '@/core/monitoring/monitoring-activity.service';
import { installationMode } from '@/common/installation-mode';
import { enterBackupMutation } from '@/common/backup-maintenance';
import { backupDiskActive } from '@/common/backup-disk';
import { castAppUrn } from '@/common/helpers/app-helpers';
import { AppsRepository } from '../apps/apps.repository';
import { MarketplaceService } from '../marketplace/marketplace.service';
import { AppLifecycleService } from '../app-lifecycle/app-lifecycle.service';
import { OrbisReleaseService } from '../system/orbis-release.service';
import { OrbisReleaseChannelsService } from '../system/orbis-release-channels.service';
import { HostUpdatesService, type HostUpdateStatus } from './host-updates.service';
import {
  automaticUpdateStateSchema,
  dailyUpdateSlot,
  parseAppUpdateRule,
  parseAutomaticSettings,
  type AutomaticUpdateAttempt,
  type AutomaticUpdateState,
  systemUpdateSettingsSchema,
  systemUpdateStateSchema,
  type SystemUpdateState,
} from './automatic-updates.model';

const QUIET_MS = 10 * 60_000;
const normalApp = new Set(['running', 'stopped']);
const stableApp = new Set(['running', 'stopped', 'missing']);
const busyHost = new Set(['queued', 'running', 'recovering', 'interrupted']);

@Injectable()
export class AutomaticUpdatesService implements OnModuleInit, OnModuleDestroy {
  private state: AutomaticUpdateState;
  private loading?: Promise<void>;
  private writes: Promise<void> = Promise.resolve();
  private pending?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private storageError: string | null = null;
  private systemError: string | null = null;
  private system: SystemUpdateState = {
    version: 1,
    revision: 0,
    enabled: false,
    phase: null,
    settingsRevision: null,
    policyRevision: null,
    attempt: null,
    pauseReason: null,
  };
  private readonly startedAt = Date.now();

  constructor(
    private readonly config: ConfigurationService,
    private readonly host: HostUpdatesService,
    private readonly releases: OrbisReleaseService,
    private readonly activity: MonitoringActivityService,
    private readonly apps: AppsRepository,
    private readonly marketplace: MarketplaceService,
    private readonly lifecycle: AppLifecycleService,
    private readonly logger: LoggerService,
    private readonly channels: OrbisReleaseChannelsService,
  ) {
    this.state = {
      version: 1,
      revision: 0,
      settings: { orbis: { enabled: false, mode: 'idle' }, schedule: { time: '03:00', timezone: this.serverTimezone() } },
      rules: {},
      apps: {},
      orbis: null,
      pauseReason: null,
    };
  }

  private serverTimezone() {
    const validTimezone = (value: unknown): value is string => {
      if (typeof value !== 'string' || !value || value.length > 100) return false;
      try {
        new Intl.DateTimeFormat('en', { timeZone: value }).format();
        return true;
      } catch {
        return false;
      }
    };
    const configured = this.config.get('userSettings').timeZone;
    if (validTimezone(configured)) return configured;
    try {
      const system = new Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (validTimezone(system)) return system;
    } catch {
      // A server without usable system timezone data still has a deterministic daily schedule.
    }
    return 'UTC';
  }
  private effectiveSchedule() {
    return { time: this.state.settings.schedule.time, timezone: this.serverTimezone() };
  }
  private serverTime(timezone: string) {
    return { now: Date.now(), timezone };
  }

  async onModuleInit() {
    await this.load();
    this.ensureTimer();
  }
  onModuleDestroy() {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
  }
  private file() {
    return path.join(this.config.get('directories').dataDir, 'state', 'automatic-updates', 'settings.json');
  }
  private systemFile() {
    return path.join(path.dirname(this.file()), 'system.json');
  }
  private load() {
    this.loading ??= Promise.all([this.readStored(), this.readSystemStored()]).then(() => undefined);
    return this.loading;
  }
  private async readStored() {
    try {
      const stat = await fs.lstat(this.file());
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > 256 * 1024 ||
        (stat.mode & 0o077) !== 0 ||
        (process.getuid && stat.uid !== process.getuid())
      )
        throw new Error('Unsafe automatic update settings');
      const parsed = automaticUpdateStateSchema(JSON.parse(await fs.readFile(this.file(), 'utf8')));
      if (parsed instanceof type.errors) throw new Error('Invalid automatic update settings');
      this.state = parsed;
      const previous = this.state.orbis;
      const interrupted = previous && ['checking', 'planning', 'applying', 'accepted'].includes(previous.state);
      if (interrupted) {
        const done = previous?.targetTag === process.env.ORBIS_VERSION && ['applying', 'accepted'].includes(previous.state);
        await this.change((next) => {
          if (!next.orbis) return;
          next.orbis.state = done ? 'complete' : 'interrupted';
          next.orbis.message = done ? 'Orbis updated successfully.' : 'An earlier automatic update needs review in Updates.';
          if (!done) {
            next.settings.orbis.enabled = false;
            next.pauseReason = next.orbis.message;
            next.revision++;
          }
        }, false);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      this.storageError = 'Automatic update settings could not be read safely. Automatic updates are disabled.';
      this.state.settings.orbis.enabled = false;
      this.state.rules = {};
      this.logger.warn(this.storageError);
    }
  }

  private async readSystemStored() {
    try {
      const stat = await fs.lstat(this.systemFile());
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > 16 * 1024 ||
        (stat.mode & 0o077) !== 0 ||
        (process.getuid && stat.uid !== process.getuid())
      )
        throw new Error('Unsafe system update settings');
      const parsed = systemUpdateStateSchema(JSON.parse(await fs.readFile(this.systemFile(), 'utf8')));
      if (parsed instanceof type.errors) throw new Error('Invalid system update settings');
      this.system = parsed;
      if (parsed.attempt && ['checking', 'planning', 'applying'].includes(parsed.attempt.state)) {
        await this.changeSystem((next) => {
          if (!next.attempt) return;
          next.attempt.state = 'interrupted';
          next.attempt.message = 'An earlier automatic system update needs review in Updates.';
          next.enabled = false;
          next.pauseReason = next.attempt.message;
          next.revision++;
        }, false);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      this.systemError = 'System update settings could not be read safely. Automatic system updates are disabled.';
      this.system.enabled = false;
      this.logger.warn(this.systemError);
    }
  }

  private async persist(next: AutomaticUpdateState | SystemUpdateState, file = this.file()) {
    const directory = path.dirname(file);
    const temporary = `${file}.${randomUUID()}.tmp`;
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const parent = await fs.lstat(directory);
    if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0 || (process.getuid && parent.uid !== process.getuid()))
      throw new Error('Unsafe automatic update directory');
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(next)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, file);
      const handleDirectory = await fs.open(directory, 'r');
      try {
        await handleDirectory.sync();
      } finally {
        await handleDirectory.close();
      }
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
  private async write(save: () => Promise<void>, requireLoaded = true) {
    if (requireLoaded) await this.load();
    const run = this.writes
      .catch(() => undefined)
      .then(async () => {
        try {
          await save();
        } finally {
          this.ensureTimer();
        }
      });
    this.writes = run;
    return run;
  }
  private change(mutate: (next: AutomaticUpdateState) => void, requireLoaded = true) {
    return this.write(async () => {
      if (this.storageError) throw new ServiceUnavailableException(this.storageError);
      const next = structuredClone(this.state);
      mutate(next);
      try {
        await this.persist(next);
      } catch {
        this.storageError = 'Automatic update settings could not be saved safely. Automatic updates are disabled.';
        this.state.settings.orbis.enabled = false;
        this.state.rules = {};
        this.ensureTimer();
        throw new ServiceUnavailableException(this.storageError);
      }
      this.state = next;
    }, requireLoaded);
  }
  private changeSystem(mutate: (next: SystemUpdateState) => void, requireLoaded = true) {
    return this.write(async () => {
      if (this.systemError) throw new ServiceUnavailableException(this.systemError);
      const next = structuredClone(this.system);
      mutate(next);
      try {
        await this.persist(next, this.systemFile());
      } catch {
        this.systemError = 'System update settings could not be saved safely. Automatic system updates are disabled.';
        this.system.enabled = false;
        throw new ServiceUnavailableException(this.systemError);
      }
      this.system = next;
    }, requireLoaded);
  }
  private ensureTimer() {
    const enabled =
      this.state.settings.orbis.enabled ||
      (!this.systemError && (this.system.enabled || this.system.attempt?.state === 'accepted')) ||
      Object.values(this.state.rules).some((rule) => rule.mode !== 'disabled');
    if (this.stopped || this.storageError || !enabled || this.config.get('demoMode')) {
      clearInterval(this.timer);
      this.timer = undefined;
      return;
    }
    if (!this.timer) {
      this.timer = setInterval(() => void this.tick(), 60_000);
      this.timer.unref();
    }
  }
  async read() {
    await this.load();
    const schedule = this.effectiveSchedule();
    return {
      settings: { ...structuredClone(this.state.settings), schedule },
      serverTime: this.serverTime(schedule.timezone),
      available: !this.storageError,
      ...(this.storageError ? { reason: this.storageError } : {}),
      pauseReason: this.state.pauseReason,
      lastAttempt: this.state.orbis,
    };
  }
  async update(raw: unknown) {
    const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
    const schedule = body?.schedule;
    const settings = parseAutomaticSettings(
      schedule && typeof schedule === 'object' && !Array.isArray(schedule)
        ? { ...body, schedule: { ...schedule, timezone: this.serverTimezone() } }
        : raw,
    );
    if (this.config.get('demoMode')) throw new BadRequestException('Automatic updates are unavailable in demo mode.');
    await this.change((next) => {
      if (JSON.stringify(next.settings) === JSON.stringify(settings)) return;
      if (settings.orbis.enabled && !next.settings.orbis.enabled) {
        next.orbis = null;
        next.pauseReason = null;
      }
      if (next.orbis && ['checking', 'planning', 'deferred'].includes(next.orbis.state)) next.orbis = null;
      next.settings = settings;
      next.revision++;
    });
    return this.read();
  }
  async pauseForDowngrade() {
    await this.change((next) => {
      next.settings.orbis.enabled = false;
      next.pauseReason = 'Automatic Orbis updates were paused for a downgrade. Enable them again when you are ready.';
      next.revision++;
    });
    if (!this.systemError && (this.system.enabled || this.system.attempt?.state === 'accepted')) {
      await this.changeSystem((next) => {
        next.enabled = false;
        next.pauseReason = 'Automatic system updates were paused for a downgrade. Enable them again when you are ready.';
        next.revision++;
      });
    }
  }

  async readSystem() {
    await this.load();
    const reason = this.systemError ?? this.storageError;
    const shared = this.effectiveSchedule();
    return {
      settings: { enabled: this.system.enabled },
      shared,
      serverTime: this.serverTime(shared.timezone),
      available: !reason,
      ...(reason ? { reason } : {}),
      pauseReason: this.system.pauseReason,
      lastAttempt: this.system.attempt,
    };
  }
  async updateSystem(raw: unknown) {
    const settings = systemUpdateSettingsSchema(raw);
    if (settings instanceof type.errors) throw new BadRequestException('Choose whether automatic system updates are enabled.');
    if (this.config.get('demoMode')) throw new BadRequestException('Automatic updates are unavailable in demo mode.');
    await this.load();
    if (this.storageError) throw new ServiceUnavailableException(this.storageError);
    const revision = this.system.revision;
    const settingsRevision = this.state.revision;
    if (settings.enabled) {
      const status = await this.host.status();
      if (!status.capabilities?.includes('packages.refresh.v1'))
        throw new BadRequestException('Update the Orbis host service to enable automatic system updates.');
      if (!this.healthy(status)) throw new BadRequestException('Automatic system updates require a healthy enrolled Orbis server.');
      const inventory = await this.host.packages();
      if (!inventory.available || inventory.manager !== 'apt')
        throw new BadRequestException(inventory.reason ?? 'Automatic system updates currently require Ubuntu 24.04.');
    }
    await this.changeSystem((next) => {
      if (next.revision !== revision || (settings.enabled && this.state.revision !== settingsRevision))
        throw new BadRequestException('System update settings changed. Reload them before saving again.');
      if (settings.enabled) {
        next.pauseReason = null;
        if (!next.attempt || !['accepted', 'applying', 'planning', 'checking'].includes(next.attempt.state)) {
          next.attempt = null;
          next.phase = null;
          next.settingsRevision = null;
          next.policyRevision = null;
        }
      }
      next.enabled = settings.enabled;
      next.revision++;
    });
    return this.readSystem();
  }
  private appUrn(raw: unknown) {
    if (typeof raw !== 'string' || raw.length > 180) throw new BadRequestException('Choose an installed app.');
    try {
      return castAppUrn(raw);
    } catch {
      throw new BadRequestException('Choose an installed app.');
    }
  }
  async readApp(raw: unknown) {
    await this.load();
    const urn = this.appUrn(raw);
    const app = await this.apps.getAppByUrn(urn);
    const reason =
      this.storageError ??
      (app ? (urn.endsWith(':_user') ? 'Custom apps do not support scheduled store updates.' : null) : 'This app is no longer installed.');
    const shared = this.effectiveSchedule();
    return {
      rule: this.state.rules[urn] ?? { mode: 'disabled' as const },
      shared,
      serverTime: this.serverTime(shared.timezone),
      available: !reason,
      ...(reason ? { reason } : {}),
      lastAttempt: this.state.apps[urn] ?? null,
    };
  }
  async updateApp(raw: unknown, body: unknown) {
    const urn = this.appUrn(raw);
    const rule = parseAppUpdateRule(body);
    if (this.config.get('demoMode')) throw new BadRequestException('Automatic updates are unavailable in demo mode.');
    if (rule.mode !== 'disabled' && (!(await this.apps.getAppByUrn(urn)) || urn.endsWith(':_user')))
      throw new BadRequestException('Choose an installed store app.');
    await this.change((next) => {
      if (JSON.stringify(next.rules[urn] ?? { mode: 'disabled' }) === JSON.stringify(rule)) return;
      if (rule.mode === 'disabled') delete next.rules[urn];
      else {
        if (!next.rules[urn] && Object.keys(next.rules).length >= 256) throw new BadRequestException('Too many app schedules.');
        next.rules[urn] = rule;
      }
      delete next.apps[urn];
      next.revision++;
    });
    return this.readApp(urn);
  }
  private systemReady() {
    return (
      !this.stopped &&
      !this.storageError &&
      !this.systemError &&
      this.system.enabled &&
      this.system.policyRevision === this.system.revision &&
      this.system.settingsRevision === this.state.revision &&
      installationMode().phase === 'normal'
    );
  }
  private async recordSystem(attempt: AutomaticUpdateAttempt, pause = false) {
    const identity = this.system.attempt?.at;
    await this.changeSystem((next) => {
      if (next.attempt?.at !== identity) return;
      next.attempt = attempt;
      if (pause && next.revision === next.policyRevision) {
        next.enabled = false;
        next.pauseReason = attempt.message;
        next.revision++;
      }
    });
  }
  private async dispatchSystem(phase: 'refresh' | 'install', slot: string, planId?: string) {
    if (!this.systemReady()) return;
    const attempt: AutomaticUpdateAttempt = {
      slot,
      state: 'applying',
      at: Date.now(),
      message: phase === 'refresh' ? 'Refreshing system package lists.' : 'Starting the scheduled system package update.',
    };
    await this.changeSystem((next) => {
      next.phase = phase;
      next.attempt = attempt;
    });
    if (!this.systemReady()) {
      await this.recordSystem({ ...attempt, state: 'complete', message: 'System update settings changed. No further operation was started.' });
      return;
    }
    try {
      const result = phase === 'refresh' ? await this.host.packageRefresh() : await this.host.packageApply(planId);
      if (typeof result.jobId !== 'string' || !/^[0-9a-f-]{36}$/i.test(result.jobId)) throw new Error('Invalid package job identity');
      if (phase === 'install' && result.jobId !== planId) throw new Error('Package job differs from the reviewed plan');
      await this.recordSystem({
        ...attempt,
        state: 'accepted',
        jobId: result.jobId,
        message: phase === 'refresh' ? 'The host is refreshing system package lists.' : 'The host accepted the scheduled system update.',
      });
    } catch {
      await this.recordSystem(
        { ...attempt, state: 'interrupted', message: 'The system operation could not be confirmed. Review Updates before enabling it again.' },
        true,
      );
    }
  }
  private async continueSystem() {
    const previous = this.system.attempt;
    if (!previous || previous.state !== 'accepted') return false;
    if (!previous.jobId || !this.system.phase) {
      await this.recordSystem({ ...previous, state: 'interrupted', message: 'The system update job could not be verified. Review Updates.' }, true);
      return true;
    }
    let job: Awaited<ReturnType<HostUpdatesService['packageJob']>>['job'];
    try {
      job = (await this.host.packageJob()).job;
    } catch {
      return true;
    }
    if (!job || job.id !== previous.jobId || !['queued', 'running', 'complete'].includes(job.state)) {
      await this.recordSystem({ ...previous, state: 'interrupted', message: 'The scheduled system job needs review in Updates.' }, true);
      return true;
    }
    if ((job.kind === 'refresh') !== (this.system.phase === 'refresh')) {
      await this.recordSystem({ ...previous, state: 'interrupted', message: 'The scheduled system job type changed. Review Updates.' }, true);
      return true;
    }
    if (job.state !== 'complete') return true;
    if (this.system.phase === 'install') {
      await this.recordSystem({
        ...previous,
        state: 'complete',
        message: job.rebootRequired
          ? 'System packages updated. Restart the server manually from Updates when ready.'
          : 'System packages updated successfully.',
      });
      return true;
    }
    if (!this.systemReady()) {
      await this.recordSystem({
        ...previous,
        state: 'complete',
        message: 'Package lists refreshed. Changed settings stopped the automatic installation.',
      });
      return true;
    }
    try {
      const status = await this.host.status();
      if (!this.systemReady()) return true;
      if (!this.healthy(status)) throw new Error('Host not ready');
      const applications = await this.apps.getApps();
      if (!this.systemReady() || applications.some((app) => !stableApp.has(app.status))) return true;
      const inventory = await this.host.packages();
      if (!this.systemReady()) return true;
      if (
        !inventory.available ||
        inventory.manager !== 'apt' ||
        inventory.truncated ||
        !Array.isArray(inventory.packages) ||
        inventory.packageCount !== inventory.packages.length ||
        inventory.packages.length > 250
      )
        throw new Error('Inventory requires manual review');
      if (!inventory.packages.length) {
        await this.recordSystem({ ...previous, state: 'no-update', message: 'System package lists refreshed. No updates are available.' });
        return true;
      }
      const names = inventory.packages.map((item) => item.name);
      if (
        new Set(names).size !== names.length ||
        inventory.packages.some(
          (item) => !Array.isArray(item.sources) || !item.sources.length || !item.sources.every((source) => source.trusted === true),
        )
      )
        throw new Error('Unverified package source');
      const plan = await this.host.packagePlan(names);
      if (!this.systemReady()) return true;
      if (
        !Array.isArray(plan.selected) ||
        !Array.isArray(plan.operations) ||
        !plan.operations.length ||
        plan.operations.length > 250 ||
        plan.selected.length !== names.length ||
        new Set(plan.selected.map((item) => item.name)).size !== names.length ||
        plan.operations.some((item) => !['install', 'upgrade'].includes(item.action)) ||
        plan.selected.some(
          (item) =>
            !inventory.packages?.some(
              (candidate) =>
                candidate.name === item.name &&
                candidate.candidateVersion === item.candidateVersion &&
                candidate.installedVersion === item.installedVersion,
            ),
        )
      )
        throw new Error('Package plan changed');
      const current = await this.host.status();
      if (!this.systemReady()) return true;
      if (!this.healthy(current)) throw new Error('Host not ready');
      const currentApps = await this.apps.getApps();
      if (!this.systemReady() || currentApps.some((app) => !stableApp.has(app.status))) return true;
      await this.dispatchSystem('install', previous.slot, plan.planId);
    } catch {
      await this.recordSystem(
        { ...previous, state: 'failed', message: 'Automatic system updates are paused. Review package changes in Updates.' },
        true,
      );
    }
    return true;
  }
  tick() {
    if (backupDiskActive() && !this.pending) return Promise.resolve();
    if (!this.pending) {
      const release = enterBackupMutation();
      if (!release) return Promise.resolve();
      this.pending = this.run()
        .catch(() => this.logger.warn('An automatic update check failed. No operation will be replayed.'))
        .finally(() => {
          this.pending = undefined;
          release();
        });
    }
    return this.pending;
  }
  private healthy(status: HostUpdateStatus) {
    return (
      status.available &&
      status.enrolled &&
      status.imageMatches &&
      status.coreState === 'running' &&
      status.coreHealth === 'healthy' &&
      status.currentTag === process.env.ORBIS_VERSION &&
      !busyHost.has(status.job?.state ?? '') &&
      status.job?.state !== 'failed'
    );
  }
  private quiet(revision: number) {
    return (
      !this.stopped &&
      !backupDiskActive() &&
      !this.storageError &&
      this.state.revision === revision &&
      this.state.settings.orbis.enabled &&
      Date.now() - this.startedAt >= QUIET_MS &&
      this.activity.isIdleFor(QUIET_MS)
    );
  }
  private async recordCore(attempt: AutomaticUpdateAttempt, pause = false, revision?: number) {
    await this.change((next) => {
      if (revision !== undefined && next.revision !== revision) return;
      next.orbis = attempt;
      if (pause) {
        next.settings.orbis.enabled = false;
        next.pauseReason = attempt.message;
        next.revision++;
      }
    });
  }
  private async runCore(slot: string, revision: number) {
    const record = (attempt: AutomaticUpdateAttempt, pause = false) => this.recordCore(attempt, pause, revision);
    let stage: AutomaticUpdateAttempt['state'] = 'checking';
    let targetTag = this.state.orbis?.slot === slot && this.state.orbis.state === 'deferred' ? this.state.orbis.targetTag : undefined;
    try {
      const channel = (await this.channels.read()).channel;
      if (targetTag && !releaseAllowedOnChannel(targetTag, channel)) targetTag = undefined;
      if (!targetTag) {
        await record({ slot, state: 'checking', at: Date.now(), message: 'Checking for a newer Orbis release.' });
        const latest = await this.releases.latest(channel);
        const installed = process.env.ORBIS_VERSION;
        if (!latest?.imageManifestUrl || !installed || !valid(installed) || !valid(latest.tag) || !gt(latest.tag, installed)) {
          await record({ slot, state: 'no-update', at: Date.now(), message: 'Orbis is up to date.' });
          return;
        }
        targetTag = latest.tag;
      }
      if (!this.quiet(revision)) {
        await record({ slot, state: 'deferred', targetTag, at: Date.now(), message: 'A browser became active. The update will wait.' });
        return;
      }
      stage = 'planning';
      await record({ slot, state: stage, targetTag, at: Date.now(), message: 'Preparing the Orbis update.' });
      const plan = await this.host.plan(targetTag);
      if (plan.appsMustBeStopped !== false) {
        await record(
          {
            slot,
            state: 'deferred',
            targetTag,
            at: Date.now(),
            message: 'This release requires stopped applications. Review it manually in Updates.',
          },
          true,
        );
        return;
      }
      const status = await this.host.status();
      const applications = await this.apps.getApps();
      if (
        !this.quiet(revision) ||
        !this.healthy(status) ||
        applications.some((app) => !stableApp.has(app.status)) ||
        plan.currentTag !== process.env.ORBIS_VERSION ||
        plan.targetTag !== targetTag
      ) {
        await record({
          slot,
          state: 'deferred',
          targetTag,
          at: Date.now(),
          message: 'Waiting until Orbis is idle and other operations have finished.',
        });
        return;
      }
      stage = 'applying';
      await record({ slot, state: stage, targetTag, at: Date.now(), message: 'Starting the Orbis update.' });
      if (!this.quiet(revision)) {
        await record({ slot, state: 'deferred', targetTag, at: Date.now(), message: 'A browser became active. The update will wait.' });
        return;
      }
      const result = await this.host.apply(plan.planId);
      await record({
        slot,
        state: 'accepted',
        targetTag,
        at: Date.now(),
        jobId: result.jobId,
        message: 'The host accepted the Orbis update.',
      });
    } catch {
      await record(
        {
          slot,
          state: 'failed',
          ...(targetTag ? { targetTag } : {}),
          at: Date.now(),
          message:
            stage === 'checking'
              ? 'The release check failed. A new check will wait until the next day.'
              : 'The automatic Orbis update needs review in Updates before it can run again.',
        },
        stage !== 'checking',
      );
    }
  }
  private async run() {
    await this.load();
    if (
      this.stopped ||
      this.storageError ||
      this.config.get('demoMode') ||
      installationMode().phase !== 'normal' ||
      Date.now() - this.startedAt < QUIET_MS
    )
      return;
    const state = this.state;
    const schedule = this.effectiveSchedule();
    const now = Date.now();
    if (await this.continueSystem()) return;
    const slot = dailyUpdateSlot(schedule, now, state.settings.orbis.mode === 'idle');
    const systemSlot = dailyUpdateSlot(schedule, now);
    const systemRevision = this.system.revision;
    const dueSystem = !this.systemError && this.system.enabled && systemSlot.due && this.system.attempt?.slot !== systemSlot.key;
    const dueCore =
      state.settings.orbis.enabled && slot.due && (state.orbis?.slot !== slot.key || state.orbis.state === 'deferred') && this.quiet(state.revision);
    const dueApps = Object.entries(state.rules).filter(
      ([urn, rule]) =>
        rule.mode !== 'disabled' &&
        (() => {
          const selected = dailyUpdateSlot({ ...schedule, time: rule.mode === 'custom' ? (rule.time ?? schedule.time) : schedule.time }, now);
          return selected.due && state.apps[urn]?.slot !== selected.key;
        })(),
    );
    if (!dueCore && !dueSystem && !dueApps.length) return;
    const status = await this.host.status();
    if (this.state.revision !== state.revision || this.stopped) return;
    if (dueCore && this.healthy(status) && (await this.apps.getApps()).every((app) => stableApp.has(app.status))) {
      await this.runCore(slot.key, state.revision);
      return;
    }
    if (
      dueSystem &&
      this.healthy(status) &&
      status.capabilities?.includes('packages.refresh.v1') &&
      (await this.apps.getApps()).every((app) => stableApp.has(app.status))
    ) {
      if (this.system.revision !== systemRevision || this.state.revision !== state.revision) return;
      await this.changeSystem((next) => {
        next.policyRevision = systemRevision;
        next.settingsRevision = state.revision;
      });
      if (this.systemReady()) await this.dispatchSystem('refresh', systemSlot.key);
      return;
    }
    if ((status.available && (status.coreState !== 'running' || busyHost.has(status.job?.state ?? ''))) || this.state.revision !== state.revision)
      return;
    if ((await this.apps.getApps()).some((app) => !stableApp.has(app.status))) return;
    for (const [urn, rule] of dueApps) {
      if (this.stopped || this.state.revision !== state.revision || installationMode().phase !== 'normal') return;
      const selected = dailyUpdateSlot({ ...schedule, time: rule.mode === 'custom' ? (rule.time ?? schedule.time) : schedule.time }, now);
      const appUrn = this.appUrn(urn);
      const app = await this.apps.getAppByUrn(appUrn);
      if (!app || !normalApp.has(app.status) || urn.endsWith(':_user')) continue;
      const update = await this.marketplace.getAppUpdateInfo(appUrn).catch(() => null);
      if (!update) {
        await this.change((next) => {
          next.apps[urn] = {
            slot: selected.key,
            state: 'failed',
            at: Date.now(),
            message: 'The app update check failed. A new check will wait until the next day.',
          };
        });
        continue;
      }
      if (!Number.isSafeInteger(update.latestVersion) || update.latestVersion <= app.version || app.ignoredVersion === update.latestVersion) {
        await this.change((next) => {
          next.apps[urn] = { slot: selected.key, state: 'no-update', at: Date.now(), message: 'No eligible app update.' };
        });
        continue;
      }
      if (
        state.apps[urn]?.targetVersion === update.latestVersion &&
        ['applying', 'accepted', 'failed', 'interrupted'].includes(state.apps[urn]?.state ?? '')
      ) {
        await this.change((next) => {
          const previous = next.apps[urn];
          if (previous) next.apps[urn] = { ...previous, slot: selected.key };
        });
        continue;
      }
      const attempt: AutomaticUpdateAttempt = {
        slot: selected.key,
        state: 'applying',
        targetVersion: update.latestVersion,
        at: Date.now(),
        message: 'Starting the scheduled app update with a backup.',
      };
      await this.change((next) => {
        next.apps[urn] = attempt;
      });
      if (this.state.revision !== state.revision || this.stopped) return;
      try {
        const result = await this.lifecycle.updateApp({ appUrn, performBackup: true });
        await this.change((next) => {
          next.apps[urn] = { ...attempt, state: 'accepted', jobId: result.requestId, message: 'The app update was queued with a backup.' };
        });
      } catch {
        await this.change((next) => {
          next.apps[urn] = { ...attempt, state: 'failed', message: 'This app update failed. Its version will not be retried automatically.' };
        });
      }
      return;
    }
  }
}
