import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createBackupCiphertextSequenceInspector, encryptBackupStream, inspectBackupCiphertextSequence } from './backup-crypto';
import { stabilizeExistingDarwinFixtures } from './darwin-files.fixture';
let root: string;
const passphrase = 'synthetic sequence passphrase';
beforeEach(async () => {
  if (!process.env.TMPDIR) throw new Error('Project-scoped TMPDIR required');
  root = await fs.realpath(await fs.mkdtemp(path.join(process.env.TMPDIR, 'crypto-sequence-')));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true });
});
async function parts() {
  const payloads = [Buffer.alloc(0), Buffer.alloc(256 * 1024 + 7, 0x71), Buffer.from('last authenticated chunk')];
  const chunks = [];
  for (const payload of payloads) {
    const source = path.join(root, `${randomUUID()}.orbis`);
    await encryptBackupStream({
      source: Readable.from([payload]),
      plaintextBytes: payload.length,
      destination: source,
      passphrase,
      signal: AbortSignal.timeout(10000),
    });
    chunks.push({ source, plaintextBytes: payload.length });
  }
  stabilizeExistingDarwinFixtures(root);
  return { chunks, payloads };
}
it('authenticates ordered chunks and the combined original-file digest without writing plaintext', async () => {
  const { chunks, payloads } = await parts();
  const result = await inspectBackupCiphertextSequence({ chunks, passphrase, signal: AbortSignal.timeout(10000) });
  expect(result.plaintextSha256).toBe(createHash('sha256').update(Buffer.concat(payloads)).digest('hex'));
  expect(result.chunks.map((part) => part.plaintextSha256)).toEqual(payloads.map((data) => createHash('sha256').update(data).digest('hex')));
  expect(await fs.readdir(root)).toHaveLength(3);
});
it('withholds the combined digest when the final authentication tag is damaged', async () => {
  const { chunks } = await parts();
  const last = chunks[2];
  if (!last) throw new Error('Missing last chunk fixture');
  const data = await fs.readFile(last.source);
  const tag = data[data.length - 1];
  if (tag === undefined) throw new Error('Missing authentication tag fixture');
  data[data.length - 1] = tag ^ 1;
  await fs.writeFile(last.source, data);
  stabilizeExistingDarwinFixtures(root);
  await expect(inspectBackupCiphertextSequence({ chunks, passphrase, signal: AbortSignal.timeout(10000) })).rejects.toThrow();
  expect(await fs.readdir(root)).toHaveLength(3);
});
it('rejects reused source members and cancellation without deleting encrypted evidence', async () => {
  const { chunks } = await parts();
  const first = chunks[0];
  if (!first) throw new Error('Missing first chunk fixture');
  await expect(inspectBackupCiphertextSequence({ chunks: [first, first], passphrase, signal: AbortSignal.timeout(10000) })).rejects.toThrow();
  await expect(inspectBackupCiphertextSequence({ chunks, passphrase, signal: AbortSignal.abort() })).rejects.toThrow();
  expect(await fs.readdir(root)).toHaveLength(3);
});

it('keeps the original-file digest while verified chunks are released one at a time', async () => {
  const { chunks, payloads } = await parts();
  const inspector = createBackupCiphertextSequenceInspector({ passphrase, signal: AbortSignal.timeout(10000) });
  for (const chunk of chunks) {
    await inspector.add(chunk);
    await fs.unlink(chunk.source);
  }
  const result = inspector.finish();
  expect(result.plaintextSha256).toBe(createHash('sha256').update(Buffer.concat(payloads)).digest('hex'));
  expect(result.plaintextBytes).toBe(payloads.reduce((sum, data) => sum + data.length, 0));
  expect(result.chunks).toHaveLength(3);
  expect(await fs.readdir(root)).toEqual([]);
  expect(() => inspector.finish()).toThrow();
});

it('never returns a combined receipt after a later chunk fails authentication or overlaps an active read', async () => {
  const { chunks } = await parts();
  const first = chunks[0];
  const last = chunks[2];
  if (!first || !last) throw new Error('Missing sequence fixtures');
  const data = await fs.readFile(last.source);
  data[data.length - 1] = (data[data.length - 1] ?? 0) ^ 1;
  await fs.writeFile(last.source, data);
  stabilizeExistingDarwinFixtures(root);
  const damaged = createBackupCiphertextSequenceInspector({ passphrase, signal: AbortSignal.timeout(10000) });
  await damaged.add(first);
  await expect(damaged.add(last)).rejects.toThrow();
  expect(() => damaged.finish()).toThrow();
  const overlapping = createBackupCiphertextSequenceInspector({ passphrase, signal: AbortSignal.timeout(10000) });
  const pending = overlapping.add(first);
  await expect(overlapping.add(first)).rejects.toThrow();
  await expect(pending).rejects.toThrow();
  expect(() => overlapping.finish()).toThrow();
});
