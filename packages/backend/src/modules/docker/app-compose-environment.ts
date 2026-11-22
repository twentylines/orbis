// Compose interpolation must see the explicit app/user files, never private Core process values.
const cliVariables = [
  'PATH',
  'HOME',
  'DOCKER_CONFIG',
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_CERT_PATH',
  'DOCKER_TLS_VERIFY',
  'DOCKER_API_VERSION',
  'DOCKER_DEFAULT_PLATFORM',
  'DOCKER_CLIENT_TIMEOUT',
  'COMPOSE_HTTP_TIMEOUT',
  'COMPOSE_PARALLEL_LIMIT',
  'DOCKER_BUILDKIT',
  'BUILDX_CONFIG',
  'SSH_AUTH_SOCK',
] as const;
export function appComposeEnvironment(localSocket = false, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const selected: NodeJS.ProcessEnv = {};
  for (const name of cliVariables) if (source[name] !== undefined) selected[name] = source[name];
  if (localSocket) {
    selected.DOCKER_HOST = 'unix:///var/run/docker.sock';
    selected.DOCKER_CONTEXT = '';
    selected.DOCKER_TLS_VERIFY = '';
    delete selected.SSH_AUTH_SOCK;
  }
  return selected;
}
