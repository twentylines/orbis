import { EventEmitter } from 'node:events';
import { LoggerService } from '@/core/logger/logger.service';
import { Test } from '@nestjs/testing';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import type { Request, Response } from 'express';
import httpRequest from 'supertest';
import { expect, it, vi } from 'vitest';
import { TimeMachineController } from './time-machine.controller';
import { TimeMachineService } from './time-machine.service';

function fixture() {
  const point = { id: '11111111-1111-4111-8111-111111111111', status: 'capturing', metadata: null };
  const machine = { captureCore: vi.fn(async () => point), launchCapture: vi.fn(async () => undefined) };
  const controller = new TimeMachineController(machine as unknown as TimeMachineService);
  const request = { authMethod: 'session', user: { id: 7, operator: true } } as unknown as Request;
  const response = Object.assign(new EventEmitter(), { writableFinished: false, destroyed: false }) as unknown as Response;
  return { point, machine, controller, request, response };
}

it('provides a separate authenticated POST without replacing the existing capture endpoint', () => {
  expect(Reflect.getMetadata(PATH_METADATA, TimeMachineController.prototype.captureCore)).toBe('core-captures');
  expect(Reflect.getMetadata(METHOD_METADATA, TimeMachineController.prototype.captureCore)).toBe(RequestMethod.POST);
  expect(Reflect.getMetadata(PATH_METADATA, TimeMachineController.prototype.capture)).toBe('captures');
  expect(Reflect.getMetadata(GUARDS_METADATA, TimeMachineController)).toContain(AuthGuard);
});

it('passes the current operator request and starts only after the accepted response ends', async () => {
  const f = fixture();
  const body = { label: 'Before update' };
  expect(await f.controller.captureCore(f.request, body, f.response)).toBe(f.point);
  expect(f.machine.captureCore).toHaveBeenCalledWith(7, {}, body, f.request);
  expect(f.machine.launchCapture).not.toHaveBeenCalled();
  f.response.emit('finish');
  f.response.emit('close');
  expect(f.machine.launchCapture).toHaveBeenCalledExactlyOnceWith(f.point.id, 7);
});

it('rejects non-operator sessions and caller-supplied authorization identities', async () => {
  const f = fixture();
  await expect(
    f.controller.captureCore({ ...f.request, authMethod: 'token' } as unknown as Request, { label: 'Capture' }, f.response),
  ).rejects.toThrow();
  await expect(f.controller.captureCore(f.request, { label: 'Capture', operatorAuthorizationId: 'forged' }, f.response)).rejects.toThrow();
  expect(f.machine.captureCore).not.toHaveBeenCalled();
});

it('does not launch when admission is rejected before a point is accepted', async () => {
  const f = fixture();
  f.machine.captureCore.mockRejectedValueOnce(Error('Session changed.'));
  await expect(f.controller.captureCore(f.request, { label: 'Capture' }, f.response)).rejects.toThrow('Session changed');
  f.response.emit('close');
  expect(f.machine.launchCapture).not.toHaveBeenCalled();
});

it('enforces authentication, operator sessions and same-origin requests through the HTTP adapter', async () => {
  const f = fixture();
  const module = await Test.createTestingModule({
    controllers: [TimeMachineController],
    providers: [AuthGuard, { provide: LoggerService, useValue: { debug: vi.fn() } }, { provide: TimeMachineService, useValue: f.machine }],
  }).compile();
  const app = module.createNestApplication({ logger: false });
  app.use((request: Request, _response: Response, next: () => void) => {
    const identity = request.headers.authorization;
    if (identity) {
      request.user = { id: 7, operator: identity !== 'member' } as Request['user'];
      request.authMethod = identity === 'token' ? 'cli' : 'session';
    }
    next();
  });
  await app.listen(0, '127.0.0.1');
  const post = (identity?: string, origin = 'http://orbis.test') => {
    const action = httpRequest(app.getHttpServer())
      .post('/system-backups/time-machine/core-captures')
      .set('Host', 'orbis.test')
      .set('Origin', origin);
    if (identity) action.set('Authorization', identity);
    return action.send({ label: 'Capture' });
  };
  try {
    expect((await post()).status).toBe(401);
    expect((await post('operator', 'http://other.test')).status).toBe(403);
    expect((await post('member')).status).toBe(403);
    expect((await post('token')).status).toBe(403);
    expect(f.machine.captureCore).not.toHaveBeenCalled();
    const accepted = await post('operator');
    expect(accepted.status).toBe(202);
    expect(accepted.body).toEqual(f.point);
    expect(f.machine.captureCore).toHaveBeenCalledOnce();
    expect(f.machine.launchCapture).toHaveBeenCalledExactlyOnceWith(f.point.id, 7);
  } finally {
    await app.close();
  }
});
