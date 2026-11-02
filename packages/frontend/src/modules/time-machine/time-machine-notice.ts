type NoticeStorage = Pick<Storage, 'getItem' | 'setItem'>;

const seenInMemory = new Set<string>();

export function timeMachineNoticeKey(userId: string | number, serverOrigin: string) {
  return `orbis:time-machine:first-open:v1:${encodeURIComponent(serverOrigin)}:${userId}`;
}

function browserStorage(): NoticeStorage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function hasSeenTimeMachineNotice(userId: string | number, serverOrigin: string, storage = browserStorage()) {
  const key = timeMachineNoticeKey(userId, serverOrigin);
  if (seenInMemory.has(key)) return true;
  try {
    return storage?.getItem(key) === 'seen';
  } catch {
    return false;
  }
}

export function markTimeMachineNoticeSeen(userId: string | number, serverOrigin: string, storage = browserStorage()) {
  const key = timeMachineNoticeKey(userId, serverOrigin);
  seenInMemory.add(key);
  try {
    storage?.setItem(key, 'seen');
  } catch {
    // Keep the dismissal for this browser session if persistent storage is unavailable.
  }
}
