import { beforeEach, expect, it, vi } from 'vitest';
import type { HostCoreCaptureAbortClient, CoreCaptureAbortPreparation } from '../host-updates/host-core-capture-abort-client';
import type { QueueFactory } from '../queue/queue.factory';
import { cancelLiveCoreCapture, cancelLiveCoreCaptureAfterIntent } from './time-machine-core-abort';
import type { prepareCoreCaptureSourceHold } from './time-machine-core-source-hold';

const stages = vi.hoisted(() => ({ seal: vi.fn(), resume: vi.fn(), settle: vi.fn() }));
vi.mock('./time-machine-core-source-hold', () => ({
  sealCoreCaptureSourceForAbort: stages.seal,
  resumeCoreCaptureSourceAfterAbort: stages.resume,
  settleCoreCaptureSourceAbort: stages.settle,
}));
beforeEach(() => {
  vi.clearAllMocks();
  stages.seal.mockResolvedValue({ id: 'point', decisionSha256: 'decision', terminalSha256: 'terminal', sourceHoldSha256: 'hold' });
  stages.resume.mockResolvedValue({ id: 'point', continuationSha256: 'ready' });
  stages.settle.mockResolvedValue(undefined);
});
function fixture() {
  const client = {
    intent: vi.fn(async () => ({ token: 'intent' })),
    observeIntent: vi.fn(async () => ({ token: 'observed-intent' })),
    prepare: vi.fn(async () => ({ token: 'approved', details: { approvalSha256: 'approval' } })),
    observeApproval: vi.fn(async () => ({ token: 'observed-approval', details: { approvalSha256: 'approval' } })),
    finish: vi.fn(async () => ({ token: 'done' })),
    observeComplete: vi.fn(async () => ({ token: 'observed-done' })),
  };
  const source = {} as Awaited<ReturnType<typeof prepareCoreCaptureSourceHold>>;
  const options = {
    client: client as unknown as HostCoreCaptureAbortClient,
    preparation: { id: 'point' } as CoreCaptureAbortPreparation,
    queue: {} as Pick<QueueFactory, 'resumeCoreCapturePause'>,
    signal: new AbortController().signal,
  };
  return { source, client, options };
}
const transport = () => Object.assign(new Error('fixture connection lost'), { code: 'ECONNRESET' });

it('observes an already-selected abort after journal reconciliation without replaying intent', async () => {
  const f = fixture();
  await cancelLiveCoreCaptureAfterIntent(f.source, f.options);
  expect(f.client.intent).not.toHaveBeenCalled();
  expect(f.client.observeIntent).toHaveBeenCalledOnce();
  expect(stages.seal).toHaveBeenCalledExactlyOnceWith(f.source, 'observed-intent', f.options.signal);
  expect(f.client.prepare).toHaveBeenCalledOnce();
  expect(stages.settle).toHaveBeenCalledOnce();
});

it('runs each cancellation stage once and retains the same result on another call', async () => {
  const f = fixture();
  const pending = cancelLiveCoreCapture(f.source, f.options);
  expect(cancelLiveCoreCapture(f.source, f.options)).toBe(pending);
  await expect(pending).resolves.toEqual({ id: 'point', state: 'complete', continuationSha256: 'ready' });
  expect(f.client.intent).toHaveBeenCalledOnce();
  expect(f.client.prepare).toHaveBeenCalledOnce();
  expect(f.client.finish).toHaveBeenCalledOnce();
  expect(stages.seal).toHaveBeenCalledOnce();
  expect(stages.resume).toHaveBeenCalledOnce();
  expect(stages.settle).toHaveBeenCalledExactlyOnceWith(f.source, 'done', f.options.signal);
});

it.each(['intent', 'prepare', 'finish'] as const)('observes a lost %s reply without repeating that operation', async (stage) => {
  const f = fixture();
  f.client[stage].mockRejectedValueOnce(transport());
  await cancelLiveCoreCapture(f.source, f.options);
  expect(f.client[stage]).toHaveBeenCalledOnce();
  expect(
    stage === 'intent' ? f.client.observeIntent : stage === 'prepare' ? f.client.observeApproval : f.client.observeComplete,
  ).toHaveBeenCalledOnce();
  expect(stages.resume).toHaveBeenCalledOnce();
  expect(stages.settle).toHaveBeenCalledOnce();
});

it('does not turn malformed authority or inherited errno text into a status recovery', async () => {
  for (const error of [new Error('invalid authority'), Object.assign(Object.create({ code: 'ECONNRESET' }), { message: 'inherited code' })]) {
    const f = fixture();
    f.client.intent.mockRejectedValueOnce(error);
    await expect(cancelLiveCoreCapture(f.source, f.options)).rejects.toBe(error);
    expect(f.client.observeIntent).not.toHaveBeenCalled();
    expect(f.client.prepare).not.toHaveBeenCalled();
  }
  expect(stages.resume).not.toHaveBeenCalled();
});

it('does not submit root cleanup after failed queue resumption or repeat a failed attempt', async () => {
  const f = fixture();
  stages.resume.mockRejectedValueOnce(new Error('partial restart'));
  const pending = cancelLiveCoreCapture(f.source, f.options);
  await expect(pending).rejects.toThrow('partial restart');
  expect(cancelLiveCoreCapture(f.source, f.options)).toBe(pending);
  expect(f.client.finish).not.toHaveBeenCalled();
  expect(stages.settle).not.toHaveBeenCalled();
  expect(stages.resume).toHaveBeenCalledOnce();
});

it('retains a lost finish response as unresolved when positive completion is unavailable', async () => {
  const f = fixture();
  f.client.finish.mockRejectedValueOnce(transport());
  f.client.observeComplete.mockRejectedValueOnce(new Error('not committed'));
  await expect(cancelLiveCoreCapture(f.source, f.options)).rejects.toThrow('not committed');
  expect(f.client.finish).toHaveBeenCalledOnce();
  expect(stages.settle).not.toHaveBeenCalled();
});

it('stops before contacting root if the recovery attempt is already cancelled', async () => {
  const f = fixture();
  const abort = new AbortController();
  abort.abort();
  await expect(cancelLiveCoreCapture(f.source, { ...f.options, signal: abort.signal })).rejects.toThrow();
  expect(f.client.intent).not.toHaveBeenCalled();
  expect(stages.seal).not.toHaveBeenCalled();
});
