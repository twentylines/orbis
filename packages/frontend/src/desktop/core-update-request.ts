let activeRequests = 0;

// This protects the current page from chunk-recovery reloads. It never grants
// update authority or retries an operation whose acknowledgement was lost.
export const coreUpdateRequestPending = () => activeRequests > 0;

export async function duringCoreUpdateRequest<T>(request: () => Promise<T>): Promise<T> {
  activeRequests += 1;
  try {
    return await request();
  } finally {
    activeRequests -= 1;
  }
}
