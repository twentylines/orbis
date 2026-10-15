import { Link } from 'react-router';
import { FallbackSurface } from '@/components/error/error-page';

export default function NotFoundPage() {
  return (
    <FallbackSurface>
      <h1>Page not found</h1>
      <p>Check the address or return to the workspace.</p>
      <Link to="/dashboard" className="btn btn-primary">
        Open workspace
      </Link>
    </FallbackSurface>
  );
}
