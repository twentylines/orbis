import { Fragment, type ReactNode } from 'react';
import type { AppInfoSimple } from '@/types/app.types';
import { StoreTile } from '../components/store-tile/store-tile';

export function StoreCatalogue({
  apps,
  collections,
  collectionsAfter = 8,
  canInstall = false,
  installedApps,
  pendingApps,
  installLoadingUrn,
  onInstall,
  lastElementRef,
}: {
  apps: AppInfoSimple[];
  collections?: ReactNode;
  collectionsAfter?: number;
  canInstall?: boolean;
  installedApps?: ReadonlySet<string>;
  pendingApps?: ReadonlySet<string>;
  installLoadingUrn?: string | null;
  onInstall?: (app: AppInfoSimple) => void;
  lastElementRef: (node: HTMLDivElement) => void;
}) {
  return (
    <div className="orbis-store-grid">
      {apps.map((app, index) => (
        <Fragment key={app.urn}>
          <div ref={index === apps.length - 1 ? lastElementRef : null} className="orbis-store-grid-item">
            <StoreTile
              app={app}
              isLoading={false}
              catalogueRow
              installed={installedApps?.has(app.urn)}
              pending={pendingApps?.has(app.urn)}
              quickInstall={canInstall && !installedApps?.has(app.urn) && !pendingApps?.has(app.urn)}
              installLoading={installLoadingUrn === app.urn}
              installDisabled={Boolean(installLoadingUrn)}
              onInstall={onInstall}
            />
          </div>
          {index === collectionsAfter - 1 ? collections : null}
        </Fragment>
      ))}
    </div>
  );
}
