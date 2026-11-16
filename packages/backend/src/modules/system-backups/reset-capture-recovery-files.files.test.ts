import { createHash, randomUUID } from 'node:crypto';
import { resetCaptureInventory } from './reset-safety-capture-inventory';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { withBackupMaintenanceLease } from '@/common/backup-maintenance-lease';
import { TimeMachineService } from './time-machine.service';
import { TimeMachineStore } from './time-machine-store';
import { TimeMachineComponentsStore } from './time-machine-components-store';
import { resetCaptureRecoveryChunks } from './reset-capture-recovery-files';
import {
  verifyResetExportProof,
  withResetInventoryAccess,
  type ResetInventoryBinding,
  type ResetInventoryAccess,
} from './settings-export-authorization';
import { decryptBackup } from './backup-crypto';
import * as backupCrypto from './backup-crypto';
import { stabilizeDarwinFixtureCreation, stabilizeExistingDarwinFixtures } from './darwin-files.fixture';
import { modelLinuxProcFiles } from './linux-proc-model.fixture';
import {
  resetCaptureRecoveryManifest,
  inspectResetCaptureRecoveryManifest,
  validateResetCaptureRecoveryManifest,
} from './reset-capture-recovery-manifest';

let root: string;
let dataDir: string;
let directory: string;
let id: string;
let machine: TimeMachineService;
let restorePlatform: () => void;
let restoreCreation: () => void;
const nativePlatform = process.platform;
let aliases: Map<string, string>;
const auth = { operatorActionContext: vi.fn(), verifySensitiveAction: vi.fn() };
const passphrase = 'synthetic raw capture recovery phrase';
beforeEach(async () => {
  if (!process.env.TMPDIR) throw new Error('Project-scoped TMPDIR required');
  root = await fs.realpath(await fs.mkdtemp(path.join(process.env.TMPDIR, 'capture-recovery-')));
  dataDir = path.join(root, 'source');
  directory = path.join(root, 'encrypted');
  await fs.mkdir(dataDir, { mode: 0o700 });
  await fs.mkdir(directory, { mode: 0o700 });
  restoreCreation = stabilizeDarwinFixtureCreation(() => root);
  auth.operatorActionContext.mockResolvedValue({ userId: 1, sessionBinding: 'synthetic-session', securityBinding: 'synthetic-security' });
  auth.verifySensitiveAction.mockResolvedValue({});
  const config = { get: (key: string) => (key === 'directories' ? { dataDir } : false) };
  machine = new TimeMachineService(
    config as never,
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
  id = point.id;
  await store.fail(point, 'capture-failed');
  const selected = await components.create(23, id, id, 'a'.repeat(64), {
    version: 1,
    reviewId: randomUUID(),
    reviewSha256: 'b'.repeat(64),
    apps: [{ urn: 'fixture:store', mountIds: ['c'.repeat(64)] }],
  });
  await components.interrupted(selected);
  await fs.writeFile(path.join(dataDir, 'backups/time-machine/points', id, 'archive.partial'), 'incomplete original capture bytes', { mode: 0o600 });
  await fs.mkdir(path.join(dataDir, 'app-data'), { mode: 0o700 });
  await fs.writeFile(path.join(dataDir, 'app-data/media'), 'excluded app data', { mode: 0o600 });
  stabilizeExistingDarwinFixtures(dataDir);
  aliases = new Map();
  restorePlatform = modelLinuxProcFiles(aliases);
});
afterEach(async () => {
  await machine?.onModuleDestroy();
  vi.restoreAllMocks();
  restorePlatform?.();
  restoreCreation?.();
  await fs.rm(root, { recursive: true, force: true });
  vi.clearAllMocks();
});
async function scope<T>(work: (binding: ResetInventoryBinding & { access: ResetInventoryAccess }) => Promise<T>) {
  const accounts = 'remove' as const;
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

it('plans bounded authenticated chunks for a runtime larger than one GCM message', () => {
  const chunks = resetCaptureRecoveryChunks(2 ** 36 + 52);
  expect(chunks).toHaveLength(65);
  expect(chunks[64]).toEqual({ offset: 2 ** 36, plaintextBytes: 52 });
  expect(chunks.slice(0, 64).every((chunk) => chunk.plaintextBytes === 1024 ** 3)).toBe(true);
  expect(resetCaptureRecoveryChunks(0)).toEqual([{ offset: 0, plaintextBytes: 0 }]);
  expect(() => resetCaptureRecoveryChunks(128 * 1024 ** 3 + 1)).toThrow();
});

it.skipIf(nativePlatform === 'linux')('rejects a modeled staging alias before writing any source or ciphertext', async () => {
  aliases.set(path.join(dataDir, 'backups/time-machine/components'), directory);
  await expect(scope((binding) => machine.withResetCaptureRecoveryFiles({ ...binding, directory, passphrase }, async () => {}))).rejects.toThrow();
  expect(await fs.readdir(directory)).toEqual([]);
  expect(await fs.readFile(path.join(dataDir, 'backups/time-machine/points', id, 'archive.partial'), 'utf8')).toBe(
    'incomplete original capture bytes',
  );
});

it('preserves actual orphan and equal-UUID store bytes, original key and incomplete recovery files', async () => {
  const key = await fs.readFile(path.join(dataDir, 'backups/time-machine/keys/master-v1.key'));
  await scope((binding) =>
    machine.withResetCaptureRecoveryFiles({ ...binding, directory, passphrase }, async (snapshot) => {
      expect(snapshot.inventory.captures.map((point) => [point.kind, point.sourceOwnerId])).toEqual([
        ['components', 23],
        ['core', 19],
      ]);
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.entries)).toBe(true);
      const manifest = resetCaptureRecoveryManifest(snapshot);
      expect(JSON.stringify(manifest)).not.toContain(root);
      expect(
        await inspectResetCaptureRecoveryManifest({
          manifest,
          expected: {
            resetId: snapshot.resetId,
            accounts: snapshot.accounts,
            filesSha256: snapshot.filesSha256,
            inventorySha256: snapshot.inventory.sha256,
          },
          directory,
          passphrase,
          signal: binding.signal,
        }),
      ).toEqual(manifest);
      const malformed = structuredClone(manifest);
      const member = malformed.entries.find((entry) => entry.type === 'file');
      if (member?.type !== 'file' || !member.chunks[0]) throw new Error('Missing manifest fixture');
      member.chunks[0].part = '../key.orbis';
      expect(() => validateResetCaptureRecoveryManifest(malformed)).toThrow();
      const extra = { ...manifest, sourcePath: root };
      expect(() => validateResetCaptureRecoveryManifest(extra)).toThrow();

      for (const name of [`points/${id}/point.json`, `components/${id}/point.json`, `points/${id}/archive.partial`, 'keys/master-v1.key']) {
        const entry = snapshot.entries.find((entry) => entry.name === name);
        if (entry?.type !== 'file') throw new Error('Missing retained file fixture');
        expect(entry.chunks).toHaveLength(1);
        const chunk = entry.chunks[0];
        if (!chunk) throw new Error('Missing recovery chunk');
        expect((await fs.readFile(chunk.file)).includes(key)).toBe(false);
        const recovered = path.join(root, randomUUID());
        await decryptBackup({ source: chunk.file, destination: recovered, passphrase, signal: binding.signal });
        expect(await fs.readFile(recovered)).toEqual(await fs.readFile(path.join(dataDir, 'backups/time-machine', name)));
      }
      expect(snapshot.entries.some((entry) => entry.name.includes('app-data'))).toBe(false);
      expect(snapshot.entries.find((entry) => entry.name === 'custody')).toEqual({ name: 'custody', type: 'absent' });
      expect(JSON.stringify(snapshot)).not.toContain(key.toString('base64'));
    }),
  );
  expect(await fs.readFile(path.join(dataDir, 'backups/time-machine/keys/master-v1.key'))).toEqual(key);
  expect(await fs.readFile(path.join(dataDir, 'app-data/media'), 'utf8')).toBe('excluded app data');
  expect(auth.verifySensitiveAction).toHaveBeenCalledOnce();
}, 20000);

it('retains protected custody records as recovery evidence without replaying or claiming them', async () => {
  await scope(async (binding) => {
    await machine.prepareResetOwnership(
      { version: 1, id: binding.resetId, accounts: 'remove', users: [1], controller: 'synthetic', phase: 'prepared', createdAt: 1 },
      [1],
    );
    const records = await fs.readdir(path.join(dataDir, 'backups/reset-capture-custody'));
    await machine.withResetCaptureRecoveryFiles({ ...binding, directory, passphrase }, async (snapshot) => {
      expect(snapshot.entries.some((entry) => entry.name.startsWith('custody/') && entry.type === 'file')).toBe(true);
      expect(snapshot.inventory.captures.map((point) => point.effectiveOwnerId)).toEqual([23, 19]);
    });
    expect(await fs.readdir(path.join(dataDir, 'backups/reset-capture-custody'))).toEqual(records);
  });
}, 20000);

it.each(['key', 'source-directory', 'ciphertext'] as const)(
  'withholds snapshot readiness after a %s replacement and preserves replacement data',
  async (change) => {
    const replacement = Buffer.alloc(32, 0x35);
    let changed = '';
    await expect(
      scope((binding) =>
        machine.withResetCaptureRecoveryFiles({ ...binding, directory, passphrase }, async (snapshot) => {
          if (change === 'key') changed = path.join(dataDir, 'backups/time-machine/keys/master-v1.key');
          else if (change === 'ciphertext') {
            const file = snapshot.entries.find((entry) => entry.type === 'file');
            if (file?.type !== 'file' || !file.chunks[0]) throw new Error('Missing recovery artifact');
            changed = file.chunks[0].file;
          } else {
            const source = path.join(dataDir, 'backups/time-machine/points');
            await fs.rename(source, `${source}.retained`);
            await fs.mkdir(source, { mode: 0o700 });
            return;
          }
          await fs.writeFile(changed, replacement);
        }),
      ),
    ).rejects.toThrow();
    if (changed) expect(await fs.readFile(changed)).toEqual(replacement);
    else expect(await fs.stat(path.join(dataDir, 'backups/time-machine/points.retained', id, 'point.json'))).toBeDefined();
  },
  20000,
);

it('preserves already encrypted recovery output when its caller fails', async () => {
  await expect(
    scope((binding) =>
      machine.withResetCaptureRecoveryFiles({ ...binding, directory, passphrase }, async () => {
        throw new Error('Synthetic caller stopped');
      }),
    ),
  ).rejects.toThrow('Synthetic caller stopped');
  expect((await fs.readdir(directory)).length).toBeGreaterThan(0);
  expect(await fs.readFile(path.join(dataDir, 'backups/time-machine/points', id, 'archive.partial'), 'utf8')).toBe(
    'incomplete original capture bytes',
  );
}, 20000);

it('rejects changed ciphertext bytes even when replacement decrypts to the same plaintext', async () => {
  const inspect = backupCrypto.inspectBackupCiphertext;
  let replaced = '';
  vi.spyOn(backupCrypto, 'inspectBackupCiphertext').mockImplementation(async (options) => {
    const result = await inspect(options);
    if (!replaced) {
      const plaintext = await backupCrypto.backupMetadataBytes(await fs.readFile(options.source), passphrase, true, 65536);
      try {
        await fs.writeFile(options.source, await backupCrypto.backupMetadataBytes(plaintext, passphrase, false, 65536));
      } finally {
        plaintext.fill(0);
      }
      replaced = options.source;
    }
    return result;
  });
  const consume = vi.fn(async () => {});
  await expect(scope((binding) => machine.withResetCaptureRecoveryFiles({ ...binding, directory, passphrase }, consume))).rejects.toThrow();
  expect(consume).not.toHaveBeenCalled();
  expect(replaced).not.toBe('');
  expect(await fs.stat(replaced)).toBeDefined();
}, 20000);

it('rejects source links and forged authority without traversing app data', async () => {
  await fs.symlink(path.join(dataDir, 'app-data/media'), path.join(dataDir, 'backups/time-machine/points', id, 'linked'));
  await expect(scope((binding) => machine.withResetCaptureRecoveryFiles({ ...binding, directory, passphrase }, async () => {}))).rejects.toThrow();
  await withBackupMaintenanceLease(new AbortController().signal, (lease) =>
    expect(
      machine.withResetCaptureRecoveryFiles(
        {
          resetId: randomUUID(),
          accounts: 'keep',
          lease,
          signal: new AbortController().signal,
          access: {} as ResetInventoryAccess,
          directory,
          passphrase,
        },
        async () => {},
      ),
    ).rejects.toThrow(),
  );
  expect(await fs.readFile(path.join(dataDir, 'app-data/media'), 'utf8')).toBe('excluded app data');
});

it('rejects changed recovery ciphertext during independent portable readback and retains all members', async () => {
  let inspected = false;
  await expect(
    scope((binding) =>
      machine.withResetCaptureRecoveryFiles({ ...binding, directory, passphrase }, async (snapshot) => {
        const manifest = resetCaptureRecoveryManifest(snapshot);
        const member = snapshot.entries.find((entry) => entry.type === 'file');
        if (member?.type !== 'file' || !member.chunks[0]) throw new Error('Missing ciphertext fixture');
        const file = member.chunks[0].file;
        const handle = await fs.open(file, 'r+');
        try {
          await handle.write(Buffer.from([0]), 0, 1, 0);
        } finally {
          await handle.close();
        }
        await expect(
          inspectResetCaptureRecoveryManifest({
            manifest,
            expected: {
              resetId: snapshot.resetId,
              accounts: snapshot.accounts,
              filesSha256: snapshot.filesSha256,
              inventorySha256: snapshot.inventory.sha256,
            },
            directory,
            passphrase,
            signal: binding.signal,
          }),
        ).rejects.toThrow();
        expect((await fs.readdir(directory)).length).toBeGreaterThan(0);
        inspected = true;
      }),
    ),
  ).rejects.toThrow();
  expect(inspected).toBe(true);
});

it('rejects unknown recovery members without deleting any staged evidence', async () => {
  await expect(
    scope((binding) =>
      machine.withResetCaptureRecoveryFiles({ ...binding, directory, passphrase }, async (snapshot) => {
        const manifest = resetCaptureRecoveryManifest(snapshot);
        const extra = path.join(directory, 'unlisted.orbis');
        await fs.writeFile(extra, 'evidence', { mode: 0o600 });
        await expect(
          inspectResetCaptureRecoveryManifest({
            manifest,
            expected: {
              resetId: snapshot.resetId,
              accounts: snapshot.accounts,
              filesSha256: snapshot.filesSha256,
              inventorySha256: snapshot.inventory.sha256,
            },
            directory,
            passphrase,
            signal: binding.signal,
          }),
        ).rejects.toThrow();
        expect(await fs.readFile(extra, 'utf8')).toBe('evidence');
      }),
    ),
  ).rejects.toThrow();
});

it('cross-checks original ownership against authenticated metadata even when catalog hashes are recomputed', async () => {
  await scope((binding) =>
    machine.withResetCaptureRecoveryFiles({ ...binding, directory, passphrase }, async (snapshot) => {
      const inventory = resetCaptureInventory(
        snapshot.resetId,
        snapshot.accounts,
        snapshot.inventory.captures.map((record) => ({ ...record, sourceOwnerId: 99 })),
      );
      const entries = snapshot.entries.map((entry) =>
        entry.type === 'file' ? { ...entry, chunks: entry.chunks.map(({ file: _file, ...chunk }) => chunk) } : entry,
      );
      const filesSha256 = createHash('sha256')
        .update('orbis-reset-capture-recovery-files-v1\n')
        .update(JSON.stringify({ resetId: snapshot.resetId, accounts: snapshot.accounts, inventorySha256: inventory.sha256, entries }))
        .digest('hex');
      const manifest = resetCaptureRecoveryManifest({ ...snapshot, inventory, filesSha256 });
      expect(validateResetCaptureRecoveryManifest(manifest)).toEqual(manifest);
      await expect(
        inspectResetCaptureRecoveryManifest({
          manifest,
          directory,
          passphrase,
          signal: binding.signal,
          expected: { resetId: snapshot.resetId, accounts: snapshot.accounts, filesSha256, inventorySha256: inventory.sha256 },
        }),
      ).rejects.toThrow();
      await expect(
        inspectResetCaptureRecoveryManifest({
          manifest,
          directory,
          passphrase,
          signal: binding.signal,
          expected: {
            resetId: snapshot.resetId,
            accounts: snapshot.accounts,
            filesSha256: snapshot.filesSha256,
            inventorySha256: snapshot.inventory.sha256,
          },
        }),
      ).rejects.toThrow();
    }),
  );
});

it('rechecks reset authorization after independent readback before invoking its caller', async () => {
  const original = backupCrypto.inspectBackupCiphertextSequence;
  vi.spyOn(backupCrypto, 'inspectBackupCiphertextSequence').mockImplementation(async (options) => {
    const result = await original(options);
    auth.operatorActionContext.mockResolvedValue({ userId: 1, sessionBinding: 'synthetic-session', securityBinding: 'revoked-security' });
    return result;
  });
  let called = false;
  await expect(
    scope((binding) =>
      machine.withResetCaptureRecoveryFiles({ ...binding, directory, passphrase }, async () => {
        called = true;
      }),
    ),
  ).rejects.toThrow();
  expect(called).toBe(false);
  expect((await fs.readdir(directory)).length).toBeGreaterThan(0);
});
