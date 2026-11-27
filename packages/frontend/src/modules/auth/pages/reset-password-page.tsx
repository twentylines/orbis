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
        If your server was migrated from Runtipi and still has its CLI, a server administrator can run this command from the installation folder.
      </p>
      <pre className="desktop-auth-recovery-command">
        <code>./runtipi-cli reset-password</code>
      </pre>
      <AuthBack to={`/login${query ? `?${query}` : ''}`} />
    </div>
  );
}
