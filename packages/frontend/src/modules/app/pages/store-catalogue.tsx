import { Fragment, type ReactNode } from 'react';
import { LayoutGroup, motion } from 'framer-motion';
import { useReducedMotion } from '@/desktop/motion-preferences';
import { sectionMotionTiming } from '@/desktop/section-motion-geometry';
import { useWindowVisible } from '@/desktop/window-visibility';
import type { AppInfoSimple } from '@/types/app.types';
import { StoreTile } from '../components/store-tile/store-tile';

export function storeCataloguePositionMotion(reduced: boolean, visible: boolean) {
  return {
    layout: 'position' as const,
    transition: {
      duration: reduced || !visible ? 0 : sectionMotionTiming.content / 1000,
      ease: [0.32, 0.08, 0.24, 1] as const,
    },
  };
}

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
  const reduced = Boolean(useReducedMotion());
  const visible = useWindowVisible();
  const layoutMotion = storeCataloguePositionMotion(reduced, visible);

  return (
    <LayoutGroup id="store-catalogue">
      <div className="orbis-store-grid">
        {apps.map((app, index) => (
          <Fragment key={app.urn}>
            <motion.div {...layoutMotion} ref={index === apps.length - 1 ? lastElementRef : null} className="orbis-store-grid-item">
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
            </motion.div>
            {index === collectionsAfter - 1 ? collections : null}
          </Fragment>
        ))}
      </div>
    </LayoutGroup>
  );
}
