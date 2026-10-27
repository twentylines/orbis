import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { arktypeResolver } from '@hookform/resolvers/arktype';
import { type } from 'arktype';
import type React from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router';
import { AuthError } from './auth-stages';
import { signInAccountIdentifier, signInIdentifierMessage, signInPassword, signInPasswordMessage } from '../account-identifier';
import { PasskeySignIn } from './passkey-sign-in';

type FormValues = { username: string; password: string };

const schema = type({
  username: signInAccountIdentifier,
  password: signInPassword,
});

interface IProps {
  active?: boolean;
  onSubmit: (values: FormValues) => void;
  loading: boolean;
  showProgress?: boolean;
  loginType: string;
  onPasskey: () => void;
  warmPasskey: () => void;
  passkeyAvailable: boolean;
  passkeyReason?: string;
  error?: string;
  onEdit: () => void;
}

export const LoginForm: React.FC<IProps> = ({
  active = true,
  loading,
  showProgress = false,
  onSubmit,
  loginType,
  onPasskey,
  warmPasskey,
  passkeyAvailable,
  passkeyReason,
  error,
  onEdit,
}) => {
  const { t } = useTranslation();
  const location = useLocation();
  const {
    register,
    handleSubmit,
    formState: { errors },
    watch,
  } = useForm<FormValues>({
    resolver: arktypeResolver(schema),
  });

  const watchUsername = watch('username');
  const watchPassword = watch('password');

  const isDisabled = !watchUsername?.trim() || !watchPassword;

  return (
    <>
      <h2 className="desktop-auth-heading">{t('AUTH_LOGIN_TITLE', { type: loginType })}</h2>
      <form onSubmit={handleSubmit(onSubmit)} onChange={onEdit}>
        <Input
          {...register('username')}
          animateCharacters
          name="username"
          label="Username or email"
          error={errors.username ? signInIdentifierMessage : undefined}
          isInvalid={Boolean(error)}
          aria-describedby={error ? 'credentials-feedback' : undefined}
          disabled={loading}
          type="text"
          autoCapitalize="none"
          autoCorrect="off"
          className="mb-3"
          autoComplete="username"
        />
        <Input
          {...register('password')}
          animateCharacters
          name="password"
          label={t('AUTH_FORM_PASSWORD')}
          error={errors.password ? signInPasswordMessage : undefined}
          isInvalid={Boolean(error)}
          aria-describedby={error ? 'credentials-feedback' : undefined}
          disabled={loading}
          type="password"
          className="mb-3 password-input"
          autoComplete="current-password"
        />
        <div className="form-footer desktop-login-actions">
          <Button disabled={isDisabled || loading} aria-busy={loading || undefined} type="submit" intent="primary" className="w-100">
            {showProgress ? 'Signing in…' : t('AUTH_LOGIN_SUBMIT')}
          </Button>
          <div className="desktop-login-passkey">
            <PasskeySignIn
              active={active}
              available={passkeyAvailable}
              loading={loading}
              reason={passkeyReason}
              onPasskey={onPasskey}
              warmPasskey={warmPasskey}
            />
          </div>
          <AuthError id="credentials-feedback" message={error} />
          <div className="form-text desktop-login-recovery">
            <Link to={`/reset-password${location.search}`}>{t('AUTH_FORM_FORGOT')}</Link>
          </div>
        </div>
      </form>
    </>
  );
};
