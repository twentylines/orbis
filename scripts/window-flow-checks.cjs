const assert = require('node:assert/strict');

// Run on a dedicated page with visual-qa's isolated API fixtures already installed.
module.exports = async function inspectWindowFlows(page, { capture, getPreferences, modes = ['light', 'dark'], checkPolling = true } = {}) {
  const base = new URL(page.url()).origin;
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname), 'window flow checks require loopback fixtures');
  const requests = new Map();
  const mutations = [];
  const onRequest = (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/')) return;
    const path = decodeURIComponent(url.pathname);
    requests.set(path, (requests.get(path) || 0) + 1);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && path !== '/api/desktop-preferences') mutations.push(path);
  };
  page.on('request', onRequest);
  const hostJobFixture = (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        available: true,
        enrolled: true,
        coreState: 'running',
        coreHealth: 'healthy',
        imageMatches: true,
        job: { id: 'fixture-core-job', state: 'running', targetTag: 'fixture-release', startedAt: 1, message: 'Isolated polling fixture' },
      }),
    });
  const packageJobFixture = (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ available: true, job: { id: 'fixture-package-job', state: 'running', createdAt: 1, operationCount: 1 } }),
    });
  await page.route('**/api/host-updates/status', hostJobFixture);
  await page.route('**/api/host-updates/packages/job', packageJobFixture);
  await page.addInitScript(() => {
    const instances = [];
    class FixtureEventSource extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSED = 2;
      CONNECTING = 0;
      OPEN = 1;
      CLOSED = 2;
      readyState = 0;
      onopen = null;
      onmessage = null;
      onerror = null;
      constructor(url) {
        super();
        this.url = new URL(url, location.origin).href;
        instances.push(this);
        setTimeout(() => {
          if (this.readyState === this.CLOSED) return;
          this.readyState = this.OPEN;
          this.onopen?.(new Event('open'));
          if (new URL(this.url).pathname.endsWith('-logs'))
            this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ lines: ['fixture output'] }) }));
        }, 0);
      }
      close() {
        this.readyState = this.CLOSED;
      }
    }
    window.EventSource = FixtureEventSource;
    window.__orbisWindowFixtureStreams = {
      summary: () => instances.map((instance) => ({ url: instance.url, state: instance.readyState })),
      emit: (topic, data) => {
        for (const instance of instances) {
          if (instance.readyState === 1 && new URL(instance.url).pathname === `/api/sse/${topic}`)
            instance.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data) }));
        }
      },
      fail: (topic) => {
        for (const instance of instances) {
          if (instance.readyState === 1 && new URL(instance.url).pathname === `/api/sse/${topic}`) instance.onerror?.(new Event('error'));
        }
      },
    };
  });

  const frame = () => page.locator('.desktop-route-window');
  const dock = () => page.getByRole('navigation', { name: 'Desktop tools', exact: true });
  const count = (path) => requests.get(path) || 0;
  const waitFor = async (condition, message, timeout = 12000) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      if (await condition()) return;
      await page.waitForTimeout(50);
    }
    assert.fail(message);
  };
  const snapshot = async (name) => {
    if (capture) await capture(name, { scrollTop: false });
  };
  const open = async (path, label) => {
    await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('toolbar', { name: `${label} window`, exact: true }).waitFor();
    await page.waitForFunction(() =>
      window.__orbisWindowFixtureStreams.summary().some(({ url, state }) => new URL(url).pathname === '/api/sse/app' && state === 1),
    );
  };
  const identity = (value) => {
    const url = new URL(value);
    url.searchParams.delete('orbisWindow');
    return { path: url.pathname, query: [...url.searchParams].sort(([a], [b]) => a.localeCompare(b)), hash: url.hash };
  };
  const minimize = async (label) => {
    const before = identity(page.url());
    await page.getByRole('button', { name: `Minimize ${label}`, exact: true }).click();
    await page.waitForURL((url) => url.searchParams.get('orbisWindow') === 'minimized');
    await frame().waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: `Restore ${label}`, exact: true }).waitFor();
    assert.deepEqual(identity(page.url()), before, 'minimize must preserve the exact route, query values and hash');
    assert.equal(await frame().evaluate((element) => element.inert), true);
    for (let tab = 0; tab < 8; tab++) {
      await page.keyboard.press('Tab');
      assert.equal(
        await frame().evaluate((element) => element.contains(document.activeElement)),
        false,
        'minimized content must leave the tab order',
      );
    }
  };
  const restore = async (label, useDock = true) => {
    if (useDock) await dock().getByRole('link', { name: label, exact: true }).click();
    else await page.getByRole('button', { name: `Restore ${label}`, exact: true }).click();
    await page.waitForURL((url) => !url.searchParams.has('orbisWindow'));
    await frame().waitFor({ state: 'visible' });
    await page.waitForTimeout(350);
    assert.equal(await frame().evaluate((element) => element.inert), false);
  };
  const activeStreams = (topic) =>
    page.evaluate(
      (name) =>
        window.__orbisWindowFixtureStreams.summary().filter(({ url, state }) => state === 1 && new URL(url).pathname === `/api/sse/${name}`).length,
      topic,
    );
  const totalStreams = (topic) =>
    page.evaluate(
      (name) => window.__orbisWindowFixtureStreams.summary().filter(({ url }) => new URL(url).pathname === `/api/sse/${name}`).length,
      topic,
    );
  const assertFits = async () =>
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      'window flow must not introduce horizontal overflow',
    );
  const report = [];

  try {
    for (const mode of modes) {
      await open('/settings?tab=appearance&probe=space%20value#draft', 'Settings');
      if ((await page.locator('.desktop').getAttribute('data-desktop-mode')) !== mode) {
        await page.getByRole('button', { name: `Switch to ${mode} mode`, exact: true }).click();
        await page.locator(`.desktop[data-desktop-mode="${mode}"]`).waitFor();
      }
      await page.getByText('Synced to your account', { exact: true }).waitFor();
      const name = page.getByRole('textbox', { name: 'Server name', exact: true });
      const originalName = await name.inputValue();
      const draft = `unsaved-${mode}-window-draft`;
      await name.fill(draft);
      const initialRoute = identity(page.url());
      const historyBefore = await page.evaluate(() => history.length);
      await minimize('Settings');
      assert.equal(await page.evaluate(() => history.length), historyBefore + 1);
      await dock().getByRole('link', { name: 'Workspace', exact: true }).click();
      assert.equal(await page.evaluate(() => history.length), historyBefore + 1, 'repeated Home must not add minimized entries');
      await page.evaluate(() => window.__orbisWindowFixtureStreams.emit('app', { event: 'uninstall_success', appUrn: 'unrelated:_user' }));
      await page.waitForTimeout(300);
      assert.deepEqual(identity(page.url()), initialRoute, 'an unrelated custom-app uninstall must not navigate away');
      assert.equal(new URL(page.url()).searchParams.get('orbisWindow'), 'minimized');
      assert.equal(await activeStreams('app'), 1, 'global lifecycle events must stay connected while minimized');
      await snapshot(`${mode}-window-minimized`);
      await restore('Settings');
      assert.equal(await name.inputValue(), draft, 'minimize/restore must preserve an unsaved form draft');
      assert.deepEqual(identity(page.url()), initialRoute);
      assert.equal(await page.evaluate(() => history.length), historyBefore + 2);
      await page.goBack();
      await frame().waitFor({ state: 'hidden' });
      assert.equal(new URL(page.url()).searchParams.get('orbisWindow'), 'minimized');
      await page.goForward();
      await frame().waitFor({ state: 'visible' });
      assert.equal(await name.inputValue(), draft, 'history visibility changes must retain the mounted route');
      await assertFits();
      if (getPreferences)
        assert.equal(JSON.stringify(await getPreferences()).includes(draft), false, 'form drafts must not be serialized into preferences');
      await page.getByRole('button', { name: 'Close Settings', exact: true }).click();
      await page.waitForURL((url) => url.pathname === '/dashboard');
      await dock().getByRole('link', { name: 'Settings', exact: true }).click();
      await page.getByRole('tab', { name: 'Appearance', exact: true }).click();
      assert.equal(await name.inputValue(), originalName, 'Close must discard the old route draft');
      await minimize('Settings');
      const minimizedRoute = identity(page.url());
      await page.reload({ waitUntil: 'domcontentloaded' });
      await frame().waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: 'Restore Settings', exact: true }).waitFor();
      assert.deepEqual(identity(page.url()), minimizedRoute, 'a minimized deep link must reload coherently');
      await restore('Settings', false);
      assert.equal(await name.inputValue(), originalName);

      await open('/apps/create?probe=create#draft', 'Applications');
      const appName = page.getByRole('textbox', { name: /^App name/i });
      await appName.fill(`draft-${mode}-service`);
      const createRoute = identity(page.url());
      await minimize('Applications');
      await restore('Applications');
      assert.deepEqual(identity(page.url()), createRoute, 'dock restore must recover a nested create route');
      assert.equal(await appName.inputValue(), `draft-${mode}-service`);
      await assertFits();

      await open('/apps/test/media/edit?probe=edit#compose', 'Applications');
      const image = page.getByRole('textbox', { name: /^Image/ });
      await image.waitFor();
      const configReads = count('/api/apps/media:test/config');
      assert.ok(configReads > 0, 'the app editor must load its fixture before testing revalidation');
      await image.fill(`nginx:unsaved-${mode}`);
      await minimize('Applications');
      await restore('Applications');
      assert.equal(count('/api/apps/media:test/config'), configReads, 'minimize/restore must not revalidate the app editor loader');
      assert.equal(await image.inputValue(), `nginx:unsaved-${mode}`, 'loader-backed form edits must survive minimize/restore');
      await page.getByRole('button', { name: 'YAML Editor', exact: true }).click();
      const editor = page.locator('.cm-content[contenteditable="true"]:visible');
      await editor.click();
      await page.keyboard.press('ControlOrMeta+A');
      const composeDraft = `x-runtipi:\n  schema_version: 2\nservices:\n  web:\n    image: nginx:unsaved-${mode}\n    x-runtipi:\n      is_main: true\n      internal_port: 80\n# unsaved-window-${mode}\n`;
      await page.keyboard.insertText(composeDraft);
      await waitFor(() => editor.textContent().then((text) => text.includes(`# unsaved-window-${mode}`)), 'Compose draft did not reach the editor');
      await minimize('Applications');
      await restore('Applications');
      assert.equal(count('/api/apps/media:test/config'), configReads, 'raw editor visibility changes must not reload app configuration');
      assert.ok((await editor.textContent()).includes(`# unsaved-window-${mode}`), 'raw Compose draft must survive minimize/restore');
      if (getPreferences)
        assert.equal(
          JSON.stringify(await getPreferences()).includes(`# unsaved-window-${mode}`),
          false,
          'Compose drafts must remain outside persisted placement',
        );
      await page.getByRole('button', { name: 'Close Applications', exact: true }).click();
      await page.waitForURL((url) => url.pathname === '/dashboard');

      await open('/apps/test/media?tab=logs&probe=app#output', 'Applications');
      await waitFor(() => activeStreams('app-logs').then((value) => value === 1), 'app logs never connected');
      await minimize('Applications');
      assert.equal(await activeStreams('app-logs'), 0, 'minimizing must close the app log reader');
      assert.equal(await activeStreams('app'), 1);
      await restore('Applications');
      await waitFor(() => activeStreams('app-logs').then((value) => value === 1), 'restoring must reconnect exactly one app log reader');
      await page.evaluate(() => window.__orbisWindowFixtureStreams.fail('app-logs'));
      await minimize('Applications');
      const logStreamsBeforeRetry = await totalStreams('app-logs');
      await page.waitForTimeout(2300);
      assert.equal(await totalStreams('app-logs'), logStreamsBeforeRetry, 'a hidden log pane must cancel its pending retry');
      await restore('Applications', false);
      await waitFor(() => activeStreams('app-logs').then((value) => value === 1), 'retry recovery must reconnect one log reader');
      assert.equal(new URL(page.url()).searchParams.get('tab'), 'logs');

      await open('/settings?tab=logs&probe=system#output', 'Settings');
      await waitFor(() => activeStreams('runtipi-logs').then((value) => value === 1), 'system logs never connected');
      await minimize('Settings');
      assert.equal(await activeStreams('runtipi-logs'), 0, 'minimizing must close the system log reader');
      await restore('Settings');
      await waitFor(() => activeStreams('runtipi-logs').then((value) => value === 1), 'restoring must reconnect one system log reader');

      let polling = null;
      let updatePolling = null;
      if (checkPolling) {
        await open('/monitor?range=5m&probe=monitor#chart', 'Monitor');
        await page.getByRole('slider', { name: 'Inspect CPU utilisation history', exact: true }).waitFor();
        const initialHistory = count('/api/system/history');
        await waitFor(() => count('/api/system/history') > initialHistory, 'visible Monitor history never polled', 12500);
        await minimize('Monitor');
        await page.waitForTimeout(200);
        const hiddenHistory = count('/api/system/history');
        const hiddenTasks = count('/api/tasks');
        await page.waitForTimeout(5500);
        await page.waitForTimeout(5500);
        assert.equal(count('/api/system/history'), hiddenHistory, 'hidden Monitor history must pause polling');
        assert.ok(count('/api/tasks') > hiddenTasks, 'header/Home task polling must remain live');
        await restore('Monitor');
        await waitFor(() => count('/api/system/history') > hiddenHistory, 'restored Monitor history did not resume');
        assert.equal(new URL(page.url()).searchParams.get('range'), '5m');
        polling = { hiddenHistoryRequests: 0, globalTaskRequests: count('/api/tasks') - hiddenTasks, resumed: true };

        await open('/updates?probe=updates#jobs', 'Updates');
        await page.getByText('Host package operation: running', { exact: false }).waitFor();
        const initialHost = count('/api/host-updates/status');
        const initialPackageJob = count('/api/host-updates/packages/job');
        await waitFor(
          () => count('/api/host-updates/status') > initialHost && count('/api/host-updates/packages/job') > initialPackageJob,
          'visible Updates job polling never started',
          6000,
        );
        await minimize('Updates');
        await page.waitForTimeout(200);
        const hiddenHost = count('/api/host-updates/status');
        const hiddenPackageJob = count('/api/host-updates/packages/job');
        await page.waitForTimeout(4500);
        assert.equal(count('/api/host-updates/status'), hiddenHost, 'hidden core-update status must pause polling');
        assert.equal(count('/api/host-updates/packages/job'), hiddenPackageJob, 'hidden package jobs must pause polling');
        await restore('Updates');
        await waitFor(
          () => count('/api/host-updates/status') > hiddenHost && count('/api/host-updates/packages/job') > hiddenPackageJob,
          'restored Updates job polling did not resume',
          6000,
        );
        updatePolling = { hostPaused: true, packagesPaused: true, resumed: true };
      }
      await assertFits();
      report.push({
        mode,
        draft: true,
        nestedRoute: true,
        editorDraft: true,
        editorLoaderUnchanged: true,
        queryHash: true,
        history: true,
        minimizedReload: true,
        unrelatedUninstall: true,
        appLogs: true,
        systemLogs: true,
        retryCleanup: true,
        polling,
        updatePolling,
      });
    }
    assert.deepEqual(mutations, [], 'window interactions must not submit app lifecycle or unsaved forms');
  } finally {
    page.off('request', onRequest);
    await page.unroute('**/api/host-updates/status', hostJobFixture);
    await page.unroute('**/api/host-updates/packages/job', packageJobFixture);
  }
  return report;
};
