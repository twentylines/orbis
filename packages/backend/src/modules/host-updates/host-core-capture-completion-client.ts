import http, { type IncomingMessage } from 'node:http';
import { controllerCaptureSocketIdentity } from './host-controller-config';
import { validateCoreCaptureBinding, type CoreCaptureBinding } from './host-core-capture-contract';

export type CoreCaptureCompletionDetails = Readonly<
  CoreCaptureBinding & {
    version: 1;
    state: 'verified-awaiting-continuation' | 'complete';
    completionSha256: string;
    pointReservationSha256: string;
    controller: Readonly<{ id: string; imageId: string; startedAt: string; definitionSha256: string }>;
    continuationSha256?: string;
  }
>;
declare const verifiedCompletion: unique symbol;
export type VerifiedCoreCompletion = { readonly [verifiedCompletion]: true };
const approvals = new WeakMap<VerifiedCoreCompletion, { socket: string; identity: string; details: CoreCaptureCompletionDetails }>();
const fail = () => new Error('Core capture completion could not be verified.');
async function checkedSocketIdentity(socket: string) {
  try {
    return await controllerCaptureSocketIdentity(socket);
  } catch {
    // A missing endpoint after a reply is a failed verification, not a reconnect hint.
    throw fail();
  }
}
const hash = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === keys.sort().join(',');

function decode(raw: unknown, binding: CoreCaptureBinding): CoreCaptureCompletionDetails {
  const complete = !!raw && typeof raw === 'object' && 'state' in raw && raw.state === 'complete';
  if (
    !exact(raw, [
      'version',
      'id',
      'sourceSha256',
      'sourceHoldSha256',
      'state',
      'completionSha256',
      'pointReservationSha256',
      'controller',
      ...(complete ? ['continuationSha256'] : []),
    ]) ||
    raw.version !== 1 ||
    raw.id !== binding.id ||
    raw.sourceSha256 !== binding.sourceSha256 ||
    raw.sourceHoldSha256 !== binding.sourceHoldSha256 ||
    (!complete && raw.state !== 'verified-awaiting-continuation') ||
    !hash(raw.completionSha256) ||
    !hash(raw.pointReservationSha256) ||
    (complete && !hash(raw.continuationSha256)) ||
    !exact(raw.controller, ['id', 'imageId', 'startedAt', 'definitionSha256']) ||
    !hash(raw.controller.id) ||
    typeof raw.controller.imageId !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(raw.controller.imageId) ||
    !hash(raw.controller.definitionSha256) ||
    typeof raw.controller.startedAt !== 'string' ||
    !/^[\x20-\x7e]{1,128}$/.test(raw.controller.startedAt)
  )
    throw fail();
  const controller = Object.freeze({
    id: raw.controller.id,
    imageId: raw.controller.imageId,
    startedAt: raw.controller.startedAt,
    definitionSha256: raw.controller.definitionSha256,
  });
  return Object.freeze({
    version: 1,
    ...binding,
    state: complete ? 'complete' : 'verified-awaiting-continuation',
    completionSha256: raw.completionSha256,
    pointReservationSha256: raw.pointReservationSha256,
    controller,
    ...(complete ? { continuationSha256: raw.continuationSha256 as string } : {}),
  });
}

function length(reply: IncomingMessage) {
  const counts = new Map<string, number>();
  for (let i = 0; i < reply.rawHeaders.length; i += 2) {
    const name = reply.rawHeaders[i]?.toLowerCase() ?? '';
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const bytes = reply.headers['content-length'];
  if (
    reply.statusCode !== 200 ||
    reply.headers['cache-control'] !== 'no-store' ||
    reply.headers['content-type'] !== 'application/json' ||
    ['content-length', 'content-type', 'cache-control'].some((name) => counts.get(name) !== 1) ||
    ['transfer-encoding', 'content-encoding', 'trailer'].some((name) => counts.has(name)) ||
    typeof bytes !== 'string' ||
    !/^[1-9][0-9]*$/.test(bytes) ||
    !Number.isSafeInteger(Number(bytes)) ||
    Number(bytes) > 8192
  )
    throw fail();
  return Number(bytes);
}

export async function useVerifiedCoreCompletion<T>(
  token: VerifiedCoreCompletion,
  work: (details: CoreCaptureCompletionDetails) => Promise<T>,
): Promise<T> {
  const approved = approvals.get(token);
  if (!approved) throw fail();
  approvals.delete(token);
  if ((await controllerCaptureSocketIdentity(approved.socket)) !== approved.identity) throw fail();
  const outcome = await Promise.resolve()
    .then(() => work(approved.details))
    .then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
  if ((await controllerCaptureSocketIdentity(approved.socket)) !== approved.identity) throw fail();
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

export class HostCoreCaptureCompletionClient {
  constructor(private readonly socket: string) {}

  private async request(
    input: CoreCaptureBinding,
    operation: 'completion' | 'continuation',
    extra: Record<string, string>,
    cancellation: AbortSignal,
  ) {
    const binding = validateCoreCaptureBinding(input);
    cancellation.throwIfAborted();
    const identity = await controllerCaptureSocketIdentity(this.socket);
    const timeout = operation === 'completion' ? 31 * 60_000 : 30_000;
    const signal = AbortSignal.any([cancellation, AbortSignal.timeout(timeout)]);
    const payload = JSON.stringify({ sourceSha256: binding.sourceSha256, sourceHoldSha256: binding.sourceHoldSha256, ...extra });
    const reply = await new Promise<IncomingMessage>((resolve, reject) => {
      const request = http.request(
        {
          socketPath: this.socket,
          method: 'POST',
          path: `/v1/core-captures/${binding.id}/${operation}`,
          signal,
          agent: false,
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Connection: 'close' },
        },
        resolve,
      );
      request.setTimeout(timeout, () => request.destroy(fail()));
      request.on('error', reject);
      request.end(payload);
    });
    try {
      const expected = length(reply);
      const parts: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of reply) {
        signal.throwIfAborted();
        const part = Buffer.from(chunk);
        bytes += part.length;
        if (bytes > expected) throw fail();
        parts.push(part);
      }
      if (!reply.complete || bytes !== expected || Object.keys(reply.trailers).length || (await checkedSocketIdentity(this.socket)) !== identity)
        throw fail();
      signal.throwIfAborted();
      const details = decode(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts))), binding);
      if (
        operation === 'continuation' &&
        (details.state !== 'complete' ||
          details.completionSha256 !== extra.completionSha256 ||
          details.continuationSha256 !== extra.continuationSha256)
      )
        throw fail();
      const token = Object.freeze({}) as VerifiedCoreCompletion;
      approvals.set(token, { socket: this.socket, identity, details });
      return token;
    } finally {
      reply.destroy();
    }
  }

  prepare(binding: CoreCaptureBinding, signal: AbortSignal): Promise<VerifiedCoreCompletion> {
    return this.request(binding, 'completion', {}, signal);
  }

  finish(binding: CoreCaptureBinding, completionSha256: string, continuationSha256: string, signal: AbortSignal): Promise<VerifiedCoreCompletion> {
    if (!hash(completionSha256) || !hash(continuationSha256)) return Promise.reject(fail());
    return this.request(binding, 'continuation', { completionSha256, continuationSha256 }, signal);
  }
}
