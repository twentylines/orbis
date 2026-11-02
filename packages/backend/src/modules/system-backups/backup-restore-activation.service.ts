import { Inject, Injectable, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type Dockerode from 'dockerode';
import { DATA_DIR } from '@/common/constants';
import { installationMode, releaseRestoreInstallationMode } from '@/common/installation-mode';
import { acquireBackupMaintenance, setRestoreRecoveryRequired } from '@/common/backup-maintenance';
import { readRootRestorationState } from '@/common/restoration-root-status';
import { QueueFactory } from '../queue/queue.factory';
import { RetainedRootTransaction } from './time-machine-retained-root-client';
import { finishRetainedNormalBootstrap } from './backup-retained-normal-bootstrap';
import { createAppUrn, validateAppUrn } from '@/common/helpers/app-helpers';
import { AppLifecycleService } from '../app-lifecycle/app-lifecycle.service';
import { AppsRepository } from '../apps/apps.repository';
import { DOCKERODE } from '../docker/docker.module';
import { BackupRestoreJournal } from './backup-restore-journal';
import { readRestoreOperation } from './backup-restore-runtime';
import { captureRestoreStartupRole, restoreStartupRole, retainedBootstrapStartup, setRetainedBootstrapStartup } from './backup-restore-startup';
import { BackupRequirementError } from './backup-files';
import { BackupRestoresService } from './backup-restores.service';
import { verifyRetainedCandidateApps } from './time-machine-retained-app-result';

@Injectable()
export class BackupRestoreActivationService implements OnModuleInit, OnModuleDestroy {
  private transactionId?: string;
  private timer?: ReturnType<typeof setInterval>;
  private continuation?: { prepare: () => Promise<void>; activate: () => void };
  private checking = false;
  private readonly bootstrapAbort = new AbortController();
  private retainedRelease?: () => void;
  constructor(
    private readonly apps: AppsRepository,
    private readonly lifecycle: AppLifecycleService,
    private readonly restores: BackupRestoresService,
    @Inject(DOCKERODE) private readonly docker: Dockerode,
    private readonly queue: QueueFactory,
  ) {}
  configureRetainedContinuation(continuation: { prepare: () => Promise<void>; activate: () => void }) {
    this.continuation = continuation;
  }
  onModuleInit() {
    if (restoreStartupRole() !== 'candidate' || !this.transactionId) return;
    this.timer = setInterval(() => {
      void this.releaseWhenComplete().catch(() => undefined);
    }, 1000);
    this.timer.unref();
  }
  onModuleDestroy() {
    this.bootstrapAbort.abort();
    clearInterval(this.timer);
  }
  private async releaseWhenComplete() {
    if (this.checking || !this.transactionId) return;
    this.checking = true;
    try {
      const store = path.join(DATA_DIR, 'backups', 'restores');
      const active = await BackupRestoreJournal.active(store);
      const journal = active ?? (await BackupRestoreJournal.latest(store));
      if (
        !journal ||
        journal.state.id !== this.transactionId ||
        journal.state.phase !== 'completed' ||
        !journal.state.candidateController.startsWith(os.hostname())
      )
        return;
      await this.restores.startRetainedSettlement();
      const maintenance = await readRootRestorationState();
      if (maintenance === 'checking' || (maintenance === 'idle' && this.retainedRelease)) {
        const transaction = await RetainedRootTransaction.read(journal.directory);
        const signal = AbortSignal.timeout(60_000);
        const proof = await transaction.terminalProof(signal);
        const status = await transaction.normalBootstrapStatus(proof.proofSha256, signal);
        if (!status.required || active) return;
        setRestoreRecoveryRequired(true);
        setRetainedBootstrapStartup(true);
        this.retainedRelease ??= await acquireBackupMaintenance(this.bootstrapAbort.signal);
        if (!this.continuation) throw new BackupRequirementError('Retained continuation is unavailable.');
        await this.continuation.prepare();
        await finishRetainedNormalBootstrap(journal, this.queue, AbortSignal.any([this.bootstrapAbort.signal, AbortSignal.timeout(15 * 60_000)]));
        if (installationMode().phase === 'resume') this.queue.resumeRetainedAfterSettlement();
        this.continuation.activate();
        if (!releaseRestoreInstallationMode(this.transactionId) && installationMode().phase !== 'normal') return;
        captureRestoreStartupRole('ordinary');
        setRetainedBootstrapStartup(false);
        setRestoreRecoveryRequired(false);
        this.retainedRelease();
        this.retainedRelease = undefined;
        clearInterval(this.timer);
        return;
      }
      if (maintenance !== 'idle' && maintenance !== null) return;
      if (restoreStartupRole() === 'ordinary' || releaseRestoreInstallationMode(this.transactionId)) {
        captureRestoreStartupRole('ordinary');
        clearInterval(this.timer);
      }
    } finally {
      this.checking = false;
    }
  }
  async resumeApps() {
    if (restoreStartupRole() !== 'candidate') return;
    const store = path.join(DATA_DIR, 'backups', 'restores');
    const journal = (await BackupRestoreJournal.active(store)) ?? (await BackupRestoreJournal.latest(store));
    if (!journal || journal.state.decision !== 'commit' || !journal.state.candidateController.startsWith(os.hostname()))
      throw new BackupRequirementError('Restored app activation could not be verified.');
    this.transactionId = journal.state.id;
    if (journal.state.phase !== 'committing') return;
    if (retainedBootstrapStartup()) {
      await verifyRetainedCandidateApps(
        journal,
        DATA_DIR,
        os.hostname(),
        AbortSignal.any([this.bootstrapAbort.signal, AbortSignal.timeout(15 * 60_000)]),
      );
      return;
    }
    const operation = await readRestoreOperation(journal);
    const deadline = Date.now() + 15 * 60_000;
    const pending = [...operation.resumeApps];
    const failed = () => new BackupRequirementError('Some restored apps could not start. Review restore recovery before continuing.');
    const run = async () => {
      while (pending.length) {
        const selected = pending.shift();
        if (!selected) return;
        const app = await this.apps.getAppById(selected.id);
        if (!app || createAppUrn(app.appName, app.appStoreSlug) !== selected.appUrn) throw failed();
        const appUrn = validateAppUrn(selected.appUrn);
        if (!['running', 'starting'].includes(app.status)) await this.lifecycle.startApp({ appUrn });
        while (true) {
          if (Date.now() >= deadline) throw failed();
          const current = await this.apps.getAppById(selected.id);
          if (!current || current.status === 'stopped' || current.status === 'missing') throw failed();
          if (current.status === 'running') {
            const containers = await this.docker.listContainers({
              all: true,
              filters: { label: [`com.docker.compose.project=${appUrn.replace(':', '_')}`] },
            });
            if (containers.length) {
              let ready = true;
              for (const info of containers) {
                const state = (await this.docker.getContainer(info.Id).inspect()).State;
                if (!state.Running || state.Restarting || state.Paused || (state.Health && state.Health.Status !== 'healthy')) ready = false;
              }
              if (ready) break;
            }
          }
          await delay(500);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, pending.length) }, run));
  }
}
