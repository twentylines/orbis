import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { expect, it } from 'vitest';
import { HostUpdatesService } from '../host-updates/host-updates.service';
import { copyControllerPublicationExpectation, decodeControllerPublicationReceipt } from '../host-updates/host-controller-publication';
import { CaptureFenceJournal } from './time-machine-capture-fence';
import { TimeMachineStore } from './time-machine-store';
import { TimeMachineCaptureRuntime } from './time-machine-capture-runtime';

it('recovers durable Node capture credentials through the actual Python root fence after both clients and host service restart', async () => {
  const data = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-fence-bridge-')));
  const { point } = await new TimeMachineStore(data).create(1, 2);
  const child = spawn('python3', [path.resolve('../../scripts/test_orbis_host_capture_fence.py'), '--serve-journal-fixture', point.id], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: child.stdout });
  child.stderr.on('data', () => undefined);
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.once('error', () => resolve());
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const original = process.env.ORBIS_HOST_SOCKET;
  try {
    const line = await new Promise<string>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Root fence fixture readiness timed out.')), 5000);
      lines.once('line', resolve);
      child.once('error', () => reject(new Error('Root fence fixture failed to start.')));
      child.once('exit', () => reject(new Error('Root fence fixture exited before readiness.')));
    });
    clearTimeout(timer);
    const fixture = JSON.parse(line);
    const expected = copyControllerPublicationExpectation(fixture.expected);
    const receipt = decodeControllerPublicationReceipt(fixture.receipt, expected);
    const journals = new CaptureFenceJournal(data);
    const attempt = await journals.create(expected, receipt);
    process.env.ORBIS_HOST_SOCKET = fixture.socket;
    const before = new HostUpdatesService({} as never, {} as never);
    await before.acquireControllerCaptureFence(expected, receipt, undefined, attempt.clientKey);
    // The root restart drops its process flock and changes only the controller start time.
    await new Promise<void>((resolve, reject) => {
      const request = http.request(
        { socketPath: fixture.socket, path: '/__fixture_restart', method: 'POST', signal: AbortSignal.timeout(3000) },
        (response) => {
          response.resume();
          response.on('end', () => (response.statusCode === 200 ? resolve() : reject(new Error('Root fixture restart failed.'))));
        },
      );
      request.on('error', reject);
      request.end();
    });
    const restartedClient = new HostUpdatesService({} as never, {} as never);
    const runtime = new TimeMachineCaptureRuntime(
      { get: () => ({ dataDir: data }) } as never,
      restartedClient,
      {} as never,
      {} as never,
      {} as never,
    );
    // Recovery reads the key/graph from disk rather than reusing the old lease closure.
    await runtime.recoverCaptureFences([point]);
    expect(await new CaptureFenceJournal(data).list()).toEqual([]);
    const capture = await restartedClient.captureControllerConfiguration({
      pointId: point.id,
      controllerId: expected.configuration.controller.id,
      imageId: expected.configuration.controller.imageId,
    });
    expect(capture.metadata.controller.startedAt).toBe('2026-11-01T12:00:00Z');
    expect(JSON.stringify(await new TimeMachineStore(data).list())).not.toContain(attempt.clientKey);
  } finally {
    clearTimeout(timer);
    process.env.ORBIS_HOST_SOCKET = original;
    lines.close();
    child.kill('SIGTERM');
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        exited,
        new Promise<void>((resolve) => {
          killTimer = setTimeout(() => {
            child.kill('SIGKILL');
            resolve();
          }, 3000);
        }),
      ]);
      await exited;
    } finally {
      clearTimeout(killTimer);
    }
    await fs.rm(data, { recursive: true, force: true });
  }
}, 15_000);
