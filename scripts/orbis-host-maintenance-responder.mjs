import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

const socketPath = '/run/orbis/host.sock';
const assets = '/app/assets/frontend';
const states = new Set(['idle', 'restoring', 'updating', 'downgrading', 'recovery', 'checking']);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export function permittedDuringMaintenance(method, pathname) {
  if (
    method === 'GET' &&
    /^\/api\/(?:health|user-context|installation\/status|system\/build|host-updates\/status|system-backups\/restores|auth\/passkeys\/availability)\/?$/.test(
      pathname,
    )
  )
    return true;
  if (method === 'POST' && /^\/api\/auth\/(?:login|logout|verify-totp|passkeys\/login\/(?:options|verify))\/?$/.test(pathname)) return true;
  return (
    method === 'POST' &&
    (/^\/api\/host-updates\/recover\/?$/.test(pathname) ||
      /^\/api\/system-backups\/restores\/[a-f0-9-]{36}\/(?:recover|cancel)\/?$/.test(pathname) ||
      /^\/api\/system-backups\/time-machine\/points\/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\/recover\/?$/.test(pathname))
  );
}

export function assetName(raw, accept = '') {
  const pathname = decodeURIComponent(new URL(raw, 'http://localhost').pathname);
  if (pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some((part) => part === '..' || part === '.'))
    throw new Error('Invalid asset');
  const relative = pathname.replace(/^\/+/, '');
  return !relative || (!path.extname(relative) && accept.includes('text/html')) ? 'index.html' : relative;
}

async function rootState(route) {
  const before = await fs.lstat(socketPath);
  if (!before.isSocket() || before.uid !== 0 || before.mode & 0o077) throw new Error('Unavailable');
  const state = await new Promise((resolve, reject) => {
    const request = http.get({ socketPath, path: route, timeout: 2000 }, (response) => {
      let size = 0;
      const chunks = [];
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > 1024) {
          response.destroy();
          reject(new Error('Unavailable'));
        } else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (
            response.statusCode !== 200 ||
            !value ||
            typeof value !== 'object' ||
            Array.isArray(value) ||
            Object.keys(value).join() !== 'state' ||
            !states.has(value.state)
          )
            throw new Error('Unavailable');
          resolve(value.state);
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('Unavailable')));
    request.on('error', reject);
  });
  const after = await fs.lstat(socketPath);
  if (['dev', 'ino', 'mode', 'uid'].some((key) => before[key] !== after[key])) throw new Error('Unavailable');
  return state;
}

export async function maintenanceState(read = rootState) {
  try {
    const restore = await read('/v1/retained-restore/maintenance');
    if (restore !== 'idle') return { state: restore };
    return { state: await read('/v1/core-operation/maintenance') };
  } catch {
    return { state: 'checking' };
  }
}

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(body));
}

function proxy(request, response) {
  const headers = { ...request.headers };
  for (const key of ['connection', 'proxy-connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer']) delete headers[key];
  headers.connection = 'close';
  const upstream = http.request(
    { hostname: 'runtipi', port: 3000, path: request.url, method: request.method, headers, timeout: 5000 },
    (incoming) => {
      const resultHeaders = { ...incoming.headers, 'cache-control': 'no-store' };
      for (const key of ['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer']) delete resultHeaders[key];
      response.writeHead(incoming.statusCode ?? 503, resultHeaders);
      incoming.pipe(response);
      incoming.on('error', () => response.destroy());
    },
  );
  upstream.on('timeout', () => upstream.destroy());
  upstream.on('error', () => {
    if (response.headersSent) response.destroy();
    else json(response, 503, { code: 'ORBIS_MAINTENANCE', message: 'The server is reconnecting.' });
  });
  let count = 0;
  request.on('data', (chunk) => {
    count += chunk.length;
    if (count > 1024 * 1024) {
      upstream.destroy();
      request.destroy();
    }
  });
  request.on('aborted', () => upstream.destroy());
  request.pipe(upstream);
}

export function createMaintenanceServer(options = {}) {
  const read = options.readState ?? maintenanceState;
  const directory = options.assets ?? assets;
  const forward = options.proxy ?? proxy;
  return http.createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      const state = await read();
      if (['GET', 'HEAD'].includes(request.method) && /^\/api\/system\/(?:restoration-status|operation-status)\/?$/.test(pathname))
        return json(response, 200, state);
      if (request.method === 'GET' && pathname === '/api/health') return json(response, 200, { status: 'ok', maintenance: state.state !== 'idle' });
      if (state.state === 'idle' || permittedDuringMaintenance(request.method, pathname)) return forward(request, response);
      if (pathname.startsWith('/api/') || !['GET', 'HEAD'].includes(request.method))
        return json(response, 503, { code: 'ORBIS_RESTORATION_IN_PROGRESS', message: 'Restoration is in progress.' });
      const name = assetName(request.url, request.headers.accept);
      const file = path.join(directory, name);
      if (!file.startsWith(`${directory}/`)) throw new Error('Unavailable');
      const details = await fs.lstat(file);
      if (!details.isFile() || details.isSymbolicLink() || details.size > 32 * 1024 * 1024 || (await fs.realpath(file)) !== file)
        throw new Error('Unavailable');
      const body = request.method === 'HEAD' ? undefined : await fs.readFile(file);
      response.writeHead(200, {
        'Content-Type': types[path.extname(file)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
        'Content-Length': details.size,
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(body);
    } catch {
      if (response.headersSent) response.destroy();
      else json(response, 503, { code: 'ORBIS_MAINTENANCE', message: 'The server is reconnecting.' });
    }
  });
}

if (process.env.ORBIS_MAINTENANCE_RESPONDER === '1') {
  const server = createMaintenanceServer();
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;
  server.maxHeadersCount = 64;
  server.listen(3000, '0.0.0.0');
}
