const assert = require('node:assert/strict');
const { test } = require('node:test');
const { verifyNodeSecurity } = require('./verify-node-security.cjs');

test('rejects the previously shipped runtime and versions before the security release', () => {
  for (const version of ['22.21.1', '22.23.3', '22.9.99', '22.0.0']) {
    assert.throws(() => verifyNodeSecurity(version), /requires Node.js 22.23.4/);
  }
});

test('accepts the patched release and subsequent patches on the supported line', () => {
  for (const version of ['22.23.4', 'v22.23.4', '22.23.5', '22.24.0']) {
    assert.equal(verifyNodeSecurity(version).securityBaseline, '22.23.4');
  }
});

test('does not assume another major release has the same security floor', () => {
  for (const version of ['20.99.99', '24.22.1', '26.12.1']) {
    assert.throws(() => verifyNodeSecurity(version), /requires Node.js 22.23.4/);
  }
});

test('rejects unverified prerelease and malformed versions', () => {
  for (const version of ['', '22', '22.23', '22.23.4-rc.1', '22.23.4-extra', 'anything']) {
    assert.throws(() => verifyNodeSecurity(version), /Cannot verify/);
  }
});

test('verifies the Node.js process executing these tests', () => {
  assert.equal(verifyNodeSecurity().node, process.versions.node);
});
