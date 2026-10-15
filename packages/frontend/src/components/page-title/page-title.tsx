import type { AppInfoSimple } from '@/types/app.types';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router';

type Props = {
  apps: AppInfoSimple[];
};

export const PageTitle = ({ apps }: Props) => {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const pathArray = pathname.substring(1).split('/');
  const installedAppRoute =
    pathArray[0] === 'apps' &&
    pathArray[1] &&
    pathArray[2] &&
    apps.some((app) => app.id === pathArray[2] && app.urn === `${pathArray[2]}:${pathArray[1]}`);

  const renderBreadcrumbs = () => {
    return (
      <ol className="breadcrumb" aria-label="breadcrumbs">
        {pathArray.map((breadcrumb, index) => {
          const to = installedAppRoute && index === 1 ? `/app-store/${pathArray[1]}` : `/${pathArray.slice(0, index + 1).join('/')}`;

          return (
            <li key={breadcrumb} className={clsx('breadcrumb-item', { active: index === pathArray.length - 1 })}>
              <Link to={to}>{breadcrumb}</Link>
            </li>
          );
        })}
      </ol>
    );
  };

  const operation = pathArray.at(-1);
  const appId = operation === 'edit' || operation === 'update' ? pathArray.at(-2) : operation;
  const appTitle = apps.find((app) => app.id.split('_')[0] === appId)?.name ?? appId;
  const title =
    operation === 'create'
      ? 'Create an application'
      : operation === 'edit'
        ? `Edit ${appTitle}`
        : operation === 'update'
          ? `Update ${appTitle}`
          : (appTitle ?? t(`HEADER_${pathArray[0]?.toUpperCase().replace('-', '_')}`));

  return (
    <>
      {pathArray.length > 1 ? <div className="page-pretitle">{renderBreadcrumbs()}</div> : null}
      <h2 className="page-title mt-1">{title}</h2>
    </>
  );
};
