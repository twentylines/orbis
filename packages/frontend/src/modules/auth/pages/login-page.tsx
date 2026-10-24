import { useSignInBoot } from '@/components/startup/use-sign-in-boot';
import { userContext } from '@/api-client';
import { loginMutation, verifyTotpMutation } from '@/api-client/@tanstack/react-query.gen';
import { useUserContext } from '@/context/user-context';
import type { TranslatableError } from '@/types/error.types';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { Navigate, redirect, useNavigate, useSearchParams } from 'react-router';
import { LoginForm } from '../components/login-form';
import { TotpForm } from '../components/totp-form/totp-form';
import {
  browserPasskeyReason,
  passkeyAvailabilityOptions,
  signInWithPasskey,
  passkeyErrorMessage,
  warmPasskeyClient,
  cancelPasskeyCeremony,
} from '../passkeys/passkey-api';

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const isSafeRedirect = (url: string) => {
  try {
    const redirectUrl = new URL(url);
    return ['http:', 'https:'].includes(redirectUrl.protocol) && redirectUrl.hostname.endsWith(`.${window.location.hostname}`);
  } catch {
    return false;
  }
};

const createForwardAuthSession = async (redirectUrl: string) => {
  const response = await fetch('/api/auth/forward-auth', {
    body: JSON.stringify({ redirectUrl }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });

  if (!response.ok) {
    throw new Error('Unable to create forward-auth session');
  }

  const body = (await response.json()) as { redirectUrl?: string };
  if (!body.redirectUrl) {
    throw new Error('Unable to create forward-auth redirect');
  }

  return body.redirectUrl;
};

export async function clientLoader() {
  const user = await userContext();

  if (!user.data?.isConfigured) {
    return redirect('/register');
  }

  if (user.data?.isLoggedIn) {
    const redirectUrl = new URL(window.location.href).searchParams.get('redirect_url');
    if (redirectUrl && isSafeRedirect(redirectUrl)) {
      return;
    }

    return redirect('/dashboard');
  }
}

export default () => {
  const { isLoggedIn, isConfigured, refreshUserContext, setUserContext } = useUserContext();
  const boot = useSignInBoot();
  const [totpSessionId, setTotpSessionId] = useState<string | null>(null);
  const [passkeyPending, setPasskeyPending] = useState(false);
  const [passkeyError, setPasskeyError] = useState('');
  const passkeyActive = useRef(false);
  const [browserReason] = useState(browserPasskeyReason);
  const passkeyAvailability = useQuery({ ...passkeyAvailabilityOptions(), enabled: !browserReason });
  useEffect(
    () => () => {
      if (passkeyActive.current) cancelPasskeyCeremony();
    },
    [],
  );

  const [searchParams] = useSearchParams();
  const redirect_url = searchParams.get('redirect_url');
  const app = searchParams.get('app');

  const { t } = useTranslation();
  const navigate = useNavigate();

  const loginType = capitalize(app ?? '') || t('AUTH_LOGIN_TYPE_ACCOUNT');

  useEffect(() => {
    if (boot.signingIn || !isLoggedIn || !redirect_url || !isSafeRedirect(redirect_url)) {
      return;
    }

    let cancelled = false;

    createForwardAuthSession(redirect_url)
      .then((authRedirectUrl) => {
        if (!cancelled) {
          window.location.href = authRedirectUrl;
        }
      })
      .catch(() => {
        if (!cancelled) {
          navigate('/dashboard');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [boot.signingIn, isLoggedIn, navigate, redirect_url]);

  const completeSignIn = async (redirectUrl?: string) => {
    if (!boot.isActive()) return;
    setUserContext({ isLoggedIn: true });
    void refreshUserContext();
    await boot.finish();
    if (!boot.isActive()) return;
    if (redirect_url && isSafeRedirect(redirect_url)) {
      try {
        window.location.href = redirectUrl ?? (await createForwardAuthSession(redirect_url));
      } catch {
        void navigate('/dashboard', { replace: true });
      }
    } else void navigate('/dashboard', { replace: true });
  };
  const failedSignIn = async (error: TranslatableError) => {
    if (!boot.isActive()) return;
    await boot.finish(true);
    if (!boot.isActive()) return;
    toast.error(t(error.message, error.intlParams), { id: 'orbis-sign-in-error' });
  };
  const beginSignIn = () => {
    toast.dismiss('orbis-sign-in-error');
    setPasskeyError('');
    boot.begin();
  };
  const acceptSignIn = async (data: { success: boolean; totpSessionId?: string; redirectUrl?: string }) => {
    if (!data.success) throw new Error('Sign-in was not verified.');
    if (data.totpSessionId) {
      setTotpSessionId(data.totpSessionId);
      await boot.finish(true);
      if (!boot.isActive()) return;
    } else await completeSignIn(data.redirectUrl);
  };
  const beginPasskey = async () => {
    if (passkeyActive.current || passkeyPending || !passkeyAvailability.data?.available || browserReason) return;
    passkeyActive.current = true;
    setPasskeyPending(true);
    setPasskeyError('');
    beginSignIn();
    try {
      await acceptSignIn(await signInWithPasskey(boot.isActive, redirect_url ?? undefined));
    } catch (error) {
      if (boot.isActive()) {
        await boot.finish(true);
        if (boot.isActive()) setPasskeyError(passkeyErrorMessage(error));
      }
    } finally {
      passkeyActive.current = false;
      if (boot.isActive()) setPasskeyPending(false);
    }
  };
  const login = useMutation({
    ...loginMutation(),
    onMutate: beginSignIn,
    onSuccess: acceptSignIn,
    onError: failedSignIn,
  });
  const verifyTotp = useMutation({
    ...verifyTotpMutation(),
    onMutate: beginSignIn,
    onError: failedSignIn,
    onSuccess: async (data) => completeSignIn(data.redirectUrl),
  });

  if (isLoggedIn && !boot.signingIn) {
    if (redirect_url && isSafeRedirect(redirect_url)) {
      return null;
    }
    return <Navigate to="/dashboard" />;
  }

  if (!isConfigured) {
    return <Navigate to="/register" />;
  }

  const form = totpSessionId ? (
    <TotpForm
      loading={verifyTotp.isPending}
      onSubmit={(totpCode) => verifyTotp.mutate({ body: { redirectUrl: redirect_url ?? undefined, totpCode, totpSessionId } })}
    />
  ) : (
    <LoginForm
      onSubmit={(values) =>
        login.mutate({ body: { password: values.password, redirectUrl: redirect_url ?? undefined, username: values.username.trim() } })
      }
      loading={login.isPending || passkeyPending}
      showProgress={boot.visible}
      loginType={loginType}
      onPasskey={() => void beginPasskey()}
      warmPasskey={warmPasskeyClient}
      passkeyAvailable={Boolean(!browserReason && passkeyAvailability.data?.available)}
      passkeyReason={
        browserReason ??
        passkeyAvailability.data?.reason ??
        (passkeyAvailability.isError ? 'Passkey sign-in is unavailable. You can still use your password.' : undefined)
      }
    />
  );
  return (
    <>
      {form}
      {passkeyError && (
        <p className="desktop-auth-error" role="alert">
          {passkeyError}
        </p>
      )}
    </>
  );
};
