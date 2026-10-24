import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { arktypeResolver } from '@hookform/resolvers/arktype';
import { type } from 'arktype';
import type React from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { IconFingerprint } from '@tabler/icons-react';

type FormValues = { username: string; password: string };

const schema = type({
  username: type('string').narrow((value) => value.trim().length > 0),
  password: 'string',
});

interface IProps {
  onSubmit: (values: FormValues) => void;
  loading: boolean;
  showProgress?: boolean;
  loginType: string;
  onPasskey: () => void;
  warmPasskey: () => void;
  passkeyAvailable: boolean;
  passkeyReason?: string;
}

export const LoginForm: React.FC<IProps> = ({
  loading,
  showProgress = false,
  onSubmit,
  loginType,
  onPasskey,
  warmPasskey,
  passkeyAvailable,
  passkeyReason,
}) => {
  const { t } = useTranslation();
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
      <form onSubmit={handleSubmit(onSubmit)}>
        <Input
          {...register('username')}
          name="username"
          label="Username or email"
          error={errors.username?.message}
          disabled={loading}
          type="text"
          autoCapitalize="none"
          autoCorrect="off"
          className="mb-3"
          autoComplete="username"
        />
        <Input
          {...register('password')}
          name="password"
          label={t('AUTH_FORM_PASSWORD')}
          error={errors.password?.message}
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
            <Button
              type="button"
              disabled={loading || !passkeyAvailable}
              onClick={onPasskey}
              onPointerEnter={warmPasskey}
              onFocus={warmPasskey}
              className="w-100"
            >
              <IconFingerprint size={20} aria-hidden="true" />
              Sign in with a passkey
            </Button>
            {passkeyReason && <p className="desktop-auth-help">{passkeyReason}</p>}
          </div>
          <div className="form-text desktop-login-recovery">
            <Link to="/reset-password">{t('AUTH_FORM_FORGOT')}</Link>
          </div>
        </div>
      </form>
    </>
  );
};
