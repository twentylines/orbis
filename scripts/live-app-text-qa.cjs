const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const { chromium } = require('@playwright/test');
const inspectAppUpdateComfort = require('./app-update-comfort-checks.cjs');

const installRoot = (process.env.ORBIS_QA_INSTALL_ROOT || '/opt/orbis-qa/install');
const ownedCookieFile = `${installRoot}/test-cookies.txt`;
const dockerContext = 'colima-runtipi-test';
const urn = 'rehearsal-app:orbis-qa';
const updatePath = '/apps/orbis-qa/rehearsal-app/update';
const expectedTag = 'v0.1.0-beta.29';
const expectedCommit = '1697920a0fe14ccea2cc791cc26b6d06244eee12';
const base = process.env.ORBIS_AUDIT_URL || 'http://127.0.0.1:18080';
const origin = new URL(base);
const releaseFile = process.env.ORBIS_AUDIT_RELEASE_FILE;
const cookieFile = process.env.ORBIS_AUDIT_COOKIE_FILE;
const screenshotDir = process.env.ORBIS_AUDIT_SCREENSHOT_DIR || '/tmp/orbis-live-beta29-app-text';
const reportFile = process.env.ORBIS_AUDIT_REPORT_FILE || '/tmp/orbis-beta29-app-text.json';
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const clone = (value) => JSON.parse(JSON.stringify(value));
const samePrivate = (actual, expected, message) => assert.ok(isDeepStrictEqual(actual, expected), message);
const parsePrivate = (value, label) => {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
};
const readOwnedInput = (file) => {
  assert.ok(path.isAbsolute(file), 'Audit inputs must be absolute paths');
  const stat = fs.lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid(), 'Audit inputs must be owned regular files');
  const real = fs.realpathSync(file);
  assert.ok(
    file === ownedCookieFile ? real === file : real.startsWith(`${fs.realpathSync('/tmp')}/`),
    'Audit input paths must remain in their authorized locations',
  );
  return fs.readFileSync(file, 'utf8');
};
const temporaryOutput = (file) => {
  assert.ok(path.isAbsolute(file) && path.resolve(file) === file && file.startsWith('/tmp/'), 'Audit output must remain under /tmp');
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    assert.ok(!stat.isSymbolicLink() && stat.uid === process.getuid(), 'Audit output must be owned and must not be a symlink');
  }
  let parent = file;
  while (!fs.existsSync(parent)) parent = path.dirname(parent);
  const real = fs.realpathSync(parent);
  const temporaryRoot = fs.realpathSync('/tmp');
  assert.ok(real === temporaryRoot || real.startsWith(`${temporaryRoot}/`), 'Audit output must not redirect outside the temporary directory');
};
const readDocker = (args) => {
  const result = spawnSync('docker', ['--context', dockerContext, ...args], {
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
  assert.ok(!result.error && result.status === 0, 'Owned Docker inspection failed');
  return result.stdout;
};
const verifyCore = (image) => {
  const ids = readDocker(['ps', '-q', '--filter', 'label=com.docker.compose.service=runtipi']).trim().split('\n').filter(Boolean);
  assert.equal(ids.length, 1, 'Exactly one running core is required in the owned Docker context');
  const format =
    '{"image":{{json .Config.Image}},"running":{{json .State.Running}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}},"mounts":{{json .Mounts}}}';
  const core = parsePrivate(readDocker(['inspect', '--format', format, ids[0]]), 'Owned core inspection');
  assert.equal(core.image, image, 'Owned core image differs from the target release');
  assert.equal(core.running, true, 'Owned core must be running');
  assert.equal(core.health, 'healthy', 'Owned core must be healthy');
  for (const [destination, relative] of Object.entries({
    '/data/.env': '.env',
    '/data/apps': 'apps',
    '/data/repos': 'repos',
    '/data/user-config': 'user-config',
    '/data/state': 'state',
    '/app-data': 'app-data',
  })) {
    const mounts = core.mounts.filter((mount) => mount.Destination === destination);
    assert.ok(
      mounts.length === 1 && mounts[0].Type === 'bind' && mounts[0].Source === path.join(installRoot, relative),
      'Core bind ownership does not match the owned fixture',
    );
  }
};

async function main() {
  let browser;
  let reader;
  let before;
  let failure;
  let stage = 'preflight';
  const report = {
    passed: false,
    source: 'Published image, HTML, assets and live read-only APIs; browser-controlled metadata, review diffs and appearance.',
    release: null,
    appUrn: urn,
    actualApp: null,
    controlledMetadata: {
      name: 'Jellyfin Media Library and Transcoding Server',
      currentVersion: '2026.10.15-release-candidate.1234567890-arm64',
      latestVersion: '2026.10.16-release-candidate.1234567890-arm64',
      description: 'Synthetic long application description; no installed source files are changed.',
    },
    widths: [],
    mockedPreferenceWrites: 0,
    blockedMutations: [],
    externalRequestsBlocked: 0,
    pageErrors: [],
    realNonReadRequests: 0,
    appRecordUnchanged: false,
    preferencesUnchanged: false,
    cleanupFailures: [],
  };
  const writeReport = () => {
    temporaryOutput(reportFile);
    fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  };
  const verifyBuild = (build, release) => {
    assert.equal(build.version, release.tag, 'Published build tag mismatch');
    assert.equal(build.commit, release.commit, 'Published build commit mismatch');
    assert.equal(build.imageDigest, release.image.split('@')[1], 'Published build digest mismatch');
  };
  let release;
  try {
    assert.ok(releaseFile && cookieFile, 'Explicit release and cookie files are required');
    assert.equal(cookieFile, ownedCookieFile, 'Only the owned fixture cookie file is allowed');
    assert.ok(releaseFile.startsWith('/tmp/'), 'The release manifest must be an explicit owned temporary file');
    assert.ok(
      ['127.0.0.1', 'localhost'].includes(origin.hostname) && origin.protocol === 'http:' && origin.port === '18080',
      'Only loopback HTTP port 18080 is allowed',
    );
    assert.ok(!origin.username && !origin.password && origin.pathname === '/' && !origin.search && !origin.hash, 'Audit URL must be an origin');
    assert.equal(fs.realpathSync(installRoot), installRoot, 'Owned install root must not be redirected');
    release = parsePrivate(readOwnedInput(releaseFile), 'Release manifest');
    assert.equal(release.tag, expectedTag, 'This audit targets beta29 only');
    assert.equal(release.commit, expectedCommit, 'This audit targets the verified beta29 commit only');
    assert.match(release.image || '', /^ghcr\.io\/twentylines\/orbis@sha256:[a-f0-9]{64}$/);
    report.release = { tag: release.tag, commit: release.commit, image: release.image };
    const cookies = readOwnedInput(cookieFile)
      .split('\n')
      .filter((line) => line && (!line.startsWith('#') || line.startsWith('#HttpOnly_')))
      .map((line) => {
        const fields = line.split('\t');
        assert.equal(fields.length, 7, 'Cookie entry is malformed');
        const [rawDomain, , cookiePath, secure, expires, name, value] = fields;
        const domain = rawDomain.replace(/^#HttpOnly_/, '');
        assert.ok(['127.0.0.1', 'localhost', '::1', '[::1]'].includes(domain), 'Only loopback cookies are allowed');
        return {
          domain,
          path: cookiePath,
          secure: secure === 'TRUE',
          expires: Number(expires) || -1,
          name,
          value,
          httpOnly: rawDomain.startsWith('#HttpOnly_'),
        };
      });
    assert.ok(
      cookies.some((cookie) => cookie.name === 'runtipi-sid' && cookie.domain === origin.hostname),
      'Matching fixture session cookie is required',
    );
    temporaryOutput(screenshotDir);
    temporaryOutput(reportFile);
    assert.ok(fs.existsSync(path.dirname(reportFile)), 'Report parent must already exist');
    fs.mkdirSync(screenshotDir, { recursive: true, mode: 0o700 });
    verifyCore(release.image);
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.ORBIS_BROWSER_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    });
    reader = await browser.newContext({ serviceWorkers: 'block' });
    await reader.addCookies(cookies);
    const read = async (endpoint) => {
      assert.ok(endpoint.startsWith('/api/') && !endpoint.includes('?'), 'Direct reads must use a fixed API path');
      const response = await reader.request.get(`${origin.origin}${endpoint}`, { maxRedirects: 0, timeout: 15000 });
      assert.ok(response.ok(), 'Authenticated audit GET failed');
      return response.json();
    };
    stage = 'baseline';
    const build = await read('/api/system/build');
    verifyBuild(build, release);
    before = { app: await read(`/api/apps/${encodeURIComponent(urn)}`), preferences: await read('/api/desktop-preferences') };
    assert.equal(before.app.info?.urn, urn, 'Unexpected fixture app identity');
    assert.equal(before.app.info?.id, 'rehearsal-app', 'Unexpected fixture app identifier');
    assert.ok(before.app.app && ['stopped', 'running'].includes(before.app.app.status), 'Fixture app must be installed and idle');
    assert.equal(before.app.app.appStore?.url, 'http://orbis-qa-git:9418/orbis-qa.git', 'Unexpected fixture store');
    assert.equal((await read('/api/user-context')).isLoggedIn, true, 'The cookie must authenticate the audit account');
    assert.equal((await read('/api/app-context')).user?.hasSeenWelcome, true, 'The audit account must have completed onboarding');
    report.actualApp = { version: before.app.app.version, catalogueRevision: before.app.metadata.latestVersion, status: before.app.app.status };
    const controlled = clone(before.app);
    Object.assign(controlled.info, {
      name: report.controlledMetadata.name,
      short_desc: 'A private media library and home automation companion with clear application health and resource information.',
      version: report.controlledMetadata.currentVersion,
      description: `## ${report.controlledMetadata.name} on your server\n\nRead the application documentation before configuring access.\n\n- Configuration stays with this installation.\n- Backups and logs remain available in their sections.\n- This description is controlled browser test metadata for comfortable long text.`,
    });
    Object.assign(controlled.metadata, {
      latestVersion: Math.max(Number(before.app.metadata.latestVersion) || 0, Number(before.app.app.version) + 1),
      latestDockerVersion: report.controlledMetadata.latestVersion,
    });
    const configDiff = { current: 'SERVICE_LABEL=Controlled previous label\n', new: 'SERVICE_LABEL=Controlled reviewed label\n' };
    const composeDiff = {
      current: JSON.stringify({ services: { web: { image: 'example.invalid/browser-text-fixture:previous' } } }),
      new: JSON.stringify({ services: { web: { image: 'example.invalid/browser-text-fixture:reviewed' } } }),
    };
    for (const width of [1440, 390, 320]) {
      stage = `visual-${width}`;
      verifyBuild(await read('/api/system/build'), release);
      const context = await browser.newContext({
        viewport: { width, height: width === 1440 ? 1120 : width === 390 ? 844 : 800 },
        serviceWorkers: 'block',
      });
      try {
        await context.addCookies(cookies);
        let preferences = { ...clone(before.preferences), mode: 'light', windows: {} };
        await context.addInitScript(
          ({ value, origin }) => {
            if (window === window.top && location.origin === origin) localStorage.setItem('server-desktop-preferences-v1', JSON.stringify(value));
          },
          { value: preferences, origin: origin.origin },
        );
        const forwardedReads = new Map();
        const assets = { documents: 0, scripts: 0, stylesheets: 0 };
        let preferenceAttempts = 0;
        let preferenceResponses = 0;
        let detailResponses = 0;
        let configResponses = 0;
        let composeResponses = 0;
        context.on('page', (page) =>
          page.on('pageerror', (error) => report.pageErrors.push({ width, type: error.name, messageHash: hash(error.message) })),
        );
        context.on('request', (request) => {
          if (['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return;
          const target = new URL(request.url());
          if (target.origin === origin.origin && target.pathname === '/api/desktop-preferences' && request.method() === 'PUT')
            preferenceAttempts += 1;
          else report.blockedMutations.push({ width, method: request.method(), path: target.pathname });
        });
        context.on('response', (response) => {
          const request = response.request();
          const target = new URL(request.url());
          if (target.origin !== origin.origin || target.pathname.startsWith('/api/') || !response.ok()) return;
          const key = { document: 'documents', script: 'scripts', stylesheet: 'stylesheets' }[request.resourceType()];
          if (key) assets[key] += 1;
        });
        await context.route('**/*', async (route) => {
          const request = route.request();
          const target = new URL(request.url());
          const respond = (value) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
          if (target.origin !== origin.origin) {
            report.externalRequestsBlocked += 1;
            return route.abort('blockedbyclient');
          }
          if (target.pathname === '/api/desktop-preferences') {
            if (request.method() === 'GET') return respond(preferences);
            if (request.method() === 'PUT') {
              const next = parsePrivate(request.postData() || '', 'Browser preference fixture');
              assert.ok(next && ['light', 'dark'].includes(next.mode), 'Unexpected browser preference fixture');
              preferences = next;
              preferenceResponses += 1;
              report.mockedPreferenceWrites += 1;
              return respond(preferences);
            }
          }
          if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return route.abort('blockedbyclient');
          const endpoint = decodeURIComponent(target.pathname);
          if (endpoint === `/api/apps/${urn}`) {
            detailResponses += 1;
            return respond(controlled);
          }
          if (endpoint === `/api/apps/${urn}/config-diff`) {
            configResponses += 1;
            return respond(configDiff);
          }
          if (endpoint === `/api/apps/${urn}/compose-diff`) {
            composeResponses += 1;
            return respond(composeDiff);
          }
          forwardedReads.set(target.pathname, (forwardedReads.get(target.pathname) || 0) + 1);
          return route.continue();
        });
        const page = await context.newPage();
        const result = await inspectAppUpdateComfort({
          page,
          base: origin.origin,
          updatePath,
          verifiedPublished: true,
          capture: async (name, options = {}) => {
            if (options.scrollTop !== false)
              await page.locator('.desktop-window-content').evaluate((element) => element.scrollTo({ top: 0, behavior: 'instant' }));
            await page.evaluate(() => document.fonts.ready);
            await page.screenshot({
              path: path.join(screenshotDir, `${width}-${name}.png`),
              animations: 'disabled',
              fullPage: options.fullPage ?? false,
            });
          },
        });
        assert.deepEqual(result.mutations, [], 'Unexpected browser lifecycle attempt');
        assert.equal(preferenceAttempts, preferenceResponses, 'Every browser preference write must be fulfilled by the local fixture');
        assert.ok(
          detailResponses > 0 && configResponses > 0 && composeResponses > 0,
          'Controlled metadata and review fixtures must all be exercised',
        );
        assert.ok(assets.documents > 0 && assets.scripts > 0 && assets.stylesheets > 0, 'The published server must provide HTML, scripts and styles');
        assert.ok(
          forwardedReads.has('/api/system/load') && forwardedReads.has('/api/system/containers'),
          'System load and container health must come from the real server',
        );
        const expectedSamples = ['light', 'dark'].flatMap((mode) =>
          [1, 2].flatMap((scale) =>
            ['information', 'configuration', 'compose-file', 'backup', 'app-detail'].map((step) => `${mode}/${scale}/${step}`),
          ),
        );
        assert.deepEqual(
          result.samples.map(({ mode, scale, step }) => `${mode}/${scale}/${step}`),
          expectedSamples,
          'Each width must cover both modes, both text scales, all wizard steps and app details',
        );
        report.widths.push({
          width,
          assets,
          browserPreferenceWrites: preferenceResponses,
          controlledResponses: { app: detailResponses, config: configResponses, compose: composeResponses },
          forwardedReads: Object.fromEntries(forwardedReads),
          samples: result.samples.map(({ mode, scale, step, copy, brokenWords, documentOverflow, contentOverflow, labels }) => ({
            mode,
            scale,
            step,
            textsMeasured: copy.length,
            brokenWords,
            documentOverflow,
            contentOverflow,
            stepControlsMeasured: labels.length,
          })),
        });
        assert.equal(report.pageErrors.length, 0, 'Browser page errors were recorded');
        assert.equal(report.blockedMutations.length, 0, 'Unexpected non-read requests were blocked');
      } finally {
        await context.close();
      }
    }
    stage = 'final-records';
    samePrivate(await read(`/api/apps/${encodeURIComponent(urn)}`), before.app, 'Actual app details changed during the read-only audit');
    report.appRecordUnchanged = true;
    samePrivate(await read('/api/desktop-preferences'), before.preferences, 'Actual server preferences changed during the read-only audit');
    report.preferencesUnchanged = true;
    verifyBuild(await read('/api/system/build'), release);
    verifyCore(release.image);
    assert.equal(report.pageErrors.length, 0, 'Browser page errors were recorded');
    assert.equal(report.blockedMutations.length, 0, 'Unexpected non-read requests were blocked');
    report.passed = true;
  } catch (error) {
    failure = error;
    report.failure = { stage, type: /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name) ? error.name : 'Error', messageHash: hash(String(error.message)) };
  } finally {
    if (reader && before) {
      const read = async (endpoint) => {
        const response = await reader.request.get(`${origin.origin}${endpoint}`, { maxRedirects: 0, timeout: 15000 });
        assert.ok(response.ok(), 'Final audit GET failed');
        return response.json();
      };
      try {
        samePrivate(await read(`/api/apps/${encodeURIComponent(urn)}`), before.app, 'Final actual app comparison failed');
        report.appRecordUnchanged = true;
      } catch {
        report.appRecordUnchanged = false;
        report.cleanupFailures.push('app-record-comparison-failed');
      }
      try {
        samePrivate(await read('/api/desktop-preferences'), before.preferences, 'Final actual preference comparison failed');
        report.preferencesUnchanged = true;
      } catch {
        report.preferencesUnchanged = false;
        report.cleanupFailures.push('preference-comparison-failed');
      }
    }
    try {
      await browser?.close();
    } catch {
      report.cleanupFailures.push('browser-close-failed');
    }
    if (report.cleanupFailures.length) report.passed = false;
    if (release) writeReport();
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (failure || !report.passed) process.exitCode = 1;
}

main().catch(() => {
  process.stderr.write('Published app text audit could not complete; no credential or app configuration output was printed.\n');
  process.exitCode = 1;
});
