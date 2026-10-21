import type { GetAppDto } from '@/api-client';

type ServerAddresses = { localDomain?: string; sslPort?: number };
export type AppDestinationData = {
  app?: Pick<NonNullable<GetAppDto['app']>, 'status' | 'openPort' | 'port' | 'exposedLocal' | 'exposed' | 'domain'> | null;
  info: Pick<GetAppDto['info'], 'no_gui' | 'url_suffix' | 'https' | 'dynamic_config' | 'port'>;
  metadata: Pick<GetAppDto['metadata'], 'localSubdomain'>;
};
export function appDestinations({ app, info, metadata }: AppDestinationData, settings: ServerAddresses, hostname: string) {
  if (!app || app.status !== 'running' || info.no_gui) return [];
  const result: { label: string; url: string }[] = [];
  const tlsPort = settings.sslPort && settings.sslPort !== 443 ? `:${settings.sslPort}` : '';
  const suffix = info.url_suffix || '';
  const add = (label: string, address: string) => {
    try {
      const url = new URL(address);
      if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !result.some((item) => item.url === url.href)) {
        result.push({ label, url: url.href });
      }
    } catch {
      /* An incomplete saved address is not a launch destination. */
    }
  };
  if (app.openPort || !info.dynamic_config) {
    const host = hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname;
    add('Server address', `${info.https ? 'https' : 'http'}://${host}:${app.port ?? info.port}${suffix}`);
  }
  if (app.exposedLocal && metadata.localSubdomain && settings.localDomain)
    add('Local domain', `https://${metadata.localSubdomain}.${settings.localDomain}${tlsPort}${suffix}`);
  if (app.exposed && app.domain) add('Domain', `https://${app.domain}${tlsPort}${suffix}`);
  return result;
}
