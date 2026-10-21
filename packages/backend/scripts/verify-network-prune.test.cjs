const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const Dockerode = require('dockerode');

test('Dockerode sends the Orbis ownership filter in the Engine request', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbis-prune-'));
  const socketPath = path.join(directory, 'docker.sock');
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ NetworksDeleted: [] }));
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    await new Dockerode({ socketPath }).pruneNetworks({ filters: { label: ['orbis.managed=true'] } });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'POST');
    const url = new URL(requests[0].url, 'http://docker');
    assert.ok(url.pathname.endsWith('/networks/prune'));
    assert.deepEqual(JSON.parse(url.searchParams.get('filters')), { label: ['orbis.managed=true'] });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
