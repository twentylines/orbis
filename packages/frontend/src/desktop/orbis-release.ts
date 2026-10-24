import { queryOptions } from '@tanstack/react-query';
import { gt, lte, rcompare, valid } from 'semver';

export type OrbisRelease = {
  tag: string;
  publishedAt: string | null;
  body: string;
  url: string;
  imageManifestUrl: string | null;
  kind?: 'feature' | 'maintenance';
};
export type OrbisReleaseCatalog = { releases: OrbisRelease[]; complete: boolean };
export type OrbisReleaseHistory = OrbisReleaseCatalog & { truncated: boolean; context?: OrbisRelease | null };
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

export const orbisPublishedReleasesOptions = () =>
  queryOptions({
    queryKey: ['orbis-published-releases'],
    queryFn: ({ signal }) => readSystem<OrbisReleaseCatalog>('orbis-releases', signal),
    ...checkOnEntry,
  });
export const orbisReleaseHistoryOptions = (installed: string | undefined, target: string) =>
  queryOptions({
    queryKey: ['orbis-release-history', installed, target],
    queryFn: ({ signal }) =>
      readSystem<OrbisReleaseHistory>(`orbis-release-history?${new URLSearchParams({ installed: installed ?? '', target })}`, signal),
    ...checkOnEntry,
    enabled: Boolean(installed && valid(installed) && valid(target) && gt(target, installed)),
  });

export function includedOrbisReleases(latest: OrbisRelease, installed: string | undefined, history: OrbisRelease[] = []): OrbisRelease[] {
  if (!installed || !valid(installed) || !valid(latest.tag) || !gt(latest.tag, installed)) return [latest];
  const releases = new Map(
    history
      .filter((release) => valid(release.tag) && gt(release.tag, installed) && lte(release.tag, latest.tag))
      .map((release) => [release.tag, release]),
  );
  const known = releases.get(latest.tag);
  releases.set(latest.tag, { ...latest, kind: latest.kind ?? known?.kind, publishedAt: latest.publishedAt ?? known?.publishedAt ?? null });
  return [...releases.values()].sort((a, b) => rcompare(a.tag, b.tag));
}

export type OrbisReleaseGroup = { feature: OrbisRelease | null; revisions: OrbisRelease[]; alreadyInstalled: boolean };
export function groupOrbisReleaseNotes(releases: OrbisRelease[], context?: OrbisRelease | null): OrbisReleaseGroup[] {
  const groups: OrbisReleaseGroup[] = [];
  let current: OrbisReleaseGroup = { feature: context ?? null, revisions: [], alreadyInstalled: Boolean(context) };
  for (const release of [...releases].sort((a, b) => rcompare(b.tag, a.tag))) {
    if (release.kind === 'feature') {
      if (current.feature || current.revisions.length) groups.push(current);
      current = { feature: release, revisions: [], alreadyInstalled: false };
    } else current.revisions.unshift(release);
  }
  if (current.feature || current.revisions.length) groups.push(current);
  return groups.reverse();
}
