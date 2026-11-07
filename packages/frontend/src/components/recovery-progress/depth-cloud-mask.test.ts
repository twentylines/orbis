import { expect, test } from 'bun:test';
import { createCloudMaskLoader } from './depth-cloud-mask';

test('concurrent scenes share one retained image and receive it only after decoding', async () => {
  let ready!: () => void;
  let calls = 0;
  const image = {
    src: '',
    decoding: 'auto' as HTMLImageElement['decoding'],
    decode: () =>
      new Promise<void>((resolve) => {
        ready = resolve;
      }),
  };
  const load = createCloudMaskLoader(() => {
    calls++;
    return image;
  }, '/mask.webp');
  const first = load();
  const second = load();
  expect(first).toBe(second);
  let settled = false;
  void first.then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(calls).toBe(1);
  expect(image.src).toBe('/mask.webp');
  expect(image.decoding).toBe('async');
  expect(settled).toBe(false);
  ready();
  expect(await first).toBe(image);
  expect(await load()).toBe(image);
  expect(calls).toBe(1);
});

test('a failed or unsupported decoder retains the procedural fallback without retries', async () => {
  for (const create of [
    () => ({ src: '', decoding: 'auto' as const, decode: () => Promise.reject(new Error('unavailable')) }),
    () => {
      throw new Error('unsupported');
    },
  ]) {
    let calls = 0;
    const load = createCloudMaskLoader(() => {
      calls++;
      return create();
    }, '/mask.webp');
    expect(await load()).toBeNull();
    expect(await load()).toBeNull();
    expect(calls).toBe(1);
  }
});
