import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { CapsulesService } from './capsules.service';
import { CapsulesController } from './capsules.controller';
import { setBackupRecoveryRequired, setResetRecoveryRequired } from '@/common/backup-maintenance';
let root: string;
let service: CapsulesService;
const actor = { userId: 7, sessionBinding: 'a'.repeat(64), securityBinding: 'b'.repeat(64) };
const auth = { operatorActionContext: vi.fn(), verifySensitiveAction: vi.fn() };
const machine = { withPortablePoint: vi.fn() };
const credentials = { password: 'fixture-only-password' };
const request = {} as Request;
const point = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const create = () => new CapsulesService({ get: () => ({ dataDir: root }) } as never, auth as never, machine as never, {} as never);
beforeEach(async () => {
  vi.resetAllMocks();
  auth.operatorActionContext.mockResolvedValue(actor);
  auth.verifySensitiveAction.mockResolvedValue({ operator: true });
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'capsule-jobs-')));
  await fs.chmod(root, 0o700);
  setBackupRecoveryRequired(false);
  setResetRecoveryRequired(false);
  service = create();
});
afterEach(async () => {
  await service.onModuleDestroy();
  await fs.rm(root, { recursive: true, force: true });
});
it('requires current operator/session proof before creating any archive job', async () => {
  auth.verifySensitiveAction.mockRejectedValue(new Error('fixture authentication failure'));
  await expect(service.createImport(7, request, credentials)).rejects.toThrow();
  await expect(fs.stat(path.join(root, 'backups/capsules'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('fails admission when account security changes during confirmation', async () => {
  auth.operatorActionContext.mockResolvedValueOnce(actor).mockResolvedValueOnce({ ...actor, securityBinding: 'c'.repeat(64) });
  await expect(service.createImport(7, request, credentials)).rejects.toThrow();
});
it('blocks CLI/forward-auth sessions and undeclared credential fields at the controller', () => {
  const controller = new CapsulesController(service);
  expect(() => controller.create({ authMethod: 'cli', user: { id: 7, operator: true } } as Request, credentials)).toThrow();
  expect(() =>
    controller.create({ authMethod: 'session', user: { id: 7, operator: true } } as Request, { ...credentials, pointKey: 'never-accepted' }),
  ).toThrow();
});
it('reserves one export before its response finishes and cannot resurrect a removed reservation', async () => {
  const accepted = await service.startExport(7, request, credentials, point, 'fixture archive password');
  await expect(service.startExport(7, request, credentials, point, 'fixture archive password')).rejects.toThrow();
  await service.remove(accepted.job.id, 7, request, credentials);
  accepted.start();
  expect(machine.withPortablePoint).not.toHaveBeenCalled();
  expect((await service.list(7)).jobs).toEqual([]);
});
it('keeps job ownership ahead of fresh download or deletion credentials', async () => {
  const job = await service.createImport(7, request, credentials);
  await expect(service.remove(job.id, 8, request, credentials)).rejects.toThrow();
  expect((await service.list(8)).jobs).toEqual([]);
  expect((await service.list(7)).jobs).toHaveLength(1);
});
it('cancels an in-flight upload on shutdown and removes its incomplete cipher', async () => {
  const job = await service.createImport(7, request, credentials);
  const input = new PassThrough();
  input.write(Buffer.alloc(512));
  const upload = service.upload(job.id, 7, input, '1024', new AbortController().signal).catch((error) => error);
  await vi.waitFor(async () => expect((await service.list(7)).jobs[0]?.status).toBe('running'));
  await service.onModuleDestroy();
  expect(await upload).toBeInstanceOf(Error);
  expect((await service.list(7)).jobs[0]?.status).toBe('cancelled');
  await expect(fs.stat(path.join(root, 'backups/capsules', job.id, 'capsule.orbis-tm'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('holds interrupted verification and clears only its recognized private plaintext staging after restart', async () => {
  const job = await service.createImport(7, request, credentials);
  const dir = path.join(root, 'backups/capsules', job.id);
  const stored = JSON.parse(await fs.readFile(path.join(dir, 'job.json'), 'utf8'));
  stored.status = 'verifying';
  stored.bytes = 26;
  await fs.writeFile(path.join(dir, 'job.json'), JSON.stringify(stored), { mode: 0o600 });
  await fs.writeFile(path.join(dir, 'capsule.orbis-tm'), 'encrypted fixture retained', { mode: 0o600 });
  const staging = path.join(dir, 'capsule-Abc123');
  await fs.mkdir(staging, { mode: 0o700 });
  await fs.writeFile(path.join(staging, 'runtime.ciphers'), 'private fixture only', { mode: 0o600 });
  const restored = create();
  expect((await restored.list(7)).jobs[0]?.status).toBe('failed');
  await expect(fs.stat(staging)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await fs.readFile(path.join(dir, 'capsule.orbis-tm'), 'utf8')).toBe('encrypted fixture retained');
  await restored.onModuleDestroy();
});
it('refuses a linked staging directory rather than deleting unrelated files', async () => {
  const job = await service.createImport(7, request, credentials);
  const outside = path.join(root, 'outside');
  await fs.mkdir(outside, { mode: 0o700 });
  await fs.writeFile(path.join(outside, 'keep'), 'unchanged', { mode: 0o600 });
  await fs.symlink(outside, path.join(root, 'backups/capsules', job.id, 'capsule-Abc123'));
  await expect(create().list(7)).rejects.toThrow();
  expect(await fs.readFile(path.join(outside, 'keep'), 'utf8')).toBe('unchanged');
});

it('clears interrupted ciphertext fragments without retaining uncounted disk usage or removing unrelated files', async () => {
  const accepted = await service.startExport(7, request, credentials, point, 'fixture archive password');
  const dir = path.join(root, 'backups/capsules', accepted.job.id);
  for (const name of [
    '.capsule-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.partial',
    '.segment-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.orbis',
    'capsule.orbis-tm',
    'keep',
  ])
    await fs.writeFile(path.join(dir, name), 'encrypted fixture only', { mode: 0o600 });
  const restored = create();
  expect((await restored.list(7)).jobs[0]?.status).toBe('failed');
  expect((await fs.readdir(dir)).sort()).toEqual(['job.json', 'keep']);
  await restored.onModuleDestroy();
});
