import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { retainedWorkerCapability } from '../../retained-worker-capability';

it('declares the connected retained phases and protected app-engine contract', async () => {
  expect(retainedWorkerCapability).toEqual({
    schema: 'orbis.retained-worker-phase.v1',
    version: 1,
    phases: ['prepare', 'promote', 'verify', 'rollback', 'commit'],
    commitStages: ['authorize', 'finish'],
  });
  expect(Object.isFrozen(retainedWorkerCapability)).toBe(true);
  expect(Object.isFrozen(retainedWorkerCapability.phases)).toBe(true);
  expect(Object.isFrozen(retainedWorkerCapability.commitStages)).toBe(true);
  const engine = JSON.parse(await readFile(path.resolve('src/retained-app-engine-capability.json'), 'utf8'));
  expect(engine).toEqual({
    schema: 'orbis.retained-app-engine.v1',
    version: 1,
    authority: 'root-candidate-app-result.v1',
    execution: 'verify-only-root-engine.v1',
    ordinaryMutationsHeld: true,
    normalBootstrap: 'idempotent-after-root-settlement.v1',
  });
  const dockerfile = await readFile(path.resolve('../../Dockerfile'), 'utf8');
  expect(dockerfile).toContain(
    'COPY --from=builder /app/packages/backend/src/retained-app-engine-capability.json ./retained-app-engine-capability.json',
  );
});
