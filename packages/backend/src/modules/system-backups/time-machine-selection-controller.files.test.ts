import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { expect, it, vi } from 'vitest';
import { TimeMachineController } from './time-machine.controller';
import type { TimeMachineService } from './time-machine.service';

it('passes the reviewed selected-component request unchanged and launches only after response completion', async () => {
  const point = { id: '11111111-1111-4111-8111-111111111111', status: 'capturing', metadata: null };
  const machine = { captureCore: vi.fn(async () => point), launchCapture: vi.fn(), captureReview: vi.fn() };
  const controller = new TimeMachineController(machine as unknown as TimeMachineService);
  const request = { authMethod: 'session', user: { id: 7, operator: true } } as unknown as Request;
  const response = Object.assign(new EventEmitter(), { writableFinished: false, destroyed: false }) as unknown as Response;
  const selection = { version: 1, reviewId: point.id, reviewSha256: 'a'.repeat(64), apps: [{ urn: 'jellyfin:_user', mountIds: ['b'.repeat(64)] }] };
  await controller.captureCore(request, { label: 'Jellyfin settings', selection }, response);
  expect(machine.captureCore).toHaveBeenCalledExactlyOnceWith(7, {}, { label: 'Jellyfin settings', selection }, request);
  expect(machine.launchCapture).not.toHaveBeenCalled();
  response.emit('finish');
  response.emit('close');
  expect(machine.launchCapture).toHaveBeenCalledExactlyOnceWith(point.id, 7);
  await expect(controller.captureCore(request, { label: 'Unsafe', selection, command: 'stop omitted app' }, response)).rejects.toThrow();
});

it('binds storage review to the authenticated operator and forbids API-token or member sessions', () => {
  const machine = { captureReview: vi.fn() };
  const controller = new TimeMachineController(machine as unknown as TimeMachineService);
  const request = { authMethod: 'session', user: { id: 7, operator: true } } as unknown as Request;
  controller.captureReview(request, { appUrns: ['jellyfin:_user'] });
  expect(machine.captureReview).toHaveBeenCalledExactlyOnceWith(7, request, { appUrns: ['jellyfin:_user'] });
  expect(() => controller.captureReview({ ...request, authMethod: 'token' } as unknown as Request, {})).toThrow();
  expect(() => controller.captureReview({ ...request, user: { id: 7, operator: false } } as unknown as Request, {})).toThrow();
});
