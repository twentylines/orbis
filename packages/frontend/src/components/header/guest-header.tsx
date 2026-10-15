import { Link } from 'react-router';
import { IconBrandGithub, IconCertificate, IconHeart, IconLogin, IconMoon, IconSun } from '@tabler/icons-react';
import { useDesktopPreferences } from '@/desktop/preferences';
import { useTranslation } from 'react-i18next';

export const GuestHeader = () => {
  const { preferences, update } = useDesktopPreferences();
  const { t } = useTranslation();
  return (
    <header className="desktop-system-bar desktop-guest-bar">
      <Link to="/dashboard" className="desktop-brand" aria-label="Orbis shared apps">
        <img src="/icons/orbis.svg" width={28} height={28} alt="" />
        <span>Orbis</span>
      </Link>
      <div className="desktop-system-actions">
        <a
          className="desktop-icon-button"
          href="https://github.com/runtipi/runtipi"
          target="_blank"
          rel="noreferrer"
          aria-label="Runtipi source"
          title="Runtipi source"
        >
          <IconBrandGithub size={20} aria-hidden="true" />
        </a>
        <a
          className="desktop-icon-button"
          href="https://github.com/runtipi/runtipi?sponsor=1"
          target="_blank"
          rel="noreferrer"
          aria-label={t('HEADER_SPONSOR')}
          title={t('HEADER_SPONSOR')}
        >
          <IconHeart size={20} aria-hidden="true" />
        </a>
        <a
          className="desktop-icon-button"
          href="/api/system/certificate"
          target="_blank"
          rel="noreferrer"
          aria-label={t('GUEST_DASHBOARD_DOWNLOAD_CERTIFICATE_TOOLTIP')}
          title={t('GUEST_DASHBOARD_DOWNLOAD_CERTIFICATE_TOOLTIP')}
        >
          <IconCertificate size={20} aria-hidden="true" />
        </a>
        <button
          className="desktop-icon-button"
          type="button"
          aria-label={`Switch to ${preferences.mode === 'dark' ? 'light' : 'dark'} mode`}
          onClick={() => update({ mode: preferences.mode === 'dark' ? 'light' : 'dark' })}
        >
          {preferences.mode === 'dark' ? <IconSun size={20} aria-hidden="true" /> : <IconMoon size={20} aria-hidden="true" />}
        </button>
        <Link to="/login" className="desktop-icon-button" aria-label={t('HEADER_LOGIN')} title={t('HEADER_LOGIN')}>
          <IconLogin size={20} aria-hidden="true" />
        </Link>
      </div>
    </header>
  );
};
