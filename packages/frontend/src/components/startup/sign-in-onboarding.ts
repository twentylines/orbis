export async function firstSetupAfterSignIn(
  fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = fetch,
): Promise<boolean | undefined> {
  try {
    const response = await fetcher('/api/desktop-preferences/onboarding', {
      credentials: 'include',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return undefined;
    const value: unknown = await response.json();
    if (!value || typeof value !== 'object' || !('complete' in value) || typeof value.complete !== 'boolean') return undefined;
    return !value.complete;
  } catch {
    return undefined;
  }
}

export function showSetupSpace(firstSetup: boolean, transition: string | null, operation: string | null, themeHandoff: boolean) {
  return firstSetup && transition !== 'preparing-orbis' && transition !== 'logging-out' && !operation && !themeHandoff;
}
