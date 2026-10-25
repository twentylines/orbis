const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');
const tls = require('node:tls');
const { execFileSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const { chromium } = require('@playwright/test');

process.umask(0o077);
const root = (process.env.ORBIS_QA_AUTH_ROOT || '/opt/orbis-qa/auth');
const contextName = 'colima-orbis-amd64-test';
const base = 'https://orbis-auth.local:19443';
const rootHost = new URL(base).hostname;
const hosts = ['one.orbis-auth.local', 'two.orbis-auth.local'];
const forwardCookieName = 'runtipi-forward-auth';
const releaseFile = process.env.ORBIS_AUDIT_RELEASE_FILE;
const output = process.env.ORBIS_AUDIT_PROXY_OUTPUT;
const expected = {
  tag: process.env.ORBIS_AUDIT_EXPECTED_TAG,
  commit: process.env.ORBIS_AUDIT_EXPECTED_COMMIT,
  digest: process.env.ORBIS_AUDIT_EXPECTED_DIGEST,
};
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const privateFile = (file) => {
  assert.ok(file === fs.realpathSync(file) || fs.realpathSync(file) === file.replace(/^\/tmp\//, '/private/tmp/'), 'Unexpected input path');
  const s = fs.lstatSync(file);
  assert.ok(s.isFile() && !s.isSymbolicLink() && s.uid === process.getuid() && (s.mode & 0o077) === 0, 'Input must be a private owned file');
  return fs.readFileSync(file, 'utf8');
};
const dockerJson = (...args) => JSON.parse(execFileSync('docker', ['--context', contextName, ...args], { encoding: 'utf8' }));
const stable = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && !Array.isArray(item) && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item,
  );
const report = {
  passed: false,
  release: expected,
  scope:
    'Actual published core and existing runtipi@docker middleware, two read-only non-root fixture services, scoped HTTPS, real browser app-host requests and isolated authentication sessions/grants. No production state or enrollment calls.',
  rootRequests: [],
  browserRequests: 0,
  blockedRequests: [],
  pageErrors: [],
  checks: {},
};
let browser;
let sessionCookie = '';
let certificate;
let credentials;
let beforeAccount;
let rootPreferences;
let stage = 'preflight';
let outputReady = false;
const contexts = [];
const rootRequest = async (method, path, body, cookie = sessionCookie) => {
  assert.ok(
    (method === 'GET' && ['/api/user-context', '/api/system/build', '/api/desktop-preferences'].includes(path)) ||
      (method === 'POST' && ['/api/auth/login', '/api/auth/verify-totp', '/api/auth/forward-auth', '/api/auth/logout'].includes(path)),
    'Unapproved authentication request',
  );
  const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const result = await new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: '127.0.0.1',
        port: 19443,
        servername: rootHost,
        ca: certificate,
        checkServerIdentity: (_host, cert) => tls.checkServerIdentity(rootHost, cert),
        method,
        path,
        timeout: 15000,
        headers: {
          Host: `${rootHost}:19443`,
          Origin: base,
          ...(cookie ? { Cookie: cookie } : {}),
          ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length } : {}),
        },
      },
      (response) => {
        let raw = '';
        response.on('data', (part) => {
          raw += part;
        });
        response.on('end', () => {
          try {
            resolve({ status: response.statusCode, body: raw ? JSON.parse(raw) : null, cookies: response.headers['set-cookie'] || [] });
          } catch {
            reject(new Error('Scoped HTTPS response was not JSON'));
          }
        });
      },
    );
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error('Scoped HTTPS request timed out')));
    if (bytes) request.write(bytes);
    request.end();
  });
  report.rootRequests.push({ method, path, status: result.status });
  return result;
};
const accountRecord = () => {
  const query = 'select row_to_json(t) from (select id,username,password,totp_enabled,totp_secret,salt from "user" order by id) t;';
  return execFileSync('docker', ['--context', contextName, 'exec', 'runtipi-db', 'psql', '-U', 'tipi', '-d', 'tipi', '-At', '-c', query], {
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
};
const totp = () => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const letter of credentials.totpSecret.replace(/=+$/, '').toUpperCase()) {
    const value = alphabet.indexOf(letter);
    assert.ok(value >= 0, 'Invalid private seed encoding');
    bits += value.toString(2).padStart(5, '0');
  }
  const key = Buffer.from(bits.match(/.{8}/g).map((byte) => Number.parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = crypto.createHmac('sha1', key).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
};
async function newContext() {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  contexts.push(context);
  const allowed = new Set([base, ...hosts.map((host) => `https://${host}:19443`)]);
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!allowed.has(url.origin) || !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      report.blockedRequests.push({ origin: url.origin, path: url.pathname, method: request.method() });
      return route.abort('blockedbyclient');
    }
    report.browserRequests++;
    return route.continue();
  });
  context.on('page', (page) =>
    page.on('pageerror', (error) => report.pageErrors.push({ type: error.name, messageHash: hash(String(error.message)) })),
  );
  return context;
}
async function expectApp(context, url, index) {
  const page = await context.newPage();
  const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
  assert.equal(response.status(), 200, 'Fixture app request failed');
  const location = new URL(page.url());
  assert.equal(location.hostname, hosts[index], 'App request left its assigned host');
  assert.equal(location.pathname, '/healthboard');
  assert.equal(location.searchParams.get('view'), 'summary');
  assert.equal(location.searchParams.has('runtipi_forward_auth'), false, 'Grant remained in final URL');
  const data = JSON.parse(await page.locator('body').innerText());
  assert.ok(data.fixture === `orbis-auth-app-${index === 0 ? 'one' : 'two'}` && data.path === '/healthboard', 'Wrong fixture service answered');
  assert.ok(data.hasGrantParam === false && data.hasDashboardCookie === false, 'Backend saw a dashboard cookie or grant');
  const cookie = (await context.cookies(`https://${hosts[index]}:19443`)).find((item) => item.name === forwardCookieName);
  assert.ok(
    cookie && cookie.domain === hosts[index] && cookie.path === '/' && cookie.secure && cookie.httpOnly && cookie.sameSite === 'Lax',
    'App cookie must be secure, HttpOnly and host-only',
  );
  assert.ok(!(await context.cookies()).some((item) => item.name === 'runtipi-sid'), 'Dashboard cookie entered an app browser context');
  await page.close();
  return cookie;
}
async function expectLogin(context, url) {
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const location = new URL(page.url());
  assert.ok(location.origin === base && location.pathname === '/login', 'Rejected app request must reach the real login route');
  await page.locator('input[name="email"]').waitFor();
  await page.close();
}
async function grant(index) {
  const target = `https://${hosts[index]}:19443/healthboard?view=summary`;
  const result = await rootRequest('POST', '/api/auth/forward-auth', { redirectUrl: target });
  assert.equal(result.status, 201, 'Authenticated grant request failed');
  const parsed = new URL(result.body.redirectUrl);
  assert.ok(parsed.origin === new URL(target).origin && parsed.searchParams.has('runtipi_forward_auth'), 'Grant target mismatch');
  return parsed.toString();
}
(async () => {
  try {
    assert.equal(process.env.ORBIS_ALLOW_COPIED_PROXY_AUDIT, '1');
    assert.match(expected.tag || '', /^v\d+\.\d+\.\d+(?:-beta\.\d+)?$/);
    assert.match(expected.commit || '', /^[a-f0-9]{40}$/);
    assert.match(expected.digest || '', /^sha256:[a-f0-9]{64}$/);
    assert.ok(
      output &&
        path.resolve(output) === output &&
        path.dirname(output) === '/tmp' &&
        /^orbis-forward-auth-[a-z0-9.-]+$/.test(path.basename(output)) &&
        !fs.existsSync(output),
      'Output must be a new fixture evidence directory',
    );
    const release = JSON.parse(privateFile(releaseFile));
    assert.ok(
      release.tag === expected.tag && release.commit === expected.commit && release.image === `ghcr.io/twentylines/orbis@${expected.digest}`,
      'Independent release pins mismatch',
    );
    assert.equal(execFileSync('docker', ['context', 'show'], { encoding: 'utf8' }).trim(), 'default');
    const core = dockerJson('inspect', 'runtipi')[0];
    assert.ok(
      core.Config.Image === release.image &&
        core.State.Health.Status === 'healthy' &&
        core.Config.Labels['com.docker.compose.project.working_dir'] === root,
      'Owned copied core mismatch',
    );
    assert.equal(core.Config.Labels['traefik.http.middlewares.runtipi.forwardauth.address'], 'http://runtipi:3000/api/auth/traefik');
    for (const name of ['orbis-auth-app-one', 'orbis-auth-app-two']) {
      const app = dockerJson('inspect', name)[0];
      assert.ok(
        app.Config.Image === release.image &&
          app.Config.Labels['com.docker.compose.project'] === 'orbis-forward-auth-qa' &&
          app.State.Running &&
          app.HostConfig.ReadonlyRootfs &&
          app.Config.User === '1000:1000' &&
          app.Mounts.length === 0 &&
          Object.keys(app.HostConfig.PortBindings || {}).length === 0,
        'Owned app fixture bounds mismatch',
      );
    }
    certificate = Buffer.from(privateFile(`${root}/runtime-cert.pem`));
    credentials = JSON.parse(privateFile(`${root}/test-credentials.json`));
    beforeAccount = JSON.parse(privateFile(`${root}/stock-account-records.json`));
    assert.ok(isDeepStrictEqual(accountRecord(), beforeAccount), 'Copied stock account baseline changed');
    fs.mkdirSync(output, { mode: 0o700 });
    outputReady = true;
    stage = 'retained authenticator login';
    let response = await rootRequest('POST', '/api/auth/login', { username: credentials.username, password: credentials.password });
    assert.ok(
      response.status === 201 && response.body.totpSessionId && !response.cookies.some((cookie) => /^runtipi-sid=[^;]/.test(cookie)),
      'Password alone must stay signed out',
    );
    response = await rootRequest('POST', '/api/auth/verify-totp', { totpSessionId: response.body.totpSessionId, totpCode: totp() });
    assert.equal(response.status, 201);
    const sid = response.cookies.find((cookie) => /^runtipi-sid=[^;]/.test(cookie));
    assert.ok(
      sid && /;\s*Secure(?:;|$)/i.test(sid) && /;\s*HttpOnly(?:;|$)/i.test(sid) && /;\s*SameSite=Lax(?:;|$)/i.test(sid) && !/;\s*Domain=/i.test(sid),
      'Dashboard cookie flags failed',
    );
    sessionCookie = sid.split(';')[0];
    response = await rootRequest('GET', '/api/system/build');
    assert.ok(
      response.status === 200 &&
        response.body.version === expected.tag &&
        response.body.commit === expected.commit &&
        response.body.imageDigest === expected.digest,
      'Actual build mismatch',
    );
    rootPreferences = (await rootRequest('GET', '/api/desktop-preferences')).body;
    const cert = new crypto.X509Certificate(certificate);
    assert.ok(
      hosts.every((host) => Boolean(cert.checkHost(host))),
      'Fixture certificate must cover both application hosts',
    );
    const spki = hash(cert.publicKey.export({ type: 'spki', format: 'der' }));
    browser = await chromium.launch({
      headless: true,
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      args: [
        '--no-proxy-server',
        '--host-resolver-rules=MAP orbis-auth.local 127.0.0.1, MAP *.orbis-auth.local 127.0.0.1',
        `--ignore-certificate-errors-spki-list=${Buffer.from(spki, 'hex').toString('base64')}`,
      ],
    });
    const one = await newContext();
    const two = await newContext();
    stage = 'unsigned app hosts';
    await expectLogin(one, `https://${hosts[0]}:19443/healthboard?view=summary`);
    await expectLogin(two, `https://${hosts[1]}:19443/healthboard?view=summary`);
    report.checks.unsignedHostsRequireLogin = true;
    stage = 'first grant and reload';
    const firstGrant = await grant(0);
    const firstCookie = await expectApp(one, firstGrant, 0);
    await expectApp(one, `https://${hosts[0]}:19443/healthboard?view=summary`, 0);
    report.checks.appOneGrantCookieAndReload = true;
    stage = 'consumed grant replay';
    await expectLogin(await newContext(), firstGrant);
    report.checks.consumedGrantRejected = true;
    stage = 'second independent host';
    const secondCookie = await expectApp(two, await grant(1), 1);
    assert.ok(firstCookie.value !== secondCookie.value, 'App hosts shared a session identifier');
    await expectApp(two, `https://${hosts[1]}:19443/healthboard?view=summary`, 1);
    report.checks.appTwoIndependentCookieAndReload = true;
    stage = 'cross-host cookie';
    const transplanted = await newContext();
    await transplanted.addCookies([{ ...firstCookie, domain: hosts[1] }]);
    await expectLogin(transplanted, `https://${hosts[1]}:19443/healthboard?view=summary`);
    report.checks.transplantedAppCookieRejected = true;
    stage = 'cross-host grant';
    const bound = await grant(0);
    const moved = new URL(bound);
    moved.hostname = hosts[1];
    await expectLogin(await newContext(), moved.toString());
    await expectLogin(await newContext(), bound);
    report.checks.crossHostGrantRejectedAndConsumed = true;
    stage = 'app cookie cannot access administration';
    response = await rootRequest('GET', '/api/system/build', undefined, `${forwardCookieName}=${firstCookie.value}`);
    assert.equal(response.status, 401);
    report.checks.appCookieCannotAuthenticateDashboardApi = true;
    stage = 'grant expiry';
    const expires = await grant(0);
    const started = Date.now();
    while (Date.now() - started < 61_000) await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 61_000 - (Date.now() - started))));
    await expectLogin(await newContext(), expires);
    report.checks.expiredGrantRejected = true;
    report.expiryWaitMs = Date.now() - started;
    stage = 'logout revocation';
    const pending = await grant(1);
    assert.ok(isDeepStrictEqual((await rootRequest('GET', '/api/desktop-preferences')).body, rootPreferences), 'Saved preferences changed');
    response = await rootRequest('POST', '/api/auth/logout');
    assert.equal(response.status, 204);
    assert.equal((await rootRequest('GET', '/api/user-context')).body.isLoggedIn, false);
    report.checks.newRootSessionClosed = true;
    await expectLogin(one, `https://${hosts[0]}:19443/healthboard?view=summary`);
    await expectLogin(two, `https://${hosts[1]}:19443/healthboard?view=summary`);
    await expectLogin(await newContext(), pending);
    report.checks.logoutRevokesBothAppSessionsAndPendingGrant = true;
    assert.ok(isDeepStrictEqual(accountRecord(), beforeAccount), 'Copied account changed');
    assert.ok(report.blockedRequests.length === 0 && report.pageErrors.length === 0, 'Unexpected browser request or error');
    report.checks.accountAndPreferencesRetained = true;
    report.accountBaselineSha256 = hash(stable(beforeAccount));
    report.passed = true;
  } catch (error) {
    report.failure = { stage, type: error.name, messageHash: hash(String(error.message)) };
  } finally {
    if (sessionCookie && !report.checks.newRootSessionClosed) {
      try {
        const closed = await rootRequest('POST', '/api/auth/logout');
        const check = await rootRequest('GET', '/api/user-context');
        report.checks.newRootSessionClosed = closed.status === 204 && check.status === 200 && check.body.isLoggedIn === false;
      } catch {
        report.cleanupFailure = true;
      }
    }
    await Promise.all(
      contexts.map((context) =>
        context.close().catch(() => {
          report.cleanupFailure = true;
        }),
      ),
    );
    await browser?.close().catch(() => {
      report.cleanupFailure = true;
    });
    report.browsersClosed = true;
    if (report.cleanupFailure || (sessionCookie && !report.checks.newRootSessionClosed)) report.passed = false;
    if (outputReady) fs.writeFileSync(`${output}/report.json`, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (!report.passed) process.exitCode = 1;
  }
})().catch(() => {
  console.error('Proxy authentication audit failed; private request/session details omitted.');
  process.exitCode = 1;
});
