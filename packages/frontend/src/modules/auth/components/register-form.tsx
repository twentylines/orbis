import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { arktypeResolver } from '@hookform/resolvers/arktype';
import { type } from 'arktype';
import type React from 'react';
import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { newAccountIdentifier } from '../account-identifier';

interface IProps {
  onSubmit: (values: FormValues) => void;
  loading: boolean;
}

type FormValues = { username: string; password: string; passwordConfirm: string };

export const RegisterForm: React.FC<IProps> = ({ onSubmit, loading }) => {
  const { t } = useTranslation();

  const schema = useMemo(
    () =>
      type({
        username: newAccountIdentifier,
        password: type('string')
          .atLeastLength(8)
          .configure({ message: t('AUTH_ERROR_INVALID_PASSWORD_LENGTH') }),
        passwordConfirm: type('string')
          .atLeastLength(8)
          .configure({ message: t('AUTH_ERROR_INVALID_PASSWORD_LENGTH') })
          .narrow((confirm, ctx) => confirm === (ctx.root as { password?: string }).password)
          .configure({ message: t('AUTH_FORM_ERROR_PASSWORD_CONFIRMATION_MATCH') }),
      }),
    [t],
  );

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: arktypeResolver(schema),
  });

  return (
    <>
      <h2 className="desktop-auth-heading">{t('AUTH_REGISTER_TITLE')}</h2>
      <form onSubmit={handleSubmit(onSubmit)}>
        <Input
          {...register('username')}
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
          label={t('AUTH_FORM_PASSWORD')}
          error={errors.password?.message}
          disabled={loading}
          type="password"
          className="mb-3"
          autoComplete="new-password"
        />
        <Input
          {...register('passwordConfirm')}
          label={t('AUTH_FORM_PASSWORD_CONFIRMATION')}
          error={errors.passwordConfirm?.message}
          disabled={loading}
          type="password"
          className="mb-3"
          autoComplete="new-password"
        />
        <p className="desktop-auth-help">
          Email is optional. Choose a username or use your email address as the account identifier. Password recovery requires access to the server.
        </p>
        <div className="form-footer">
          <Button loading={loading} type="submit" intent="primary" className="w-100">
            {t('AUTH_REGISTER_SUBMIT')}
          </Button>
        </div>
      </form>
    </>
  );
};
