const fs = require('node:fs');
const assert = require('node:assert/strict');
const { chromium } = require('@playwright/test');
const cookieFile = process.env.ORBIS_AUDIT_COOKIE_FILE;
const releaseFile = process.env.ORBIS_AUDIT_RELEASE_FILE;
if (!cookieFile || !releaseFile || process.env.ORBIS_ALLOW_CATALOGUE_AUDIT !== '1')
  throw new Error('Set release/cookie files and ORBIS_ALLOW_CATALOGUE_AUDIT=1 for a disposable account.');
const release = JSON.parse(fs.readFileSync(releaseFile, 'utf8'));
const base = process.env.ORBIS_AUDIT_URL || 'http://127.0.0.1:18080';
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname)) throw new Error('This audit requires a loopback disposable stack.');
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
  try {
    const context = await browser.newContext();
    await context.addCookies(cookies);
    const build = await (await context.request.get(`${base}/api/system/build`)).json();
    assert.equal(build.version, release.tag);
    assert.equal(build.imageDigest, release.image.split('@')[1]);
    const page = await context.newPage();
    await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
    const result = await page.evaluate(async () => {
      const urns = new Set();
      let cursor = null;
      let pages = 0;
      do {
        const query = new URLSearchParams({ pageSize: '100' });
        if (cursor) query.set('cursor', cursor);
        const response = await fetch(`/api/marketplace/apps/search?${query}`);
        if (!response.ok) throw new Error('Catalogue read failed');
        const data = await response.json();
        for (const app of data.data) urns.add(app.urn);
        cursor = data.nextCursor;
        pages++;
        if (pages > 100) throw new Error('Catalogue cursor did not finish');
      } while (cursor);
      const installed = await (await fetch('/api/apps/installed')).json();
      for (const { info } of installed.installed) urns.add(info.urn);
      const list = [...urns];
      let next = 0;
      const failures = [];
      await Promise.all(
        Array.from({ length: Math.min(12, list.length) }, async () => {
          while (next < list.length) {
            const urn = list[next++];
            const img = new Image();
            img.src = `/api/marketplace/apps/${encodeURIComponent(urn)}/image`;
            try {
              await img.decode();
              if (!img.naturalWidth) failures.push(urn);
            } catch {
              failures.push(urn);
            }
          }
        }),
      );
      return { icons: list.length, failures };
    });
    assert.ok(result.icons > 0, 'Catalogue was empty');
    assert.deepEqual(result.failures, []);
    process.stdout.write(`${JSON.stringify({ version: build.version, ...result })}\n`);
  } finally {
    await browser.close();
  }
})().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
