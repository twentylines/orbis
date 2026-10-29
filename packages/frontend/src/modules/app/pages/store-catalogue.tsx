import { Fragment, type ReactNode } from 'react';
import type { AppInfoSimple } from '@/types/app.types';
import { StoreTile } from '../components/store-tile/store-tile';

export function StoreCatalogue({
  apps,
  collections,
  lastElementRef,
}: {
  apps: AppInfoSimple[];
  collections?: ReactNode;
  lastElementRef: (node: HTMLDivElement) => void;
}) {
  return (
    <div className="orbis-store-grid">
      {apps.map((app, index) => (
        <Fragment key={app.urn}>
          <div ref={index === apps.length - 1 ? lastElementRef : null} className="orbis-store-grid-item">
            <StoreTile app={app} isLoading={false} />
          </div>
          {index === 7 ? collections : null}
        </Fragment>
      ))}
    </div>
  );
}
