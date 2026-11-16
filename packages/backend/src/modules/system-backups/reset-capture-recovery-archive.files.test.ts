import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { withBackupMaintenanceLease } from '@/common/backup-maintenance-lease';
import { TimeMachineService } from './time-machine.service';
import { TimeMachineStore } from './time-machine-store';
import { TimeMachineComponentsStore } from './time-machine-components-store';
import {
  exportResetCaptureRecoveryArchive,
  inspectResetCaptureRecoveryArchive,
  verifyResetCaptureRecoveryArchive,
} from './reset-capture-recovery-archive';
import {
  verifyResetExportProof,
  withResetInventoryAccess,
  type ResetInventoryAccess,
  type ResetInventoryBinding,
} from './settings-export-authorization';
import { decryptBackup } from './backup-crypto';
import { sealedBundleFiles } from './settings-backup-format';
import { stabilizeDarwinFixtureCreation, stabilizeExistingDarwinFixtures } from './darwin-files.fixture';
import { modelLinuxProcFiles } from './linux-proc-model.fixture';

let root: string;
let dataDir: string;
let directory: string;
let destination: string;
let pointId: string;
let machine: TimeMachineService;
let restorePlatform: () => void;
let restoreCreation: () => void;
const passphrase = 'synthetic capture archive phrase';
const auth = { operatorActionContext: vi.fn(), verifySensitiveAction: vi.fn() };
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
beforeEach(async () => {
  if (!process.env.TMPDIR) throw new Error('Project-scoped TMPDIR required');
  root = await fs.realpath(await fs.mkdtemp(path.join(process.env.TMPDIR, 'capture-archive-')));
  dataDir = path.join(root, 'source');
  directory = path.join(root, 'package');
  destination = path.join(root, 'recovery.tar');
  await fs.mkdir(dataDir, { mode: 0o700 });
  restoreCreation = stabilizeDarwinFixtureCreation(() => root);
  auth.operatorActionContext.mockResolvedValue({ userId: 1, sessionBinding: 'synthetic-session', securityBinding: 'synthetic-security' });
  auth.verifySensitiveAction.mockResolvedValue({});
  machine = new TimeMachineService(
    { get: (key: string) => (key === 'directories' ? { dataDir } : false) } as never,
    {} as never,
    auth as never,
    { warn: vi.fn() } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { recoverCaptureFences: vi.fn(async () => {}) } as never,
  );
  await machine.onModuleInit();
  const store = new TimeMachineStore(dataDir);
  const components = new TimeMachineComponentsStore(dataDir);
  const { point } = await store.create(19, 1);
  pointId = point.id;
  await store.fail(point, 'capture-failed');
  const selected = await components.create(23, point.id, point.id, 'a'.repeat(64), {
    version: 1,
    reviewId: randomUUID(),
    reviewSha256: 'b'.repeat(64),
    apps: [{ urn: 'fixture:store', mountIds: ['c'.repeat(64)] }],
  });
  await components.interrupted(selected);
  await fs.writeFile(path.join(dataDir, 'backups/time-machine/points', point.id, 'archive.partial'), 'retained incomplete payload', { mode: 0o600 });
  stabilizeExistingDarwinFixtures(dataDir);
  restorePlatform = modelLinuxProcFiles(new Map());
});
afterEach(async () => {
  await machine?.onModuleDestroy();
  vi.restoreAllMocks();
  restorePlatform?.();
  restoreCreation?.();
  await fs.rm(root, { recursive: true, force: true });
  vi.clearAllMocks();
});
async function scope<T>(
  work: (value: ResetInventoryBinding & { access: ResetInventoryAccess }) => Promise<T>,
  accounts: 'keep' | 'remove' = 'remove',
) {
  const resetId = randomUUID();
  const signal = AbortSignal.timeout(20000);
  const proof = await verifyResetExportProof(auth as never, {} as never, {} as never, accounts, {
    method: 'password',
    password: 'synthetic password',
  });
  return withBackupMaintenanceLease(signal, (lease) =>
    withResetInventoryAccess(proof, { resetId, accounts, lease, signal }, (access) => work({ resetId, accounts, lease, signal, access })),
  );
}
const write = (binding: ResetInventoryBinding & { access: ResetInventoryAccess }) =>
  exportResetCaptureRecoveryArchive({ ...binding, machine, directory, destination, passphrase });

it('verifies with only one chunk of scratch capacity while retaining full extraction capacity checks', async () => {
  await scope(async (binding) => {
    const result = await write(binding);
    expect(await fs.readdir(path.join(directory, 'verify'))).toEqual([]);
    const retained = await inspectResetCaptureRecoveryArchive({
      source: destination,
      directory: path.join(root, 'retained'),
      passphrase,
      signal: binding.signal,
      expected: result,
    });
    const files = retained.manifest.entries.flatMap((item) => (item.type === 'file' ? item.chunks : []));
    const largest = Math.max(...files.map((part) => part.bytes));
    expect(files.reduce((sum, part) => sum + part.bytes, 0)).toBeGreaterThan(largest);
    const bounded = path.join(root, 'bounded');
    const full = path.join(root, 'insufficient-full');
    const requested: number[] = [];
    const original = sealedBundleFiles.capacity;
    vi.spyOn(sealedBundleFiles, 'capacity').mockImplementation(async (directory, bytes) => {
      if (directory === bounded || directory === full) {
        if (bytes > largest) throw new Error('Synthetic one-chunk scratch capacity');
        if (directory === bounded) {
          requested.push(bytes);
          expect(await fs.readdir(directory)).toEqual([]);
        }
      }
      await original(directory, bytes);
    });
    const verified = await verifyResetCaptureRecoveryArchive({
      source: destination,
      directory: bounded,
      passphrase,
      signal: binding.signal,
      expected: result,
    });
    expect(verified.manifest).toEqual(retained.manifest);
    expect(verified.sha256).toBe(result.sha256);
    expect(Math.max(...requested)).toBe(largest);
    expect(requested).toHaveLength(files.length + 1);
    expect(await fs.readdir(bounded)).toEqual([]);
    await expect(
      inspectResetCaptureRecoveryArchive({
        source: destination,
        directory: full,
        passphrase,
        signal: binding.signal,
        expected: result,
      }),
    ).rejects.toThrow('Synthetic one-chunk scratch capacity');
    expect(sha(await fs.readFile(destination))).toBe(result.sha256);
  });
});

it('retains a failed scratch member and the original archive instead of returning a bounded verification receipt', async () => {
  await scope(async (binding) => {
    const result = await write(binding);
    const data = await fs.readFile(destination);
    const size = (at: number) =>
      Number.parseInt(
        data
          .subarray(at + 124, at + 136)
          .toString('ascii')
          .replace(/\0/g, ''),
        8,
      );
    const manifestHeader = 512 + Math.ceil(size(0) / 512) * 512;
    const partHeader = manifestHeader + 512 + Math.ceil(size(manifestHeader) / 512) * 512;
    const at = partHeader + 512 + 36;
    data[at] = (data[at] ?? 0) ^ 1;
    const damaged = path.join(root, 'damaged-member.tar');
    const scratch = path.join(root, 'failed-member');
    await fs.writeFile(damaged, data, { mode: 0o600 });
    await expect(
      verifyResetCaptureRecoveryArchive({
        source: damaged,
        directory: scratch,
        passphrase,
        signal: binding.signal,
      }),
    ).rejects.toThrow();
    expect(await fs.readdir(scratch)).toHaveLength(1);
    expect(await fs.readFile(damaged)).toEqual(data);
    expect(sha(await fs.readFile(destination))).toBe(result.sha256);
  });
});

it('rejects unexpected scratch evidence without removing it', async () => {
  await scope(async (binding) => {
    const result = await write(binding);
    const scratch = path.join(root, 'unexpected-scratch');
    const original = sealedBundleFiles.readTar;
    vi.spyOn(sealedBundleFiles, 'readTar').mockImplementation(async (...args) => {
      const measured = await original(...args);
      await fs.writeFile(path.join(scratch, 'unrelated-evidence'), 'retain this evidence', { mode: 0o600 });
      return measured;
    });
    await expect(
      verifyResetCaptureRecoveryArchive({
        source: destination,
        directory: scratch,
        passphrase,
        signal: binding.signal,
        expected: result,
      }),
    ).rejects.toThrow();
    expect(await fs.readFile(path.join(scratch, 'unrelated-evidence'), 'utf8')).toBe('retain this evidence');
    expect(sha(await fs.readFile(destination))).toBe(result.sha256);
  });
});

it('retains in-flight encrypted scratch and the archive when bounded verification is cancelled', async () => {
  await scope(async (binding) => {
    const result = await write(binding);
    const scratch = path.join(root, 'cancelled-readback');
    const controller = new AbortController();
    const original = sealedBundleFiles.readTar;
    vi.spyOn(sealedBundleFiles, 'readTar').mockImplementation(async (source, signal, limit, options) =>
      original(source, signal, limit, {
        ...options,
        onData: async (data) => {
          await options?.onData?.(data);
          if ((await fs.readdir(scratch)).some((name) => name.endsWith('.orbis'))) controller.abort();
        },
      }),
    );
    await expect(
      verifyResetCaptureRecoveryArchive({
        source: destination,
        directory: scratch,
        passphrase,
        signal: controller.signal,
        expected: result,
      }),
    ).rejects.toThrow();
    expect(controller.signal.aborted).toBe(true);
    expect(await fs.readdir(scratch)).toHaveLength(1);
    expect(sha(await fs.readFile(destination))).toBe(result.sha256);
  });
});

it('withholds bounded verification after its retained archive changes following the tar read', async () => {
  await scope(async (binding) => {
    const result = await write(binding);
    const original = sealedBundleFiles.readTar;
    vi.spyOn(sealedBundleFiles, 'readTar').mockImplementation(async (...args) => {
      const measured = await original(...args);
      const handle = await fs.open(destination, 'r+');
      try {
        await handle.write(Buffer.from('X'), 0, 1, 0);
      } finally {
        await handle.close();
      }
      return measured;
    });
    await expect(
      verifyResetCaptureRecoveryArchive({
        source: destination,
        directory: path.join(root, 'changed-archive'),
        passphrase,
        signal: binding.signal,
        expected: result,
      }),
    ).rejects.toThrow();
    expect(sha(await fs.readFile(destination))).not.toBe(result.sha256);
    expect(await fs.readFile(path.join(dataDir, 'backups/time-machine/points', pointId, 'archive.partial'), 'utf8')).toBe(
      'retained incomplete payload',
    );
  });
});

it.each(['keep', 'remove'] as const)(
  'packages both raw namespaces and the original key into an authenticated %s-account archive',
  async (accounts) => {
    const originalKey = await fs.readFile(path.join(dataDir, 'backups/time-machine/keys/master-v1.key'));
    await scope(async (binding) => {
      const result = await write(binding);
      const inspected = await inspectResetCaptureRecoveryArchive({
        source: destination,
        directory: path.join(root, 'readback'),
        passphrase,
        signal: binding.signal,
        expected: result,
      });
      expect(inspected.manifest.inventory.captures.map((record) => [record.kind, record.sourceOwnerId])).toEqual([
        ['components', 23],
        ['core', 19],
      ]);
      expect(inspected.manifest.entries.some((entry) => entry.name === `points/${pointId}/archive.partial`)).toBe(true);
      expect(inspected.manifest.accounts).toBe(accounts);
      expect(JSON.stringify(inspected.manifest)).not.toContain(root);
      const key = inspected.manifest.entries.find((entry) => entry.name === 'keys/master-v1.key');
      if (key?.type !== 'file' || !key.chunks[0]) throw new Error('Missing archived original key');
      const restored = path.join(root, 'original-key');
      await decryptBackup({ source: path.join(inspected.directory, key.chunks[0].part), destination: restored, passphrase, signal: binding.signal });
      expect(await fs.readFile(restored)).toEqual(originalKey);
      expect(await fs.readFile(path.join(dataDir, 'backups/time-machine/keys/master-v1.key'))).toEqual(originalKey);
      expect((await fs.readdir(inspected.directory)).every((name) => name.endsWith('.orbis'))).toBe(true);
      expect(sha(await fs.readFile(destination))).toBe(result.sha256);
    }, accounts);
  },
);

it('rejects the wrong recovery passphrase and a foreign trusted binding without deleting the archive', async () => {
  await scope(async (binding) => {
    const result = await write(binding);
    await expect(
      inspectResetCaptureRecoveryArchive({
        source: destination,
        directory: path.join(root, 'wrong-key'),
        passphrase: 'different synthetic passphrase',
        signal: binding.signal,
      }),
    ).rejects.toThrow();
    await expect(
      inspectResetCaptureRecoveryArchive({
        source: destination,
        directory: path.join(root, 'wrong-binding'),
        passphrase,
        signal: binding.signal,
        expected: { ...result, filesSha256: 'a'.repeat(64) },
      }),
    ).rejects.toThrow();
    expect(await fs.readdir(path.join(root, 'wrong-binding'))).toEqual([]);
    expect(sha(await fs.readFile(destination))).toBe(result.sha256);
  });
});

it('authenticates the encrypted manifest before extracting any raw member', async () => {
  await scope(async (binding) => {
    await write(binding);
    const data = await fs.readFile(destination);
    const indexBytes = Number.parseInt(data.subarray(124, 136).toString('ascii').replace(/\0/g, ''), 8);
    const manifestStart = 1024 + Math.ceil(indexBytes / 512) * 512;
    const byte = data[manifestStart + 10];
    if (byte === undefined) throw new Error('Missing encrypted manifest fixture');
    data[manifestStart + 10] = byte ^ 1;
    const damaged = path.join(root, 'damaged.tar');
    await fs.writeFile(damaged, data, { mode: 0o600 });
    await expect(
      inspectResetCaptureRecoveryArchive({ source: damaged, directory: path.join(root, 'damaged-readback'), passphrase, signal: binding.signal }),
    ).rejects.toThrow();
    expect(await fs.readdir(path.join(root, 'damaged-readback'))).toEqual([]);
    expect(await fs.readFile(damaged)).toEqual(data);
  });
});

it('refuses existing destinations and forged reset access before allocating recovery staging', async () => {
  await fs.writeFile(destination, 'protected existing artifact', { mode: 0o600 });
  await expect(scope(write)).rejects.toThrow();
  expect(await fs.readFile(destination, 'utf8')).toBe('protected existing artifact');
  await expect(fs.lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(scope((binding) => write({ ...binding, access: {} as ResetInventoryAccess }))).rejects.toThrow();
  await expect(fs.lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('withholds its receipt when reset authorization changes during archive readback and retains evidence', async () => {
  const original = sealedBundleFiles.readTar;
  vi.spyOn(sealedBundleFiles, 'readTar').mockImplementation(async (...args) => {
    const result = await original(...args);
    auth.operatorActionContext.mockResolvedValue({ userId: 1, sessionBinding: 'synthetic-session', securityBinding: 'revoked-security' });
    return result;
  });
  await expect(scope(write)).rejects.toThrow();
  expect((await fs.stat(destination)).size).toBeGreaterThan(0);
  expect((await fs.readdir(path.join(directory, 'captures'))).length).toBeGreaterThan(0);
});

it('withholds its receipt after an original key is replaced while the archive is being independently read', async () => {
  const original = sealedBundleFiles.readTar;
  const key = path.join(dataDir, 'backups/time-machine/keys/master-v1.key');
  const replacement = Buffer.alloc(32, 0x71);
  vi.spyOn(sealedBundleFiles, 'readTar').mockImplementation(async (...args) => {
    const result = await original(...args);
    await fs.unlink(key);
    await fs.writeFile(key, replacement, { mode: 0o600 });
    return result;
  });
  await expect(scope(write)).rejects.toThrow();
  expect(await fs.readFile(key)).toEqual(replacement);
  expect((await fs.stat(destination)).size).toBeGreaterThan(0);
  expect((await fs.readdir(path.join(directory, 'captures'))).length).toBeGreaterThan(0);
});
