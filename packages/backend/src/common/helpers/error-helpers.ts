export function isRecoveryKeyHandoffPath(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const url = value.replace(/^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+/i, '');
  if (!url.startsWith('/') && !/^https?:\/\//i.test(url)) return false;
  try {
    const pathname = decodeURIComponent(new URL(url, 'http://orbis.invalid').pathname);
    return /^\/(?:api\/)?system\/sentinel\/enrollment\/(?:save-key|confirm-key)\/?$/i.test(pathname);
  } catch {
    return false;
  }
}
