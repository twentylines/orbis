import { IconKey, IconLock, IconUser } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { ChangePasswordForm } from '../components/change-password-form/change-password-form';
import { ChangeUsernameForm } from '../components/change-username-form/change-username-form';
import { OtpForm } from '../components/otp-form/otp-form';
import { WrapWords } from '@/components/wrap-words/wrap-words';
import './security.css';

export const SecurityContainer = (props: { totpEnabled: boolean; username?: string }) => {
  const { totpEnabled, username } = props;
  const { t } = useTranslation();

  return (
    <div className="card-body settings-security">
      <div className="settings-security-heading">
        <IconUser aria-hidden="true" />
        <h2 title={t('SETTINGS_SECURITY_CHANGE_USERNAME_TITLE')}>
          <WrapWords text={t('SETTINGS_SECURITY_CHANGE_USERNAME_TITLE')} />
        </h2>
      </div>
      <p className="text-muted">{t('SETTINGS_SECURITY_CHANGE_USERNAME_SUBTITLE')}</p>
      <ChangeUsernameForm username={username} />
      <div className="settings-security-heading">
        <IconKey aria-hidden="true" />
        <h2 title={t('SETTINGS_SECURITY_CHANGE_PASSWORD_TITLE')}>
          <WrapWords text={t('SETTINGS_SECURITY_CHANGE_PASSWORD_TITLE')} />
        </h2>
      </div>
      <p className="text-muted">{t('SETTINGS_SECURITY_CHANGE_PASSWORD_SUBTITLE')}</p>
      <ChangePasswordForm />
      <div className="settings-security-heading">
        <IconLock aria-hidden="true" />
        <h2 title={t('SETTINGS_SECURITY_2FA_TITLE')}>
          <WrapWords text={t('SETTINGS_SECURITY_2FA_TITLE')} />
        </h2>
      </div>
      <p className="text-muted">{t('SETTINGS_SECURITY_2FA_SUBTITLE')}</p>
      <OtpForm totpEnabled={totpEnabled} />
    </div>
  );
};
