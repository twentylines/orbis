import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { decodeRetainedCandidateResume } from './time-machine-retained-root-client';

const id = randomUUID();
const point = randomUUID();
const nonce = randomUUID();
const now = 1_900_000_000_000;
const hash = (value: string) => value.repeat(64);
const proof = () => ({
  version: 1,
  transactionId: id,
  pointId: point,
  nonce,
  state: 'activating',
  decision: 'commit',
  operationSha256: hash('a'),
  imageCaptureSha256: hash('b'),
  imageInventorySha256: hash('c'),
  expiresAt: now + 1000,
  binding: {
    restoreId: id,
    pointId: point,
    nonce,
    workerId: hash('1'),
    originalController: hash('2'),
    candidateController: hash('3'),
    verifierController: hash('4'),
    target: {
      publication: {
        schema: 'orbis.release.v1',
        image: 'ghcr.io/twentylines/orbis',
        tag: 'v0.5.0-beta.3',
        commit: 'f'.repeat(40),
        digest: `sha256:${hash('5')}`,
        runtipiCompatibility: '4.10.1',
      },
      creationReference: `sha256:${hash('6')}`,
      platform: { os: 'linux', architecture: 'arm64' },
      platformManifestDigest: `sha256:${hash('6')}`,
      configDigest: `sha256:${hash('7')}`,
    },
    migrationsPath: `/data/backups/restores/${id}/retained/migrations`,
    workerSnapshot: {},
    sourceBinding: Object.fromEntries(
      ['originalJournalSha256', 'bootstrapSha256', 'admissionSha256', 'sourceSealSha256', 'legacyManifestSha256', 'runtimeManifestSha256'].map(
        (key) => [key, hash('a')],
      ),
    ),
  },
});
it('accepts an exact, fresh root-bound candidate activation proof', () => {
  expect(decodeRetainedCandidateResume(proof(), { restoreId: id, pointId: point, now })).toMatchObject({ state: 'activating', decision: 'commit' });
});
it('rejects expired, excessive, changed or malformed candidate proofs', () => {
  const bad = [
    { ...proof(), expiresAt: now },
    { ...proof(), expiresAt: now + 900_001 },
    { ...proof(), decision: 'rollback' },
    { ...proof(), pointId: randomUUID() },
    { ...proof(), nonce: randomUUID() },
    { ...proof(), operationSha256: 'bad' },
    { ...proof(), extra: true },
    { ...proof(), binding: { ...proof().binding, candidateController: hash('2') } },
  ];
  for (const value of bad) expect(() => decodeRetainedCandidateResume(value, { restoreId: id, pointId: point, now })).toThrow();
});
