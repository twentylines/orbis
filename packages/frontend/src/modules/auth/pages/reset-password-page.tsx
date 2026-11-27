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
      <p className="desktop-auth-help">A server administrator can run this command on the Docker host to reset the Orbis operator password.</p>
      <pre className="desktop-auth-recovery-command">
        <code>
          sudo docker exec -it runtipi <span className="text-nowrap">orbis-cli</span> <span className="text-nowrap">reset-password</span>
        </code>
      </pre>
      <AuthBack to={`/login${query ? `?${query}` : ''}`} />
    </div>
  );
}
