import { afterEach, expect, test } from 'bun:test';
import { createHash, randomFillSync } from 'node:crypto';
import { portablePreviewSha256, previewSha256 } from './preview-sha256';
const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
afterEach(() => {
  if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor);
});
test('matches the published empty, abc and million-a SHA-256 answers', () => {
  expect(portablePreviewSha256(new Uint8Array())).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  expect(portablePreviewSha256(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  expect(portablePreviewSha256(new Uint8Array(1_000_000).fill(97))).toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
});
test('matches the independent native digest at padding boundaries and on sliced buffers', async () => {
  for (const length of [0, 1, 7, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 255, 256, 1024, 65536]) {
    const backing = randomFillSync(new Uint8Array(length + 23));
    const bytes = backing.subarray(11, 11 + length);
    const expected = createHash('sha256').update(bytes).digest('hex');
    expect(portablePreviewSha256(bytes)).toBe(expected);
    expect(await previewSha256(bytes)).toBe(expected);
  }
});
test('retains exact integrity checks when Web Crypto is unavailable on an HTTP origin', async () => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {} });
  const bytes = new Uint8Array(4096);
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 256;
  const before = bytes.slice();
  expect(await previewSha256(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'));
  expect(bytes).toEqual(before);
});
