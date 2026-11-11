import type { AppContextDto } from '@/api-client';
import { appContextQueryKey } from '@/api-client/@tanstack/react-query.gen';
import type { QueryClient } from '@tanstack/react-query';

export function patchAppContext(client: QueryClient, patch: Partial<AppContextDto>, fallback: AppContextDto) {
  client.setQueryData<AppContextDto>(appContextQueryKey(), (current) => ({ ...(current ?? fallback), ...patch }));
}
