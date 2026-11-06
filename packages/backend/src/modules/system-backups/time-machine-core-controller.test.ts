import { EventEmitter } from 'node:events';
import { PATH_METADATA } from '@nestjs/common/constants';
import type { Request, Response } from 'express';
import { expect, it, vi } from 'vitest';
import { TimeMachineController } from './time-machine.controller';
import type { TimeMachineService } from './time-machine.service';

function fixture() {
  const point = { id: '11111111-1111-4111-8111-111111111111', status: 'capturing', metadata: null };
  const machine = { captureCore: vi.fn(async () => point), launchCapture: vi.fn(async () => undefined) };
  const controller = new TimeMachineController(machine as unknown as TimeMachineService);
  const request = { authMethod: 'session', user: { id: 7, operator: true } } as unknown as Request;
  const response = Object.assign(new EventEmitter(), { writableFinished: false, destroyed: false }) as unknown as Response;
  return { point, machine, controller, request, response };
}

it('keeps core capture unavailable over HTTP until preparation and abort exclusion are integrated', () => {
  expect(Reflect.getMetadata(PATH_METADATA, TimeMachineController.prototype.captureCore)).toBeUndefined();
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
