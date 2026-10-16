import { IconAlertCircle } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { WrapWords } from '@/components/wrap-words/wrap-words';
import type { TranslatableError } from '@/types/error.types';
import './app-stores.css';

export const AppStoreError = ({ error }: { error: TranslatableError | null }) => {
  const { t } = useTranslation();
  if (!error) return null;
  return (
    <div className="app-store-error" role="alert">
      <IconAlertCircle size={20} aria-hidden="true" />
      <p>
        <WrapWords text={t(error.message, error.intlParams)} />
      </p>
    </div>
  );
};
