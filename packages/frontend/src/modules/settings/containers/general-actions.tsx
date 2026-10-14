import { useAppContext } from '@/context/app-context';
import { useTranslation } from 'react-i18next';
import { UpdateRepoModal } from '../components/update-repo-modal/update-repo-modal';

export const GeneralActionsContainer = () => {
  const { t } = useTranslation();
  const { version } = useAppContext();

  return (
    <div className="card-body">
      <h2 className="mb-4">{t('SETTINGS_ACTIONS_TITLE')}</h2>
      <h3 className="card-title mt-4">{t('SETTINGS_ACTIONS_CURRENT_VERSION', { version: version.current })}</h3>
      <p className="card-subtitle">
        This server runs Orbis, a custom Runtipi fork. Core updates must be built and deployed from this project after compatibility checks. The
        upstream Runtipi release shown by the API is a reference, not an update for this fork.
      </p>
      <p className="card-subtitle">Upstream release currently reported: {version.latest || 'Unavailable'}.</p>
      <h3 className="card-title mt-4">{t('SETTINGS_ACTIONS_UPDATE_REPO_TITLE')}</h3>
      <p className="card-subtitle">{t('SETTINGS_ACTIONS_UPDATE_REPO_SUBTITLE')} App-store refreshes do not replace the server interface.</p>
      <UpdateRepoModal />
    </div>
  );
};
