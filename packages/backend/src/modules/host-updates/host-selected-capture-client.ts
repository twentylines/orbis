import http, { type IncomingMessage } from 'node:http';
import { createHash } from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import {
  timeMachineCaptureReviewSchema,
  timeMachineHashSchema,
  timeMachineIdSchema,
  timeMachineSelectedReceiptSchema,
  type TimeMachineCaptureSelection,
  type TimeMachineSelectedReceipt,
} from '@runtipi/common/schemas/time-machine';
import { controllerCaptureSocketIdentity } from './host-controller-config';
import { canonicalPublicationJson } from './host-controller-publication';

const maximum = 4 * 1024 ** 2;
const fail = () => new Error('Selected app capture could not be verified. Review the included storage again.');
export class SelectedCaptureConflict extends Error {}
const digest = (value: unknown) => createHash('sha256').update(canonicalPublicationJson(value)).digest('hex');
export type SelectedCaptureBinding = {
  version: 1;
  pointId: string;
  corePointId: string;
  planSha256: string;
  apps: ReturnType<typeof timeMachineCaptureReviewSchema.assert>['apps'];
  selection: TimeMachineCaptureSelection['apps'];
};
export class HostSelectedCaptureClient {
  constructor(private readonly socket: string) {}

  private async request(route: string, body: object, signal: AbortSignal, binary = false) {
    signal.throwIfAborted();
    const identity = await controllerCaptureSocketIdentity(this.socket);
    const wire = JSON.stringify(body);
    if (Buffer.byteLength(wire) > 65536) throw fail();
    const cancellation = AbortSignal.any([signal, AbortSignal.timeout(binary ? 30 * 60_000 : 120_000)]);
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const request = http.request(
        {
          socketPath: this.socket,
          method: 'POST',
          path: `/v1/selected-captures/${route}`,
          signal: cancellation,
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(wire), connection: 'close' },
        },
        resolve,
      );
      request.once('error', reject);
      request.end(wire);
    });
    try {
      if (response.statusCode === 409) throw new SelectedCaptureConflict('Selected app storage needs review.');
      const counts = new Map<string, number>();
      for (let index = 0; index < response.rawHeaders.length; index += 2) {
        const key = response.rawHeaders[index]?.toLowerCase() ?? '';
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const length = response.headers['content-length'];
      if (
        response.statusCode !== 200 ||
        response.headers['content-type'] !== (binary ? 'application/octet-stream' : 'application/json') ||
        response.headers['cache-control'] !== 'no-store' ||
        typeof length !== 'string' ||
        !/^[1-9][0-9]*$/.test(length) ||
        !Number.isSafeInteger(Number(length)) ||
        Number(length) > (binary ? 2 ** 36 - 32 : maximum) ||
        ['content-length', 'content-type', 'cache-control'].some((key) => counts.get(key) !== 1) ||
        ['transfer-encoding', 'content-encoding', 'trailer'].some((key) => counts.has(key)) ||
        identity !== (await controllerCaptureSocketIdentity(this.socket))
      )
        throw fail();
      return { response, bytes: Number(length), identity };
    } catch (error) {
      response.destroy();
      throw error;
    }
  }

  private async json(route: string, body: object, signal: AbortSignal): Promise<unknown> {
    const { response, bytes, identity } = await this.request(route, body, signal);
    try {
      const chunks: Buffer[] = [];
      let count = 0;
      for await (const chunk of response) {
        count += chunk.length;
        if (count > bytes) throw fail();
        chunks.push(Buffer.from(chunk));
      }
      if (count !== bytes || identity !== (await controllerCaptureSocketIdentity(this.socket))) throw fail();
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    } finally {
      response.destroy();
    }
  }

  async requireCapability(signal: AbortSignal) {
    const value = await this.json('capability', {}, signal);
    const expected = {
      schema: 'orbis.selected-capture-capability.v1',
      version: 1,
      pointVersion: 4,
      payloadFormat: 'orbis.time-machine-components.v1',
      operations: ['review', 'bind', 'receipt', 'artifact', 'status'],
      lifecycleAuthority: 'parent-core-admission.v1',
      legacyReceipts: 'unchanged',
    };
    if (canonicalPublicationJson(value) !== canonicalPublicationJson(expected)) throw fail();
  }

  async review(appUrns: string[], signal: AbortSignal) {
    await this.requireCapability(signal);
    return timeMachineCaptureReviewSchema.assert(await this.json('review', { appUrns }, signal));
  }

  async bind(pointId: string, corePointId: string, coreReservationSha256: string, selection: TimeMachineCaptureSelection, signal: AbortSignal) {
    if (!timeMachineIdSchema.allows(pointId) || !timeMachineIdSchema.allows(corePointId) || !timeMachineHashSchema.allows(coreReservationSha256))
      throw fail();
    const value = (await this.json(
      `${corePointId}/bind`,
      { pointId, coreReservationSha256, reviewId: selection.reviewId, reviewSha256: selection.reviewSha256, apps: selection.apps },
      signal,
    )) as SelectedCaptureBinding;
    if (
      !value ||
      Object.keys(value).sort().join(',') !== 'apps,corePointId,planSha256,pointId,selection,version' ||
      value.version !== 1 ||
      value.pointId !== pointId ||
      value.corePointId !== corePointId ||
      !timeMachineHashSchema.allows(value.planSha256) ||
      canonicalPublicationJson(value.selection) !==
        canonicalPublicationJson(
          [...selection.apps].map((app) => ({ urn: app.urn, mountIds: [...app.mountIds].sort() })).sort((a, b) => a.urn.localeCompare(b.urn)),
        )
    )
      throw fail();
    timeMachineCaptureReviewSchema.assert({ version: 1, reviewId: selection.reviewId, reviewSha256: selection.reviewSha256, apps: value.apps });
    return value;
  }

  async receipt(corePointId: string, signal: AbortSignal) {
    if (!timeMachineIdSchema.allows(corePointId)) throw fail();
    const value = (await this.json(`${corePointId}/receipt`, {}, signal)) as {
      version: 1;
      receiptSha256: string;
      receipt: TimeMachineSelectedReceipt;
    };
    if (
      !value ||
      Object.keys(value).sort().join(',') !== 'receipt,receiptSha256,version' ||
      value.version !== 1 ||
      !timeMachineSelectedReceiptSchema.allows(value.receipt) ||
      value.receipt.corePointId !== corePointId ||
      value.receiptSha256 !== digest(value.receipt)
    )
      throw fail();
    return value;
  }

  async withArtifact<T>(
    corePointId: string,
    receiptSha256: string,
    receipt: TimeMachineSelectedReceipt,
    signal: AbortSignal,
    consume: (source: Readable) => Promise<T>,
  ) {
    if (
      !timeMachineIdSchema.allows(corePointId) ||
      !timeMachineHashSchema.allows(receiptSha256) ||
      !timeMachineSelectedReceiptSchema.allows(receipt) ||
      receipt.corePointId !== corePointId ||
      digest(receipt) !== receiptSha256
    )
      throw fail();
    const { response, bytes, identity } = await this.request(`${corePointId}/artifact`, { receiptSha256 }, signal, true);
    let received = 0;
    const hash = createHash('sha256');
    const source = new Transform({
      transform(chunk, _encoding, done) {
        received += chunk.length;
        if (received > bytes) return done(fail());
        hash.update(chunk);
        done(null, chunk);
      },
    });
    response.on('error', (error) => source.destroy(error));
    source.on('error', () => response.destroy());
    response.pipe(source);
    try {
      if (bytes !== receipt.artifact.bytes) throw fail();
      const result = await consume(source);
      if (
        !source.readableEnded ||
        received !== bytes ||
        hash.digest('hex') !== receipt.artifact.sha256 ||
        identity !== (await controllerCaptureSocketIdentity(this.socket))
      )
        throw fail();
      return result;
    } finally {
      source.destroy();
      response.destroy();
    }
  }
}
