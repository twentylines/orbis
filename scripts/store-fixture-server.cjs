// Read-only smart HTTP Git endpoint for an isolated Docker acceptance rehearsal.
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

if (process.env.ORBIS_ALLOW_STORE_FIXTURE !== '1') throw new Error('Explicit fixture opt-in required');
const root = path.resolve(process.env.ORBIS_STORE_FIXTURE_ROOT || '/fixtures/repos');
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://fixture');
  const allowed =
    (request.method === 'GET' && url.pathname === '/orbis-qa.git/info/refs' && url.searchParams.get('service') === 'git-upload-pack') ||
    (request.method === 'POST' && url.pathname === '/orbis-qa.git/git-upload-pack');
  if (!allowed) {
    response.writeHead(404).end();
    return;
  }
  const backend = spawn('git', ['http-backend'], {
    env: {
      ...process.env,
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: '1',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'safe.directory',
      GIT_CONFIG_VALUE_0: path.join(root, 'orbis-qa.git'),
      PATH_INFO: url.pathname,
      QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: request.method,
      CONTENT_TYPE: request.headers['content-type'] || '',
      CONTENT_LENGTH: request.headers['content-length'] || '',
      REMOTE_ADDR: request.socket.remoteAddress || '',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let prefix = Buffer.alloc(0);
  let sentHeaders = false;
  backend.stdout.on('data', (chunk) => {
    if (sentHeaders) {
      response.write(chunk);
      return;
    }
    prefix = Buffer.concat([prefix, chunk]);
    const separator = prefix.indexOf('\r\n\r\n');
    if (separator === -1) return;
    const headers = {};
    let status = 200;
    for (const line of prefix.subarray(0, separator).toString().split('\r\n')) {
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      const name = line.slice(0, colon).toLowerCase();
      const value = line.slice(colon + 1).trim();
      if (name === 'status') status = Number.parseInt(value, 10);
      else headers[name] = value;
    }
    response.writeHead(status, headers);
    sentHeaders = true;
    response.write(prefix.subarray(separator + 4));
    prefix = Buffer.alloc(0);
  });
  backend.on('error', () => {
    if (!sentHeaders) response.writeHead(500);
    response.end();
  });
  backend.on('close', (code) => {
    if (!sentHeaders) response.writeHead(code ? 500 : 502);
    response.end();
  });
  response.on('close', () => {
    if (!backend.killed) backend.kill();
  });
  backend.stdin.on('error', () => {});
  backend.stderr.on('data', () => {});
  request.pipe(backend.stdin);
});
server.listen(9418, '0.0.0.0');
