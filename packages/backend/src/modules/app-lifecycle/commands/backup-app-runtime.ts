import type { TaskPhase } from '@runtipi/common/schemas/task-history';
import type { AppUrn } from '@runtipi/common/types';
import type Dockerode from 'dockerode';
import type { DockerService } from '@/modules/docker/docker.service';
import type { AppJobContext } from '../services/app-job.service';

export type AppContainerSnapshot = { container: Dockerode.Container; state: Dockerode.ContainerInspectInfo['State'] };
type BackupResult = { success: true; statePreserved: boolean } | { success: false; message: string; statePreserved: boolean };
export const isActiveAppContainer = (state: AppContainerSnapshot['state']) => Boolean(state.Running || state.Restarting || state.Paused);
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function resumeAppContainers(snapshots: AppContainerSnapshot[]) {
  const errors: string[] = [];
  for (const { container, state: original } of snapshots) {
    try {
      let current = (await container.inspect()).State;
      if (isActiveAppContainer(original) && !isActiveAppContainer(current)) {
        await container.start().catch((error: unknown) => {
          if ((error as { statusCode?: number } | null)?.statusCode !== 304) throw error;
        });
        current = (await container.inspect()).State;
      }
      if (original.Paused && !current.Paused) await container.pause();
      else if (!original.Paused && current.Paused) await container.unpause();
      const restored = (await container.inspect()).State;
      if (isActiveAppContainer(original) !== isActiveAppContainer(restored) || Boolean(original.Paused) !== Boolean(restored.Paused)) {
        throw new Error('Container did not return to its previous state');
      }
    } catch (error) {
      errors.push(`${container.id}: ${messageOf(error)}`);
    }
  }
  if (errors.length) throw new Error(errors.join('; '));
}

export async function backupAppWithRuntime({
  appUrn,
  docker,
  dockerService,
  backup,
  resumeAfterSuccess,
  reportProgress,
  job,
}: {
  appUrn: AppUrn;
  docker: Dockerode;
  dockerService: Pick<DockerService, 'composeApp'>;
  backup: (snapshotReady?: () => Promise<void>) => Promise<void>;
  resumeAfterSuccess: boolean;
  reportProgress?: (phase: TaskPhase) => Promise<void>;
  job?: AppJobContext;
}): Promise<BackupResult> {
  const snapshots: AppContainerSnapshot[] = [];
  let stopAttempted = false;
  let snapshotNotified = false;
  let resumed = false;
  let failure: string | undefined;
  try {
    job?.check();
    const containers = await docker.listContainers({
      all: true,
      filters: { label: [`com.docker.compose.project=${appUrn.replace(':', '_')}`] },
    });
    for (const info of containers) {
      const container = docker.getContainer(info.Id);
      snapshots.push({ container, state: (await container.inspect()).State });
    }
    await reportProgress?.('stopping');
    job?.check();
    stopAttempted = true;
    for (const { container, state } of snapshots) if (state.Paused) await container.unpause();
    if (job) await dockerService.composeApp(appUrn, 'stop', { signal: job.signal });
    else await dockerService.composeApp(appUrn, 'stop');
    for (const { container } of snapshots) {
      if (isActiveAppContainer((await container.inspect()).State)) throw new Error('App containers must be stopped before backup');
    }
    await reportProgress?.('backing_up');
    job?.check();
    await backup(
      resumeAfterSuccess
        ? async () => {
            if (snapshotNotified) throw new Error('The backup snapshot was already acknowledged.');
            snapshotNotified = true;
            await reportProgress?.('starting');
            await resumeAppContainers(snapshots);
            resumed = true;
            await reportProgress?.('backing_up');
          }
        : undefined,
    );
  } catch (error) {
    failure = messageOf(error);
  }

  if (failure === undefined && !resumeAfterSuccess) return { success: true, statePreserved: false };
  if (resumed) {
    try {
      for (const { container, state: original } of snapshots) {
        const current = (await container.inspect()).State;
        if (isActiveAppContainer(original) !== isActiveAppContainer(current) || Boolean(original.Paused) !== Boolean(current.Paused))
          throw new Error('Container state changed after the backup snapshot was captured');
      }
    } catch (error) {
      return {
        success: false,
        message: `${failure ?? 'Backup completed'}. App runtime could not be confirmed: ${messageOf(error)}`,
        statePreserved: false,
      };
    }
    return failure === undefined ? { success: true, statePreserved: true } : { success: false, message: failure, statePreserved: true };
  }
  if (stopAttempted) {
    try {
      await reportProgress?.(failure === undefined ? 'starting' : 'recovering');
      await resumeAppContainers(snapshots);
    } catch (error) {
      return {
        success: false,
        message: `${failure ?? 'Backup completed'}. App could not be fully resumed: ${messageOf(error)}`,
        statePreserved: false,
      };
    }
  }
  return failure === undefined ? { success: true, statePreserved: true } : { success: false, message: failure, statePreserved: true };
}
