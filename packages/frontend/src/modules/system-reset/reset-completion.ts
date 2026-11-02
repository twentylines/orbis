import { preferenceStorageKey } from '@/desktop/appearance-cache';
import { themePackCacheKey } from '@/modules/theme-packs/theme-pack-cache';
import {
  clearAcceptedReset,
  hasAcceptedReset,
  operationAllowsDeparture,
  type OperationSnapshot,
} from '@/components/recovery-progress/operation-status';
import {
  decodeOperationContinuity,
  operationContinuityStorage,
  operationContinuityStorageName,
} from '@/components/recovery-progress/operation-continuity';
import type { AcceptedReset } from './reset-api';

const completionKey = 'orbis-reset-completion-v1';
type CompletionStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type CompletionReceipt = { version: 1; id: string; acceptedAt: number; previous: string | null };
let memoryReceipt: CompletionReceipt | null = null;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export function rememberResetCompletion(receipt: AcceptedReset, storage = operationContinuityStorage(), now = Date.now()) {
  if (receipt.state !== 'resetting' || !uuid.test(receipt.id)) return;
  let previous: string | null = null;
  try {
    const raw = storage?.getItem(operationContinuityStorageName) ?? null;
    if (decodeOperationContinuity(raw, now)) previous = raw;
  } catch {
    /* Unreadable browser state never authorizes its removal. */
  }
  memoryReceipt = { version: 1, id: receipt.id, acceptedAt: now, previous };
  try {
    storage?.setItem(completionKey, JSON.stringify(memoryReceipt));
  } catch {
    /* The accepted response remains bound in this document. */
  }
}
function completionReceipt(storage: CompletionStorage, now: number): CompletionReceipt | null {
  try {
    const raw = storage.getItem(completionKey);
    if (!raw || raw.length > 1024) return memoryReceipt;
    const value = JSON.parse(raw) as CompletionReceipt;
    if (
      Object.keys(value).sort().join(',') !== 'acceptedAt,id,previous,version' ||
      value.version !== 1 ||
      !uuid.test(value.id) ||
      !Number.isSafeInteger(value.acceptedAt) ||
      value.acceptedAt <= 0 ||
      value.acceptedAt > now ||
      (value.previous !== null && !decodeOperationContinuity(value.previous, value.acceptedAt))
    )
      return null;
    return value;
  } catch {
    return memoryReceipt;
  }
}
export function clearCompletedResetContinuity(authority: OperationSnapshot, resetId: string, storage: CompletionStorage, now = Date.now()) {
  if (!operationAllowsDeparture(authority)) return false;
  const receipt = completionReceipt(storage, now);
  if (!receipt || receipt.id !== resetId || (!hasAcceptedReset(storage) && memoryReceipt?.id !== receipt.id)) return false;
  try {
    const current = storage.getItem(operationContinuityStorageName);
    if (receipt.previous !== null && current === receipt.previous) {
      storage.removeItem(operationContinuityStorageName);
      if (storage.getItem(operationContinuityStorageName) !== null) return false;
    }
    storage.removeItem(completionKey);
    clearAcceptedReset(storage);
    memoryReceipt = null;
    return true;
  } catch {
    return false;
  }
}

export function resetCompletion(clearPreferences: () => void, navigate: () => void) {
  let navigating = false;
  return () => {
    if (navigating) return;
    navigating = true;
    try {
      clearPreferences();
    } catch {
      // Stored browser preferences must not prevent reopening setup.
    }
    try {
      navigate();
    } catch (failure) {
      navigating = false;
      throw failure;
    }
  };
}

const finishResetOnboarding = resetCompletion(
  () => {
    for (const key of [preferenceStorageKey, themePackCacheKey]) {
      try {
        localStorage.removeItem(key);
      } catch {
        // Server preferences remain authoritative if storage is unavailable.
      }
    }
  },
  () => {
    window.location.replace('/');
    clearAcceptedReset();
  },
);
export function openResetOnboarding(authority: OperationSnapshot) {
  if (!operationAllowsDeparture(authority)) return false;
  const storage = operationContinuityStorage();
  const receipt = storage ? completionReceipt(storage, Date.now()) : null;
  if (storage && receipt && !clearCompletedResetContinuity(authority, receipt.id, storage)) return false;
  finishResetOnboarding();
  return true;
}
