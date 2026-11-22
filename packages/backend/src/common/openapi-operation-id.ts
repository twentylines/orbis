import type { OpenAPIObject } from '@nestjs/swagger';
import { portableJsonSchema } from '@runtipi/common/schemas/portable-json-schema';

// Retain the existing client entry points when expanding the generated API.
const clientNames: Record<string, string> = {
  'GET /api/user-context': 'userContext',
  'GET /api/app-context': 'appContext',
  'PATCH /api/user-settings': 'updateUserSettings',
  'PATCH /api/acknowledge-welcome': 'acknowledgeWelcome',
  'GET /api/system/load': 'systemLoad',
  'GET /api/system/certificate': 'downloadLocalCertificate',
  'GET /api/i18n/locales/{ns}/{lng}.json': 'getTranslation',
  'POST /api/auth/login': 'login',
  'POST /api/auth/verify-totp': 'verifyTotp',
  'POST /api/auth/register': 'register',
  'POST /api/auth/logout': 'logout',
  'POST /api/auth/forward-auth': 'forwardAuth',
  'PATCH /api/auth/username': 'changeUsername',
  'PATCH /api/auth/password': 'changePassword',
  'PATCH /api/auth/totp/get-uri': 'getTotpUri',
  'PATCH /api/auth/totp/setup': 'setupTotp',
  'PATCH /api/auth/totp/disable': 'disableTotp',
  'POST /api/auth/reset-password': 'resetPassword',
  'GET /api/auth/traefik': 'traefik',
  'GET /api/apps/installed': 'getInstalledApps',
  'GET /api/apps/guest': 'getGuestApps',
  'POST /api/apps/random-port': 'getRandomPort',
  'GET /api/apps/{urn}': 'getApp',
  'GET /api/apps/{urn}/compose-diff': 'getAppComposeDiff',
  'GET /api/apps/{urn}/config-diff': 'getAppConfigDiff',
  'PATCH /api/apps/{urn}/ignore-version': 'ignoreAppVersion',
  'PATCH /api/apps/{urn}/unignore-version': 'unignoreAppVersion',
  'GET /api/marketplace/apps/search': 'searchApps',
  'GET /api/marketplace/apps/{urn}/image': 'getImage',
  'POST /api/marketplace/pull': 'pullAppStores',
  'POST /api/marketplace/create': 'createAppStore',
  'GET /api/marketplace/all': 'getAllAppStores',
  'GET /api/marketplace/enabled': 'getEnabledAppStores',
  'PATCH /api/marketplace/{id}': 'updateAppStore',
  'DELETE /api/marketplace/{id}': 'deleteAppStore',
  'POST /api/app-lifecycle/{urn}/install': 'installApp',
  'POST /api/app-lifecycle/{urn}/start': 'startApp',
  'POST /api/app-lifecycle/{urn}/stop': 'stopApp',
  'POST /api/app-lifecycle/{urn}/restart': 'restartApp',
  'DELETE /api/app-lifecycle/{urn}/uninstall': 'uninstallApp',
  'POST /api/app-lifecycle/{urn}/reset': 'resetApp',
  'PATCH /api/app-lifecycle/{urn}/update': 'updateApp',
  'PATCH /api/app-lifecycle/{urn}/update-config': 'updateAppSettings',
  'PATCH /api/app-lifecycle/update-all': 'updateAllApps',
  'POST /api/app-lifecycle/start-all': 'startAllApps',
  'POST /api/app-lifecycle/stop-all': 'stopAllApps',
  'POST /api/app-lifecycle/restart-all': 'restartAllApps',
  'POST /api/backups/{urn}/backup': 'backupApp',
  'POST /api/backups/{urn}/restore': 'restoreAppBackup',
  'GET /api/backups/{urn}': 'getAppBackups',
  'DELETE /api/backups/{urn}': 'deleteAppBackup',
  'GET /api/backups/{urn}/{filename}/download': 'downloadBackup',
  'POST /api/backups/{urn}/upload': 'uploadBackup',
  'GET /api/sse/app': 'appEvents',
  'GET /api/sse/app-logs': 'appLogsEvents',
  'GET /api/sse/runtipi-logs': 'runtipiLogsEvents',
  'GET /api/links/guest': 'getGuestLinks',
  'GET /api/links': 'getLinks',
  'POST /api/links': 'createLink',
  'PATCH /api/links/{id}': 'editLink',
  'DELETE /api/links/{id}': 'deleteLink',
  'GET /api/health': 'check',
  'GET /api/user-config/{urn}': 'getUserConfig',
  'PUT /api/user-config/{urn}': 'updateUserConfig',
  'POST /api/user-config/{urn}/enable': 'enableUserConfig',
  'POST /api/user-config/{urn}/disable': 'disableUserConfig',
  'POST /api/custom-apps': 'createCustomApp',
  'PATCH /api/custom-apps/{urn}': 'updateCustomApp',
  'POST /api/custom-apps/{urn}/image': 'uploadAppImage',
  'PATCH /api/custom-apps/{urn}/metadata': 'updateAppMetadata',
  'GET /api/apps/{urn}/config': 'getEditableAppConfig',
  'POST /api/apps/{urn}/config': 'updateEditableAppConfig',
  'GET /api/apps/{urn}/template/diff': 'getTemplateDiff',
  'POST /api/apps/{urn}/template/sync': 'syncWithTemplate',
  'POST /api/debug/seed': 'seedDatabase',
  'POST /api/debug/set-all-app-update-available': 'setAllAppUpdateAvailable',
  'POST /api/debug/set-all-subnets-to-null': 'setAllAppSubnetToNull',
  'POST /api/debug/start-all-apps': 'startAllApps2',
  'POST /api/debug/backup-all-apps': 'backupAllApps',
  'POST /api/debug/increment-all-app-versions': 'incrementAllAppVersions',
  'POST /api/debug/uninstall-all-apps': 'uninstallAllApps',
  'GET /api/app-lifecycle/{urn}/job': 'getAppJob',
  'POST /api/app-lifecycle/{urn}/jobs/{requestId}/cancel': 'cancelAppJob',
};

export function normalizeOpenApiOperationIds(document: Pick<OpenAPIObject, 'paths' | 'components'>) {
  if (document.components?.schemas) {
    document.components.schemas = Object.fromEntries(
      Object.entries(document.components.schemas).map(([name, schema]) => [name, portableJsonSchema(schema)]),
    );
  }
  const used = new Set(Object.values(clientNames));
  const operations = Object.entries(document.paths).flatMap(([route, methods]) =>
    Object.entries(methods)
      .filter(([method]) => ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(method))
      .map(([method, value]) => ({ route, method, value: value as { operationId?: string; tags?: string[] } })),
  );
  for (const { route, method, value } of operations) {
    const retained = clientNames[`${method.toUpperCase()} ${route}`];
    if (retained) {
      value.operationId = retained;
      continue;
    }
    const original = value.operationId ?? method;
    const tag = (value.tags?.[0] ?? 'operation').replace(/[^a-zA-Z0-9]/g, '');
    const prefix = tag.charAt(0).toLowerCase() + tag.slice(1);
    const fallback =
      method +
      route
        .split(/[^a-zA-Z0-9]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join('');
    let name = original === fallback || original.startsWith(prefix) ? original : prefix + original.charAt(0).toUpperCase() + original.slice(1);
    if (used.has(name)) name = fallback;
    if (used.has(name)) throw new Error('API operation names are not unique.');
    value.operationId = name;
    used.add(name);
  }
  const names = operations.map(({ value }) => value.operationId);
  if (new Set(names).size !== names.length) throw new Error('API operation names are not unique.');
  return document;
}
