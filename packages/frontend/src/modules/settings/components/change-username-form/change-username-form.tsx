import { changeUsernameMutation } from '@/api-client/@tanstack/react-query.gen';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { useDisclosure } from '@/lib/hooks/use-disclosure';
import type { TranslatableError } from '@/types/error.types';
import { arktypeResolver } from '@hookform/resolvers/arktype';
import { useMutation } from '@tanstack/react-query';
import { type } from 'arktype';
import { useId } from 'react';
import { useForm } from 'react-hook-form';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { newAccountIdentifier, accountIdentifierHint } from '@/modules/auth/account-identifier';

type Props = {
  username?: string;
};

export const ChangeUsernameForm = ({ username }: Props) => {
  const changeUsernameDisclosure = useDisclosure();
  const { t } = useTranslation();

  const schema = type({
    newUsername: newAccountIdentifier,
    password: type('string').atLeastLength(1),
  });

  const formId = useId();
  type FormValues = typeof schema.infer;

  const changeUsername = useMutation({
    ...changeUsernameMutation(),
    onSuccess: () => {
      window.location.replace('/login');
    },
    onError: (e: TranslatableError) => {
      toast.error(t(e.message, e.intlParams));
    },
  });

  const { register, handleSubmit, formState } = useForm<FormValues>({
    resolver: arktypeResolver(schema),
  });

  const onSubmit = (body: FormValues) => {
    changeUsername.mutate({ body: { ...body, newUsername: body.newUsername.trim() } });
  };

  return (
    <div className="mb-4">
      <Input disabled type="text" value={username} label="Username or email" autoComplete="username" />
      <Button className="mt-3" onClick={() => changeUsernameDisclosure.open()}>
        Change username or email
      </Button>
      <Dialog open={changeUsernameDisclosure.isOpen} onOpenChange={changeUsernameDisclosure.toggle}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Change username or email</DialogTitle>
          </DialogHeader>
          <DialogDescription className="d-flex flex-column">
            <form onSubmit={handleSubmit(onSubmit)} className="w-100" id={formId}>
              <p className="text-muted">Confirm your password to change your sign-in identifier. This signs out every account session.</p>
              <Input
                error={formState.errors.newUsername?.message}
                disabled={changeUsername.isPending}
                type="text"
                label="New username or email"
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                {...register('newUsername')}
              />
              <p className="form-text">{accountIdentifierHint}</p>
              <Input
                className="mt-3"
                error={formState.errors.password?.message}
                disabled={changeUsername.isPending}
                type="password"
                label={t('SETTINGS_SECURITY_CHANGE_USERNAME_FORM_PASSWORD')}
                autoComplete="current-password"
                {...register('password')}
              />
            </form>
          </DialogDescription>
          <DialogFooter>
            <Button loading={changeUsername.isPending} type="submit" intent="success" form={formId}>
              {t('SETTINGS_SECURITY_CHANGE_USERNAME_FORM_SUBMIT')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
