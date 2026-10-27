import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { isPublishedOrbisReleaseTag, isStableOrbisReleaseTag } from '@runtipi/common/schemas/orbis-release-channel';
import { valid } from 'semver';

export const RELEASE_DIGEST = /^sha256:[a-f0-9]{64}$/;

export type PublishedReleaseManifest = {
  tag: string;
  commit: string;
  digest: string;
  runtipiCompatibility: string;
  dataCompatibility: unknown;
  migrationFingerprint: unknown;
  accountIdentifierCompatibility: unknown;
};

export function publishedReleaseManifest(raw: unknown, tag: string): PublishedReleaseManifest {
  const value = raw as Record<string, unknown> | null;
  if (
    !value ||
    Array.isArray(value) ||
    value.schema !== 'orbis.release.v1' ||
    value.tag !== tag ||
    value.image !== 'ghcr.io/twentylines/orbis' ||
    typeof value.commit !== 'string' ||
    !/^[a-f0-9]{40}$/.test(value.commit) ||
    typeof value.digest !== 'string' ||
    !RELEASE_DIGEST.test(value.digest) ||
    value.installationProtocol !== 'orbis.installation-state.v1'
  ) {
    throw new BadRequestException('This release does not support a verified Orbis downgrade or update review.');
  }
  if ('releaseChannel' in value && value.releaseChannel !== (isStableOrbisReleaseTag(tag) ? 'stable' : 'nightly'))
    throw new BadRequestException('The release channel does not match its verified version.');
  if ('updatePriority' in value && !['normal', 'critical'].includes(value.updatePriority as string))
    throw new BadRequestException('The published update priority is invalid.');
  if (typeof value.runtipiCompatibility !== 'string' || !valid(value.runtipiCompatibility)) {
    throw new BadRequestException('The published Runtipi version could not be verified.');
  }
  return {
    tag,
    commit: value.commit,
    digest: value.digest,
    runtipiCompatibility: value.runtipiCompatibility.replace(/^v/, ''),
    dataCompatibility: value.dataCompatibility,
    migrationFingerprint: value.migrationFingerprint,
    accountIdentifierCompatibility: value.accountIdentifierCompatibility,
  };
}

export async function fetchPublishedReleaseManifest(tag: unknown): Promise<PublishedReleaseManifest> {
  if (!isPublishedOrbisReleaseTag(tag) || !valid(tag)) {
    throw new BadRequestException('Choose a published Orbis release tag.');
  }
  let raw: unknown;
  try {
    const response = await fetch(`https://github.com/twentylines/orbis/releases/download/${tag}/release-manifest.json`, {
      signal: AbortSignal.timeout(12_000),
      headers: { 'User-Agent': 'Orbis-update-center/1' },
    });
    if (!response.ok || !response.body) throw new Error('Release unavailable');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 16 * 1024) throw new Error('Release manifest exceeded its limit');
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel();
    }
    raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ServiceUnavailableException('The published release manifest could not be verified. Try again later.');
  }
  return publishedReleaseManifest(raw, tag);
}
