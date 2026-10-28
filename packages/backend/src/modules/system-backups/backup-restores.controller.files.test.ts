import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { expect, it, vi } from 'vitest';
import { BackupRestoresController, restoreRequest } from './backup-restores.controller';
import type { BackupRestoresService } from './backup-restores.service';

const operator = { authMethod: 'session', user: { id: 7, operator: true } } as Request;
const input = () => ({
  importId: randomUUID(),
  manifestSha256: 'a'.repeat(64),
  confirmation: 'replace-server',
  password: 'fixture-password',
  totpCode: '123456',
});
const response = () => Object.assign(new EventEmitter(), { setHeader: vi.fn(), writableFinished: false, destroyed: false });
function fixture() {
  const result = { job: { id: randomUUID(), status: 'ready' } };
  const service = {
    status: vi.fn().mockResolvedValue(result),
    prepare: vi.fn().mockResolvedValue(result),
    cancel: vi.fn().mockResolvedValue(result),
    recover: vi.fn().mockResolvedValue(result),
    launch: vi.fn().mockResolvedValue(undefined),
  };
  return { result, service, controller: new BackupRestoresController(service as unknown as BackupRestoresService) };
}
it.each([
  { authMethod: 'forward-auth', user: { id: 7, operator: true } },
  { authMethod: 'session', user: { id: 7, operator: false } },
  { authMethod: 'session' },
])('requires an operator session for every restore endpoint %#', async (request) => {
  const { controller, service } = fixture();
  const res = response() as unknown as Response;
  expect(() => controller.status(request as Request, res)).toThrow('operator session');
  await expect(controller.prepare(request as Request, input(), res)).rejects.toThrow('operator session');
  for (const action of ['cancel', 'recover'] as const)
    await expect(controller[action](request as Request, randomUUID(), { password: 'fixture' }, res)).rejects.toThrow('operator session');
  for (const action of Object.values(service)) expect(action).not.toHaveBeenCalled();
});
it.each([
  { confirmation: undefined },
  { confirmation: 'yes' },
  { importId: '../backup' },
  { manifestSha256: 'A'.repeat(64) },
  { path: '/outside' },
  { container: 'foreign' },
  { database: 'foreign' },
  { password: '' },
  { totpCode: 'bad' },
])('rejects an unconfirmed, inexact or extra-field restore request %#', (override) => {
  expect(() => restoreRequest({ ...input(), ...override })).toThrow();
});
it('uses the session owner and exact reviewed manifest, then starts only after the response finishes', async () => {
  const { controller, service, result } = fixture();
  const body = input();
  const res = response();
  expect(await controller.prepare(operator, body, res as unknown as Response)).toEqual(result);
  expect(service.prepare).toHaveBeenCalledWith(
    body.importId,
    7,
    { password: body.password, totpCode: body.totpCode, passphrase: undefined },
    body.manifestSha256,
  );
  expect(service.launch).not.toHaveBeenCalled();
  res.emit('finish');
  res.emit('close');
  expect(service.launch).toHaveBeenCalledExactlyOnceWith(result.job.id);
  expect(res.listenerCount('finish') + res.listenerCount('close')).toBe(0);
});
it('starts a fully confirmed handoff once even if the client disconnects before receiving it', async () => {
  const { controller, service } = fixture();
  const res = response();
  await controller.prepare(operator, input(), res as unknown as Response);
  res.emit('close');
  res.emit('finish');
  expect(service.launch).toHaveBeenCalledTimes(1);
});
it('does not strand a handoff when disconnect happened during preparation', async () => {
  const { controller, service } = fixture();
  const res = Object.assign(response(), { destroyed: true });
  await controller.prepare(operator, input(), res as unknown as Response);
  expect(service.launch).toHaveBeenCalledTimes(1);
  expect(res.listenerCount('finish') + res.listenerCount('close')).toBe(0);
});
it.each(['cancel', 'recover'] as const)('keeps %s gated on fresh credentials and a flushed response', async (action) => {
  const { controller, service, result } = fixture();
  const res = response();
  const id = randomUUID();
  await controller[action](operator, id, { password: 'fixture', totpCode: '123456' }, res as unknown as Response);
  expect(service[action]).toHaveBeenCalledWith(id, 7, { password: 'fixture', totpCode: '123456', passphrase: undefined });
  expect(service.launch).not.toHaveBeenCalled();
  res.emit('finish');
  expect(service.launch).toHaveBeenCalledExactlyOnceWith(result.job.id);
});
it('does not launch after rejected preparation and prevents cached progress', async () => {
  const { controller, service } = fixture();
  const res = response();
  service.prepare.mockRejectedValue(new Error('review required'));
  await expect(controller.prepare(operator, input(), res as unknown as Response)).rejects.toThrow('review required');
  res.emit('finish');
  res.emit('close');
  expect(service.launch).not.toHaveBeenCalled();
  await controller.status(operator, res as unknown as Response);
  expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
});
