import path from 'node:path';
import type { ArchiveService } from '@/core/archive/archive.service';
import type Dockerode from 'dockerode';
import type { AppUrn } from '@runtipi/common/types';
import {
  AppMigrationJournal,
  migrationFailure,
  migrationStorageHash,
  migrationOperationSchema,
  migrationHash,
} from '../backups/app-migration-journal';
import { AppStorageWitness } from '../host-updates/app-storage-observation';
import type { AppsRepository } from '../apps/apps.repository';
import { AppUpdateStage } from './app-update-stage';
import { AppMigrationRunner } from './app-migration-runner';
import { parseAppMigration } from './app-migration-plan';
import { prepareAppMigrationImage } from './app-migration-images';
import type { DockerService } from './docker.service';

type Plan = Parameters<AppMigrationRunner['run']>[0][number];

/** Owns one staged update's data migration. It does not grant recovery/enrollment authority or start the target app. */
export class AppUpdateMigrations {
  private constructor(
    readonly journal: AppMigrationJournal,
    private readonly stage: AppUpdateStage,
    private readonly storage: AppStorageWitness,
    private readonly plans: readonly Plan[],
    private readonly localDirectory: string,
    private readonly archive: ArchiveService,
  ) {}

  static async prepare(input: {
    stage: AppUpdateStage;
    appUrn: AppUrn;
    docker: Dockerode;
    service: DockerService;
    localDirectory: string;
    journalRoot: string;
    socketPath: string;
    architecture: 'amd64' | 'arm64';
    archive: ArchiveService;
  }) {
    let storage: AppStorageWitness | undefined;
    let journal: AppMigrationJournal | undefined;
    try {
      const state = await input.stage.read();
      const context = state.context;
      if (
        !(input.stage instanceof AppUpdateStage) ||
        state.appUrn !== input.appUrn ||
        state.phase !== 'target-ready' ||
        !state.pulledImages ||
        !context ||
        !context.previousLedger.baselined ||
        state.migrationPreparation?.phase !== 'intent' ||
        !path.isAbsolute(input.journalRoot) ||
        path.resolve(input.journalRoot) !== input.journalRoot
      )
        throw migrationFailure();
      if (await AppMigrationJournal.operationExists(input.journalRoot, state.requestId)) throw migrationFailure();
      const known = new Set(context.previousLedger.migrationIds);
      const pending = context.targetMigrationIds.filter((id) => !known.has(id)).sort();
      if (!pending.length) throw migrationFailure();
      storage = await AppStorageWitness.open({
        socketPath: input.socketPath,
        appUrn: input.appUrn,
        localDirectory: input.localDirectory,
        docker: input.docker,
      });
      const selected = await input.service.readAppUpdateMigrationInputs(input.appUrn, input.stage, pending);
      if (JSON.stringify(selected.sources.map(({ id }) => id)) !== JSON.stringify(pending)) throw migrationFailure();
      const witness = storage;
      const plans = await witness.use(async (docker, observed) => {
        if (observed.containerPath !== input.localDirectory || selected.environment.APP_DATA_DIR !== observed.hostPath) throw migrationFailure();
        const prepared: Plan[] = [];
        for (const source of selected.sources) {
          const definition = parseAppMigration(source, { appDataHostPath: observed.hostPath, environment: selected.environment });
          prepared.push({ definition, image: await prepareAppMigrationImage(docker, definition, { architecture: input.architecture }) });
        }
        return prepared;
      });
      // Recheck the sealed target and exact override authority after potentially slow image preparation, before stopping writers.
      const checked = await input.service.readAppUpdateMigrationInputs(input.appUrn, input.stage, pending);
      if (
        JSON.stringify(checked.environment) !== JSON.stringify(selected.environment) ||
        checked.sources.some((source, index) => source.id !== selected.sources[index]?.id || source.sha256 !== selected.sources[index]?.sha256) ||
        checked.sources.length !== selected.sources.length
      )
        throw migrationFailure();
      journal = await AppMigrationJournal.create(
        input.journalRoot,
        migrationOperationSchema.assert({
          version: 1,
          requestId: state.requestId,
          stageId: state.id,
          appUrn: input.appUrn,
          appId: context.appId,
          createdAt: context.appCreatedAt,
          fromVersion: context.fromVersion,
          toVersion: context.toVersion,
          previousLedger: context.previousLedger,
          images: plans.map(({ image }) => image),
          originalContainers: context.originalContainers.map(({ id, imageId, service }) => ({ id, imageId, service })),
        }),
        witness,
      );
      await input.stage.confirmMigrationPreparation(journal);
      return new AppUpdateMigrations(journal, input.stage, witness, plans, input.localDirectory, input.archive);
    } catch {
      await journal?.close().catch(() => undefined);
      await storage?.close().catch(() => undefined);
      throw migrationFailure();
    }
  }

  static async openJournal(stage: AppUpdateStage, journalRoot: string) {
    const state = await stage.read();
    const context = state.context;
    if (!context?.previousLedger.baselined) throw migrationFailure();
    const migrationIds = context.targetMigrationIds.filter((id) => !context.previousLedger.migrationIds.includes(id)).sort();
    if (!migrationIds.length) throw migrationFailure();
    const journal = await AppMigrationJournal.openBound(journalRoot, {
      version: 1,
      requestId: state.requestId,
      stageId: state.id,
      appUrn: state.appUrn,
      appId: context.appId,
      createdAt: context.appCreatedAt,
      fromVersion: context.fromVersion,
      toVersion: context.toVersion,
      previousLedger: context.previousLedger,
      originalContainers: context.originalContainers.map(({ id, imageId, service }) => ({ id, imageId, service })),
      migrationIds,
    });
    try {
      if (state.migrationPreparation?.phase === 'ready') await stage.verifyMigrationPreparation(journal);
      return journal;
    } catch (error) {
      await journal.close();
      throw error;
    }
  }

  /** Uses saved local identities and definition hashes. It never performs registry resolution or a second image pull. */
  static async resume(input: {
    stage: AppUpdateStage;
    appUrn: AppUrn;
    docker: Dockerode;
    service: DockerService;
    localDirectory: string;
    journalRoot: string;
    socketPath: string;
    archive: ArchiveService;
  }) {
    let journal: AppMigrationJournal | undefined;
    let storage: AppStorageWitness | undefined;
    try {
      if ((await input.stage.read()).appUrn !== input.appUrn) throw migrationFailure();
      journal = await AppUpdateMigrations.openJournal(input.stage, input.journalRoot);
      const state = await journal.read();
      storage = await AppStorageWitness.open({
        socketPath: input.socketPath,
        appUrn: input.appUrn,
        localDirectory: input.localDirectory,
        docker: input.docker,
      });
      const selected = await input.service.readAppUpdateMigrationInputs(
        input.appUrn,
        input.stage,
        state.operation.images.map(({ migrationId }) => migrationId),
      );
      const plans = await storage.use(async (_docker, observed) => {
        if (
          migrationStorageHash(observed) !== state.storageSha256 ||
          observed.containerPath !== input.localDirectory ||
          selected.environment.APP_DATA_DIR !== observed.hostPath ||
          selected.sources.length !== state.operation.images.length
        )
          throw migrationFailure();
        return state.operation.images.map((image, index) => {
          const source = selected.sources[index];
          if (!source || source.id !== image.migrationId || source.sha256 !== image.sourceSha256) throw migrationFailure();
          const definition = parseAppMigration(source, { appDataHostPath: observed.hostPath, environment: selected.environment });
          if (migrationHash(definition) !== image.definitionSha256) throw migrationFailure();
          return { definition, image };
        });
      });
      if ((await input.stage.read()).migrationPreparation?.phase === 'intent') await input.stage.confirmMigrationPreparation(journal);
      await input.stage.verifyMigrationPreparation(journal);
      return new AppUpdateMigrations(journal, input.stage, storage, plans, input.localDirectory, input.archive);
    } catch {
      await journal?.close().catch(() => undefined);
      await storage?.close().catch(() => undefined);
      throw migrationFailure();
    }
  }

  async verifyStorage() {
    await this.verified(async () => undefined);
  }

  async capture() {
    await this.stage.verifyMigrationPreparation(this.journal);
    await this.journal.capture(this.storage, this.localDirectory, this.archive);
  }
  async run() {
    await this.stage.verifyMigrationPreparation(this.journal);
    await new AppMigrationRunner(this.journal, this.storage).run(this.plans);
  }
  private async verified<T>(effect: () => Promise<T>) {
    await this.stage.verifyMigrationPreparation(this.journal);
    const state = await this.journal.read();
    return this.storage.use(async (_docker, observed) => {
      if (migrationStorageHash(observed) !== state.storageSha256) throw migrationFailure();
      return effect();
    });
  }
  async activationAttempted() {
    await this.verified(() => this.journal.activationAttempted());
  }
  async beginCommit() {
    await this.verified(() => this.journal.beginCommit());
  }
  async commit(repository: Pick<AppsRepository, 'commitMigration'>, status: 'running' | 'stopped', pendingRestart?: boolean) {
    await this.verified(async () => {
      const committed = await repository.commitMigration(await this.journal.read(), status, pendingRestart);
      await this.journal.confirmCommitted(committed.sha256);
    });
  }
  async recoverBeforeActivation() {
    const state = await this.journal.read();
    if (state.targetWritesPossible || state.commitAttempted) throw migrationFailure();
    // Preparation/checkpoint capture never changes app data. Any possible script start requires positive checkpoint restoration.
    if (state.phase === 'restored' || (state.runners.length === 0 && ['allocated', 'capturing', 'ready'].includes(state.phase))) {
      await this.verified(async () => undefined);
      return;
    }
    await new AppMigrationRunner(this.journal, this.storage).restoreCheckpoint(this.plans, this.localDirectory, this.archive);
  }
  async verifyRollbackWriters() {
    await new AppMigrationRunner(this.journal, this.storage).verifyRollbackWriters(this.plans);
  }

  async close() {
    const closed = await Promise.allSettled([this.journal.close(), this.storage.close()]);
    if (closed.some(({ status }) => status === 'rejected')) throw migrationFailure();
  }
}
