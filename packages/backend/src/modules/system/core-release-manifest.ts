export const CORE_RELEASE_MANIFEST = 'release-manifest.json';
export const QUALIFIED_CORE_RELEASE_MANIFEST = 'qualified-release-manifest.json';
export const QUALIFIED_CORE_BASE = '4.12.0';

export function coreReleaseManifestUrl(tag: string, name: typeof CORE_RELEASE_MANIFEST | typeof QUALIFIED_CORE_RELEASE_MANIFEST) {
  return `https://github.com/twentylines/orbis/releases/download/${tag}/${name}`;
}

// A qualified release is intentionally absent from the legacy manifest path.
// A timeout, denial or malformed legacy manifest is never treated as absence.
export async function readCoreReleaseManifest(tag: string, read: (url: string) => Promise<string | null>) {
  for (const name of [CORE_RELEASE_MANIFEST, QUALIFIED_CORE_RELEASE_MANIFEST] as const) {
    const url = coreReleaseManifestUrl(tag, name);
    const body = await read(url);
    if (body !== null) return { url, body, qualified: name === QUALIFIED_CORE_RELEASE_MANIFEST };
  }
  return null;
}
