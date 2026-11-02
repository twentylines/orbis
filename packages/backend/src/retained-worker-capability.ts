export const retainedWorkerCapability = Object.freeze({
  schema: 'orbis.retained-worker-phase.v1',
  version: 1,
  phases: Object.freeze(['prepare', 'promote', 'verify', 'rollback', 'commit']),
  commitStages: Object.freeze(['authorize', 'finish']),
});
