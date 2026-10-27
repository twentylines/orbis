export type OrbisReleaseChannel = 'stable' | 'nightly';

export type OrbisReleaseChannelStatus = {
  phase: 'development';
  current: OrbisReleaseChannel;
  revision: string;
  installedVersion: string | null;
  requiresStableInstall: boolean;
  channels: Array<{ id: OrbisReleaseChannel; available: boolean }>;
};

export const orbisReleaseChannelStatus: OrbisReleaseChannelStatus = {
  phase: 'development',
  current: 'stable',
  revision: 'initial',
  installedVersion: null,
  requiresStableInstall: false,
  channels: [
    { id: 'stable', available: true },
    { id: 'nightly', available: true },
  ],
};

export function parseOrbisVersion(value: unknown) {
  if (typeof value !== 'string' || value.length > 80) return null;
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(beta|rc)\.(0|[1-9]\d*))?$/.exec(value);
  if (!match) return null;
  const numbers = [Number(match[1]), Number(match[2]), Number(match[3])];
  const iteration = match[5] === undefined ? null : Number(match[5]);
  if (!numbers.every(Number.isSafeInteger) || (iteration !== null && !Number.isSafeInteger(iteration))) return null;
  return { base: numbers.join('.'), numbers, prerelease: (match[4] as 'beta' | 'rc' | undefined) ?? null, iteration };
}

export function isPublishedOrbisReleaseTag(tag: unknown): tag is string {
  return typeof tag === 'string' && tag.startsWith('v') && parseOrbisVersion(tag) !== null;
}

export function isStableOrbisReleaseTag(tag: string): boolean {
  return isPublishedOrbisReleaseTag(tag) && parseOrbisVersion(tag)?.prerelease === null;
}

export function releaseAllowedOnChannel(tag: unknown, channel: OrbisReleaseChannel): boolean {
  return isPublishedOrbisReleaseTag(tag) && (channel === 'nightly' || (channel === 'stable' && isStableOrbisReleaseTag(tag)));
}

export function orbisVersionOrder(first: string, second: string): number | null {
  const a = parseOrbisVersion(first);
  const b = parseOrbisVersion(second);
  if (!a || !b) return null;
  for (const index of [0, 1, 2]) {
    const delta = (a.numbers[index] as number) - (b.numbers[index] as number);
    if (delta) return Math.sign(delta);
  }
  const rank = { beta: 0, rc: 1, stable: 2 };
  const stage = rank[a.prerelease ?? 'stable'] - rank[b.prerelease ?? 'stable'];
  return stage ? Math.sign(stage) : Math.sign((a.iteration ?? 0) - (b.iteration ?? 0));
}

export function downgradeAllowedOnChannel(target: unknown, installed: unknown, channel: OrbisReleaseChannel): boolean {
  if (typeof installed !== 'string' || !releaseAllowedOnChannel(target, channel)) return false;
  const current = parseOrbisVersion(installed);
  const candidate = parseOrbisVersion(target);
  if (!current || !candidate || orbisVersionOrder(target as string, installed) !== -1) return false;
  return candidate.prerelease === null || (channel === 'nightly' && candidate.base === current.base);
}
