import { IconKey, IconLock, IconUser } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { ChangePasswordForm } from '../components/change-password-form/change-password-form';
import { ChangeUsernameForm } from '../components/change-username-form/change-username-form';
import { OtpForm } from '../components/otp-form/otp-form';
import { WrapWords } from '@/components/wrap-words/wrap-words';
import { PasskeySettings } from '../components/passkey-settings/passkey-settings';
import { CaptureSecurity } from '../components/capture-security';
import './security.css';

export const SecurityContainer = (props: { totpEnabled: boolean; username?: string }) => {
  const { totpEnabled, username } = props;
  const { t } = useTranslation();

  return (
    <div className="card-body settings-security">
      <section className="settings-group" aria-labelledby="settings-username-heading">
        <div className="settings-security-heading">
          <IconUser aria-hidden="true" />
          <h2 id="settings-username-heading">Username or email</h2>
        </div>
        <p className="text-muted">
          Choose the identifier you use to sign in. An email address is optional; password recovery is managed on the server.
        </p>
        <div id="setting-username">
          <ChangeUsernameForm username={username} />
        </div>
      </section>
      <div id="setting-passkeys" className="settings-group">
        <PasskeySettings totpEnabled={totpEnabled} />
      </div>
      <section className="settings-group" aria-labelledby="settings-password-heading">
        <div className="settings-security-heading">
          <IconKey aria-hidden="true" />
          <h2 id="settings-password-heading" title={t('SETTINGS_SECURITY_CHANGE_PASSWORD_TITLE')}>
            <WrapWords text={t('SETTINGS_SECURITY_CHANGE_PASSWORD_TITLE')} />
          </h2>
        </div>
        <p className="text-muted">{t('SETTINGS_SECURITY_CHANGE_PASSWORD_SUBTITLE')}</p>
        <div id="setting-password">
          <ChangePasswordForm />
        </div>
      </section>
      <section className="settings-group" aria-labelledby="settings-two-factor-heading">
        <div className="settings-security-heading">
          <IconLock aria-hidden="true" />
          <h2 id="settings-two-factor-heading" title={t('SETTINGS_SECURITY_2FA_TITLE')}>
            <WrapWords text={t('SETTINGS_SECURITY_2FA_TITLE')} />
          </h2>
        </div>
        <p className="text-muted">{t('SETTINGS_SECURITY_2FA_SUBTITLE')}</p>
        <div id="setting-two-factor">
          <OtpForm totpEnabled={totpEnabled} />
        </div>
      </section>
      <div className="settings-group">
        <CaptureSecurity />
      </div>
    </div>
  );
};
