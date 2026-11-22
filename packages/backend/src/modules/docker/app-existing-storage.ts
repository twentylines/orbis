import path from 'node:path';
import type Dockerode from 'dockerode';
import type { AppUrn } from '@runtipi/common/types';
import { existingBaselineBindingSchema, existingBaselineFailure as fail, type ExistingBaselineBinding } from '../apps/app-existing-baseline-schema';
import { readAppMigrationIds } from '../apps/app-migrations';
import { migrationHash, migrationStorageHash } from '../backups/app-migration-journal';
import { AppStorageWitness } from '../host-updates/app-storage-observation';
import { appUpdateStorage } from './app-image-pins';
import { migrationRecord as record } from './app-migration-engine';
import { appContainerMounts, readAppContainerInventory, requireAppStorageOwners } from './app-storage-inventory';
import { AppUpdateStage, type AppUpdateContext } from './app-update-stage';
import type { DockerService } from './docker.service';

const live = new WeakMap<ExistingAppBaseline, { stage: AppUpdateStage; verify: () => Promise<ExistingBaselineBinding> }>();
const same = (left: unknown, right: unknown) => migrationHash(left) === migrationHash(right);
const hash = /^[a-f0-9]{64}$/;
const projectContainers = (values: Record<string, unknown>[], appUrn: AppUrn) =>
  values.filter(
    (value) => record(value.Config) && record(value.Config.Labels) && value.Config.Labels['com.docker.compose.project'] === appUrn.replace(':', '_'),
  );

function footprint(values: Record<string, unknown>[], appUrn: AppUrn) {
  return values
    .map((value) => {
      if (!record(value.Config) || !record(value.Config.Labels) || !record(value.State)) throw fail();
      const labels = value.Config.Labels;
      const state = value.State;
      if (
        typeof value.Id !== 'string' ||
        !hash.test(value.Id) ||
        typeof value.Image !== 'string' ||
        !/^sha256:[a-f0-9]{64}$/.test(value.Image) ||
        labels['com.docker.compose.project'] !== appUrn.replace(':', '_') ||
        labels['runtipi.appurn'] !== appUrn ||
        labels['runtipi.managed'] !== 'true' ||
        typeof labels['com.docker.compose.service'] !== 'string' ||
        typeof labels['com.docker.compose.config-hash'] !== 'string' ||
        !hash.test(labels['com.docker.compose.config-hash']) ||
        ['Running', 'Paused', 'Restarting'].some((key) => typeof state[key] !== 'boolean') ||
        state.Dead !== false ||
        !Number.isSafeInteger(state.Pid) ||
        Number(state.Pid) < 0 ||
        typeof state.StartedAt !== 'string' ||
        !Number.isFinite(Date.parse(state.StartedAt)) ||
        /^0001-01-01T/.test(state.StartedAt)
      )
        throw fail();
      return {
        id: value.Id,
        imageId: value.Image,
        service: labels['com.docker.compose.service'],
        configSha256: labels['com.docker.compose.config-hash'],
        mountsSha256: migrationHash(appContainerMounts(value)),
        startedAt: state.StartedAt,
        running: state.Running as boolean,
        paused: state.Paused as boolean,
        restarting: state.Restarting as boolean,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}
const contextContainers = (rows: ReturnType<typeof footprint>): AppUpdateContext['originalContainers'] =>
  rows.map(({ id, imageId, service, running, paused, restarting }) => ({ id, imageId, service, running, paused, restarting }));

type ExistingBaselineInput = {
  stage: AppUpdateStage;
  service: Pick<DockerService, 'prepareExistingBaselineConfiguration' | 'verifyExistingBaselineInputs'>;
  docker: Dockerode;
  appUrn: AppUrn;
  localDirectory: string;
  socketPath: string;
  appId: number;
  appCreatedAt: number;
  version: number;
  requestInputSha256: string;
  originalContainers: AppUpdateContext['originalContainers'];
};

/** Current deployed-version cut-over, backed by live Host storage and the installed Compose model. Never a clean-data or script-execution claim. */
export class ExistingAppBaseline {
  private constructor(private readonly witness: AppStorageWitness) {}

  static open(input: ExistingBaselineInput) {
    return ExistingAppBaseline.qualify(input, false);
  }
  static reopen(input: ExistingBaselineInput) {
    return ExistingAppBaseline.qualify(input, true);
  }
  private static async qualify(input: ExistingBaselineInput, reopening: boolean) {
    if (!(input.stage instanceof AppUpdateStage)) throw fail();
    const witness = await AppStorageWitness.open(input);
    try {
      const stage = await input.stage.read();
      const source = await input.stage.readOriginalBaseline();
      if (stage.appUrn !== input.appUrn || Boolean(stage.existingBaseline) !== reopening) throw fail();
      const config = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(await appUpdateStorage.readOwned(path.join(source.metadata, 'config.json'), 1024 * 1024)),
      );
      if (!record(config) || config.tipi_version !== input.version) throw fail();
      const migrationIds = [...(await readAppMigrationIds(source.metadata))].sort();
      const initial = await witness.use(async (docker, observation) => {
        if (observation.appUrn !== input.appUrn || observation.containerPath !== input.localDirectory) throw fail();
        return { rows: projectContainers(await readAppContainerInventory(docker), input.appUrn), storageSha256: migrationStorageHash(observation) };
      });
      const rows = footprint(initial.rows, input.appUrn);
      if (
        !rows.length ||
        !same(
          contextContainers(rows),
          [...input.originalContainers].sort((a, b) => a.id.localeCompare(b.id)),
        )
      )
        throw fail();
      const markers: Record<string, string> = Object.create(null);
      for (const value of initial.rows) {
        if (!record(value.Config) || !record(value.Config.Labels)) throw fail();
        const labels = value.Config.Labels;
        const marker = labels['io.orbis.app-update.stage'];
        if (marker !== undefined) {
          const name = String(labels['com.docker.compose.service']);
          if (typeof marker !== 'string' || (Object.hasOwn(markers, name) && markers[name] !== marker)) throw fail();
          markers[name] = marker;
        }
      }
      const model = await input.service.prepareExistingBaselineConfiguration(input.appUrn, input.stage, markers);
      if (
        !model.activeServices.length ||
        rows.some((row) => !Object.hasOwn(model.serviceHashes, row.service) || model.serviceHashes[row.service] !== row.configSha256) ||
        model.activeServices.some((name) => !rows.some((row) => row.service === name))
      )
        throw fail();
      const ownVolumes = new Set<string>();
      for (const value of initial.rows)
        for (const mount of appContainerMounts(value)) {
          if (mount.type === 'volume' && mount.writable) {
            if (typeof mount.name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/.test(mount.name)) throw fail();
            ownVolumes.add(mount.name);
          }
        }
      const binding = existingBaselineBindingSchema.assert({
        schema: 'orbis.existing-app-baseline.v1',
        requestId: stage.requestId,
        stageId: stage.id,
        appUrn: input.appUrn,
        appId: input.appId,
        appCreatedAt: input.appCreatedAt,
        version: input.version,
        requestInputSha256: input.requestInputSha256,
        authoritySha256: model.authoritySha256,
        metadataSha256: migrationHash(stage.baseline),
        storageSha256: initial.storageSha256,
        configurationSha256: model.configurationSha256,
        migrationIds,
        originalContainers: rows,
      });
      if (reopening && !same(stage.existingBaseline?.binding, binding)) throw fail();
      const proof = new ExistingAppBaseline(witness);
      live.set(proof, {
        stage: input.stage,
        verify: async () => {
          const current = await input.stage.read();
          await input.stage.readOriginalBaseline();
          if (
            current.id !== binding.stageId ||
            current.requestId !== binding.requestId ||
            current.appUrn !== binding.appUrn ||
            migrationHash(current.baseline) !== binding.metadataSha256 ||
            (current.existingBaseline && !same(current.existingBaseline.binding, binding))
          )
            throw fail();
          await input.service.verifyExistingBaselineInputs(input.appUrn, binding.authoritySha256);
          await witness.use(async (docker, observation) => {
            if (migrationStorageHash(observation) !== binding.storageSha256) throw fail();
            const values = await requireAppStorageOwners(docker, observation, new Set(rows.map(({ id }) => id)), ownVolumes);
            if (!same(footprint(values, input.appUrn), rows)) throw fail();
          });
          await input.stage.readOriginalBaseline();
          await input.service.verifyExistingBaselineInputs(input.appUrn, binding.authoritySha256);
          return structuredClone(binding);
        },
      });
      await verifyExistingAppBaseline(proof, input.stage);
      return proof;
    } catch {
      await witness.close();
      throw fail();
    }
  }
  async close() {
    live.delete(this);
    await this.witness.close();
  }
  toJSON() {
    throw fail();
  }
}

export async function verifyExistingAppBaseline(proof: ExistingAppBaseline, stage: AppUpdateStage) {
  const selected = live.get(proof);
  if (!selected || selected.stage !== stage) throw fail();
  return selected.verify();
}
