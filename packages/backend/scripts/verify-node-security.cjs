const assert = require('node:assert/strict');

const minimum = [22, 23, 4];
const verifyNodeSecurity = (version = process.versions.node) => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  assert.ok(match, 'Cannot verify the Node.js security version');
  const [major, minor, patch] = match.slice(1).map(Number);
  assert.ok(
    major === minimum[0] && (minor > minimum[1] || (minor === minimum[1] && patch >= minimum[2])),
    `Orbis requires Node.js 22.23.4 or a newer Node.js 22 release; found ${version}. See the October 2026 Node.js security advisory.`,
  );
  return { node: version, securityBaseline: minimum.join('.') };
};

module.exports = { verifyNodeSecurity };

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(verifyNodeSecurity())}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
