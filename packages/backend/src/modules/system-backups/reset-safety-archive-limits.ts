export const resetSafetyArchiveLimits = {
  indexBytes: 4 * 1024 ** 2,
  v2IndexBytes: 8 * 1024 ** 2,
  manifestBytes: 16 * 1024 ** 2,
  v2ManifestBytes: 32 * 1024 ** 2,
  stateBytes: 8 * 1024 ** 2 + 52,
  fileBytes: 32 * 1024 ** 2 + 52,
  targetBytes: 32 * 1024 ** 3,
  profileBytes: 2 * 1024 ** 4 + 1024 ** 3 + 4 * 1024 ** 2,
  archiveBytes: 8 * 1024 ** 4 + 128 * 1024 ** 3,
  parts: 16_097,
  v2Parts: 32_097,
  targets: 12_000,
} as const;
