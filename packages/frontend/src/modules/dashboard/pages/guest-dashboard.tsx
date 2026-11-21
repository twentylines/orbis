import type { GuestAppsDto } from '@/api-client';
import { getGuestAppsOptions, getGuestLinksOptions } from '@/api-client/@tanstack/react-query.gen';
import { EmptyPage } from '@/components/empty-page/empty-page';
import { GuestHeader } from '@/components/header/guest-header';
import { BaseDashboardLayout } from '@/components/layouts/dashboard/base-dashboard-layout';
import { Button } from '@/components/ui/Button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/DropdownMenu';
import { useUserContext } from '@/context/user-context';
import { appDestinations } from '@/desktop/app-destinations';
import { AppTile } from '@/modules/app/components/app-tile/app-tile';
import { useQuery } from '@tanstack/react-query';
import '@/styles/app-grid.css';
import { GuestLinkTile } from '../components/guest-link-tile';
import './guest-dashboard.css';

const Tile = ({ data, localDomain, sslPort }: { data: GuestAppsDto['installed'][number]; localDomain: string; sslPort: number }) => {
  const { info, app } = data;
  const destinations = appDestinations(data, { localDomain, sslPort }, window.location.hostname);
  const tile = <AppTile info={info} status={app.status} updateAvailable={false} />;

  if (destinations.length === 0) {
    return (
      <div className="app-link guest-app-tile">
        {tile}
        <div className="guest-app-unavailable">No launch address available</div>
      </div>
    );
  }

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button type="button" className="app-link guest-app-trigger" aria-label={`Open ${info.name}`}>
          {tile}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuGroup>
          {destinations.map(({ url }) => (
            <DropdownMenuItem key={url} onSelect={() => window.open(url, '_blank', 'noopener,noreferrer')}>
              {new URL(url).host}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

function GuestListFeedback({ label, pending, failed, retry }: { label: string; pending: boolean; failed: boolean; retry: () => void }) {
  if (pending) return <output className="guest-list-feedback">Loading shared {label}…</output>;
  if (!failed) return null;
  return (
    <div className="guest-list-feedback">
      <p role="alert">Could not load shared {label}.</p>
      <Button type="button" variant="outline" onClick={retry}>
        Retry {label}
      </Button>
    </div>
  );
}

export const GuestDashboard = () => {
  const { localDomain, sslPort } = useUserContext();
  const apps = useQuery({ ...getGuestAppsOptions(), networkMode: 'always' });
  const links = useQuery({ ...getGuestLinksOptions(), networkMode: 'always' });
  const installed = apps.isSuccess ? apps.data.installed : [];
  const savedLinks = links.isSuccess ? links.data.links : [];

  return (
    <BaseDashboardLayout header={<GuestHeader />} showPageHeader={false}>
      <section className="guest-applications-card" aria-labelledby="guest-applications-title">
        <h1 id="guest-applications-title" className="guest-dashboard-title">
          Applications
        </h1>
        <GuestListFeedback
          label="applications"
          pending={apps.isFetching && !apps.isSuccess}
          failed={apps.isError}
          retry={() => void apps.refetch()}
        />
        <GuestListFeedback label="links" pending={links.isFetching && !links.isSuccess} failed={links.isError} retry={() => void links.refetch()} />
        {apps.isSuccess && links.isSuccess && installed.length === 0 && savedLinks.length === 0 && (
          <EmptyPage title="GUEST_DASHBOARD_NO_APPS" subtitle="GUEST_DASHBOARD_NO_APPS_SUBTITLE" />
        )}
        <div className="guest-applications-list">
          {installed.map((appData) => (
            <Tile key={appData.app.id} data={appData} localDomain={localDomain} sslPort={sslPort} />
          ))}
          {savedLinks.map((link) => (
            <GuestLinkTile key={link.id} link={link} />
          ))}
        </div>
      </section>
    </BaseDashboardLayout>
  );
};
