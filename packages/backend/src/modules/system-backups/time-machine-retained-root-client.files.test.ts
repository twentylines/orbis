import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import * as hostConfig from '../host-updates/host-controller-config';
import { retainedNormalBootstrapCapability, RetainedRootTransaction, reviewRetainedRoot } from './time-machine-retained-root-client';
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

it('persists the private capability before begin and retries a lost reply with the same binding', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'retained-root-client-')));
  roots.push(root);
  const socket = path.join(root, 'host.sock');
  const pointId = randomUUID();
  const restoreId = randomUUID();
  const importId = randomUUID();
  const nonce = randomUUID();
  const directory = path.join(root, restoreId);
  await fs.mkdir(directory, { mode: 0o700 });
  const publication = {
    schema: 'orbis.release.v1',
    image: 'ghcr.io/twentylines/orbis',
    tag: 'v0.5.0-beta.3',
    commit: 'a'.repeat(40),
    digest: `sha256:${'b'.repeat(64)}`,
    runtipiCompatibility: '4.10.1',
  };
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  let loseBegin = true;
  let wrongFinalize = false;
  let wrongCapability = false;
  let newCapability = false;
  let missingCapability = false;
  let normalBinding: unknown;
  let bootstrapFault: 'none' | 'operation' | 'expired' | 'extra' | 'binding' = 'none';
  let wrongBootstrapStatus = false;
  const bootstrapLeaseId = randomUUID();
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    const body = bytes.length ? JSON.parse(bytes.toString()) : {};
    requests.push({ url: request.url ?? '', body });
    if (request.url?.endsWith('/candidate-resume-capability')) {
      if (missingCapability) {
        response.statusCode = 404;
        response.end();
        return;
      }
      if (request.method !== 'GET' || bytes.length) throw new Error('Invalid capability request');
      response.end(
        JSON.stringify({
          version: 1,
          protocol: wrongCapability ? 'unsupported' : 'root-candidate-resume.v1',
          leaseMilliseconds: 900000,
          requiresAppCapability: 'orbis.retained-app-activation.v1',
          ...(newCapability ? { normalBootstrap: 'root-normal-bootstrap.v1', ordinaryWritesHeldUntilBootstrap: true } : {}),
        }),
      );
    } else if (request.url?.endsWith('/review'))
      response.end(
        JSON.stringify({ version: 1, pointId, restoreId, importId, currentRevision: 'c'.repeat(64), stageRevision: 'd'.repeat(64), publication }),
      );
    else if (request.url?.endsWith('/begin')) {
      if (loseBegin) {
        loseBegin = false;
        response.destroy();
        return;
      }
      response.end(JSON.stringify({ version: 1, transactionId: restoreId, token: body.clientKey, state: 'allocating', binding: null }));
    } else if (request.url?.endsWith('/absence'))
      response.end(
        JSON.stringify({
          version: 1,
          transactionId: restoreId,
          pointId,
          state: 'absent',
          revoked: true,
          admissionSha256: 'e'.repeat(64),
          currentRevision: 'c'.repeat(64),
          stageRevision: 'd'.repeat(64),
        }),
      );
    else if (request.url?.endsWith('/terminal-finalize'))
      response.end(
        JSON.stringify({ version: 1, transactionId: restoreId, state: 'settled', proofSha256: wrongFinalize ? '0'.repeat(64) : body.proofSha256 }),
      );
    else if (request.url?.endsWith('/normal-bootstrap-status'))
      response.end(
        JSON.stringify({
          version: 1,
          transactionId: restoreId,
          terminalProofSha256: body.terminalProofSha256,
          required: !wrongBootstrapStatus,
          state: 'pending',
          bootstrapLeaseId: null,
        }),
      );
    else if (request.url?.endsWith('/normal-bootstrap-complete'))
      response.end(JSON.stringify({ version: 1, transactionId: restoreId, state: 'ready', terminalProofSha256: body.terminalProofSha256 }));
    else if (request.url?.endsWith('/normal-bootstrap'))
      response.end(
        JSON.stringify({
          version: 1,
          transactionId: restoreId,
          pointId,
          nonce,
          state: 'settled',
          decision: 'commit',
          binding:
            bootstrapFault === 'binding' && normalBinding && typeof normalBinding === 'object'
              ? { ...normalBinding, candidateController: '9'.repeat(64) }
              : normalBinding,
          operationSha256: bootstrapFault === 'operation' ? 'f'.repeat(64) : 'a'.repeat(64),
          terminalProofSha256: body.terminalProofSha256,
          bootstrapLeaseId,
          expiresAt: Date.now() + (bootstrapFault === 'expired' ? -1 : 60_000),
          ...(bootstrapFault === 'extra' ? { extra: true } : {}),
        }),
      );
    else if (request.url?.endsWith('/candidate-resume'))
      response.end(
        JSON.stringify({
          version: 1,
          transactionId: restoreId,
          pointId,
          nonce,
          state: 'activating',
          decision: 'commit',
          operationSha256: 'a'.repeat(64),
          imageCaptureSha256: 'b'.repeat(64),
          imageInventorySha256: 'c'.repeat(64),
          expiresAt: Date.now() + 60_000,
          binding: {
            restoreId,
            pointId,
            nonce,
            workerId: '1'.repeat(64),
            originalController: '2'.repeat(64),
            candidateController: '3'.repeat(64),
            verifierController: '4'.repeat(64),
            target: {
              publication,
              creationReference: `sha256:${'5'.repeat(64)}`,
              platform: { os: 'linux', architecture: 'arm64' },
              platformManifestDigest: `sha256:${'5'.repeat(64)}`,
              configDigest: `sha256:${'6'.repeat(64)}`,
            },
            migrationsPath: `/data/backups/restores/${restoreId}/retained/migrations`,
            workerSnapshot: {},
            sourceBinding: Object.fromEntries(
              [
                'originalJournalSha256',
                'bootstrapSha256',
                'admissionSha256',
                'sourceSealSha256',
                'legacyManifestSha256',
                'runtimeManifestSha256',
              ].map((key) => [key, 'a'.repeat(64)]),
            ),
          },
        }),
      );
    else if (request.url?.endsWith('/status'))
      response.end(
        JSON.stringify({
          version: 1,
          transactionId: restoreId,
          pointId,
          state: 'allocating',
          decision: null,
          recoverable: true,
          admissionSha256: 'e'.repeat(64),
          binding: null,
        }),
      );
    else {
      response.statusCode = 202;
      response.end(JSON.stringify({ version: 1, transactionId: restoreId, pointId, state: 'allocated', decision: null, recoverable: true }));
    }
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  const actualRequest = http.request;
  vi.spyOn(http, 'request').mockImplementation(((options: http.RequestOptions, callback: (response: http.IncomingMessage) => void) =>
    actualRequest({ ...options, socketPath: socket }, callback)) as typeof http.request);
  vi.spyOn(hostConfig, 'controllerCaptureSocketIdentity').mockResolvedValue('fixture-socket');
  try {
    const signal = new AbortController().signal;
    expect(await retainedNormalBootstrapCapability(signal)).toBe(false);
    newCapability = true;
    expect(await retainedNormalBootstrapCapability(signal)).toBe(true);
    await expect(reviewRetainedRoot({ pointId, restoreId, importId, signal })).resolves.toMatchObject({ pointId });
    wrongCapability = true;
    await expect(retainedNormalBootstrapCapability(signal)).rejects.toThrow();
    wrongCapability = false;
    newCapability = false;
    missingCapability = true;
    expect(await retainedNormalBootstrapCapability(signal)).toBe(false);
    missingCapability = false;
    const review = await reviewRetainedRoot({ pointId, restoreId, importId, signal });
    const transaction = await RetainedRootTransaction.create(directory, review);
    expect(() => JSON.stringify(transaction)).toThrow();
    await expect(transaction.begin(signal)).rejects.toThrow();
    const recovered = await RetainedRootTransaction.read(directory);
    expect(await recovered.begin(signal)).toEqual({ state: 'allocating', binding: null });
    const attempts = requests.filter((request) => request.url.endsWith('/begin'));
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.body).toEqual(attempts[1]?.body);
    expect((await fs.stat(path.join(directory, 'retained-root-request.json'))).mode & 0o077).toBe(0);
    expect(await recovered.status(signal)).toMatchObject({ state: 'allocating', binding: null });
    const resume = await recovered.candidateResume(signal);
    expect(resume).toMatchObject({ state: 'activating', decision: 'commit', pointId, nonce });
    expect(Object.keys(requests.at(-1)?.body ?? {})).toEqual(['token']);
    normalBinding = resume.binding;
    const expectedBootstrap = { nonce, operationSha256: resume.operationSha256, terminalProofSha256: 'a'.repeat(64), binding: resume.binding };
    expect(await recovered.normalBootstrapStatus(expectedBootstrap.terminalProofSha256, signal)).toMatchObject({ required: true, state: 'pending' });
    const lease = await recovered.normalBootstrap(expectedBootstrap, signal);
    expect(lease.bootstrapLeaseId).toBe(bootstrapLeaseId);
    expect(Object.keys(requests.at(-1)?.body ?? {}).sort()).toEqual(['terminalProofSha256', 'token']);
    wrongBootstrapStatus = true;
    await expect(recovered.normalBootstrapStatus(expectedBootstrap.terminalProofSha256, signal)).rejects.toThrow();
    wrongBootstrapStatus = false;
    for (const fault of ['operation', 'expired', 'extra', 'binding'] as const) {
      bootstrapFault = fault;
      await expect(recovered.normalBootstrap(expectedBootstrap, signal)).rejects.toThrow();
    }
    bootstrapFault = 'none';
    expect(await recovered.normalBootstrapComplete(expectedBootstrap.terminalProofSha256, bootstrapLeaseId, signal)).toMatchObject({
      state: 'ready',
    });
    expect(Object.keys(requests.at(-1)?.body ?? {}).sort()).toEqual(['bootstrapLeaseId', 'terminalProofSha256', 'token']);
    expect(await recovered.revokeAbsent(signal)).toEqual({ admissionSha256: 'e'.repeat(64) });
    expect(requests.at(-1)?.body).toEqual(attempts[0]?.body);
    expect(await recovered.launch('recover', signal)).toMatchObject({ state: 'allocated' });
    expect(await recovered.terminalFinalize('a'.repeat(64), signal)).toMatchObject({ state: 'settled' });
    wrongCapability = true;
    await expect(reviewRetainedRoot({ pointId, restoreId, importId, signal })).rejects.toThrow();
    wrongCapability = false;
    missingCapability = true;
    await expect(recovered.begin(signal)).rejects.toThrow();
    missingCapability = false;
    wrongFinalize = true;
    await expect(recovered.terminalFinalize('a'.repeat(64), signal)).rejects.toThrow();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
