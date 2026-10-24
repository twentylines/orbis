import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BadRequestException, Injectable, ServiceUnavailableException, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { type } from 'arktype';
import { gt, valid } from 'semver';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { MonitoringActivityService } from '@/core/monitoring/monitoring-activity.service';
import { installationMode } from '@/common/installation-mode';
import { castAppUrn } from '@/common/helpers/app-helpers';
import { AppsRepository } from '../apps/apps.repository';
import { MarketplaceService } from '../marketplace/marketplace.service';
import { AppLifecycleService } from '../app-lifecycle/app-lifecycle.service';
import { OrbisReleaseService } from '../system/orbis-release.service';
import { HostUpdatesService, type HostUpdateStatus } from './host-updates.service';
import {
  automaticUpdateStateSchema,
  dailyUpdateSlot,
  parseAppUpdateRule,
  parseAutomaticSettings,
  type AutomaticUpdateAttempt,
  type AutomaticUpdateState,
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
  ) {
    let timezone = this.config.get('userSettings').timeZone || 'UTC';
    try {
      new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
    } catch {
      timezone = 'UTC';
    }
    this.state = {
      version: 1,
      revision: 0,
      settings: { orbis: { enabled: false, mode: 'idle' }, schedule: { time: '03:00', timezone } },
      rules: {},
      apps: {},
      orbis: null,
      pauseReason: null,
    };
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
  private load() {
    this.loading ??= this.readStored();
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

  private async persist(next: AutomaticUpdateState) {
    const file = this.file();
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
  private async change(mutate: (next: AutomaticUpdateState) => void, requireLoaded = true) {
    if (requireLoaded) await this.load();
    const run = this.writes
      .catch(() => undefined)
      .then(async () => {
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
        this.ensureTimer();
      });
    this.writes = run;
    return run;
  }
  private ensureTimer() {
    const enabled = this.state.settings.orbis.enabled || Object.values(this.state.rules).some((rule) => rule.mode !== 'disabled');
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
    return {
      settings: structuredClone(this.state.settings),
      available: !this.storageError,
      ...(this.storageError ? { reason: this.storageError } : {}),
      pauseReason: this.state.pauseReason,
      lastAttempt: this.state.orbis,
    };
  }
  async update(raw: unknown) {
    const settings = parseAutomaticSettings(raw);
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
    return {
      rule: this.state.rules[urn] ?? { mode: 'disabled' as const },
      shared: this.state.settings.schedule,
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
  tick() {
    if (!this.pending)
      this.pending = this.run()
        .catch(() => this.logger.warn('An automatic update check failed. No operation will be replayed.'))
        .finally(() => {
          this.pending = undefined;
        });
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
      if (!targetTag) {
        await record({ slot, state: 'checking', at: Date.now(), message: 'Checking for a newer Orbis release.' });
        const latest = await this.releases.latest();
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
    const now = Date.now();
    const slot = dailyUpdateSlot(state.settings.schedule, now, state.settings.orbis.mode === 'idle');
    const dueCore =
      state.settings.orbis.enabled && slot.due && (state.orbis?.slot !== slot.key || state.orbis.state === 'deferred') && this.quiet(state.revision);
    const dueApps = Object.entries(state.rules).filter(
      ([urn, rule]) =>
        rule.mode !== 'disabled' &&
        (() => {
          const selected = dailyUpdateSlot(
            { ...state.settings.schedule, time: rule.mode === 'custom' ? (rule.time ?? state.settings.schedule.time) : state.settings.schedule.time },
            now,
          );
          return selected.due && state.apps[urn]?.slot !== selected.key;
        })(),
    );
    if (!dueCore && !dueApps.length) return;
    const status = await this.host.status();
    if (this.state.revision !== state.revision || this.stopped) return;
    if (dueCore && this.healthy(status) && (await this.apps.getApps()).every((app) => stableApp.has(app.status))) {
      await this.runCore(slot.key, state.revision);
      return;
    }
    if ((status.available && (status.coreState !== 'running' || busyHost.has(status.job?.state ?? ''))) || this.state.revision !== state.revision)
      return;
    if ((await this.apps.getApps()).some((app) => !stableApp.has(app.status))) return;
    for (const [urn, rule] of dueApps) {
      if (this.stopped || this.state.revision !== state.revision || installationMode().phase !== 'normal') return;
      const selected = dailyUpdateSlot(
        { ...state.settings.schedule, time: rule.mode === 'custom' ? (rule.time ?? state.settings.schedule.time) : state.settings.schedule.time },
        now,
      );
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
