import { Button } from '@/components/ui/Button';
import { IconFingerprint } from '@tabler/icons-react';
import { useId } from 'react';
import './passkey-sign-in.css';

type Props = {
  available: boolean;
  loading: boolean;
  reason?: string;
  onPasskey: () => void;
  warmPasskey: () => void;
};

export function PasskeySignIn({ available, loading, reason, onPasskey, warmPasskey }: Props) {
  const id = useId();
  const explanation = available ? undefined : reason;

  return (
    <>
      <Button
        type="button"
        disabled={!available || loading}
        aria-describedby={explanation ? id : undefined}
        onClick={onPasskey}
        onPointerEnter={warmPasskey}
        onFocus={warmPasskey}
        className="w-100 desktop-passkey-sign-in"
      >
        <IconFingerprint size={20} aria-hidden="true" />
        Sign in with a passkey
      </Button>
      {explanation ? (
        <p id={id} className="form-text desktop-passkey-explanation">
          {explanation}
        </p>
      ) : null}
    </>
  );
}
