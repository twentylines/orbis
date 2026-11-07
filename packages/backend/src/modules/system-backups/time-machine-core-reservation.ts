import { createHash } from 'node:crypto';
import { canonicalPublicationJson } from '../host-updates/host-controller-publication';

export function coreCapturePointReservationSha256(point: { version: 3; id: string; ownerId: number; createdAt: number; envelope: unknown }) {
  return createHash('sha256')
    .update(
      canonicalPublicationJson({
        version: point.version,
        id: point.id,
        ownerId: point.ownerId,
        createdAt: point.createdAt,
        envelope: point.envelope,
      }),
    )
    .digest('hex');
}
