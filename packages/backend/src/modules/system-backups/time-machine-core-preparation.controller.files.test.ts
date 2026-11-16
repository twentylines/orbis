import 'reflect-metadata';
import { GUARDS_METADATA, HTTP_CODE_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import type { Request, Response } from 'express';
import { expect, it, vi } from 'vitest';
vi.mock('./time-machine-core-preparation.service', () => ({ TimeMachineCorePreparationService: class {} }));
import { AuthGuard } from '../auth/auth.guard';
import { TimeMachineCorePreparationController } from './time-machine-core-preparation.controller';
const pointId = 'd5d82d7c-1f6a-429e-90ea-787833c06fe3';
const requestId = 'a71c77d2-f420-440e-951b-083209514e72';
const request = { authMethod: 'session', user: { id: 7, operator: true } } as unknown as Request;
const response = () => ({ setHeader: vi.fn() }) as unknown as Response;
function setup() {
  const service = { prepare: vi.fn(), status: vi.fn(), approve: vi.fn(), prepareTarget: vi.fn() };
  return { service, controller: new TimeMachineCorePreparationController(service as never) };
}
it('guards asynchronous mutation endpoints and keeps status read-only', () => {
  expect(Reflect.getMetadata(GUARDS_METADATA, TimeMachineCorePreparationController)).toContain(AuthGuard);
  for (const key of ['prepare', 'approve', 'target'] as const) {
    const method = TimeMachineCorePreparationController.prototype[key];
    expect(Reflect.getMetadata(METHOD_METADATA, method)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, method)).toBe(202);
  }
  expect(Reflect.getMetadata(METHOD_METADATA, TimeMachineCorePreparationController.prototype.status)).toBe(RequestMethod.GET);
});
it('uses the session owner and requires no password for preparation, status, or isolated target', () => {
  const { controller, service } = setup();
  const out = response();
  controller.prepare(request, pointId, { requestId }, out);
  controller.status(request, pointId, requestId, out);
  controller.target(request, pointId, requestId, { action: 'prepare-isolated-clean-target' }, out);
  expect(service.prepare).toHaveBeenCalledWith(pointId, 7, request, requestId);
  expect(service.status).toHaveBeenCalledWith(pointId, 7, request, requestId);
  expect(service.prepareTarget).toHaveBeenCalledWith(pointId, 7, request, requestId, 'prepare-isolated-clean-target');
  expect(out.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
});
it.each(['actor', 'ownerId', 'password', 'imageId', 'codeDirectory'])('rejects browser-supplied %s', (key) => {
  const { controller, service } = setup();
  expect(() => controller.prepare(request, pointId, { requestId, [key]: 'untrusted' }, response())).toThrow();
  expect(() => controller.target(request, pointId, requestId, { action: 'prepare-isolated-clean-target', [key]: 'untrusted' }, response())).toThrow();
  expect(service.prepare).not.toHaveBeenCalled();
  expect(service.prepareTarget).not.toHaveBeenCalled();
});
it('requires an operator session on every route and rejects activation actions', () => {
  const { controller, service } = setup();
  const denied = { ...request, authMethod: 'api-key' } as unknown as Request;
  expect(() => controller.prepare(denied, pointId, { requestId }, response())).toThrow();
  expect(() => controller.status(denied, pointId, requestId, response())).toThrow();
  expect(() => controller.target(denied, pointId, requestId, { action: 'prepare-isolated-clean-target' }, response())).toThrow();
  expect(() => controller.approve(denied, pointId, requestId, {}, response())).toThrow();
  expect(() => controller.target(request, pointId, requestId, { action: 'activate' }, response())).toThrow();
  expect(service.prepareTarget).not.toHaveBeenCalled();
});
it('separates account credentials from the source approval, refusing extra authority', () => {
  const { controller, service } = setup();
  const approval = { reviewSha256: 'a'.repeat(64), approvalNonce: 'b'.repeat(64), executionConsent: {} };
  controller.approve(request, pointId, requestId, { ...approval, password: 'fixture-password' }, response());
  expect(service.approve).toHaveBeenCalledWith(pointId, 7, request, requestId, expect.objectContaining({ password: 'fixture-password' }), approval);
  service.approve.mockClear();
  for (const extra of [{ actor: {} }, { passphrase: 'separate-password' }, { activationAuthorized: true }])
    expect(() => controller.approve(request, pointId, requestId, { ...approval, password: 'fixture-password', ...extra }, response())).toThrow();
  expect(service.approve).not.toHaveBeenCalled();
});
