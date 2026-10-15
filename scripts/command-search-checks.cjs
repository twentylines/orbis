const assert = require('node:assert/strict');

module.exports = async function inspectCommandSearch(page, capture) {
  const dialog = page.getByRole('dialog', { name: 'Search Orbis' });
  const trigger = page.getByRole('button', { name: 'Search tools and settings' });
  await page.keyboard.press('Control+k');
  await dialog.waitFor();
  await page.waitForFunction(() =>
    document
      .querySelector('.desktop-search-surface')
      ?.getAnimations()
      .some((animation) => animation.effect.getKeyframes().some((frame) => frame.transform?.includes('scale'))),
  );
  const opening = await dialog.evaluate((surface) => {
    const animation = surface.getAnimations().find((item) => item.effect.getKeyframes().some((frame) => frame.transform?.includes('scale')));
    animation.pause();
    animation.currentTime = 0;
    const start = surface.getBoundingClientRect();
    const trigger = document.querySelector('.desktop-search-trigger').getBoundingClientRect();
    const originError = Math.max(...['left', 'top', 'width', 'height'].map((key) => Math.abs(start[key] - trigger[key])));
    animation.finish();
    const end = surface.getBoundingClientRect();
    return {
      originError,
      fullWorkspace: end.height >= innerHeight - 50 && end.left >= 15 && end.right <= innerWidth - 15,
      duration: animation.effect.getTiming().duration,
      controlsContained: [...surface.querySelectorAll('.desktop-search-input input, .desktop-search-close, [data-search-result]')].every(
        (element) => {
          const bounds = element.getBoundingClientRect();
          return bounds.left >= end.left + 12 && bounds.right <= end.right - 12;
        },
      ),
    };
  });
  assert.ok(opening.originError < 1, `opening must start at trigger, error ${opening.originError}`);
  assert.equal(opening.fullWorkspace, true);
  assert.equal(opening.duration, 440);
  assert.equal(opening.controlsContained, true, 'search input, X and results must fit inside the surface');
  if (capture) await capture();
  for (let tab = 0; tab < 20; tab++) {
    await page.keyboard.press('Tab');
    assert.ok(await dialog.evaluate((surface) => surface.contains(document.activeElement)), 'search must contain keyboard focus');
  }
  await dialog.getByRole('button', { name: 'Close search' }).click();
  await page.waitForFunction(() => document.querySelector('.desktop-search-surface')?.dataset.closing === 'true');
  const closing = await dialog.evaluate((surface) => {
    const animation = surface.getAnimations().find((item) => item.effect.getKeyframes().some((frame) => frame.transform?.includes('scale')));
    animation.pause();
    animation.currentTime = animation.effect.getTiming().duration;
    const end = surface.getBoundingClientRect();
    const trigger = document.querySelector('.desktop-search-trigger').getBoundingClientRect();
    const originError = Math.max(...['left', 'top', 'width', 'height'].map((key) => Math.abs(end[key] - trigger[key])));
    animation.finish();
    return { originError };
  });
  assert.ok(closing.originError < 1, `closing must end at trigger, error ${closing.originError}`);
  await dialog.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.activeElement === document.querySelector('.desktop-search-trigger'));
  for (const method of ['Escape', 'Control+k']) {
    await trigger.click();
    await dialog.waitFor();
    await page.keyboard.press(method);
    await dialog.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.activeElement === document.querySelector('.desktop-search-trigger'));
  }
  await trigger.click();
  const input = dialog.getByRole('searchbox', { name: 'Find a tool or application' });
  await input.fill('Media');
  await dialog.getByRole('region', { name: 'App Store', exact: true }).getByRole('button', { name: /Media/ }).waitFor();
  assert.equal(await dialog.getByRole('region', { name: 'Installed apps' }).getByRole('button', { name: /Media/ }).count(), 1);
  await input.fill('wallpaper');
  await dialog.getByRole('button', { name: 'Appearance Orbis' }).waitFor();
  await input.press('ArrowDown');
  assert.equal(await page.locator(':focus').innerText(), 'Appearance\nOrbis');
  await input.focus();
  await input.fill('Monitor');
  await dialog.getByRole('button', { name: 'Monitor Orbis' }).click();
  await page.getByRole('heading', { name: 'Monitor', exact: true }).waitFor();
  return {
    opensFromTrigger: true,
    fullWorkspace: true,
    closesToTrigger: true,
    focusContainedAndRestored: true,
    installedAndCatalogue: true,
    sectionAliases: true,
    keyboardResults: true,
  };
};
