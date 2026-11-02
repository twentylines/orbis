import path from 'node:path';
import { BackupRequirementError } from './backup-files';
import type { BackupRestoreJournal } from './backup-restore-journal';
import { BackupRestoreDockerRuntime } from './backup-restore-runtime';
import type { RestoreBootstrap } from './backup-restore-bootstrap';
import {
  discardRestorePayload,
  prepareRestorePayload,
  restoreTargetEnvironmentDigest,
  type RestorePreparationProgress,
} from './backup-restore-preparation';
import { restoreTreeNames, type RestoreTreeName } from './backup-restore-materialize';
import type { RetainedPhaseRuntime } from './time-machine-retained-phases';
import { loadRetainedV6Images, prepareRetainedImagePins } from './time-machine-retained-images';
import { decodeRuntimePayloadManifest } from './time-machine-runtime-payload';
import type { decodeAppRuntimeCapture } from './time-machine-app-runtime-capture';
import type { RetainedImageDocker } from './backup-image-retention';

const fail = () => new BackupRequirementError('Retained restore preparation requires protected recovery.');

/** Caller holds the restore lease and has independently checked the root phase binding and bootstrap. */
export function retainedPhaseRuntime(options: {
  journal: BackupRestoreJournal;
  runtime: BackupRestoreDockerRuntime;
  bootstrap: RestoreBootstrap;
  hostname: string;
  directories: { data: string; appData: string; cache: string };
  migrationsPath: string;
  preserveLiveProxy?: boolean;
  imageAdmission: {
    expectedManifest: unknown;
    expectedManifestSha256: string;
    expectedCapture: unknown;
    expectedAppRuntime?: ReturnType<typeof decodeAppRuntimeCapture>;
    docker: RetainedImageDocker;
  };
  confirmRootActivation: () => Promise<void>;
  progress: (value: RestorePreparationProgress) => void;
}): RetainedPhaseRuntime {
  const { journal, runtime, bootstrap, directories } = options;
  const verifyWorker = () => runtime.verifyWorker(options.hostname, { preparing: true });
  return {
    prepare: async (signal) => {
      const state = await journal.refresh();
      if (state.phase !== 'staging' || state.decision !== null || options.migrationsPath !== `/data/backups/restores/${state.id}/retained/migrations`)
        throw fail();
      await verifyWorker();
      if (
        (await restoreTargetEnvironmentDigest(path.join(directories.data, '.env'), {
          connection: bootstrap.connection,
          queue: bootstrap.identity.queue,
        })) !== bootstrap.environmentSha256
      )
        throw fail();
      await journal.advance('preparing');
      await runtime.stopWriters(signal);
      const v6 = decodeRuntimePayloadManifest(options.imageAdmission.expectedManifest).schema === 'orbis.time-machine-runtime.v6';
      const retainedPins = v6
        ? undefined
        : await prepareRetainedImagePins({
            dataDirectory: directories.data,
            restoreId: state.id,
            ...options.imageAdmission,
            signal,
          });
      const roots = Object.fromEntries(
        restoreTreeNames.map((name) => [name, name === 'app-data' ? directories.appData : path.join(directories.data, name)]),
      ) as Record<RestoreTreeName, string>;
      await prepareRestorePayload({
        journal,
        source: { directory: path.join(journal.directory, 'source', 'payload'), seal: bootstrap.source },
        roots,
        environment: path.join(directories.data, '.env'),
        trustedMigrationsFolder: options.migrationsPath,
        retainedPins,
        beforePrepared: v6
          ? async (loadSignal) => {
              if (!options.imageAdmission.expectedAppRuntime) throw fail();
              await loadRetainedV6Images({
                dataDirectory: directories.data,
                restoreId: state.id,
                ...options.imageAdmission,
                expectedAppRuntime: options.imageAdmission.expectedAppRuntime,
                signal: loadSignal,
              });
            }
          : undefined,
        preserveLiveProxy: options.preserveLiveProxy,
        runtime: { ...bootstrap.identity, connection: bootstrap.connection },
        signal,
        progress: options.progress,
      });
    },
    discardPreparation: async (signal) => {
      await runtime.stopWriters(new AbortController().signal);
      await discardRestorePayload({ journal, connection: bootstrap.connection, signal });
      await runtime.resumeOriginal();
    },
    stopWriters: (signal) => runtime.stopWriters(signal),
    installDatabasePointer: (signal) => runtime.installDatabasePointer(signal),
    verifyCandidate: (signal) => runtime.verify(signal),
    restoreDatabasePointer: () => runtime.restoreDatabasePointer(),
    resumeOriginal: () => runtime.resumeOriginal(),
    confirmRootActivation: options.confirmRootActivation,
  };
}
