import { useSearchParams } from 'react-router';
import { AuthBack } from '../components/auth-stages';

export default function ResetPasswordPage() {
  const [search] = useSearchParams();
  const query = search.toString();
  return (
    <div className="desktop-auth-recovery">
      <h2 className="desktop-auth-heading" data-auth-focus="" tabIndex={-1}>
        Reset your password
      </h2>
      <p className="desktop-auth-help">
        Orbis does not send password-reset emails. Ask the server administrator to run the recovery command on the server, then sign in with your new
        password.
      </p>
      <pre className="desktop-auth-recovery-command">
        <code>./runtipi-cli reset-password</code>
      </pre>
      <AuthBack to={`/login${query ? `?${query}` : ''}`} />
    </div>
  );
}
