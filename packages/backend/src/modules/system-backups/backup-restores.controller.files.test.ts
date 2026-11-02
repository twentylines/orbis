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
    prepareForSession: vi.fn().mockResolvedValue(result),
    cancel: vi.fn().mockResolvedValue(result),
    recover: vi.fn().mockResolvedValue(result),
    reuse: vi.fn().mockResolvedValue({ id: randomUUID(), status: 'uploaded' }),
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
  expect(() => controller.reuse(request as Request, randomUUID(), {})).toThrow('operator session');
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
  expect(service.prepareForSession).toHaveBeenCalledWith(
    body.importId,
    7,
    operator,
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
it('passes session authorization without inventing a password', async () => {
  const { controller, service } = fixture();
  const body = input();
  await controller.prepare(
    operator,
    { importId: body.importId, manifestSha256: body.manifestSha256, confirmation: body.confirmation },
    response() as unknown as Response,
  );
  expect(service.prepareForSession).toHaveBeenCalledWith(body.importId, 7, operator, undefined, body.manifestSha256);
});
it('does not strand a handoff when disconnect happened during preparation', async () => {
  const { controller, service } = fixture();
  const res = Object.assign(response(), { destroyed: true });
  await controller.prepare(operator, input(), res as unknown as Response);
  expect(service.launch).toHaveBeenCalledTimes(1);
  expect(res.listenerCount('finish') + res.listenerCount('close')).toBe(0);
});
it.each(['cancel', 'recover'] as const)('keeps %s bound to session authorization and a flushed response', async (action) => {
  const { controller, service, result } = fixture();
  const res = response();
  const id = randomUUID();
  await controller[action](operator, id, { password: 'fixture', totpCode: '123456' }, res as unknown as Response);
  const credentials = { password: 'fixture', totpCode: '123456', passphrase: undefined };
  if (action === 'recover') expect(service.recover).toHaveBeenCalledWith(id, 7, credentials, operator);
  else expect(service.cancel).toHaveBeenCalledWith(id, 7, credentials, operator);
  expect(service.launch).not.toHaveBeenCalled();
  res.emit('finish');
  expect(service.launch).toHaveBeenCalledExactlyOnceWith(result.job.id);
});
it('never launches the legacy worker after a root-managed recovery response', async () => {
  const { controller, service, result } = fixture();
  const res = response();
  service.recover.mockResolvedValue({ ...result, rootManaged: true } as typeof result);
  await controller.recover(operator, randomUUID(), { password: 'fixture' }, res as unknown as Response);
  res.emit('finish');
  res.emit('close');
  expect(service.launch).not.toHaveBeenCalled();
});
it('does not launch after rejected preparation and prevents cached progress', async () => {
  const { controller, service } = fixture();
  const res = response();
  service.prepareForSession.mockRejectedValue(new Error('review required'));
  await expect(controller.prepare(operator, input(), res as unknown as Response)).rejects.toThrow('review required');
  res.emit('finish');
  res.emit('close');
  expect(service.launch).not.toHaveBeenCalled();
  await controller.status(operator, res as unknown as Response);
  expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
});

it('reuses an exact journal only for its session owner and rejects path or credential overrides', async () => {
  const { controller, service } = fixture();
  const id = randomUUID();
  await controller.reuse(operator, id, {});
  expect(service.reuse).toHaveBeenCalledExactlyOnceWith(id, 7, operator);
  for (const body of [{ path: 'foreign' }, { password: 'unneeded' }, { ownerId: 8 }, []])
    expect(() => controller.reuse(operator, id, body)).toThrow('without extra');
});

it('passes session-only cancellation and ordinary recovery without inventing credentials', async () => {
  for (const action of ['cancel', 'recover'] as const) {
    const { controller, service } = fixture();
    const id = randomUUID();
    await controller[action](operator, id, {}, response() as unknown as Response);
    expect(service[action]).toHaveBeenCalledWith(id, 7, undefined, operator);
  }
});
