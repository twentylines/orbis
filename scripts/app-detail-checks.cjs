const assert = require('node:assert/strict');

// Uses the development fixtures installed by visual-qa.cjs, never a real server.
module.exports = async function inspectAppDetails({ page, base, viewport, capture, logs, actions }) {
  const sections = () => page.getByRole('tablist', { name: 'Application sections' });
  const select = async (label) => {
    await sections().getByRole('tab', { name: label, exact: true }).click();
    await sections().getByRole('tab', { name: label, exact: true }).and(page.locator('[data-state="active"]')).waitFor();
  };
  const fits = async () => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  const open = async (path, name) => {
    await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded' });
    await page.locator('.app-workspace-identity').getByRole('heading', { name, exact: true }).waitFor();
    await sections().waitFor();
  };

  await open('/apps/test/media?keep=1', 'Media');
  assert.equal(await page.locator('.desktop-route-title').count(), 0);
  await capture(page, `${viewport.name}-app-detail.png`);
  await fits();
  await sections().getByRole('tab', { name: 'Description', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await page.waitForURL('**/apps/test/media?keep=1&tab=resources');
  await page.locator('.container-resource-list > li').waitFor();
  assert.equal(await page.locator('.container-resource-list > li').count(), 1);
  assert.equal(await page.getByText('media-other-store', { exact: true }).count(), 0);
  await capture(page, `${viewport.name}-app-resources.png`);
  await page.reload();
  await sections().getByRole('tab', { name: 'Resources', exact: true }).and(page.locator('[data-state="active"]')).waitFor();
  await page.goBack();
  await sections().getByRole('tab', { name: 'Description', exact: true }).and(page.locator('[data-state="active"]')).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('keep'), '1');
  await select('Operations');
  assert.equal(await page.locator('.app-operations li').count(), 1);
  await capture(page, `${viewport.name}-app-operations.png`);
  await page.locator('.app-operations').getByRole('link', { name: 'Task centre' }).click();
  await page.locator('.task-scope').waitFor();
  assert.equal(await page.locator('.task-list > li').count(), 1);
  await page.getByRole('button', { name: 'Show all applications' }).click();
  await page.locator('.task-scope').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.task-list > li').count(), 4);

  await open('/apps/test/media?tab=logs', 'Media');
  await page.getByText('[fixture] application ready', { exact: true }).waitFor();
  await Promise.all([
    page.waitForResponse((response) => response.url().includes('/api/sse/app-logs') && response.url().includes('maxLines=50')),
    page.getByRole('spinbutton', { name: 'Max lines:' }).fill('50'),
  ]);
  assert.ok(logs.limits().includes('50'));
  await capture(page, `${viewport.name}-app-logs.png`);
  await select('Resources');
  const closedAt = logs.count();
  await page.waitForTimeout(2300);
  assert.equal(logs.count(), closedAt, 'closing the logs panel must cancel its pending SSE retry');
  await page.getByRole('button', { name: 'Switch to dark mode' }).click();
  await page.locator('.desktop[data-desktop-mode="dark"]').waitFor();
  await capture(page, `${viewport.name}-app-detail-dark.png`);
  await fits();
  await page.getByRole('button', { name: 'Switch to light mode' }).click();

  await open('/apps/test/backup?tab=logs', 'Backups');
  await page.getByRole('heading', { name: 'Container logs are not streaming' }).waitFor();
  await select('Backups');
  await page.getByText('No backups yet.', { exact: false }).waitFor();
  await capture(page, `${viewport.name}-app-backups.png`);
  await fits();
  await select('Files');
  const sourceEditor = page.locator('.cm-content').first();
  await sourceEditor.waitFor();
  const sourceText = await sourceEditor.innerText();
  await sourceEditor.click();
  await page.keyboard.insertText('blocked edit');
  assert.equal(await sourceEditor.innerText(), sourceText, 'generated Compose must remain read only');
  await capture(page, `${viewport.name}-app-files.png`);
  await fits();

  await open('/app-store/official/photos?tab=backups&keep=1', 'Photos');
  await sections().getByRole('tab', { name: 'Description', exact: true }).and(page.locator('[data-state="active"]')).waitFor();
  for (const label of ['Resources', 'Backups', 'Logs', 'Files'])
    assert.equal(await sections().getByRole('tab', { name: label, exact: true }).isDisabled(), true);
  await page.locator('.app-actions').getByRole('button', { name: 'Install', exact: true }).click();
  const install = page.getByRole('dialog');
  await install.getByRole('textbox', { name: 'Service label' }).waitFor();
  const before = actions.length;
  await install.getByRole('button', { name: 'Install', exact: true }).click();
  assert.equal(actions.length, before, 'required dynamic fields must prevent a lifecycle request');
  await install.getByRole('textbox', { name: 'Service label' }).fill('Photo library');
  await install.getByRole('spinbutton', { name: 'Port', exact: true }).fill('8124');
  await capture(page, `${viewport.name}-app-install.png`);
  await fits();
  await Promise.all([
    page.waitForResponse((response) => response.url().includes('/api/app-lifecycle/') && response.request().method() === 'POST'),
    install.getByRole('button', { name: 'Install', exact: true }).click(),
  ]);
  assert.equal(actions.at(-1).body.port, 8124);
  assert.equal(actions.at(-1).body.SERVICE_LABEL, 'Photo library');
  await install.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.activeElement === document.querySelector('.app-actions'));

  await open('/apps/custom?tab=notes&bust=qa', 'Custom service');
  await select('Base info');
  assert.equal(new URL(page.url()).searchParams.get('bust'), 'qa');
  await page.getByRole('button', { name: 'More application actions' }).click();
  await page.getByRole('menuitem', { name: 'Remove', exact: true }).click();
  const remove = page.getByRole('dialog');
  await remove.getByRole('switch', { name: 'Remove backups' }).waitFor();
  assert.equal(await remove.getByRole('switch', { name: 'Remove backups' }).getAttribute('aria-checked'), 'false');
  await remove.getByRole('switch', { name: 'Remove backups' }).click();
  const beforeClose = actions.length;
  await page.keyboard.press('Escape');
  await remove.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.activeElement === document.querySelector('button[aria-label="More application actions"]'));
  assert.equal(actions.length, beforeClose);
  await page.getByRole('button', { name: 'More application actions' }).click();
  await page.getByRole('menuitem', { name: 'Remove', exact: true }).click();
  assert.equal(await page.getByRole('dialog').getByRole('switch', { name: 'Remove backups' }).getAttribute('aria-checked'), 'false');
  await capture(page, `${viewport.name}-app-remove.png`);
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await fits();
  await open('/apps/managed', 'Managed service');
  await page.getByRole('button', { name: 'More application actions' }).click();
  await page.getByRole('menuitem', { name: 'Update', exact: true }).click();
  await page.waitForURL('**/apps/_user/managed/update');
  await page.getByTestId('app-update').waitFor();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  const diff = page.locator('.cm-content').first();
  await diff.waitFor();
  const originalDiff = await diff.innerText();
  await diff.click();
  await page.keyboard.insertText('blocked edit');
  assert.equal(await diff.innerText(), originalDiff);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  assert.equal(await page.getByRole('switch', { name: 'Backup', exact: true }).getAttribute('aria-checked'), 'true');
  const beforeCancelUpdate = actions.length;
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.waitForURL('**/apps/managed');
  assert.equal(actions.length, beforeCancelUpdate);
  return {
    scopedResources: true,
    scopedTasks: true,
    keyboardAndHistory: true,
    sseCleanup: true,
    logLimitReconnect: true,
    installValidation: true,
    customRemove: true,
    backupChoiceResets: true,
    customUpdateRoute: true,
    updateBackupDefault: true,
    updateDiffReadOnly: true,
  };
};
