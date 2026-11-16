import { createHash } from 'node:crypto';
import { canonicalPublicationJson } from '../host-updates/host-controller-publication';
import type { StoredTimeMachinePoint } from './time-machine-store';
import type { StoredComponentsPoint } from './time-machine-components-store';

export type ResetCaptureInventoryEntry = Readonly<{
  kind: 'core' | 'components';
  id: string;
  sourceOwnerId: number;
  effectiveOwnerId: number | null;
  version: 1 | 2 | 3 | 4;
  status: StoredTimeMachinePoint['status'];
  metadataSha256: string;
}>;
export type ResetCaptureInventory = Readonly<{
  resetId: string;
  accounts: 'keep' | 'remove';
  sha256: string;
  captures: readonly ResetCaptureInventoryEntry[];
}>;

/** Keeps namespace and original encryption owner distinct, including legacy and unclaimed captures. */
export function resetCaptureInventoryEntry(
  kind: ResetCaptureInventoryEntry['kind'],
  point: StoredTimeMachinePoint | StoredComponentsPoint,
  effectiveOwnerId: number | null,
): ResetCaptureInventoryEntry {
  if (
    !Number.isSafeInteger(point.ownerId) ||
    point.ownerId < 1 ||
    (effectiveOwnerId !== null && (!Number.isSafeInteger(effectiveOwnerId) || effectiveOwnerId < 1))
  )
    throw new Error('Reset capture inventory ownership could not be verified.');
  return Object.freeze({
    kind,
    id: point.id,
    sourceOwnerId: point.ownerId,
    effectiveOwnerId,
    version: point.version,
    status: point.status,
    metadataSha256: createHash('sha256').update('orbis-reset-capture-metadata-v1\n').update(canonicalPublicationJson({ kind, point })).digest('hex'),
  });
}

export function resetCaptureInventory(resetId: string, accounts: 'keep' | 'remove', entries: ResetCaptureInventoryEntry[]): ResetCaptureInventory {
  const captures = Object.freeze([...entries].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)));
  return Object.freeze({
    resetId,
    accounts,
    captures,
    sha256: createHash('sha256')
      .update('orbis-reset-preplan-capture-inventory-v1\n')
      .update(canonicalPublicationJson({ resetId, accounts, captures }))
      .digest('hex'),
  });
}
