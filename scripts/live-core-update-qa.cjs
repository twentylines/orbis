const fs = require('node:fs');
const assert = require('node:assert/strict');
const { isDeepStrictEqual } = require('node:util');
const { chromium } = require('@playwright/test');
const cookieFile = process.env.ORBIS_AUDIT_COOKIE_FILE;
const releaseFile = process.env.ORBIS_AUDIT_RELEASE_FILE;
const fromVersion = process.env.ORBIS_AUDIT_FROM_VERSION;
if (!cookieFile || !releaseFile || !fromVersion || process.env.ORBIS_ALLOW_CORE_UPDATE_AUDIT !== '1')
  throw new Error('Set release/cookie files, the exact source version and ORBIS_ALLOW_CORE_UPDATE_AUDIT=1 for a disposable stack.');
const base = process.env.ORBIS_AUDIT_URL || 'http://127.0.0.1:18080';
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname), 'Core update audits require a loopback disposable stack');
const release = JSON.parse(fs.readFileSync(releaseFile, 'utf8'));
assert.match(release.image, /^ghcr\.io\/twentylines\/orbis@sha256:[a-f0-9]{64}$/);
assert.match(release.tag, /^v[\w.-]+$/);
assert.notEqual(fromVersion, release.tag, 'An update must start from a different explicitly named version');
const cookies = fs
  .readFileSync(cookieFile, 'utf8')
  .split('\n')
  .filter((line) => line && (!line.startsWith('#') || line.startsWith('#HttpOnly_')))
  .map((line) => {
    const [rawDomain, , path, secure, expires, name, value] = line.split('\t');
    return {
      domain: rawDomain.replace(/^#HttpOnly_/, ''),
      path,
      secure: secure === 'TRUE',
      expires: Number(expires),
      name,
      value,
      httpOnly: rawDomain.startsWith('#HttpOnly_'),
    };
  });

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.ORBIS_BROWSER_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  });
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1120 } });
    await context.addCookies(cookies);
    const read = async (path) => {
      const response = await context.request.get(`${base}${path}`, { timeout: 5000 });
      assert.ok(response.ok(), `Read failed with ${response.status()}`);
      return response.json();
    };
    const before = await read('/api/system/build');
    assert.equal(before.version, fromVersion, 'Unexpected source version; refusing to update');
    const status = await read('/api/host-updates/status');
    assert.equal(status.available, true);
    assert.equal(status.enrolled, true);
    assert.equal(status.imageMatches, true);
    assert.equal(status.coreHealth, 'healthy');
    assert.equal(status.currentTag, fromVersion);
    const preferences = await read('/api/desktop-preferences');
    const installed = await read('/api/apps/installed');
    const identities = installed.installed.map(({ info }) => info.urn).sort();
    const appRecords = await Promise.all(identities.map((urn) => read(`/api/apps/${encodeURIComponent(urn)}`)));
    const tasks = (await read('/api/tasks')).tasks.filter((task) => ['succeeded', 'failed', 'interrupted', 'unconfirmed'].includes(task.status));
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${base}/updates`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: `Prepare update to ${release.tag}`, exact: true }).click();
    await page.getByText('Review core update', { exact: true }).waitFor();
    await page.getByText(`Verified image: ${release.image.split('@')[1]}`, { exact: true }).waitFor();
    const applying = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/host-updates/apply' && response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Install reviewed release', exact: true }).click();
    const accepted = await applying;
    assert.equal(accepted.status(), 202, 'The host helper did not accept the reviewed update');
    const { jobId } = await accepted.json();
    assert.equal(typeof jobId, 'string');
    let build;
    const deadline = Date.now() + 240000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(2500);
      try {
        build = await read('/api/system/build');
        if (build.version === release.tag) break;
      } catch {
        // The core endpoint is briefly unavailable while its container is replaced.
      }
      let liveStatus;
      try {
        liveStatus = await read('/api/host-updates/status');
      } catch {
        /* The helper API shares the restarting core endpoint. */
      }
      if (liveStatus?.job?.id === jobId && ['rolled-back', 'failed', 'interrupted'].includes(liveStatus.job.state)) {
        const job = liveStatus.job;
        throw new Error(
          `Reviewed update ${job.state}: ${job.message || 'Inspect the host update status.'} (${job.failureCode || 'no retained failure code'})`,
        );
      }
    }
    assert.equal(build?.version, release.tag, 'Reviewed update did not reach the target build');
    assert.equal(build.commit, release.commit);
    assert.equal(build.imageDigest, release.image.split('@')[1]);
    let afterStatus;
    while (Date.now() < deadline) {
      afterStatus = await read('/api/host-updates/status');
      if (afterStatus.coreHealth === 'healthy' && afterStatus.job?.state === 'complete' && afterStatus.job.id === jobId) break;
      await page.waitForTimeout(1000);
    }
    assert.equal(afterStatus.coreHealth, 'healthy');
    assert.equal(afterStatus.enrolled, true);
    assert.equal(afterStatus.imageMatches, true);
    assert.equal(afterStatus.job?.state, 'complete');
    assert.equal(afterStatus.job.id, jobId);
    assert.ok(
      isDeepStrictEqual(await read('/api/desktop-preferences'), { ...preferences, windows: preferences.windows ?? {} }),
      'Desktop preferences changed during core OTA',
    );
    assert.deepEqual((await read('/api/apps/installed')).installed.map(({ info }) => info.urn).sort(), identities);
    for (const [index, urn] of identities.entries()) {
      const after = await read(`/api/apps/${encodeURIComponent(urn)}`);
      assert.ok(isDeepStrictEqual(after.app, appRecords[index].app), 'Inherited app configuration/state changed during core OTA');
    }
    const afterTasks = (await read('/api/tasks')).tasks;
    for (const task of tasks)
      assert.ok(
        afterTasks.some((item) => item.id === task.id && item.status === task.status),
        'A persisted task outcome was lost',
      );
    await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
    await page.locator('.desktop-connection').waitFor();
    assert.deepEqual(errors, []);
    process.stdout.write(
      `${JSON.stringify({ from: fromVersion, version: build.version, commit: build.commit, digest: build.imageDigest, jobId: afterStatus.job.id, preferencesRetained: true, appRecordsRetained: identities.length, taskOutcomesRetained: tasks.length, healthy: true, pageErrors: errors })}\n`,
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
