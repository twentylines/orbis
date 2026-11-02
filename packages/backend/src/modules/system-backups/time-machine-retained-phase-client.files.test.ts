import { randomUUID } from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import * as hostConfig from '../host-updates/host-controller-config';
import { RetainedPhaseClient } from './time-machine-retained-phase-client';
import { runAuthenticatedRetainedPhase } from './time-machine-retained-phase-bridge';
import { BackupRestoreJournal } from './backup-restore-journal';
import { BackupDirectorySwap } from './backup-directory-swap';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'retained-phase-client-')));
  roots.push(root);
  const socket = path.join(root, 'host.sock');
  const id = randomUUID();
  const nonce = randomUUID();
  const point = randomUUID();
  const worker = 'a'.repeat(64);
  const token = 'e'.repeat(64);
  const target = {
    publication: {
      schema: 'orbis.release.v1',
      image: 'ghcr.io/twentylines/orbis',
      tag: 'v0.5.0-beta.3',
      commit: 'f'.repeat(40),
      digest: `sha256:${'1'.repeat(64)}`,
      runtipiCompatibility: '4.10.1',
    },
    creationReference: `sha256:${'2'.repeat(64)}`,
    platform: { os: 'linux', architecture: 'arm64' },
    platformManifestDigest: `sha256:${'2'.repeat(64)}`,
    configDigest: `sha256:${'3'.repeat(64)}`,
  };
  let grant = {
    version: 1,
    transactionId: id,
    restoreId: id,
    nonce,
    pointId: point,
    phase: 'promote',
    sequence: 1,
    rootDecision: 'none',
    commitStage: null,
    workerId: worker,
    originalController: 'b'.repeat(64),
    candidateController: 'c'.repeat(64),
    verifierController: 'd'.repeat(64),
    target,
    migrationsPath: `/data/backups/restores/${id}/retained/migrations`,
    candidateHealthy: false,
  };
  const requests: { url: string; body: unknown }[] = [];
  let statusPhase = 'promoting';
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ url: request.url ?? '', body });
    response.end(
      JSON.stringify(
        request.url?.endsWith('/phase-status')
          ? {
              version: 1,
              transactionId: id,
              pointId: point,
              state: statusPhase,
              decision: null,
              recoverable: true,
              admissionSha256: 'a'.repeat(64),
              binding: {
                restoreId: id,
                nonce,
                pointId: point,
                workerId: worker,
                originalController: 'b'.repeat(64),
                candidateController: 'c'.repeat(64),
                verifierController: 'd'.repeat(64),
                target,
                migrationsPath: `/data/backups/restores/${id}/retained/migrations`,
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
            }
          : request.url?.endsWith('/status')
            ? {
                version: 1,
                transactionId: id,
                pointId: point,
                state: 'allocated',
                decision: null,
                recoverable: true,
                admissionSha256: 'a'.repeat(64),
                binding: null,
              }
            : request.url?.endsWith('/image-preflight')
              ? { version: 1, transactionId: id, requiredBytes: body.requiredBytes, availableBytes: 4096, availableInodes: 64 }
              : request.url?.endsWith('/phase-complete')
                ? { version: 1, transactionId: id, phase: 'promote', sequence: 1, status: 'complete' }
                : grant,
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  const actualRequest = http.request;
  vi.spyOn(http, 'request').mockImplementation(((options: http.RequestOptions, callback: (response: http.IncomingMessage) => void) =>
    actualRequest({ ...options, socketPath: socket }, callback)) as typeof http.request);
  vi.spyOn(hostConfig, 'controllerCaptureSocketIdentity').mockResolvedValue('fixture-socket-identity');
  const client = () => new RetainedPhaseClient('/run/orbis/host.sock', id, token);
  return {
    root,
    id,
    nonce,
    worker,
    point,
    target,
    token,
    requests,
    close,
    client,
    changePhaseState: (value: string) => {
      statusPhase = value;
    },
    change: (value: Partial<typeof grant>) => {
      grant = { ...grant, ...value };
    },
  };
}
it('redeems a single fixed phase and completes exactly once without serializing its capability', async () => {
  const test = await fixture();
  try {
    const client = test.client();
    expect(() => JSON.stringify(client)).toThrow();
    const signal = new AbortController().signal;
    const value = await client.redeem(
      'promote',
      {
        restoreId: test.id,
        nonce: test.nonce,
        pointId: test.point,
        workerId: test.worker,
        originalController: 'b'.repeat(64),
        candidateController: 'c'.repeat(64),
        verifierController: 'd'.repeat(64),
        target: test.target,
      },
      signal,
    );
    expect(value.phase).toBe('promote');
    await expect(
      client.redeem(
        'promote',
        {
          restoreId: test.id,
          nonce: test.nonce,
          pointId: test.point,
          workerId: test.worker,
          originalController: 'b'.repeat(64),
          candidateController: 'c'.repeat(64),
          verifierController: 'd'.repeat(64),
          target: test.target,
        },
        signal,
      ),
    ).rejects.toThrow();
    await client.complete(signal);
    await expect(client.complete(signal)).rejects.toThrow();
    expect(test.requests.map((request) => request.url)).toEqual([
      `/v1/retained-restore/${test.id}/phase`,
      `/v1/retained-restore/${test.id}/phase-complete`,
    ]);
    expect(test.requests[1]?.body).toEqual({ version: 1, token: test.token, phase: 'promote', sequence: 1 });
  } finally {
    await test.close();
  }
});
it.each(['nonce', 'pointId', 'workerId', 'rootDecision', 'migrationsPath', 'candidateHealthy', 'target', 'extra'] as const)(
  'rejects mismatched root phase response %s',
  async (field) => {
    const test = await fixture();
    try {
      test.change({ [field]: field === 'candidateHealthy' ? true : field === 'extra' ? 'unexpected' : 'invalid' });
      await expect(
        test.client().redeem(
          'promote',
          {
            restoreId: test.id,
            nonce: test.nonce,
            pointId: test.point,
            workerId: test.worker,
            originalController: 'b'.repeat(64),
            candidateController: 'c'.repeat(64),
            verifierController: 'd'.repeat(64),
            target: test.target,
          },
          new AbortController().signal,
        ),
      ).rejects.toThrow();
    } finally {
      await test.close();
    }
  },
);
it('rejects a replaced protected socket after the root reply', async () => {
  const test = await fixture();
  try {
    vi.mocked(hostConfig.controllerCaptureSocketIdentity).mockReset().mockResolvedValueOnce('before').mockResolvedValueOnce('after');
    await expect(
      test.client().redeem(
        'promote',
        {
          restoreId: test.id,
          nonce: test.nonce,
          pointId: test.point,
          workerId: test.worker,
          originalController: 'b'.repeat(64),
          candidateController: 'c'.repeat(64),
          verifierController: 'd'.repeat(64),
          target: test.target,
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  } finally {
    await test.close();
  }
});

it('uses a root-granted phase on the bound journal and acknowledges only after promotion', async () => {
  const test = await fixture();
  try {
    const journal = await BackupRestoreJournal.create(path.join(test.root, 'store'), {
      id: test.id,
      nonce: test.nonce,
      originalController: 'b'.repeat(64),
      candidateController: 'c'.repeat(64),
      verifierController: 'd'.repeat(64),
      worker: test.worker,
      roots: ['state'],
    });
    const data = path.join(test.root, 'data');
    await fs.mkdir(data, { mode: 0o700 });
    await fs.writeFile(path.join(data, 'value'), 'before');
    const swap = await BackupDirectorySwap.create({ id: test.id, root: data, journal: journal.rootJournal('state') });
    await fs.writeFile(path.join(swap.incomingDirectory, 'value'), 'restored');
    await swap.seal(new AbortController().signal);
    await journal.advance('prepared');
    const signal = new AbortController().signal;
    const runtime = {
      prepare: vi.fn(),
      discardPreparation: vi.fn(),
      stopWriters: vi.fn(),
      installDatabasePointer: vi.fn(),
      verifyCandidate: vi.fn(),
      restoreDatabasePointer: vi.fn(),
      resumeOriginal: vi.fn(),
      confirmRootActivation: vi.fn(),
    };
    const expected = {
      restoreId: test.id,
      nonce: test.nonce,
      pointId: test.point,
      workerId: test.worker,
      originalController: 'b'.repeat(64),
      candidateController: 'c'.repeat(64),
      verifierController: 'd'.repeat(64),
      target: test.target,
    };
    const runtimeFactory = vi.fn(async (status: Awaited<ReturnType<RetainedPhaseClient['phaseStatus']>>) => {
      expect(status.binding.sourceBinding.runtimeManifestSha256).toBe('a'.repeat(64));
      return runtime;
    });
    await expect(
      runAuthenticatedRetainedPhase({ client: test.client(), journal, phase: 'promote', expected, runtime: runtimeFactory, signal }),
    ).resolves.toBe('promoted');
    expect(runtimeFactory).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(path.join(data, 'value'), 'utf8')).toBe('restored');
    expect((await journal.refresh()).phase).toBe('verifying');
    expect(test.requests.map((request) => request.url?.split('/').at(-1))).toEqual(['phase', 'phase-status', 'phase-complete']);
  } finally {
    await test.close();
  }
});

it('reads protected recovery status without consuming the phase grant', async () => {
  const test = await fixture();
  try {
    const client = test.client();
    const signal = new AbortController().signal;
    expect(await client.status(signal)).toMatchObject({ transactionId: test.id, pointId: test.point, state: 'allocated' });
    expect(test.requests[0]?.body).toEqual({ token: test.token });
    await expect(
      client.redeem(
        'promote',
        {
          restoreId: test.id,
          nonce: test.nonce,
          pointId: test.point,
          workerId: test.worker,
          originalController: 'b'.repeat(64),
          candidateController: 'c'.repeat(64),
          verifierController: 'd'.repeat(64),
          target: test.target,
        },
        signal,
      ),
    ).resolves.toMatchObject({ phase: 'promote' });
  } finally {
    await test.close();
  }
});

it('uses a root daemon-storage preflight only during a redeemed prepare phase', async () => {
  const test = await fixture();
  try {
    const signal = new AbortController().signal;
    const client = test.client();
    await expect(client.imagePreflight(1024, signal)).rejects.toThrow();
    test.change({ phase: 'prepare' });
    await client.redeem(
      'prepare',
      {
        restoreId: test.id,
        nonce: test.nonce,
        pointId: test.point,
        workerId: test.worker,
        originalController: 'b'.repeat(64),
        candidateController: 'c'.repeat(64),
        verifierController: 'd'.repeat(64),
        target: test.target,
      },
      signal,
    );
    await client.imagePreflight(1024, signal);
    await expect(client.imagePreflight(5000, signal)).rejects.toThrow();
    expect(test.requests.at(-1)?.body).toEqual({ version: 1, token: test.token, requiredBytes: 5000 });
  } finally {
    await test.close();
  }
});

it('retrieves the full protected binding only while the matching phase grant runs', async () => {
  const test = await fixture();
  try {
    const client = test.client();
    const signal = new AbortController().signal;
    await expect(client.phaseStatus(signal)).rejects.toThrow();
    await client.redeem(
      'promote',
      {
        restoreId: test.id,
        nonce: test.nonce,
        pointId: test.point,
        workerId: test.worker,
        originalController: 'b'.repeat(64),
        candidateController: 'c'.repeat(64),
        verifierController: 'd'.repeat(64),
        target: test.target,
      },
      signal,
    );
    test.changePhaseState('verifying');
    await expect(client.phaseStatus(signal)).rejects.toThrow();
    test.changePhaseState('promoting');
    const status = await client.phaseStatus(signal);
    expect(status.binding.sourceBinding.runtimeManifestSha256).toBe('a'.repeat(64));
    expect(test.requests.at(-1)?.body).toEqual({ version: 1, token: test.token, phase: 'promote', sequence: 1 });
    await client.complete(signal);
    await expect(client.phaseStatus(signal)).rejects.toThrow();
  } finally {
    await test.close();
  }
});
