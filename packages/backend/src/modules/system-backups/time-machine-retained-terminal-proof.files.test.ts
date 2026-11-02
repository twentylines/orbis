import { createHash, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { canonicalPublicationJson } from '../host-updates/host-controller-publication';
import { decodeRetainedTerminalProof } from './time-machine-retained-root-client';

it('accepts only a bound, internally consistent protected terminal proof', () => {
  const expected = { restoreId: randomUUID(), pointId: randomUUID() };
  const sourceBinding = Object.fromEntries(
    ['originalJournalSha256', 'bootstrapSha256', 'admissionSha256', 'sourceSealSha256', 'legacyManifestSha256', 'runtimeManifestSha256'].map(
      (key) => [key, 'a'.repeat(64)],
    ),
  );
  const body = {
    schema: 'orbis.retained-terminal-proof.v1',
    version: 1,
    transactionId: expected.restoreId,
    pointId: expected.pointId,
    state: 'rolled-back',
    decision: 'rollback',
    admissionSha256: 'a'.repeat(64),
    sourceBinding,
    binding: null,
    nodePhase: 'staging',
    nodeJournalSha256: 'b'.repeat(64),
    operationSha256: null,
    survivor: { id: 'c'.repeat(64), imageId: `sha256:${'d'.repeat(64)}`, definitionSha256: 'e'.repeat(64), role: 'original' },
    database: {
      containerId: 'f'.repeat(64),
      imageId: `sha256:${'1'.repeat(64)}`,
      name: 'fixture',
      user: 'fixture',
      oid: 1,
      marker: null,
      connectionSha256: '2'.repeat(64),
      environmentSha256: '3'.repeat(64),
    },
    retired: [],
  };
  const sign = (value: object) => ({
    ...value,
    proofSha256: createHash('sha256')
      .update(
        `orbis.retained-terminal-proof.v1\n${canonicalPublicationJson(value).replace(/[\u007f-\uffff]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)}`,
      )
      .digest('hex'),
  });
  expect(decodeRetainedTerminalProof(sign(body), expected)).toMatchObject({ state: 'rolled-back' });
  expect(decodeRetainedTerminalProof(sign({ ...body, database: { ...body.database, marker: 'fixture-é' } }), expected)).toMatchObject({
    state: 'rolled-back',
  });
  expect(() => decodeRetainedTerminalProof({ ...sign(body), nodePhase: 'completed' }, expected)).toThrow();
  expect(() => decodeRetainedTerminalProof(sign({ ...body, state: 'complete', decision: 'commit', nodePhase: 'completed' }), expected)).toThrow();
  expect(() => decodeRetainedTerminalProof(sign(body), { ...expected, pointId: randomUUID() })).toThrow();
  expect(() => decodeRetainedTerminalProof({ ...sign(body), unexpected: true }, expected)).toThrow();
});
