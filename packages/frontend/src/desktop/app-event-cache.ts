export function appEventAffectsQuery(key: readonly unknown[], urns: ReadonlySet<string>, catalogue: boolean, reconnect = false) {
  const first = key[0];
  if (typeof first === 'string') {
    if (['tasks', 'container-telemetry', 'docker-apps'].includes(first)) return true;
    return first === 'cluster-server' && ['apps', 'docker-apps', 'containers'].includes(String(key[2]));
  }
  if (!first || typeof first !== 'object') return false;
  const query = first as { _id?: string; path?: { urn?: string } };
  if (query._id === 'getInstalledApps' || query._id === 'appContext') return true;
  if (catalogue && query._id === 'searchApps') return true;
  return typeof query.path?.urn === 'string' && (reconnect || urns.has(query.path.urn));
}
