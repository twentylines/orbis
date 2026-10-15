const assert = require('node:assert/strict');

module.exports = async function inspectWorkspaceAlignment(page) {
  await page.waitForTimeout(600);
  const measure = () =>
    page.evaluate(() => {
      const box = (element) => {
        const { top, bottom, height, left, right, width } = element.getBoundingClientRect();
        return { top: top + scrollY, bottom: bottom + scrollY, height, left, right, width };
      };
      const fixedBox = (element) => {
        const bounds = box(element);
        return { ...bounds, top: bounds.top - scrollY, bottom: bounds.bottom - scrollY };
      };
      return {
        launcher: box(document.querySelector('.workspace-app-list')),
        launcherPanel: box(document.querySelector('.workspace-apps')),
        operations: document.querySelector('.workspace-operations') ? box(document.querySelector('.workspace-operations')) : null,
        scrollApps: document.querySelector('.workspace-app-scroll')?.dataset.scroll === 'true',
        actions: [...document.querySelectorAll('.workspace-actions > *')].map((action) => ({
          ...box(action),
          icon: box(action.querySelector('svg')),
          label: box(action.querySelector('span')),
          lineHeight: getComputedStyle(action).lineHeight,
        })),
        apps: [...document.querySelectorAll('.workspace-app')].map((card) => ({
          card: box(card),
          logo: box(card.querySelector('.app-logo')),
          title: box(card.querySelector('strong')),
          health: box(card.querySelector('.docker-health')),
        })),
        dock: [...document.querySelectorAll('.desktop-dock-item')]
          .map((item) => ({
            item: fixedBox(item),
            label: fixedBox(item.querySelector('span')),
          }))
          .filter(({ label }) => label.width > 0),
      };
    });
  const initial = await measure();
  const buttonStyles = await page.locator('.workspace-actions > *').evaluateAll((actions) =>
    actions.map((action) => {
      const style = getComputedStyle(action);
      return ['backgroundColor', 'color', 'borderRadius', 'borderColor', 'fontSize', 'fontWeight', 'lineHeight', 'padding', 'gap', 'boxShadow'].map(
        (key) => style[key],
      );
    }),
  );
  assert.deepEqual(buttonStyles[0], buttonStyles[1], 'workspace actions must share the same button styling');
  assert.ok(initial.apps.length >= 3, 'exercise both plain and update-notice cards');
  const near = (first, second) => assert.ok(Math.abs(first - second) < 0.1, `${first} does not align with ${second}`);
  if (!initial.scrollApps) {
    near(initial.launcher.left, initial.launcherPanel.left);
    near(initial.launcher.right, initial.launcherPanel.right);
    if (
      initial.operations &&
      Math.abs(initial.operations.left - initial.launcher.left) < 0.1 &&
      Math.abs(initial.operations.width - initial.launcherPanel.width) < 0.1
    ) {
      near(initial.launcher.right, initial.operations.right);
    }
  }
  for (const action of initial.actions) {
    near(action.height, 44);
    assert.equal(action.lineHeight, '20px');
    near((action.top + action.bottom) / 2, (action.icon.top + action.icon.bottom) / 2);
    near((action.top + action.bottom) / 2, (action.label.top + action.label.bottom) / 2);
    near((action.left + action.right) / 2, (action.icon.left + action.label.right) / 2);
  }
  for (const { item, label } of initial.dock) {
    assert.ok(label.left - item.left >= 8 && item.right - label.right >= 8, 'dock labels need at least 8px of side padding');
  }
  if (page.viewportSize().width <= 360) {
    near(initial.actions[0].left, initial.actions[1].left);
    near(initial.actions[0].right, initial.actions[1].right);
  }
  for (const app of initial.apps) {
    for (const peer of initial.apps.filter((item) => Math.abs(item.card.top - app.card.top) < 0.1)) {
      near(app.card.bottom, peer.card.bottom);
      near(app.logo.bottom, peer.logo.bottom);
      near(app.title.top, peer.title.top);
      near(app.health.bottom, peer.health.bottom);
    }
  }
  for (const target of await page.locator('.workspace-actions > *, .workspace-app').all()) {
    await target.hover();
    await page.waitForTimeout(250);
    assert.deepEqual(await measure(), initial, 'hover must preserve card and action baselines');
    await target.focus();
    assert.deepEqual(await measure(), initial, 'focus must preserve card and action baselines');
  }
  await page.mouse.move(0, 0);
  await page.locator(':focus').evaluateAll((elements) => {
    for (const element of elements) element.blur();
  });
  await page.evaluate(() => window.scrollTo(0, 0));
  return { cards: true, actions: true, hover: true, keyboardFocus: true };
};
