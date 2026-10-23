import { queryOptions } from '@tanstack/react-query';
import { gt, valid } from 'semver';

export type OrbisRelease = { tag: string; publishedAt: string | null; body: string; url: string; imageManifestUrl: string | null };
type OrbisBuild = { version: string; commit: string | null; imageDigest: string | null; runtipiCompatibility: string | null };

async function readSystem<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(`/api/system/${path}`, {
    credentials: 'same-origin',
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
  });
  if (!response.ok) throw new Error(`Orbis ${path} check failed (${response.status})`);
  return response.json();
}
const checkOnEntry = {
  staleTime: Number.POSITIVE_INFINITY,
  refetchOnMount: false,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  retry: false,
} as const;
export const installedOrbisBuildOptions = () =>
  queryOptions({
    queryKey: ['orbis-installed-build'],
    queryFn: ({ signal }) => readSystem<OrbisBuild>('build', signal),
    ...checkOnEntry,
  });
export const orbisReleasesOptions = () =>
  queryOptions({
    queryKey: ['orbis-github-releases'],
    queryFn: async ({ signal }) => {
      const release = await readSystem<OrbisRelease | null>('orbis-release', signal);
      return release ? [release] : [];
    },
    ...checkOnEntry,
  });
export function newerOrbisRelease(release: OrbisRelease | undefined, installed: string | undefined) {
  return Boolean(release?.imageManifestUrl && valid(release.tag) && installed && valid(installed) && gt(release.tag, installed));
}
