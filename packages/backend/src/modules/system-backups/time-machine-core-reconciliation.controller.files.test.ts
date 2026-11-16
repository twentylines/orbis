import 'reflect-metadata';
import { GUARDS_METADATA, HTTP_CODE_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { TimeMachineCoreReconciliationController } from './time-machine-core-reconciliation.controller';
import { AuthGuard } from '../auth/auth.guard';

vi.mock('./time-machine-core-reconciliation.service', () => ({ TimeMachineCoreReconciliationService: class {} }));
vi.mock('../auth/auth.guard', () => ({ AuthGuard: class {} }));

const request = { authMethod: 'session', user: { id: 1, operator: true } } as never;
const pointId = randomUUID();
const input = {
  requestId: randomUUID(),
  sourcePreparationRequestId: randomUUID(),
  destinationPointId: randomUUID(),
  destinationPreparationRequestId: randomUUID(),
  action: 'prepare-isolated-reconciled-target',
  password: 'fixture-password',
};
function fixture() {
  const service = { prepare: vi.fn(), status: vi.fn(), restorationReview: vi.fn() };
  const response = { setHeader: vi.fn() };
  return { controller: new TimeMachineCoreReconciliationController(service as never), service, response };
}
it('guards admission/status and exposes only explicit POST admission and GET observation', () => {
  expect(Reflect.getMetadata(GUARDS_METADATA, TimeMachineCoreReconciliationController)).toContain(AuthGuard);
  expect(Reflect.getMetadata(METHOD_METADATA, TimeMachineCoreReconciliationController.prototype.prepare)).toBe(RequestMethod.POST);
  expect(Reflect.getMetadata(HTTP_CODE_METADATA, TimeMachineCoreReconciliationController.prototype.prepare)).toBe(202);
  expect(Reflect.getMetadata(METHOD_METADATA, TimeMachineCoreReconciliationController.prototype.status)).toBe(RequestMethod.GET);
});
it('exposes a separate explicit preparation action with credentials and no browser actor/Root identity', () => {
  const { controller, service, response } = fixture();
  controller.prepare(request, pointId, input, response as never);
  expect(service.prepare).toHaveBeenCalledExactlyOnceWith(pointId, 1, request, expect.objectContaining({ password: input.password }), {
    requestId: input.requestId,
    sourcePreparationRequestId: input.sourcePreparationRequestId,
    destinationPointId: input.destinationPointId,
    destinationPreparationRequestId: input.destinationPreparationRequestId,
    action: input.action,
  });
  expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
});
it.each([
  null,
  [],
  {},
  { ...input, password: '' },
  { ...input, action: 'activate' },
  { ...input, actor: {} },
  { ...input, id: randomUUID() },
  { ...input, sourcePreparationId: randomUUID() },
  { ...input, destinationInspectionId: randomUUID() },
  { ...input, destinationPointId: '../escape' },
  { ...input, totpCode: '123' },
])('rejects unsupported or malformed admissions %#', (body) => {
  const { controller, service, response } = fixture();
  expect(() => controller.prepare(request, pointId, body, response as never)).toThrow();
  expect(service.prepare).not.toHaveBeenCalled();
});
it('accepts status only by stored request identity and requires an operator session', () => {
  const { controller, service, response } = fixture();
  controller.status(request, pointId, input.requestId, response as never);
  expect(service.status).toHaveBeenCalledExactlyOnceWith(pointId, 1, request, input.requestId);
  expect(() =>
    controller.status({ authMethod: 'api-key', user: { id: 1, operator: true } } as never, pointId, input.requestId, response as never),
  ).toThrow();
  expect(() => controller.prepare({ authMethod: 'session', user: { id: 1, operator: false } } as never, pointId, input, response as never)).toThrow();
});

it('opens a read-only installation review without requesting credentials or browser-selected Root identities', () => {
  const { controller, service, response } = fixture();
  const reviewRequestId = randomUUID();
  controller.review(
    request,
    pointId,
    input.requestId,
    { reviewRequestId, action: 'review-current-installation-core-restoration' },
    response as never,
  );
  expect(service.restorationReview).toHaveBeenCalledExactlyOnceWith(pointId, 1, request, input.requestId, reviewRequestId, 'review');
  expect(Reflect.getMetadata(HTTP_CODE_METADATA, TimeMachineCoreReconciliationController.prototype.review)).toBe(200);
  service.restorationReview.mockClear();
  controller.reviewStatus(request, pointId, input.requestId, reviewRequestId, response as never);
  expect(service.restorationReview).toHaveBeenCalledExactlyOnceWith(pointId, 1, request, input.requestId, reviewRequestId, 'status');
});

it.each([
  null,
  [],
  {},
  { reviewRequestId: '../invalid', action: 'review-current-installation-core-restoration' },
  { reviewRequestId: randomUUID(), action: 'activate' },
  { reviewRequestId: randomUUID(), action: 'review-current-installation-core-restoration', id: randomUUID() },
  { reviewRequestId: randomUUID(), action: 'review-current-installation-core-restoration', password: 'not-needed' },
])('rejects malformed or elevated review admission %#', (body) => {
  const { controller, service, response } = fixture();
  expect(() => controller.review(request, pointId, input.requestId, body, response as never)).toThrow();
  expect(service.restorationReview).not.toHaveBeenCalled();
});
