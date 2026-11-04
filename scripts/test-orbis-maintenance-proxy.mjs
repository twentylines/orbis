import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import http from 'node:http';
import { createMaintenanceServer, proxyToOrbis } from './orbis-host-maintenance-responder.mjs';

const servers = [];
afterEach(async () => {
  for (const server of servers.splice(0).reverse()) {
    if (!server.listening) continue;
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }
});

async function listen(server) {
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function forwardingServer(upstreamPort) {
  return listen(
    createMaintenanceServer({
      readState: async () => ({ state: 'idle' }),
      proxy: (request, response) => proxyToOrbis(request, response, { hostname: '127.0.0.1', port: upstreamPort, timeoutMs: 100 }),
    }),
  );
}

test('idle SSE outlives the ordinary timeout and client disconnect closes upstream', { timeout: 3000 }, async () => {
  let finish;
  const closed = new Promise((resolve) => {
    finish = resolve;
  });
  const upstream = await listen(
    http.createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      response.flushHeaders();
      const timer = setTimeout(() => response.write('data: fixture\n\n'), 250);
      response.once('close', () => {
        clearTimeout(timer);
        finish();
      });
    }),
  );
  const gateway = await forwardingServer(upstream);
  const abort = new AbortController();
  const response = await fetch(`http://127.0.0.1:${gateway}/api/sse/app`, { signal: abort.signal });
  const chunk = await response.body.getReader().read();
  assert.match(new TextDecoder().decode(chunk.value), /data: fixture/);
  abort.abort();
  await closed;
});

test('ordinary stalled responses keep the bounded timeout', { timeout: 3000 }, async () => {
  const upstream = await listen(
    http.createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.write('fixture');
    }),
  );
  const gateway = await forwardingServer(upstream);
  const response = await fetch(`http://127.0.0.1:${gateway}/ordinary`);
  await assert.rejects(response.text());
});

test('a stalled response before headers returns unavailable', { timeout: 3000 }, async () => {
  const upstream = await listen(http.createServer(() => undefined));
  const gateway = await forwardingServer(upstream);
  assert.equal((await fetch(`http://127.0.0.1:${gateway}/unavailable`)).status, 503);
});

test('archive uploads above one MiB reach the upstream without truncation', { timeout: 3000 }, async () => {
  const size = 1024 * 1024 + 8192;
  const upstream = await listen(
    http.createServer((request, response) => {
      let received = 0;
      request.on('data', (chunk) => {
        received += chunk.length;
      });
      request.on('end', () => response.end(String(received)));
    }),
  );
  const gateway = await forwardingServer(upstream);
  const response = await fetch(`http://127.0.0.1:${gateway}/api/system-backups/imports/fixture/upload`, {
    method: 'POST',
    body: new Uint8Array(size),
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), String(size));
});

test('the production timeout permits a verified request taking more than five seconds', { timeout: 8000 }, async () => {
  const upstream = await listen(
    http.createServer((_request, response) => {
      const timer = setTimeout(() => response.end('fixture plan'), 5500);
      response.once('close', () => clearTimeout(timer));
    }),
  );
  const gateway = await listen(
    http.createServer((request, response) =>
      proxyToOrbis(request, response, {
        hostname: '127.0.0.1',
        port: upstream,
      }),
    ),
  );
  const response = await fetch(`http://127.0.0.1:${gateway}/api/host-updates/plan`, { method: 'POST', body: '{}' });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'fixture plan');
});
