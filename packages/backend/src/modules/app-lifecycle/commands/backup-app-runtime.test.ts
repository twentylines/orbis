import type { AppUrn } from '@runtipi/common/types';
import type Dockerode from 'dockerode';
import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { backupAppWithRuntime } from './backup-app-runtime';

const appUrn = 'demo:store' as AppUrn;
const fixture = (states = [{ Running: true }, { Running: false }]) => {
  const docker = mock<Dockerode>();
  const containers = states.map((initial, index) => {
    const container = mock<Dockerode.Container>({ id: `original-${index}` });
    const state = { Paused: false, Restarting: false, ...initial };
    container.inspect.mockImplementation(async () => ({ State: { ...state } }) as Dockerode.ContainerInspectInfo);
    container.start.mockImplementation(async () => {
      state.Running = true;
    });
    container.pause.mockImplementation(async () => {
      state.Paused = true;
    });
    container.unpause.mockImplementation(async () => {
      state.Paused = false;
    });
    return { container, state };
  });
  docker.listContainers.mockResolvedValue(containers.map(({ container }) => ({ Id: container.id })) as Dockerode.ContainerInfo[]);
  docker.getContainer.mockImplementation((id) => {
    const container = containers.find(({ container }) => container.id === id)?.container;
    if (!container) throw new Error('Unexpected container');
    return container;
  });
  const first = containers[0];
  const second = containers[1];
  if (!first || !second) throw new Error('Fixture requires two containers');
  const dockerService = {
    composeApp: vi.fn(async () => {
      for (const { state } of containers) Object.assign(state, { Running: false, Paused: false, Restarting: false });
      return { success: true, stdout: '', stderr: '' };
    }),
  };
  const backup = vi.fn(async () => {});
  const run = (resumeAfterSuccess = false) => backupAppWithRuntime({ appUrn, docker, dockerService, backup, resumeAfterSuccess });
  return { docker, containers, first, second, dockerService, backup, run };
};

describe('Backup runtime preservation', () => {
  it.each([false, true])('resumes only original running containers when backup fails (manual=%s)', async (manual) => {
    const f = fixture();
    f.backup.mockRejectedValue(new Error('No space left on device'));
    expect(await f.run(manual)).toEqual({ success: false, message: 'No space left on device', statePreserved: true });
    expect(f.containers.map(({ state }) => state.Running)).toEqual([true, false]);
    expect(f.first.container.start).toHaveBeenCalledOnce();
    expect(f.second.container.start).not.toHaveBeenCalled();
    expect(f.docker.listContainers).toHaveBeenCalledExactlyOnceWith({ all: true, filters: { label: ['com.docker.compose.project=demo_store'] } });
    expect(f.dockerService.composeApp).toHaveBeenCalledExactlyOnceWith(appUrn, 'stop');
  });

  it('keeps containers stopped after a successful pre-update backup', async () => {
    const f = fixture();
    expect(await f.run()).toEqual({ success: true, statePreserved: false });
    expect(f.containers.map(({ state }) => state.Running)).toEqual([false, false]);
    expect(f.first.container.start).not.toHaveBeenCalled();
  });

  it('restores the exact mixed running/stopped state after a successful manual backup', async () => {
    const f = fixture();
    f.backup.mockImplementation(async () => {
      expect(f.containers.every(({ state }) => !state.Running)).toBe(true);
    });
    expect(await f.run(true)).toEqual({ success: true, statePreserved: true });
    expect(f.containers.map(({ state }) => state.Running)).toEqual([true, false]);
    expect(f.second.container.start).not.toHaveBeenCalled();
  });

  it.each(['list', 'inspect'])('does not stop or back up when initial %s fails', async (step) => {
    const f = fixture();
    if (step === 'list') f.docker.listContainers.mockRejectedValue(new Error('Docker unavailable'));
    else f.second.container.inspect.mockRejectedValue(new Error('Docker unavailable'));
    expect(await f.run()).toEqual({ success: false, message: 'Docker unavailable', statePreserved: true });
    expect(f.dockerService.composeApp).not.toHaveBeenCalled();
    expect(f.backup).not.toHaveBeenCalled();
    expect(f.first.container.start).not.toHaveBeenCalled();
  });

  it('restores the first container after Compose stops it and then fails', async () => {
    const f = fixture([{ Running: true }, { Running: true }]);
    f.dockerService.composeApp.mockImplementation(async () => {
      f.first.state.Running = false;
      throw new Error('Second container could not stop');
    });
    expect(await f.run()).toEqual({ success: false, message: 'Second container could not stop', statePreserved: true });
    expect(f.containers.map(({ state }) => state.Running)).toEqual([true, true]);
    expect(f.backup).not.toHaveBeenCalled();
    expect(f.second.container.start).not.toHaveBeenCalled();
  });

  it('refuses to copy live data if a container remains active after Compose stop', async () => {
    const f = fixture();
    f.dockerService.composeApp.mockResolvedValue({ success: true, stdout: '', stderr: '' });
    expect(await f.run()).toEqual({ success: false, message: 'App containers must be stopped before backup', statePreserved: true });
    expect(f.backup).not.toHaveBeenCalled();
    expect(f.first.container.start).not.toHaveBeenCalled();
  });

  it('preserves the backup error and resumes other containers if one cannot restart', async () => {
    const f = fixture([{ Running: true }, { Running: true }]);
    f.backup.mockRejectedValue(new Error('Backup storage failed'));
    f.first.container.start.mockRejectedValue(new Error('Start failed'));
    const result = await f.run();
    expect(result).toMatchObject({ success: false, statePreserved: false });
    expect(result).toHaveProperty('message', 'Backup storage failed. App could not be fully resumed: original-0: Start failed');
    expect(f.second.state.Running).toBe(true);
  });

  it('reports a completed manual backup as failed if its app cannot be resumed', async () => {
    const f = fixture();
    f.first.container.start.mockRejectedValue(new Error('Start failed'));
    expect(await f.run(true)).toEqual({
      success: false,
      message: 'Backup completed. App could not be fully resumed: original-0: Start failed',
      statePreserved: false,
    });
  });

  it.each([true, false])('independently verifies Docker already-started responses (running=%s)', async (running) => {
    const f = fixture();
    f.backup.mockRejectedValue(new Error('Backup failed'));
    f.first.container.start.mockImplementation(async () => {
      f.first.state.Running = running;
      throw { statusCode: 304 };
    });
    const result = await f.run();
    expect(result).toMatchObject({ success: false, statePreserved: running });
    if (running) expect(result).toHaveProperty('message', 'Backup failed');
    else expect(result).toHaveProperty('message', expect.stringContaining('Container did not return to its previous state'));
  });

  it('restores a paused container after temporarily unpausing it to stop and back up', async () => {
    const f = fixture();
    f.first.state.Paused = true;
    f.backup.mockImplementation(async () => {
      expect(f.first.state).toMatchObject({ Running: false, Paused: false });
    });
    expect(await f.run(true)).toEqual({ success: true, statePreserved: true });
    expect(f.first.state).toMatchObject({ Running: true, Paused: true });
    expect(f.first.container.unpause).toHaveBeenCalledOnce();
    expect(f.first.container.pause).toHaveBeenCalledOnce();
  });

  it('reports a removed original container without recreating it or starting a stopped sidecar', async () => {
    const f = fixture();
    f.backup.mockImplementation(async () => {
      f.first.container.inspect.mockRejectedValue({ statusCode: 404 });
      throw new Error('Backup failed');
    });
    expect(await f.run()).toMatchObject({ success: false, statePreserved: false });
    expect(f.first.container.start).not.toHaveBeenCalled();
    expect(f.second.container.start).not.toHaveBeenCalled();
    expect(f.dockerService.composeApp).toHaveBeenCalledTimes(1);
  });
});
