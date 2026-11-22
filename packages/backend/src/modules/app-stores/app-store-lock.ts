export const APP_STORE_CATALOGUE_LOCK = 'app-stores/catalogue';

export const appStoreLockKey = (slug: string) => `app-stores/repository/${slug}`;

// All repository writers and package readers share this gate across service instances.
// Readers retain custody until every definition and asset has been captured in memory.
const repositoryOperations = new Map<string, Promise<unknown>>();
export async function withAppRepositoryCustody<T>(repository: string, operation: () => Promise<T>): Promise<T> {
  const previous = repositoryOperations.get(repository) ?? Promise.resolve();
  const pending = previous.catch(() => undefined).then(operation);
  repositoryOperations.set(repository, pending);
  try {
    return await pending;
  } finally {
    if (repositoryOperations.get(repository) === pending) repositoryOperations.delete(repository);
  }
}
