import { useOptionalCluster } from './cluster';

export function useServerPath() {
  const selectedServer = useOptionalCluster()?.selectedServer;
  return (path: string) => {
    if (!selectedServer || selectedServer.local) return path;
    const [pathname, query] = path.split('?');
    const resource = pathname?.replace('/api/system/', '');
    return `/api/cluster/servers/${encodeURIComponent(selectedServer.id)}/read/${resource}${query ? `?${query}` : ''}`;
  };
}
