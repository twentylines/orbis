const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { chromium } = require('@playwright/test');

const root = (process.env.ORBIS_QA_INSTALL_ROOT || '/opt/orbis-qa/install');
const base = 'http://127.0.0.1:18080';
const tag = process.env.ORBIS_AUDIT_EXPECTED_TAG;
const commit = process.env.ORBIS_AUDIT_EXPECTED_COMMIT;
const digest = process.env.ORBIS_AUDIT_EXPECTED_DIGEST;
const releaseFile = process.env.ORBIS_AUDIT_RELEASE_FILE;
const rejectFirst = process.env.ORBIS_AUDIT_REJECT_LOGIN_FIRST === '1';
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const privateRead = (file, fixture = false) => {
  assert.ok(path.isAbsolute(file) && path.resolve(file) === file);
  const stat = fs.lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid());
  if (fixture) {
    assert.ok([`${root}/test-cookies.txt`, `${root}/test-credentials.json`].includes(file));
    assert.equal(fs.realpathSync(file), file);
    assert.equal(stat.mode & 0o077, 0);
  } else assert.ok(file.startsWith('/tmp/') && fs.realpathSync(file).startsWith(`${fs.realpathSync('/tmp')}/`));
  return fs.readFileSync(file, 'utf8');
};

(async () => {
  process.umask(0o077);
  assert.equal(process.env.ORBIS_ALLOW_LOGIN_AUDIT, '1');
  assert.match(tag || '', /^v\d+\.\d+\.\d+(?:-beta\.\d+)?$/);
  assert.match(commit || '', /^[a-f0-9]{40}$/);
  assert.match(digest || '', /^sha256:[a-f0-9]{64}$/);
  const release = JSON.parse(privateRead(releaseFile));
  assert.ok(release.tag === tag && release.commit === commit && release.image === `ghcr.io/twentylines/orbis@${digest}`);
  const credentials = JSON.parse(privateRead(`${root}/test-credentials.json`, true));
  assert.ok(typeof credentials.username === 'string' && typeof credentials.password === 'string');
  const rejectedPassword = `orbis-invalid-${crypto.randomBytes(12).toString('hex')}`;
  assert.notEqual(rejectedPassword, credentials.password);
  const cookies = privateRead(`${root}/test-cookies.txt`, true)
    .split('\n')
    .filter((line) => line && (!line.startsWith('#') || line.startsWith('#HttpOnly_')))
    .map((line) => {
      const [domain, , cookiePath, secure, expires, name, value] = line.split('\t');
      assert.equal(domain.replace(/^#HttpOnly_/, ''), '127.0.0.1');
      return {
        domain: '127.0.0.1',
        path: cookiePath,
        secure: secure === 'TRUE',
        expires: Number(expires) || -1,
        name,
        value,
        httpOnly: domain.startsWith('#HttpOnly_'),
      };
    });
  assert.ok(cookies.some((cookie) => cookie.name === 'runtipi-sid'));
  const output = `/tmp/orbis-login-${tag}`;
  assert.ok(!fs.existsSync(output), 'Login evidence directory must be new');
  fs.mkdirSync(output, { mode: 0o700 });
  const report = {
    passed: false,
    tag,
    commit,
    digest,
    loginPosts: 0,
    validPasswordPosts: 0,
    rejectedPasswordPosts: 0,
    rejectionRequested: rejectFirst,
    rejectionKeptSignedOut: null,
    unchangedPreferenceWrites: 0,
    blockedMutations: [],
    pageErrors: [],
    newSessionClosed: false,
    originalSessionRetained: false,
    preferencesRetained: false,
  };
  let browser;
  let reader;
  let context;
  let preferences;
  let stage = 'preflight';
  try {
    browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
    reader = await browser.newContext({ serviceWorkers: 'block' });
    await reader.addCookies(cookies);
    const read = async (endpoint) => {
      const response = await reader.request.get(`${base}${endpoint}`, { maxRedirects: 0, timeout: 15000 });
      assert.ok(response.ok(), 'Owned read failed');
      return response.json();
    };
    const build = await read('/api/system/build');
    assert.ok(build.version === tag && build.commit === commit && build.imageDigest === digest, 'Published build differs from the reviewed image');
    assert.equal((await read('/api/user-context')).isLoggedIn, true);
    preferences = await read('/api/desktop-preferences');
    context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== base) return route.abort('blockedbyclient');
      if (['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return route.continue();
      try {
        const body = JSON.parse(request.postData() || '{}');
        if (url.pathname === '/api/auth/login' && request.method() === 'POST') {
          assert.equal(body.username, credentials.username, 'Only the owned audit account is permitted');
          assert.deepEqual(Object.keys(body).sort(), ['password', 'username']);
          if (body.password === rejectedPassword) {
            assert.ok(rejectFirst && report.loginPosts === 0, 'Only one explicitly requested rejected password attempt is permitted');
            report.rejectedPasswordPosts++;
          } else {
            assert.ok(body.password === credentials.password, 'Only the expected audit password is permitted');
            assert.equal(report.loginPosts, rejectFirst ? 1 : 0, 'Only one valid password attempt is permitted');
            report.validPasswordPosts++;
          }
          report.loginPosts++;
          return route.continue();
        }
        if (url.pathname === '/api/desktop-preferences' && request.method() === 'PUT' && isDeepStrictEqual(body, preferences)) {
          report.unchangedPreferenceWrites++;
          return route.continue();
        }
      } catch {
        // Never include entered credentials or Playwright call logs in an audit failure.
      }
      report.blockedMutations.push({ method: request.method(), path: url.pathname });
      return route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    page.on('pageerror', (error) => report.pageErrors.push(hash(error.message)));
    stage = 'signed-out-ui';
    await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded' });
    await page.locator('input[name="email"]').waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(output, 'login-phone.png'), animations: 'disabled' });
    if (rejectFirst) {
      stage = 'actual-rejected-password';
      await page.locator('input[name="email"]').fill(credentials.username);
      await page.locator('input[name="password"]').fill(rejectedPassword);
      const rejected = page.waitForResponse(
        (response) => new URL(response.url()).pathname === '/api/auth/login' && response.request().method() === 'POST',
      );
      await page.locator('form button[type="submit"]').click();
      const response = await rejected;
      assert.equal(response.status(), 400, 'The deliberately wrong password must be rejected');
      assert.equal((await response.json()).message, 'AUTH_ERROR_INVALID_CREDENTIALS');
      const notice = page.locator('.orbis-notification[data-notification-type="error"]');
      await notice.getByText('Incorrect email address or password.', { exact: true }).waitFor();
      await page.waitForFunction(() => {
        const element = document.querySelector('.orbis-notification[data-notification-type="error"]');
        if (!element) return false;
        const style = getComputedStyle(element);
        return style.opacity === '1' && (style.transform === 'none' || new DOMMatrix(style.transform).isIdentity);
      });
      const box = await notice.boundingBox();
      assert.ok(box && box.x >= 8 && box.x + box.width <= 382 && box.y >= 0, 'Rejected-login feedback must fit the phone viewport');
      assert.equal(page.url(), `${base}/login`, 'A rejected password must not navigate to Home');
      assert.ok(await page.locator('input[name="email"]').isEnabled());
      assert.ok(await page.locator('input[name="password"]').isEnabled());
      assert.ok(await page.locator('form button[type="submit"]').isEnabled(), 'Password retry must remain enabled');
      assert.ok(
        (await page.locator('input[name="email"]').inputValue()) === credentials.username &&
          (await page.locator('input[name="password"]').inputValue()) === rejectedPassword,
        'A rejected password must preserve the entered fields',
      );
      const anonymous = await context.request.get(`${base}/api/user-context`, { maxRedirects: 0 });
      assert.ok(anonymous.ok() && (await anonymous.json()).isLoggedIn === false, 'A rejected password must not authenticate');
      assert.ok(
        !(await context.cookies(base)).some((cookie) => cookie.name === 'runtipi-sid'),
        'A rejected password must not create a session cookie',
      );
      report.rejectionKeptSignedOut = true;
      report.rejectionNotice = { translated: true, phoneBounds: box, retryEnabled: true, fieldsPreserved: true };
    }
    stage = 'actual-password-login';
    await page.locator('input[name="email"]').fill(credentials.username);
    await page.locator('input[name="password"]').fill(credentials.password);
    const submitted = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/auth/login' && response.request().method() === 'POST',
    );
    await page.locator('form button[type="submit"]').click();
    const response = await submitted;
    assert.ok(response.ok() && (await response.json()).success === true, 'Actual password login was rejected');
    await page.waitForURL(`${base}/dashboard`);
    const authenticated = await context.request.get(`${base}/api/user-context`, { maxRedirects: 0 });
    assert.ok(authenticated.ok() && (await authenticated.json()).isLoggedIn === true, 'New session did not authenticate');
    assert.equal(report.loginPosts, rejectFirst ? 2 : 1);
    assert.equal(report.validPasswordPosts, 1);
    assert.equal(report.rejectedPasswordPosts, rejectFirst ? 1 : 0);
    assert.deepEqual(report.blockedMutations, []);
    assert.deepEqual(report.pageErrors, []);
    report.passed = true;
  } catch (error) {
    report.failure = { stage, type: error.name, messageHash: hash(String(error.message)) };
  } finally {
    if (context) {
      try {
        const current = await context.request.get(`${base}/api/user-context`, { maxRedirects: 0, timeout: 15000 });
        assert.ok(current.ok());
        if ((await current.json()).isLoggedIn === true) {
          const response = await context.request.post(`${base}/api/auth/logout`, { headers: { Origin: base }, maxRedirects: 0, timeout: 15000 });
          assert.ok(response.ok());
        }
        const anonymous = await context.request.get(`${base}/api/user-context`, { maxRedirects: 0, timeout: 15000 });
        assert.ok(anonymous.ok() && (await anonymous.json()).isLoggedIn === false);
        report.newSessionClosed = true;
      } catch {
        report.passed = false;
      }
    }
    await context?.close().catch(() => {
      report.passed = false;
    });
    if (reader && preferences) {
      try {
        const original = await reader.request.get(`${base}/api/user-context`, { maxRedirects: 0, timeout: 15000 });
        report.originalSessionRetained = original.ok() && (await original.json()).isLoggedIn === true;
        const after = await reader.request.get(`${base}/api/desktop-preferences`, { maxRedirects: 0, timeout: 15000 });
        report.preferencesRetained = after.ok() && isDeepStrictEqual(await after.json(), preferences);
      } catch {
        report.passed = false;
      }
    }
    await browser?.close().catch(() => {
      report.passed = false;
    });
    report.passed = report.passed && report.newSessionClosed && report.originalSessionRetained && report.preferencesRetained;
    fs.writeFileSync(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify(report)}\n`);
  }
  if (!report.passed) process.exitCode = 1;
})().catch(() => {
  process.stderr.write('Owned login audit could not complete; private credentials and session details were omitted.\n');
  process.exitCode = 1;
});
