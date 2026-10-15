const fs = require('node:fs');
const { chromium } = require('@playwright/test');

const base = process.env.ORBIS_ICON_AUDIT_URL || 'http://127.0.0.1:18080';
const cookieFile = process.env.ORBIS_ICON_AUDIT_COOKIE_FILE;

async function main() {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.ORBIS_BROWSER_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  });
  try {
    const context = await browser.newContext();
    if (cookieFile) {
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
      await context.addCookies(cookies);
    }
    const urns = new Set();
    let cursor;
    do {
      const query = new URLSearchParams({ pageSize: '100' });
      if (cursor) query.set('cursor', cursor);
      const response = await context.request.get(`${base}/api/marketplace/apps/search?${query}`);
      if (!response.ok()) throw new Error(`Catalogue returned HTTP ${response.status()}; use an authenticated test session.`);
      const result = await response.json();
      for (const app of result.data) urns.add(app.urn);
      if (cursor && result.nextCursor === cursor) throw new Error('Catalogue cursor did not advance');
      cursor = result.nextCursor;
    } while (cursor);
    const installedResponse = await context.request.get(`${base}/api/apps/installed`);
    if (!installedResponse.ok()) throw new Error(`Installed apps returned HTTP ${installedResponse.status()}`);
    for (const app of (await installedResponse.json()).installed) urns.add(app.info.urn);
    if (!urns.size) throw new Error('No catalogue or installed app icons were available to test');
    const page = await context.newPage();
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    const failures = await page.evaluate(
      async ({ base, urns }) => {
        const failed = [];
        let next = 0;
        await Promise.all(
          Array.from({ length: 6 }, async () => {
            while (next < urns.length) {
              const urn = urns[next++];
              const image = new Image();
              image.src = `${base}/api/marketplace/apps/${encodeURIComponent(urn)}/image`;
              try {
                await image.decode();
                if (!image.naturalWidth || !image.naturalHeight) failed.push(urn);
              } catch {
                failed.push(urn);
              }
            }
          }),
        );
        return failed;
      },
      { base, urns: [...urns] },
    );
    process.stdout.write(`${JSON.stringify({ iconsChecked: urns.size, failures })}\n`);
    if (failures.length) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
