import type { PropsWithChildren, ReactNode } from 'react';
import './layout.css';
import { useDesktopPreferences } from '@/desktop/preferences';

type BaseDashboardLayoutProps = PropsWithChildren<{
  header: ReactNode;
  pageTitle?: ReactNode;
  layoutActions?: ReactNode;
  showPageHeader?: boolean;
}>;

export const BaseDashboardLayout = ({ header, pageTitle, layoutActions, showPageHeader = true, children }: BaseDashboardLayoutProps) => {
  const { preferences } = useDesktopPreferences();
  return (
    <div
      className="desktop desktop-guest orbis-theme"
      data-desktop-mode={preferences.mode}
      data-desktop-preset={preferences.preset}
      data-desktop-wallpaper={preferences.wallpaper}
    >
      {header}
      <main className="desktop-guest-main">
        {showPageHeader && (
          <div className="page-header d-print-none">
            <div className="container-xl">
              <div className="row g-2 align-items-center">
                <div className="col">{pageTitle}</div>
                {layoutActions && <div className="col-auto ms-auto">{layoutActions}</div>}
              </div>
            </div>
          </div>
        )}
        <div className="page-body">
          <div className="container-xl">{children}</div>
        </div>
      </main>
    </div>
  );
};
