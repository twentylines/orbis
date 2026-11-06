import type { HostCoreCaptureAbortClient, CoreCaptureAbortPreparation } from '../host-updates/host-core-capture-abort-client';
import type { QueueFactory } from '../queue/queue.factory';
import {
  type prepareCoreCaptureSourceHold,
  sealCoreCaptureSourceForAbort,
  resumeCoreCaptureSourceAfterAbort,
  settleCoreCaptureSourceAbort,
} from './time-machine-core-source-hold';

type Source = Awaited<ReturnType<typeof prepareCoreCaptureSourceHold>>;
type Options = {
  preparation: CoreCaptureAbortPreparation;
  client: HostCoreCaptureAbortClient;
  queue: Pick<QueueFactory, 'resumeCoreCapturePause'>;
  signal: AbortSignal;
};
type Result = { id: string; state: 'complete'; continuationSha256: string };
const attempts = new WeakMap<Source, Promise<Result>>();
const transportFailure = (error: unknown) => {
  if (!error || typeof error !== 'object') return false;
  const code = Object.getOwnPropertyDescriptor(error, 'code');
  return !!code && 'value' in code && ['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT'].includes(code.value);
};

/** Observations may reconcile lost replies; no command or consumer start is retried. */
export function cancelLiveCoreCapture(source: Source, options: Options): Promise<Result> {
  return cancel(source, options, false);
}

export function cancelLiveCoreCaptureAfterIntent(source: Source, options: Options): Promise<Result> {
  return cancel(source, options, true);
}

function cancel(source: Source, options: Options, intentAlreadySelected: boolean): Promise<Result> {
  const existing = attempts.get(source);
  if (existing) return existing;
  const attempt = Promise.resolve().then(async (): Promise<Result> => {
    const { client, preparation, queue, signal } = options;
    signal.throwIfAborted();
    const intent = await (intentAlreadySelected ? client.observeIntent(preparation, signal) : client.intent(preparation, signal)).catch((error) => {
      if (intentAlreadySelected) throw error;
      if (!transportFailure(error)) throw error;
      return client.observeIntent(preparation, signal);
    });
    const terminal = await sealCoreCaptureSourceForAbort(source, intent.token, signal);
    const approved = await client
      .prepare(preparation, terminal.decisionSha256, terminal.terminalSha256, terminal.sourceHoldSha256, signal)
      .catch((error) => {
        if (!transportFailure(error)) throw error;
        return client.observeApproval(preparation, terminal.decisionSha256, terminal.terminalSha256, terminal.sourceHoldSha256, signal);
      });
    const ready = await resumeCoreCaptureSourceAfterAbort(source, approved.token, queue, signal);
    const complete = await client.finish(approved.details, ready.continuationSha256, signal).catch((error) => {
      if (!transportFailure(error)) throw error;
      return client.observeComplete(approved.details, ready.continuationSha256, signal);
    });
    await settleCoreCaptureSourceAbort(source, complete.token, signal);
    return { id: preparation.id, state: 'complete', continuationSha256: ready.continuationSha256 };
  });
  attempts.set(source, attempt);
  return attempt;
}
