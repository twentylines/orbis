import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/Table';
import { WrapWords } from '@/components/wrap-words/wrap-words';
import type { AppStore } from '@/types/app.types';
import { AddAppStoreDialog } from '../add-app-store-dialog/add-app-store-dialog';
import { DeleteAppStoreDialog } from '../delete-app-store-dialog/delete-app-store-dialog';
import { EditAppStoreDialog } from '../edit-app-store-dialog/edit-app-store-dialog';
import './app-stores.css';

type Props = {
  appStores: AppStore[];
};

const EnabledBadge = ({ enabled }: { enabled: boolean }) => (
  <div className="app-store-state">
    <span className="app-store-state-dot" data-enabled={enabled} aria-hidden="true" />
    <span>{enabled ? 'Enabled' : 'Disabled'}</span>
  </div>
);

export const AppStoresTable = ({ appStores }: Props) => {
  return (
    <div className="app-stores d-flex flex-column" data-dialog-focus-fallback="" tabIndex={-1}>
      <Table className="app-stores-table">
        <TableHeader>
          <TableRow>
            <TableHead className="app-store-name">Name</TableHead>
            <TableHead className="app-store-status">Status</TableHead>
            <TableHead className="app-store-repository">URL</TableHead>
            <TableHead className="app-store-actions-cell">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {appStores.map((appStore) => (
            <TableRow key={appStore.slug}>
              <TableCell className="app-store-name" title={appStore.name}>
                <WrapWords text={appStore.name} />
              </TableCell>
              <TableCell className="app-store-status">
                <EnabledBadge enabled={appStore.enabled} />
              </TableCell>
              <TableCell className="app-store-repository">
                <a className="app-store-url" title={appStore.url} href={appStore.url} target="_blank" rel="noreferrer noopener nofollow">
                  {appStore.url}
                </a>
              </TableCell>
              <TableCell className="app-store-actions-cell">
                <div className="app-store-actions">
                  <EditAppStoreDialog appStore={appStore} />
                  <DeleteAppStoreDialog appStore={appStore} />
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <AddAppStoreDialog />
    </div>
  );
};
