const fs = require('node:fs');
const assert = require('node:assert/strict');
const { chromium } = require('@playwright/test');

const base = process.env.ORBIS_TASK_QA_URL || 'http://127.0.0.1:18080';
const urn = process.env.ORBIS_TASK_TEST_URN;
const jar = process.env.ORBIS_TASK_QA_COOKIE_FILE;
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname)) throw new Error('Use a loopback URL for the isolated lifecycle test');
if (!urn || !/^[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+$/.test(urn) || !jar) throw new Error('Provide an isolated test app URN and session cookie file');

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1120 } });
    const cookies = fs
      .readFileSync(jar, 'utf8')
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
    await context.addCookies(cookies);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const ids = [];
    const run = async (action) => {
      const response = await context.request.post(`${base}/api/app-lifecycle/${encodeURIComponent(urn)}/${action}`, { headers: { Origin: base } });
      assert.equal(response.status(), 201);
      const { requestId } = await response.json();
      assert.ok(requestId);
      ids.push(requestId);
      for (let attempt = 0; attempt < 90; attempt++) {
        const result = await context.request.get(`${base}/api/tasks`);
        assert.equal(result.status(), 200);
        const history = await result.json();
        const task = history.tasks.find((item) => item.id === requestId);
        if (task?.status === 'failed') throw new Error(`${action} failed; inspect the isolated instance logs`);
        if (task?.status === 'succeeded') {
          assert.equal(history.storage, 'persistent');
          return;
        }
        await page.waitForTimeout(1000);
      }
      throw new Error(`${action} did not settle in the task history`);
    };
    await run('start');
    await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
    let reading;
    for (let attempt = 0; attempt < 10; attempt++) {
      const response = await context.request.get(`${base}/api/system/containers`);
      assert.equal(response.status(), 200);
      const result = await response.json();
      reading = result.containers.find((item) => item.appUrn === urn);
      if (reading?.state === 'running' && reading.cpuPercent !== null) break;
      await page.waitForTimeout(5500);
    }
    assert.equal(reading?.state, 'running');
    assert.ok(reading.memoryBytes >= 0 && reading.cpuPercent >= 0);
    await page.getByRole('link', { name: /Open task centre/ }).click();
    await page.getByRole('heading', { name: 'Task centre', exact: true }).waitFor();
    await page.reload();
    await page.locator('.task-list li').first().locator('summary').click();
    await page.getByText(ids[0], { exact: true }).waitFor();
    await run('stop');
    assert.deepEqual(errors, []);
    const report = {
      requestIds: ids,
      container: {
        name: reading.name,
        appUrn: reading.appUrn,
        health: reading.health,
        cpuPercent: reading.cpuPercent,
        memoryBytes: reading.memoryBytes,
      },
      pageErrors: errors,
    };
    if (process.env.ORBIS_TASK_QA_REPORT) fs.writeFileSync(process.env.ORBIS_TASK_QA_REPORT, `${JSON.stringify(report)}\n`);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } finally {
    await browser.close();
  }
}
main()
  .then(() => process.exit(0))
  .catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exit(1);
  });
