import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { Request, Response } from 'express';
import { expect, it, vi } from 'vitest';
import { SystemBackupsController } from './system-backups.controller';
import type { SystemBackupsService } from './system-backups.service';

const operator = { authMethod: 'session', user: { id: 7, operator: true } } as Request;
it.each([
  { authMethod: 'forward-auth', user: { id: 7, operator: true } },
  { authMethod: 'session', user: { id: 7, operator: false } },
  { authMethod: 'session' },
])('requires an operator session before starting an export', (request) => {
  const start = vi.fn();
  const controller = new SystemBackupsController({ start } as unknown as SystemBackupsService);
  expect(() => controller.start(request as Request, {})).toThrow('operator session');
  expect(start).not.toHaveBeenCalled();
});
it.each([
  {},
  { password: 5 },
  { password: 'fixture', passphrase: 'short' },
  { password: 'fixture', passphrase: 'disposable passphrase', totpCode: 'bad' },
  { password: 'fixture', passphrase: 'disposable passphrase', path: '/outside' },
])('rejects invalid credentials and arbitrary output paths', (body) => {
  const start = vi.fn();
  const controller = new SystemBackupsController({ start } as unknown as SystemBackupsService);
  expect(() => controller.start(operator, body)).toThrow();
  expect(start).not.toHaveBeenCalled();
});
it('destroys the download source on disconnect and removes its listener after closing', async () => {
  const stream = new PassThrough();
  const download = vi.fn().mockResolvedValue({ stream, bytes: 100 });
  const controller = new SystemBackupsController({ download } as unknown as SystemBackupsService);
  const response = Object.assign(new EventEmitter(), { setHeader: vi.fn() });
  await controller.download(operator, 'fixture-id', { password: 'fixture' }, response as unknown as Response);
  expect(response.listenerCount('close')).toBe(1);
  response.emit('close');
  expect(stream.destroyed).toBe(true);
  await new Promise<void>((resolve) => stream.once('close', resolve));
  expect(response.listenerCount('close')).toBe(0);
});
it('closes a file opened after the client already disconnected during reauthentication', async () => {
  const stream = new PassThrough();
  const controller = new SystemBackupsController({ download: vi.fn().mockResolvedValue({ stream, bytes: 100 }) } as unknown as SystemBackupsService);
  const response = Object.assign(new EventEmitter(), { destroyed: true, setHeader: vi.fn() });
  await controller.download(operator, 'fixture-id', { password: 'fixture' }, response as unknown as Response);
  expect(stream.destroyed).toBe(true);
});
