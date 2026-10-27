import { type RouteConfig, index, layout, prefix, route } from '@react-router/dev/routes';

export default [
  // Unauthenticated routes
  layout('./components/routes/unauthenticated-route.tsx', [
    route('login', './modules/auth/pages/login-page.tsx', { id: 'login' }),
    route('register', './modules/auth/pages/register-page.tsx', { id: 'register' }),
    route('reset-password', './modules/auth/pages/login-page.tsx', { id: 'reset-password' }),
  ]),
  route('playground', './modules/playground/pages/playground-page.tsx', { id: 'playground' }),
  // Authenticated routes
  layout('./components/routes/authenticated-route.tsx', [
    route('dashboard', './modules/dashboard/pages/dashboard.tsx', { id: 'dashboard' }),
    route('monitor', './modules/dashboard/pages/monitor.tsx', { id: 'monitor' }),
    route('updates', './modules/updates/pages/updates.tsx', { id: 'updates' }),
    route('tasks', './modules/tasks/pages/tasks.tsx', { id: 'tasks' }),

    // App store routes
    ...prefix('app-store', [
      layout('./modules/app/pages/app-store-layout.tsx', [
        index('./modules/app/pages/app-store-index.tsx', { id: 'app-store' }),
        route(':storeId', './modules/app/pages/app-store-index.tsx', { id: 'app-store-id' }),
        route(':storeId/:appId', './modules/app/pages/app-details-page.tsx', { id: 'app-details-store' }),
      ]),
      route(':storeId/:appId/update', './modules/app/pages/app-update-page.tsx', { id: 'app-store-app-update' }),
    ]),

    // My apps routes
    ...prefix('apps', [
      layout('./modules/app/pages/installed-apps-layout.tsx', [
        index('./modules/app/pages/app-store-index.tsx', { id: 'my-apps' }),
        route('servers/:serverId/:storeId/:appId', './modules/app/pages/cluster-app-preview.tsx', { id: 'cluster-app-preview' }),
        route(':appId', './modules/app/pages/custom-app-details-page.tsx', { id: 'custom-app' }),
        route(':storeId/:appId', './modules/app/pages/app-details-page.tsx', { id: 'app-details' }),
        route(':storeId/:appId/edit', './modules/app/pages/app-edit-page.tsx', { id: 'app-edit' }),
        route(':appId/edit', './modules/app/pages/app-edit-page.tsx', { id: 'app-edit-custom' }),
      ]),
      route('create', './modules/app/pages/custom-app-create-page.tsx', { id: 'custom-app-create' }),
      route(':storeId/:appId/update', './modules/app/pages/app-update-page.tsx', { id: 'app-update' }),
    ]),

    // Settings route
    ...prefix('settings', [index('./modules/settings/pages/settings-page.tsx', { id: 'settings' })]),
  ]),
  route('*', './routes/not-found.tsx'),
] satisfies RouteConfig;
