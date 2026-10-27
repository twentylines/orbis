import { OtpInput } from '@/components/ui/OtpInput';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { AuthBack, AuthError } from '../auth-stages';
import { IconLoader2 } from '@tabler/icons-react';

type Props = {
  onSubmit: (totpCode: string) => void;
  loading?: boolean;
  error?: string;
  onEdit: () => void;
  onBack: () => void;
};

export const TotpForm = (props: Props) => {
  const { onSubmit, loading, error, onEdit, onBack } = props;
  const { t } = useTranslation();
  const [totpCode, setTotpCode] = React.useState('');
  const submitted = React.useRef(false);
  const form = React.useRef<HTMLFormElement>(null);
  React.useEffect(() => {
    if (!loading) submitted.current = false;
  }, [loading]);
  React.useEffect(() => {
    if (!error) return;
    setTotpCode('');
    submitted.current = false;
    const focus = requestAnimationFrame(() => {
      if (!form.current?.closest('[inert]')) form.current?.querySelector('input')?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(focus);
  }, [error]);

  return (
    <>
      <h2 className="desktop-auth-heading">{t('AUTH_TOTP_TITLE')}</h2>
      <form ref={form} onSubmit={(e) => e.preventDefault()}>
        <p className="text-secondary">{t('AUTH_TOTP_INSTRUCTIONS')}</p>
        <div className="desktop-auth-code-controls">
          <OtpInput
            valueLength={6}
            value={totpCode}
            invalid={Boolean(error)}
            describedBy={error ? 'authenticator-feedback' : undefined}
            disabled={loading}
            onChange={(value) => {
              setTotpCode(value);
              onEdit();
              if (!loading && !submitted.current && /^\d{6}$/.test(value)) {
                submitted.current = true;
                onSubmit(value);
              }
            }}
          />
          {loading && (
            <output className="desktop-auth-verifying">
              <IconLoader2 size={16} aria-hidden="true" />
              Verifying code…
            </output>
          )}
          <AuthError id="authenticator-feedback" message={error} />
        </div>
        <AuthBack onBack={onBack} />
      </form>
    </>
  );
};
