import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { migrationOperationSchema } from './app-migration-journal';

const h = (letter: string) => letter.repeat(64);
const operation = (appUrn: string) => ({
  version: 1,
  requestId: randomUUID(),
  stageId: randomUUID(),
  appUrn,
  appId: 1,
  createdAt: 1,
  fromVersion: 1,
  toVersion: 2,
  previousLedger: { baselined: true, migrationIds: [] },
  originalContainers: [],
  images: [
    {
      migrationId: 'one',
      sourceSha256: h('a'),
      definitionSha256: h('b'),
      imageId: `sha256:${h('c')}`,
      reference: `fixture@sha256:${h('d')}`,
      platform: 'linux/amd64',
    },
  ],
});
describe('migration operation application identifiers', () => {
  it.each([
    'demo:store',
    'demo:_user',
    'demo:_private',
    'Demo:My_store',
    '-demo:store',
    'demo.v1:store-1',
    'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx:store',
    'demo:ssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssss',
  ])('retains the complete supported identifier %s', (urn) => {
    expect(migrationOperationSchema.assert(operation(urn)).appUrn).toBe(urn);
  });
  it.each([
    '.:store',
    '..:store',
    'demo:..',
    'demo:.store',
    'demo:store/other',
    'demo:store\\other',
    'demo:store:other',
    'demo:/store',
    'demo:store\u0000',
    'demo:\nstore',
    '\u00e9:store',
    'demo:%2e%2e',
    'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx:store',
    'demo:sssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssss',
    'demo:',
    ':store',
    'demo:store\n',
    'demo:store\r',
    'demo:store\r\n',
    'demo:store\u2028',
    'demo:store\u2029',
  ])('refuses traversal, ambiguous or oversized identifiers %s', (urn) => {
    expect(migrationOperationSchema.allows(operation(urn))).toBe(false);
  });
});
