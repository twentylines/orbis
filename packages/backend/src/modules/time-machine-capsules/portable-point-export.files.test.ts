import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { Request } from 'express';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { stabilizeDarwinFixtureCreation, stabilizeExistingDarwinFixtures } from '../system-backups/darwin-files.fixture';
import { importCapsule } from './capsule';
import { exportPortablePoint } from './portable-point-export';

let root: string;
let restoreDarwinCreation: () => void;
const pointId = randomUUID();
const pointKey = randomBytes(32).toString('base64url');
const passphrase = 'fixture portable archive password';
const credentials = { password: 'fixture password' };
const request = {} as Request;
const signal = new AbortController().signal;
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const contents = {
  'backup.orbis': Buffer.alloc(100, 1),
  'runtime.orbis': Buffer.alloc(101, 2),
  'metadata.orbis': Buffer.alloc(102, 3),
  'wallpaper.orbis': Buffer.alloc(103, 4),
  'icons.orbis': Buffer.alloc(104, 5),
};
let machine: { withPortablePoint: ReturnType<typeof vi.fn> };
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'portable-point-')));
  restoreDarwinCreation = stabilizeDarwinFixtureCreation(() => root);
  const dir = path.join(root, 'backups', 'time-machine', 'points', pointId);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  for (const [name, bytes] of Object.entries(contents)) await fs.writeFile(path.join(dir, name), bytes, { mode: 0o600 });
  stabilizeExistingDarwinFixtures(root);
  machine = {
    withPortablePoint: vi.fn(async (_id, _owner, _request, _credentials, callbackSignal, consume) =>
      consume({
        point: {
          version: 2,
          createdAt: 1234,
          archiveBytes: contents['backup.orbis'].length,
          archiveSha256: hash(contents['backup.orbis']),
          runtimeBytes: contents['runtime.orbis'].length,
          runtimeCipherSha256: hash(contents['runtime.orbis']),
          metadataSha256: hash(contents['metadata.orbis']),
        },
        metadata: {
          software: { orbis: '4.10.1' },
          preview: {
            available: true,
            wallpaperAsset: { available: true, bytes: contents['wallpaper.orbis'].length - 52, cipherSha256: hash(contents['wallpaper.orbis']) },
            appIcons: { bytes: contents['icons.orbis'].length - 52, cipherSha256: hash(contents['icons.orbis']) },
          },
        },
        source: Readable.from([contents['backup.orbis']]),
        pointKey,
        signal: callbackSignal,
      }),
    ),
  };
});
afterEach(async () => {
  restoreDarwinCreation();
  await fs.rm(root, { recursive: true, force: true });
});
function options() {
  return {
    machine: machine as never,
    dataDir: root,
    pointId,
    ownerId: 7,
    request,
    credentials,
    passphrase,
    destination: path.join(root, 'capture.orbis-tm'),
    signal,
  };
}
it('exports all bound ciphers and returns the original capture identity', async () => {
  const progress = vi.fn();
  const admitBytes = vi.fn();
  const result = await exportPortablePoint({ ...options(), progress, admitBytes });
  expect(machine.withPortablePoint).toHaveBeenCalledWith(pointId, 7, request, credentials, signal, expect.any(Function));
  expect(admitBytes).toHaveBeenCalledWith(Object.values(contents).reduce((sum, value) => sum + value.length, 0));
  expect(result).toMatchObject({ pointId, capturedAt: 1234, orbisVersion: '4.10.1' });
  expect(result.sha256).toBe(hash(await fs.readFile(options().destination)));
  expect(result.bytes).toBe((await fs.stat(options().destination)).size);
  expect(progress).toHaveBeenCalled();
  const imported = await importCapsule({
    source: options().destination,
    stagingParent: root,
    passphrase,
    signal,
    verify: async (manifest, directory) => {
      expect(manifest).toMatchObject({ pointId, createdAt: 1234, pointKey });
      for (const [name, value] of Object.entries(contents)) expect(await fs.readFile(path.join(directory, name))).toEqual(value);
    },
  });
  expect(imported.capsuleId).toBe(result.capsuleId);
  await imported.dispose();
});
it('fails before output when quota admission rejects the capture', async () => {
  await expect(
    exportPortablePoint({
      ...options(),
      admitBytes: () => {
        throw new Error('quota');
      },
    }),
  ).rejects.toThrow('quota');
  await expect(fs.stat(options().destination)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('rejects changed point ciphertext without publishing a capsule', async () => {
  await fs.writeFile(path.join(root, 'backups', 'time-machine', 'points', pointId, 'runtime.orbis'), Buffer.alloc(101, 9));
  await expect(exportPortablePoint(options())).rejects.toThrow();
  await expect(fs.stat(options().destination)).rejects.toMatchObject({ code: 'ENOENT' });
});
