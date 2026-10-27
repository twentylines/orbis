export const fullBackupLimits = {
  entries: 250_000,
  pathBytes: 32 * 1024 * 1024,
  manifestBytes: 64 * 1024 * 1024,
  reserveBytes: 256 * 1024 * 1024,
  reserveInodes: 64,
} as const;
