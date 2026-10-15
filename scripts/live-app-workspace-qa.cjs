const fs = require('node:fs');
const { chromium } = require('@playwright/test');
const releaseFile = process.env.ORBIS_AUDIT_RELEASE_FILE;
const cookieFile = process.env.ORBIS_AUDIT_COOKIE_FILE;
if (!releaseFile || !cookieFile || process.env.ORBIS_ALLOW_LIFECYCLE_AUDIT !== '1')
  throw new Error('Set release/cookie files and ORBIS_ALLOW_LIFECYCLE_AUDIT=1 for a stopped disposable app.');
const release = JSON.parse(fs.readFileSync(releaseFile, 'utf8'));
const screenshotDir = process.env.ORBIS_AUDIT_SCREENSHOT_DIR || require('node:path').join(require('node:os').tmpdir(), 'orbis-app-workspace-qa');
fs.mkdirSync(screenshotDir, { recursive: true });
const base = process.env.ORBIS_AUDIT_URL || 'http://127.0.0.1:18080';
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname)) throw new Error('This audit requires a loopback disposable stack.');
const urn = process.env.ORBIS_AUDIT_APP_URN || 'whoami:migrated';
const cookies = fs
  .readFileSync(cookieFile, 'utf8')
  .split('\n')
  .filter((line) => line && (!line.startsWith('#') || line.startsWith('#HttpOnly_')))
  .map((line) => {
    const [domain, , path, secure, expires, name, value] = line.split('\t');
    return {
      domain: domain.replace(/^#HttpOnly_/, ''),
      path,
      secure: secure === 'TRUE',
      expires: Number(expires),
      name,
      value,
      httpOnly: domain.startsWith('#HttpOnly_'),
    };
  });

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.ORBIS_BROWSER_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1120 } });
  await context.addCookies(cookies);
  let started = false;
  const readApp = async () => {
    const response = await context.request.get(`${base}/api/apps/${encodeURIComponent(urn)}`);
    if (!response.ok()) throw new Error(`Application read returned ${response.status()}`);
    return response.json();
  };
  const waitStatus = async (status) => {
    for (let attempt = 0; attempt < 60; attempt++) {
      if ((await readApp()).app?.status === status) return;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`Application did not reach ${status}`);
  };
  try {
    const initialBuild = await (await context.request.get(`${base}/api/system/build`)).json();
    if (initialBuild.version !== release.tag || initialBuild.imageDigest !== release.image.split('@')[1] || initialBuild.commit !== release.commit)
      throw new Error('Initial published build metadata mismatch');
    const before = await readApp();
    if (before.app?.status !== 'stopped') throw new Error('Disposable application must begin stopped');
    const savedConfig = JSON.stringify(before.app.config);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${base}/apps/migrated/whoami`, { waitUntil: 'domcontentloaded' });
    await page.locator('.app-workspace-identity h2').waitFor();
    const [startResponse] = await Promise.all([
      page.waitForResponse((response) => response.url().includes('/api/app-lifecycle/') && response.url().endsWith('/start')),
      page.locator('.app-actions').getByRole('button', { name: 'Start', exact: true }).click(),
    ]);
    if (!startResponse.ok()) throw new Error(`Start returned ${startResponse.status()}`);
    started = true;
    const startId = (await startResponse.json()).requestId;
    await waitStatus('running');
    await page.locator('.app-actions').getByRole('button', { name: 'Stop', exact: true }).waitFor();
    const tabs = page.getByRole('tablist', { name: 'Application sections' });
    await tabs.getByRole('tab', { name: 'Resources', exact: true }).click();
    await page.locator('.container-resource-list > li').first().waitFor();
    let scoped = [];
    for (let attempt = 0; attempt < 20; attempt++) {
      const resources = await (await context.request.get(`${base}/api/system/containers`)).json();
      scoped = resources.containers.filter((container) => container.appUrn === urn);
      if (scoped.length && scoped.every((container) => container.state === 'running')) break;
      await page.waitForTimeout(1000);
    }
    if (!scoped.length || scoped.some((container) => container.state !== 'running')) throw new Error('Running app container telemetry missing');
    if ((await page.locator('.container-resource-list > li').count()) !== scoped.length) throw new Error('Resource panel scope mismatch');
    await page.screenshot({ path: require('node:path').join(screenshotDir, 'app-resources.png'), animations: 'disabled' });
    await tabs.getByRole('tab', { name: 'Logs', exact: true }).click();
    await page.getByText('Live container output', { exact: true }).waitFor();
    const [logResponse] = await Promise.all([
      page.waitForResponse((response) => response.url().includes('/api/sse/app-logs') && response.url().includes('maxLines=50')),
      page.getByRole('spinbutton', { name: 'Max lines:' }).fill('50'),
    ]);
    if (logResponse.status() !== 200) throw new Error(`Bounded log stream returned ${logResponse.status()}`);
    const invalid = await context.request.get(`${base}/api/sse/app-logs?appUrn=${encodeURIComponent(urn)}&maxLines=0`);
    if (invalid.status() !== 400 || !invalid.headers()['content-type'].includes('application/json'))
      throw new Error('Invalid log limit was not rejected before streaming');
    const unauthenticated = await browser.newContext();
    const denied = await unauthenticated.request.get(`${base}/api/sse/app-logs?appUrn=${encodeURIComponent(urn)}&maxLines=50`);
    if (denied.status() !== 401) throw new Error('Unauthenticated logs were not rejected');
    await unauthenticated.close();
    await page.locator('.app-actions').getByRole('button', { name: 'Stop', exact: true }).click();
    const [stopResponse] = await Promise.all([
      page.waitForResponse((response) => response.url().includes('/api/app-lifecycle/') && response.url().endsWith('/stop')),
      page.getByRole('dialog').getByRole('button', { name: 'Stop', exact: true }).click(),
    ]);
    if (!stopResponse.ok()) throw new Error(`Stop returned ${stopResponse.status()}`);
    const stopId = (await stopResponse.json()).requestId;
    await waitStatus('stopped');
    started = false;
    await page.getByRole('heading', { name: 'Container logs are not streaming' }).waitFor();
    if (JSON.stringify((await readApp()).app.config) !== savedConfig) throw new Error('Application configuration changed during start/stop');
    let history;
    for (let attempt = 0; attempt < 20; attempt++) {
      history = await (await context.request.get(`${base}/api/tasks`)).json();
      if ([startId, stopId].every((id) => history.tasks.some((task) => task.id === id && task.status === 'succeeded'))) break;
      await page.waitForTimeout(1000);
    }
    if (![startId, stopId].every((id) => history.tasks.some((task) => task.id === id && task.status === 'succeeded')))
      throw new Error('Lifecycle task outcomes missing');
    const build = await (await context.request.get(`${base}/api/system/build`)).json();
    if (build.version !== release.tag || build.imageDigest !== release.image.split('@')[1] || build.commit !== release.commit)
      throw new Error('Published build metadata mismatch');
    if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
    process.stdout.write(
      `${JSON.stringify({
        version: build.version,
        commit: build.commit,
        digest: build.imageDigest,
        scopedContainers: scoped.length,
        liveLogs: true,
        invalidLimit400: true,
        unauthenticated401: true,
        startStopTasks: [startId, stopId],
        configurationRetained: true,
        restoredStatus: 'stopped',
        pageErrors: errors,
      })}\n`,
    );
  } catch (error) {
    process.stderr.write(`Primary failure: ${error.stack || error}\n`);
    throw error;
  } finally {
    try {
      if (started) {
        await context.request.post(`${base}/api/app-lifecycle/${encodeURIComponent(urn)}/stop`, { data: {}, headers: { Origin: base } });
        await waitStatus('stopped');
      }
    } finally {
      await browser.close();
    }
  }
})()
  .then(() => process.exit(0))
  .catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exit(1);
  });
