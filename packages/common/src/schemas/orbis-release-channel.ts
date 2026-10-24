export type OrbisReleaseChannel = 'stable' | 'nightly';

export const orbisReleaseChannelStatus = {
  phase: 'beta',
  current: 'stable',
  channels: [
    { id: 'stable', available: true },
    { id: 'nightly', available: false },
  ],
} as const;

export type OrbisReleaseChannelStatus = typeof orbisReleaseChannelStatus;

export function isStableOrbisReleaseTag(tag: string): boolean {
  return /^v[0-9]+\.[0-9]+\.[0-9]+(?:[-.][0-9A-Za-z.-]+)?$/.test(tag) && !/(?:^|[.-])(?:nightly|dev|alpha)(?:[.-]|$)/i.test(tag);
}
