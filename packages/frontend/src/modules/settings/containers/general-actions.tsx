import { useAppContext } from '@/context/app-context';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { UpdateRepoModal } from '../components/update-repo-modal/update-repo-modal';

export const GeneralActionsContainer = () => {
  const { t } = useTranslation();
  const { version } = useAppContext();

  return (
    <div className="card-body">
      <h2 className="mb-2">Updates</h2>
      <p className="card-subtitle">Runtipi compatibility · {version.current}</p>
      <Link to="/updates" className="btn mt-3">
        Open Update Center
      </Link>
      <h3 className="card-title mt-4">{t('SETTINGS_ACTIONS_UPDATE_REPO_TITLE')}</h3>
      <p className="card-subtitle">{t('SETTINGS_ACTIONS_UPDATE_REPO_SUBTITLE')}</p>
      <UpdateRepoModal />
    </div>
  );
};
