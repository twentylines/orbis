import { client } from './api-client/client.gen';
import { TranslatableError } from './types/error.types';

client.interceptors.response.use(async (response) => {
  if (response.status >= 400) {
    const data = await response.json();
    throw new TranslatableError(data.message, data.intlParams ?? {});
  }

  return response;
});

client.setConfig({
  credentials: 'include',
  throwOnError: true,
});
