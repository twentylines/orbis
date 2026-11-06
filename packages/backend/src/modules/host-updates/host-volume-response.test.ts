import { expect, it } from 'vitest';
import { controllerPublicationLimits, parseBackupVolumeCaptureResponse, parseControllerPublicationResponse } from './host-controller-publication';

it('preserves publication bounds while accepting larger bounded volume arrays', () => {
  const body = Buffer.from(JSON.stringify({ entries: Array.from({ length: 2049 }, () => 0) }));
  expect(() => parseControllerPublicationResponse(body)).toThrow();
  expect(parseBackupVolumeCaptureResponse(body).entries).toHaveLength(2049);
  expect(() => parseControllerPublicationResponse(Buffer.alloc(controllerPublicationLimits.receiptBytes + 1, 0x20))).toThrow();
});

it('rejects ambiguous, unsafe and incomplete volume response JSON', () => {
  const invalid = [
    Buffer.from('{"a":1,"a":2}'),
    Buffer.from('{"a":9007199254740992}'),
    Buffer.from('{"a":-9007199254740992}'),
    Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]),
    Buffer.from('{"a":'),
  ];
  for (const body of invalid) expect(() => parseBackupVolumeCaptureResponse(body)).toThrow();
});
