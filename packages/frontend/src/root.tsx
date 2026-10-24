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
import { StartupBoundary, useStartupReady } from './components/startup/startup-boundary';
import { appearanceBootstrap } from './desktop/appearance-cache';
import { sessionExitBootstrap } from './desktop/session-motion';
import { coreUpdateIsPending } from './desktop/host-update-watch';
import { claimPreloadRetry } from './components/startup/preload-retry';

export const links: Route.LinksFunction = () => [
  { rel: 'preload', href: '/fonts/source-sans-3-variable.woff2', as: 'font', type: 'font/woff2', crossOrigin: 'anonymous' },
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

export function HydrateFallback() {
  return null;
}

export function Layout({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const handlePreloadError = (event: Event) => {
      if (coreUpdateIsPending()) {
        event.preventDefault();
        return;
      }
      try {
        if (claimPreloadRetry(window.sessionStorage, Date.now())) {
          event.preventDefault();
          window.location.reload();
        }
      } catch {
        // Keep the error boundary available when this browser blocks session storage.
      }
    };
    window.addEventListener('vite:preloadError', handlePreloadError);

    return () => {
      window.removeEventListener('vite:preloadError', handlePreloadError);
    };
  }, []);

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <title>Orbis</title>
        <meta charSet="UTF-8" />
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: Only static code and a fixed allowlist enter this script. */}
        <script data-orbis-appearance dangerouslySetInnerHTML={{ __html: appearanceBootstrap }} />
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: Static code reads only a timestamp from this tab's session storage. */}
        <script data-orbis-session dangerouslySetInnerHTML={{ __html: sessionExitBootstrap }} />
        <script src="/js/tabler.min.js" async />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <Meta />
        <Links />
      </head>
      <body>
        <main id="root" tabIndex={-1}>
          <StartupBoundary>{children}</StartupBoundary>
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
  useStartupReady(true);
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
