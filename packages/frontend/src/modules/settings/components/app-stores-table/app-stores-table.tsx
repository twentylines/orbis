import { WrapWords } from '@/components/wrap-words/wrap-words';
import type { AppStore } from '@/types/app.types';
import { AddAppStoreDialog } from '../add-app-store-dialog/add-app-store-dialog';
import { DeleteAppStoreDialog } from '../delete-app-store-dialog/delete-app-store-dialog';
import { EditAppStoreDialog } from '../edit-app-store-dialog/edit-app-store-dialog';
import { useLayoutEffect, useRef } from 'react';
import './app-stores.css';

type Props = {
  appStores: AppStore[];
};

const EnabledBadge = ({ enabled }: { enabled: boolean }) => (
  <span className="app-store-state">
    <span className="app-store-state-dot" data-enabled={enabled} aria-hidden="true" />
    <span>{enabled ? 'Enabled' : 'Disabled'}</span>
  </span>
);

export const AppStoresTable = ({ appStores }: Props) => {
  const list = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: List changes can move a focused control after dialog restoration.
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== list.current && list.current?.contains(active))
      active.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  }, [appStores]);

  return (
    <div ref={list} className="app-stores d-flex flex-column" data-dialog-focus-fallback="" tabIndex={-1}>
      <ul className="app-stores-list" aria-label="App stores">
        {appStores.map((appStore) => (
          <li className="app-store-card" key={appStore.slug}>
            <div className="app-store-identity">
              <h3 className="app-store-name" title={appStore.name}>
                <WrapWords text={appStore.name} />
              </h3>
              <a className="app-store-url" title={appStore.url} href={appStore.url} target="_blank" rel="noreferrer noopener nofollow">
                {appStore.url}
              </a>
            </div>
            <div className="app-store-status">
              <span className="app-store-field-label">Status</span>
              <EnabledBadge enabled={appStore.enabled} />
            </div>
            <div className="app-store-actions">
              <EditAppStoreDialog appStore={appStore} />
              <DeleteAppStoreDialog appStore={appStore} />
            </div>
          </li>
        ))}
      </ul>
      <AddAppStoreDialog />
    </div>
  );
};
