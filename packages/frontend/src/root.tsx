import { useEffect } from 'react';
import { OrbisToaster } from './components/notifications/orbis-toaster';
import { Links, Meta, Outlet, Scripts, ScrollRestoration, isRouteErrorResponse, redirect } from 'react-router';
import type { Route } from './+types/root';
import { userContext } from './api-client';
import './api-client-config';
import stylesheet from './app.css?url';
import { Providers } from './components/providers/providers';
import { FallbackSurface } from './components/error/error-page';
import { ConfirmationDialog } from './desktop/confirmation';

export const links: Route.LinksFunction = () => [
  { rel: 'stylesheet', href: stylesheet },
  { rel: 'icon', type: 'image/svg+xml', href: '/icons/orbis.svg' },
  { rel: 'manifest', href: '/icons/site.webmanifest' },
];

export async function clientLoader({ request }: Route.ActionArgs) {
  const user = await userContext();

  const url = new URL(request.url);
  if (url.pathname !== '/') {
    return user;
  }

  if (!user.data) {
    return redirect('/register');
  }

  if (user.data?.isLoggedIn || user.data?.isGuestDashboardEnabled) {
    return redirect('/dashboard');
  }

  return redirect('/login');
}

export function Layout({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const handlePreloadError = () => {
      window.location.reload();
    };
    window.addEventListener('vite:preloadError', handlePreloadError);

    return () => {
      window.removeEventListener('vite:preloadError', handlePreloadError);
    };
  }, []);

  return (
    <html lang="en">
      <head>
        <title>Orbis</title>
        <meta charSet="UTF-8" />
        <script src="/js/tabler.min.js" async />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <Meta />
        <Links />
      </head>
      <body>
        <main id="root">
          {children}
          <ScrollRestoration />
          <Scripts />
        </main>
      </body>
    </html>
  );
}

export default function App() {
  return (
    <Providers>
      <Outlet />
      <OrbisToaster />
      <ConfirmationDialog />
    </Providers>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = 'Unable to load this page';
  let details = 'Reload the page to try again.';
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? 'Page not found' : 'Unable to load this page';
    details = error.status === 404 ? 'The requested page could not be found.' : error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <FallbackSurface>
      <h1>{message}</h1>
      <p>{details}</p>
      <a href="/dashboard" className="btn btn-primary">
        Open workspace
      </a>
      {stack && (
        <pre className="w-full p-4 overflow-x-auto">
          <code>{stack}</code>
        </pre>
      )}
    </FallbackSurface>
  );
}
