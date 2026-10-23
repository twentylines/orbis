import { Link, useNavigate } from 'react-router';
import { getInstalledAppsOptions, getLinksOptions } from '@/api-client/@tanstack/react-query.gen';
import { EmptyPage } from '@/components/empty-page/empty-page';
import type { CustomLink } from '@/types/app.types';
import { useSuspenseQuery } from '@tanstack/react-query';
import { AppTile } from '../components/app-tile/app-tile';
import { LinkTile } from '../components/link-tile/link-tile';
import { ButtonTile } from '../components/button-tile/button-tile';
import { IconAdjustmentsHorizontal, IconChevronDown, IconLayoutGridAdd, IconLinkPlus } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { useDisclosure } from '@/lib/hooks/use-disclosure';
import { AddLinkDialog } from '../components/dialogs/add-link/add-link-dialog';
import '@/styles/app-grid.css';
import { useAppContext } from '@/context/app-context';
import { ActionBar } from '@/components/action-bar/action-bar';
import clsx from 'clsx';
import { RestartAllButton, StartAllButton, StopAllButton } from '../components/batch-actions-dialog/batch-actions-dialog';
import { useContainerTelemetry } from '@/desktop/containers';
import { DockerAppsSection } from '../components/docker-apps/docker-apps';
import { useAppLauncher, useOpenedApps } from '@/desktop/app-launcher';
import { selectLibraryApps } from '@/desktop/app-library';
import { AppLibraryControls, useLibraryFilters } from '@/desktop/app-library-controls';
import { useWindowVisible } from '@/desktop/window-visibility';
import { useCluster } from '@/desktop/cluster';
import { ClusterApps } from '@/desktop/cluster-views';

export default () => {
  const cluster = useCluster();
  if (cluster.merged || (cluster.selectedServer && !cluster.selectedServer.local)) return <ClusterApps />;
  return <LocalApps />;
};

function LocalApps() {
  const { filters, change } = useLibraryFilters();
  const opened = useOpenedApps();
  const visible = useWindowVisible();
  const openApp = useAppLauncher();
  const containers = useContainerTelemetry();
  const { data: apps } = useSuspenseQuery({
    ...getInstalledAppsOptions(),
    refetchInterval: visible ? 15000 : false,
    refetchIntervalInBackground: false,
  });

  const { data: links } = useSuspenseQuery({
    ...getLinksOptions(),
  });

  const { updatesAvailable } = useAppContext();

  const addLinkDisclosure = useDisclosure();
  const navigate = useNavigate();
  const { t } = useTranslation();

  const { installed } = apps;
  const { links: customLinks = [] } = links;
  const matching = selectLibraryApps(
    installed.map((entry) => ({
      key: entry.info.urn,
      name: entry.info.name,
      categories: entry.info.categories,
      installedAt: entry.app.createdAt * 1000,
      searchText: entry.info.short_desc,
      entry,
    })),
    filters,
    opened,
  );
  const matchingLinks = selectLibraryApps(
    customLinks.map((entry) => ({ key: `link:${entry.id}`, name: entry.title, searchText: entry.description ?? undefined, entry })),
    filters,
    opened,
  );

  const renderApp = ({ info, app, metadata }: (typeof installed)[number]) => {
    const versionIsIgnored = app.ignoredVersion === metadata.latestVersion;
    const updateAvailable = Number(app.version) < Number(metadata.latestVersion) && !versionIsIgnored;

    const [appName, storeId] = info.urn.split(':');

    return (
      <Link
        key={app.id}
        to={`/apps/${storeId}/${appName}`}
        className="col-sm-6 col-lg-4 app-link p-2 pt-0 pb-0 mb-0"
        onClick={(event) => {
          if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0 && openApp(info)) event.preventDefault();
        }}
      >
        <AppTile
          key={info.urn}
          status={app.status}
          info={info}
          updateAvailable={updateAvailable}
          pendingRestart={app.pendingRestart}
          recentlyInstalled={app.createdAt * 1000 > Date.now() - 7 * 86400000}
          docker={{ data: containers.data, stale: containers.isError }}
        />
      </Link>
    );
  };

  const renderLink = (link: CustomLink) => {
    return (
      <Link key={link.id} to={link.url} target="_blank" className="col-sm-6 col-lg-4 app-link p-2 pt-0 pb-0 mb-0">
        <LinkTile key={link.id} link={link} />
      </Link>
    );
  };

  const library = (
    <div key="library" className="orbis-managed-apps">
      <AppLibraryControls filters={filters} change={change} categories={installed.flatMap(({ info }) => info.categories ?? [])} />
      <output className="app-library-results">
        {matching.length} of {installed.length} apps{matchingLinks.length ? ` · ${matchingLinks.length} links` : ''}
      </output>
      <details className={clsx('desktop-batch-controls', { 'd-none': installed.length <= 1 })}>
        <summary>
          <IconAdjustmentsHorizontal size={17} aria-hidden="true" />
          Manage Orbis apps
          <IconChevronDown size={15} aria-hidden="true" />
        </summary>
        <ActionBar>
          <ActionBar.Left>
            <StartAllButton availableUpdates={updatesAvailable} />
          </ActionBar.Left>
          <ActionBar.Center>
            <StopAllButton availableUpdates={updatesAvailable} />
          </ActionBar.Center>
          <ActionBar.Right>
            <RestartAllButton availableUpdates={updatesAvailable} />
          </ActionBar.Right>
        </ActionBar>
      </details>
      {installed.length === 0 && customLinks.length === 0 ? (
        <EmptyPage
          title="No apps in the Orbis library"
          subtitle="Install an app or add a custom app. Other Docker apps are listed separately."
          redirectPath="/app-store"
          actionLabel="MY_APPS_EMPTY_ACTION"
          extraContent={
            <div className="d-flex flex-column flex-sm-row gap-2 justify-content-center">
              <ButtonTile
                title={t('CUSTOM_APP_ADD_TITLE')}
                subtitle={t('CUSTOM_APP_ADD_SUBTITLE')}
                action={() => navigate('/apps/create')}
                icon={<IconLayoutGridAdd size={50} stroke={1.5} color="#A4A4A4" />}
                className="col-12 col-sm-6 col-lg-6 col-lg-6"
              />
              <ButtonTile
                title={t('LINKS_ADD_TITLE')}
                subtitle={t('LINKS_ADD_SUBTITLE')}
                action={() => addLinkDisclosure.open()}
                icon={<IconLinkPlus size={50} stroke={1.5} color="#A4A4A4" />}
                className="col-12 col-sm-6 col-md-6 col-lg-6"
              />
            </div>
          }
        />
      ) : (
        <div className="row row-cards desktop-installed-grid" data-testid="apps-list">
          {matching.map(({ entry }) => renderApp(entry))}
          {matchingLinks.map(({ entry }) => renderLink(entry))}
          {matching.length + matchingLinks.length === 0 ? (
            <p className="app-library-empty">No apps match these filters. Clear the search or choose another category.</p>
          ) : null}
          <ButtonTile
            title={t('CUSTOM_APP_ADD_TITLE')}
            subtitle={t('CUSTOM_APP_ADD_SUBTITLE')}
            action={() => navigate('/apps/create')}
            icon={<IconLayoutGridAdd size={50} stroke={1.5} />}
          />
          <ButtonTile
            title={t('LINKS_ADD_TITLE')}
            subtitle={t('LINKS_ADD_SUBTITLE')}
            action={() => addLinkDisclosure.open()}
            icon={<IconLinkPlus size={50} stroke={1.5} />}
          />
        </div>
      )}
    </div>
  );
  const dockerApps = <DockerAppsSection key="docker-apps" filters={filters} />;

  return (
    <div className={clsx('orbis-app-library', { 'is-empty': installed.length === 0 })}>
      {installed.length === 0 ? [dockerApps, library] : [library, dockerApps]}
      <AddLinkDialog isOpen={addLinkDisclosure.isOpen} onClose={() => addLinkDisclosure.close()} />
    </div>
  );
}
