const fs = require('node:fs');
const assert = require('node:assert/strict');
const { chromium } = require('@playwright/test');

const base = process.env.ORBIS_HISTORY_QA_URL || 'http://127.0.0.1:18080';
const jar = process.env.ORBIS_HISTORY_QA_COOKIE_FILE;
const reportPath = process.env.ORBIS_HISTORY_QA_REPORT;
const mode = process.env.ORBIS_HISTORY_QA_MODE || 'collect';
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname) || !jar || !reportPath || !['collect', 'verify'].includes(mode))
  throw new Error('Provide an isolated loopback server, private cookie file, report path, and collect/verify mode');

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1120 } });
    assert.equal((await context.request.get(`${base}/api/system/history?range=1h`)).status(), 401);
    await context.addCookies(
      fs
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
        }),
    );
    const history = async (range = '1h') => {
      const response = await context.request.get(`${base}/api/system/history?range=${range}`);
      assert.equal(response.status(), 200);
      const result = await response.json();
      assert.equal(result.storage, 'persistent');
      assert.ok(result.points.length <= 720);
      return result;
    };
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    if (mode === 'collect') {
      const before = await history();
      await page.goto('about:blank');
      // No Orbis page or history request stays open during this interval.
      await page.waitForTimeout(25000);
      const after = await history('5m');
      assert.ok(Date.parse(after.lastSampleAt) > Date.parse(before.lastSampleAt || '1970-01-01'));
      assert.ok(after.points.length >= 2);
      assert.equal(after.collectorAvailable, true);
      const deadline = Date.now() + 90000;
      let saved;
      while (Date.now() < deadline) {
        const result = await history();
        saved = result.points.find(
          (point) =>
            Date.parse(point.until) < Math.floor(Date.now() / 60000) * 60000 &&
            Date.parse(point.until) <= Date.parse(result.persistedThrough || '1970-01-01'),
        );
        if (saved) break;
        await page.waitForTimeout(5000);
      }
      assert.ok(saved, 'a closed minute should be saved without an open Monitor');
      fs.writeFileSync(reportPath, JSON.stringify({ saved, backgroundCollection: true }));
      process.stdout.write(`${JSON.stringify({ backgroundCollection: true, savedThrough: saved.until, samples: saved.samples })}\n`);
    } else {
      const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
      const restored = await history();
      assert.deepEqual(
        restored.points.find((point) => point.at === report.saved.at),
        report.saved,
      );
      await page.goto(`${base}/monitor?range=24h`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: '24 hours', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: '24 hours', exact: true }).getAttribute('aria-pressed'), 'true');
      await page.getByRole('button', { name: '7 days', exact: true }).click();
      await page.waitForURL('**/monitor?range=7d');
      await page.locator('.monitor-history-ranges button[aria-pressed="true"]').filter({ hasText: '7 days' }).waitFor();
      await page.reload();
      await page.getByRole('button', { name: '7 days', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: '7 days', exact: true }).getAttribute('aria-pressed'), 'true');
      const chart = page.getByRole('slider', { name: 'Inspect CPU utilisation history' });
      await chart.scrollIntoViewIfNeeded();
      await chart.focus();
      await page.keyboard.press('End');
      await page.locator('.metric-chart[data-metric="cpu"] .metric-chart-tooltip').waitFor();
      assert.ok((await chart.getAttribute('aria-valuetext')).includes('CPU'));
      for (const viewport of [
        { width: 1440, height: 1120 },
        { width: 390, height: 844 },
      ]) {
        await page.setViewportSize(viewport);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      }
      assert.deepEqual(errors, []);
      process.stdout.write(
        `${JSON.stringify({ historyRestored: true, rangePersisted: true, keyboardInspection: true, noOverflow: true, pageErrors: errors })}\n`,
      );
    }
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
