import 'reflect-metadata';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import type { Request, Response } from 'express';
import { expect, it, vi } from 'vitest';

vi.mock('./time-machine-core-inspection.service', () => ({ TimeMachineCoreInspectionService: class {} }));
import { AuthGuard } from '../auth/auth.guard';
import { TimeMachineCoreInspectionController } from './time-machine-core-inspection.controller';
import type { TimeMachineCoreInspectionService } from './time-machine-core-inspection.service';

const pointId = 'd5d82d7c-1f6a-429e-90ea-787833c06fe3';
const requestId = 'a71c77d2-f420-440e-951b-083209514e72';
const request = { authMethod: 'session', user: { id: 7, operator: true } } as unknown as Request;
const response = () => ({ setHeader: vi.fn() }) as unknown as Response;
const service = () => ({ prepare: vi.fn(), status: vi.fn(), approve: vi.fn() });
const controller = (inspections: ReturnType<typeof service>) =>
  new TimeMachineCoreInspectionController(inspections as unknown as TimeMachineCoreInspectionService);

it('guards the local point routes and uses asynchronous admission responses', () => {
  expect(Reflect.getMetadata(GUARDS_METADATA, TimeMachineCoreInspectionController)).toContain(AuthGuard);
  expect(Reflect.getMetadata(PATH_METADATA, TimeMachineCoreInspectionController.prototype.prepare)).toBe('points/:id/core-inspections');
  expect(Reflect.getMetadata(METHOD_METADATA, TimeMachineCoreInspectionController.prototype.prepare)).toBe(RequestMethod.POST);
  expect(Reflect.getMetadata(METHOD_METADATA, TimeMachineCoreInspectionController.prototype.status)).toBe(RequestMethod.GET);
});

it('derives owner from the session and accepts no password on prepare or status', () => {
  const inspections = service();
  const endpoint = controller(inspections);
  const out = response();
  endpoint.prepare(request, pointId, { requestId }, out);
  expect(inspections.prepare).toHaveBeenCalledWith(pointId, 7, request, requestId);
  endpoint.status(request, pointId, requestId, out);
  expect(inspections.status).toHaveBeenCalledWith(pointId, 7, request, requestId);
  expect(out.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
});

it.each(['actor', 'ownerId', 'imageId', 'codeDirectory', 'enrollmentId', 'password'])('rejects browser-selected %s during preparation', (key) => {
  const inspections = service();
  expect(() => controller(inspections).prepare(request, pointId, { requestId, [key]: 'untrusted' }, response())).toThrow();
  expect(inspections.prepare).not.toHaveBeenCalled();
});

it('requires a real operator session before reaching any service action', () => {
  const inspections = service();
  const denied = { ...request, authMethod: 'api-key' } as unknown as Request;
  expect(() => controller(inspections).prepare(denied, pointId, { requestId }, response())).toThrow();
  expect(() => controller(inspections).status(denied, pointId, requestId, response())).toThrow();
  expect(inspections.prepare).not.toHaveBeenCalled();
  expect(inspections.status).not.toHaveBeenCalled();
});

it('passes only approval credentials and exact review fields to the account bridge', () => {
  const inspections = service();
  const input = { reviewSha256: 'a'.repeat(64), approvalNonce: 'b'.repeat(64), executionConsent: { fixture: true } };
  controller(inspections).approve(request, pointId, requestId, { password: 'fixture-password', totpCode: '123456', ...input }, response());
  expect(inspections.approve).toHaveBeenCalledWith(
    pointId,
    7,
    request,
    requestId,
    expect.objectContaining({ password: 'fixture-password', totpCode: '123456' }),
    input,
  );
});

it('does not accept an actor, separate backup password, or code path in approval', () => {
  const inspections = service();
  const input = { password: 'fixture-password', reviewSha256: 'a'.repeat(64), approvalNonce: 'b'.repeat(64), executionConsent: {} };
  for (const extra of [{ actor: {} }, { passphrase: 'not-an-account-password' }, { codeDirectory: '/untrusted' }])
    expect(() => controller(inspections).approve(request, pointId, requestId, { ...input, ...extra }, response())).toThrow();
  expect(inspections.approve).not.toHaveBeenCalled();
});
