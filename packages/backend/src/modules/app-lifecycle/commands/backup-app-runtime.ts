import type { AppUrn } from '@runtipi/common/types';
import type Dockerode from 'dockerode';
import type { DockerService } from '@/modules/docker/docker.service';

type Snapshot = { container: Dockerode.Container; state: Dockerode.ContainerInspectInfo['State'] };
type BackupResult = { success: true; statePreserved: boolean } | { success: false; message: string; statePreserved: boolean };
const active = (state: Snapshot['state']) => Boolean(state.Running || state.Restarting || state.Paused);
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function resumeContainers(snapshots: Snapshot[]) {
  const errors: string[] = [];
  for (const { container, state: original } of snapshots) {
    try {
      let current = (await container.inspect()).State;
      if (active(original) && !active(current)) {
        await container.start().catch((error: unknown) => {
          if ((error as { statusCode?: number } | null)?.statusCode !== 304) throw error;
        });
        current = (await container.inspect()).State;
      }
      if (original.Paused && !current.Paused) await container.pause();
      else if (!original.Paused && current.Paused) await container.unpause();
      const restored = (await container.inspect()).State;
      if (active(original) !== active(restored) || Boolean(original.Paused) !== Boolean(restored.Paused)) {
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
}: {
  appUrn: AppUrn;
  docker: Dockerode;
  dockerService: Pick<DockerService, 'composeApp'>;
  backup: () => Promise<void>;
  resumeAfterSuccess: boolean;
}): Promise<BackupResult> {
  const snapshots: Snapshot[] = [];
  let stopAttempted = false;
  let failure: string | undefined;
  try {
    const containers = await docker.listContainers({
      all: true,
      filters: { label: [`com.docker.compose.project=${appUrn.replace(':', '_')}`] },
    });
    for (const info of containers) {
      const container = docker.getContainer(info.Id);
      snapshots.push({ container, state: (await container.inspect()).State });
    }
    stopAttempted = true;
    for (const { container, state } of snapshots) if (state.Paused) await container.unpause();
    await dockerService.composeApp(appUrn, 'stop');
    for (const { container } of snapshots) {
      if (active((await container.inspect()).State)) throw new Error('App containers must be stopped before backup');
    }
    await backup();
  } catch (error) {
    failure = messageOf(error);
  }

  if (failure === undefined && !resumeAfterSuccess) return { success: true, statePreserved: false };
  if (stopAttempted) {
    try {
      await resumeContainers(snapshots);
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
