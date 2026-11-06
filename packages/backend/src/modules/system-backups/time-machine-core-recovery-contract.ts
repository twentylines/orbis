export const coreSentinelRecoveryCapability = Object.freeze({
  schema: 'orbis.core-capture-sentinel-recovery-capability.v1',
  version: 1,
  pointVersion: 3,
  sourceHoldVersion: 2,
  publisher: 'sentinel.v1',
  publisherRecordVersion: 1,
  operations: Object.freeze(['download', 'adopt', 'continue']),
  lifecycleAuthority: false,
});
