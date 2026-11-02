import { beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { verifyRetainedCandidateApps } from './time-machine-retained-app-result';
import { RetainedRootTransaction } from './time-machine-retained-root-client';
import { readRestoreOperation } from './backup-restore-runtime';
import { readTerminalJson } from './backup-restore-terminal-record';
import { readRetainedRestoreReceipt } from './time-machine-restore-admission';
import { readRetainedBoundRecord } from './time-machine-retained-bootstrap';
import { readRootBoundImageExpectations } from './time-machine-retained-images';
vi.mock('./time-machine-retained-root-client', () => ({ RetainedRootTransaction: { read: vi.fn() } }));
vi.mock('./backup-restore-runtime', () => ({ readRestoreOperation: vi.fn() }));
vi.mock('./backup-restore-terminal-record', () => ({ readTerminalJson: vi.fn() }));
vi.mock('./time-machine-restore-admission', () => ({ readRetainedRestoreReceipt: vi.fn() }));
vi.mock('./time-machine-retained-bootstrap', () => ({ readRetainedBoundRecord: vi.fn() }));
vi.mock('./time-machine-retained-images', () => ({ readRootBoundImageExpectations: vi.fn() }));
const id = '11111111-1111-4111-8111-111111111111';
const point = '22222222-2222-4222-8222-222222222222';
const nonce = '33333333-3333-4333-8333-333333333333';
const digest = (v: string) => createHash('sha256').update(v).digest('hex');
function fixture() {
  const binding = {
    restoreId: id,
    pointId: point,
    nonce,
    originalController: 'a'.repeat(64),
    candidateController: 'b'.repeat(64),
    verifierController: 'c'.repeat(64),
    workerId: 'd'.repeat(64),
    target: {},
    sourceBinding: {
      bootstrapSha256: '1'.repeat(64),
      admissionSha256: '2'.repeat(64),
      legacyManifestSha256: '3'.repeat(64),
      runtimeManifestSha256: '4'.repeat(64),
    },
  };
  const rows = [
    { appUrn: 'whoami:demo', service: 'whoami', ordinal: 1, id: 'e'.repeat(64), imageId: `sha256:${'8'.repeat(64)}`, wasRunning: true },
    { appUrn: 'whoami:demo', service: 'whoami', ordinal: 2, id: 'f'.repeat(64), imageId: `sha256:${'9'.repeat(64)}`, wasRunning: false },
  ];
  const result = {
    binding,
    operationSha256: '5'.repeat(64),
    imageCaptureSha256: '6'.repeat(64),
    imageInventorySha256: '7'.repeat(64),
    appRuntimeSha256: digest('protected-app-runtime'),
    appEffectsSha256: 'a'.repeat(64),
    expiresAt: Date.now() + 60000,
    containers: rows,
  };
  const appRuntime = {
    read: () => Buffer.from('protected-app-runtime'),
    metadata: {
      containers: rows.map((x) => ({
        appUrn: x.appUrn,
        service: x.service,
        ordinal: x.ordinal,
        wasRunning: x.wasRunning,
        image: { creationReference: x.imageId },
      })),
    },
  };
  const manifest = {
    schema: 'orbis.time-machine-runtime.v6',
    imageCaptureSha256: result.imageCaptureSha256,
    imageInventorySha256: result.imageInventorySha256,
    appRuntimeSha256: result.appRuntimeSha256,
  };
  const journal = {
    directory: '/private/fixture',
    refresh: async () => ({
      id,
      nonce,
      phase: 'committing',
      decision: 'commit',
      originalController: binding.originalController,
      candidateController: binding.candidateController,
      verifierController: binding.verifierController,
      worker: binding.workerId,
    }),
  };
  const rpc = vi.fn().mockResolvedValue(result);
  vi.mocked(RetainedRootTransaction.read).mockResolvedValue({ candidateAppResult: rpc } as never);
  vi.mocked(readTerminalJson).mockResolvedValue({ version: 1, oldState: {}, binding } as never);
  vi.mocked(readRetainedRestoreReceipt).mockResolvedValue({
    binding: { pointId: point, manifestSha256: binding.sourceBinding.legacyManifestSha256 },
  } as never);
  vi.mocked(readRetainedBoundRecord).mockImplementation(async (file) => ({
    value: {},
    sha256: file.endsWith('bootstrap.json') ? binding.sourceBinding.bootstrapSha256 : binding.sourceBinding.admissionSha256,
  }));
  vi.mocked(readRootBoundImageExpectations).mockResolvedValue({ expectedManifest: manifest, expectedAppRuntime: appRuntime } as never);
  vi.mocked(readRestoreOperation).mockResolvedValue({} as never);
  return { journal, rpc, result, rows, binding };
}
beforeEach(() => vi.resetAllMocks());
it('verifies every protected replica and rechecks the stable Root result without app effects', async () => {
  const x = fixture();
  await verifyRetainedCandidateApps(x.journal as never, '/data', 'bbbbbbbbbbbb', new AbortController().signal);
  expect(x.rpc).toHaveBeenCalledTimes(2);
  expect(readRestoreOperation).toHaveBeenCalledWith(x.journal, x.result.operationSha256);
});
it.each(['image', 'running', 'order', 'root-role', 'changed-effect'] as const)('rejects %s divergence', async (fault) => {
  const x = fixture();
  if (fault === 'changed-effect') x.rpc.mockResolvedValueOnce(x.result).mockResolvedValueOnce({ ...x.result, appEffectsSha256: '0'.repeat(64) });
  else {
    const rows = structuredClone(x.rows);
    const first = rows[0];
    const second = rows[1];
    if (!first || !second) throw new Error('Missing fixture replicas');
    if (fault === 'image') first.imageId = `sha256:${'0'.repeat(64)}`;
    if (fault === 'running') second.wasRunning = true;
    if (fault === 'order') rows.reverse();
    if (fault === 'root-role') first.id = x.binding.workerId;
    x.rpc.mockResolvedValue({ ...x.result, containers: rows });
  }
  await expect(verifyRetainedCandidateApps(x.journal as never, '/data', 'bbbbbbbbbbbb', new AbortController().signal)).rejects.toThrow();
});
