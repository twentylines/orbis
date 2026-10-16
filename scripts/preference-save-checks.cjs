const assert = require('node:assert/strict');

module.exports = async ({ page, base, initial }) => {
  let persisted = structuredClone(initial);
  let holdNext;
  let rejectNext = false;
  let active = 0;
  let maxActive = 0;
  const requests = [];
  const failures = [];
  const gates = [];
  const waitFor = async (condition, message) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (condition()) return;
      await page.waitForTimeout(50);
    }
    throw new Error(message);
  };
  const pauseNextSave = () => {
    let started;
    let release;
    const gate = {
      arrived: new Promise((resolve) => {
        started = resolve;
      }),
      waiting: new Promise((resolve) => {
        release = resolve;
      }),
      started: () => started(),
      release: () => release(),
    };
    holdNext = gate;
    gates.push(gate);
    return gate;
  };
  const handler = async (route) => {
    const request = route.request();
    if (request.method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(persisted) });
    assert.equal(request.method(), 'PUT');
    const record = { body: JSON.parse(request.postData()), status: null };
    requests.push(record);
    active++;
    maxActive = Math.max(maxActive, active);
    const gate = holdNext;
    holdNext = undefined;
    if (gate) {
      gate.started();
      await gate.waiting;
    }
    const rejected = rejectNext;
    rejectNext = false;
    record.status = rejected ? 500 : 200;
    if (!rejected) persisted = structuredClone(record.body);
    active--;
    return route.fulfill({ status: record.status, contentType: 'application/json', body: JSON.stringify(rejected ? {} : persisted) });
  };
  const failed = (request) => {
    if (new URL(request.url()).pathname === '/api/desktop-preferences' && request.method() === 'PUT') failures.push(request.failure()?.errorText);
  };
  page.on('requestfailed', failed);
  await page.route('**/api/desktop-preferences', handler);
  try {
    await page.goto(`${base}/settings?tab=appearance`, { waitUntil: 'domcontentloaded' });
    await page.getByText('Synced to your account', { exact: true }).waitFor();
    await page.waitForTimeout(500);
    assert.equal(requests.length, 0, 'Loading acknowledged preferences must not send a redundant PUT');
    const mode = (value) => page.getByRole('button', { name: `Switch to ${value} mode`, exact: true }).click();
    const first = pauseNextSave();
    await mode('dark');
    await first.arrived;
    await mode('light');
    await page.waitForTimeout(400);
    await mode('dark');
    await page.waitForTimeout(400);
    await mode('light');
    await page.waitForTimeout(400);
    assert.equal(requests.length, 1, 'New preference snapshots must wait for the in-flight save');
    first.release();
    await waitFor(() => requests.length === 2 && requests[1].status === 200 && persisted.mode === 'light', 'Latest theme did not save');
    await page.getByText('Synced to your account', { exact: true }).waitFor();
    await page.waitForTimeout(400);
    assert.deepEqual(
      requests.map((request) => request.body.mode),
      ['dark', 'light'],
      'Superseded queued values must not be submitted',
    );
    let desktopChecks = 0;
    if (page.viewportSize().width >= 1100) {
      const layout = async (name) => {
        await page.getByRole('button', { name: 'Window layout', exact: true }).click();
        await page.getByRole('menuitem', { name, exact: true }).click();
      };
      const windowSave = pauseNextSave();
      await layout('Floating window');
      await windowSave.arrived;
      await page.getByRole('button', { name: 'Maximize Settings', exact: true }).click();
      await page.getByRole('button', { name: 'Restore Settings size', exact: true }).click();
      await layout('Snap left');
      await page.waitForTimeout(400);
      await layout('Snap right');
      await page.waitForTimeout(400);
      assert.equal(requests.length, 3, 'Rapid window changes must not overlap a pending save');
      windowSave.release();
      await waitFor(() => requests.length === 4 && requests[3].status === 200, 'Latest placement did not save');
      assert.equal(persisted.windows.settings.mode, 'right');
      assert.deepEqual(
        requests.slice(2).map((request) => request.body.windows.settings.mode),
        ['floating', 'right'],
      );
      await page.getByText('Synced to your account', { exact: true }).waitFor();
      desktopChecks++;
    }
    rejectNext = true;
    await mode('dark');
    await page.getByText('Sync unavailable. Changes are cached in this browser.', { exact: true }).waitFor();
    assert.equal(persisted.mode, 'light', 'A rejected save must not be recorded as committed');
    assert.equal(requests.at(-1).status, 500);
    await mode('light');
    await page.getByText('Synced to your account', { exact: true }).waitFor();
    assert.equal(requests.at(-1).status, 200, 'A later edit must recover from a rejected save');
    const count = requests.length;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByText('Synced to your account', { exact: true }).waitFor();
    await page.waitForTimeout(500);
    assert.equal(requests.length, count, 'Reloading saved preferences must not send a redundant save');
    assert.equal(maxActive, 1, 'Only one preference save may be active');
    assert.deepEqual(failures, [], 'Started preference saves must not be aborted by another edit');
    return {
      source: 'Controlled delayed/rejected preference API; no real writes',
      initialAndReloadWrites: 0,
      maximumConcurrentSaves: maxActive,
      coalescedThemeWrites: 2,
      desktopChecks,
      rejectedSaves: 1,
      retrySaved: true,
      savedStateSurvivesReload: true,
      abortedSaves: failures.length,
    };
  } finally {
    for (const gate of gates) gate.release();
    await page.unroute('**/api/desktop-preferences', handler);
    page.off('requestfailed', failed);
  }
};
