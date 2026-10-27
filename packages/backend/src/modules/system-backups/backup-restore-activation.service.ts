import { Inject, Injectable, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type Dockerode from 'dockerode';
import { DATA_DIR } from '@/common/constants';
import { releaseRestoreInstallationMode } from '@/common/installation-mode';
import { createAppUrn, validateAppUrn } from '@/common/helpers/app-helpers';
import { AppLifecycleService } from '../app-lifecycle/app-lifecycle.service';
import { AppsRepository } from '../apps/apps.repository';
import { DOCKERODE } from '../docker/docker.module';
import { BackupRestoreJournal } from './backup-restore-journal';
import { readRestoreOperation } from './backup-restore-runtime';
import { captureRestoreStartupRole, restoreStartupRole } from './backup-restore-startup';
import { BackupRequirementError } from './backup-files';

@Injectable()
export class BackupRestoreActivationService implements OnModuleInit, OnModuleDestroy {
  private transactionId?: string;
  private timer?: ReturnType<typeof setInterval>;
  private checking = false;
  constructor(
    private readonly apps: AppsRepository,
    private readonly lifecycle: AppLifecycleService,
    @Inject(DOCKERODE) private readonly docker: Dockerode,
  ) {}
  onModuleInit() {
    if (restoreStartupRole() !== 'candidate' || !this.transactionId) return;
    this.timer = setInterval(() => {
      void this.releaseWhenComplete().catch(() => undefined);
    }, 1000);
    this.timer.unref();
  }
  onModuleDestroy() {
    clearInterval(this.timer);
  }
  private async releaseWhenComplete() {
    if (this.checking || !this.transactionId) return;
    this.checking = true;
    try {
      const journal = await BackupRestoreJournal.active(path.join(DATA_DIR, 'backups', 'restores'));
      if (
        journal?.state.id === this.transactionId &&
        journal.state.phase === 'completed' &&
        journal.state.candidateController.startsWith(os.hostname()) &&
        releaseRestoreInstallationMode(this.transactionId)
      ) {
        captureRestoreStartupRole('ordinary');
        clearInterval(this.timer);
      }
    } finally {
      this.checking = false;
    }
  }
  async resumeApps() {
    if (restoreStartupRole() !== 'candidate') return;
    const journal = await BackupRestoreJournal.active(path.join(DATA_DIR, 'backups', 'restores'));
    if (!journal || journal.state.decision !== 'commit' || !journal.state.candidateController.startsWith(os.hostname()))
      throw new BackupRequirementError('Restored app activation could not be verified.');
    if (journal.state.phase !== 'committing') return;
    this.transactionId = journal.state.id;
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
