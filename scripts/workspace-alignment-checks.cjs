const assert = require('node:assert/strict');

module.exports = async function inspectWorkspaceAlignment(page) {
  await page.waitForTimeout(600);
  const measure = () => page.evaluate(() => {
    const box = (element) => {
      const { top, bottom, height, left, right, width } = element.getBoundingClientRect();
      return { top: top + scrollY, bottom: bottom + scrollY, height, left, right, width };
    };
    return {
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
    };
  });
  const initial = await measure();
  assert.ok(initial.apps.length >= 3, 'exercise both plain and update-notice cards');
  const near = (first, second) => assert.ok(Math.abs(first - second) < 0.1, `${first} does not align with ${second}`);
  for (const action of initial.actions) {
    near(action.height, 44);
    assert.equal(action.lineHeight, '20px');
    near((action.top + action.bottom) / 2, (action.icon.top + action.icon.bottom) / 2);
    near((action.top + action.bottom) / 2, (action.label.top + action.label.bottom) / 2);
    near((action.left + action.right) / 2, (action.icon.left + action.label.right) / 2);
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
  await page.locator(':focus').evaluateAll((elements) => elements.forEach((element) => element.blur()));
  await page.evaluate(() => window.scrollTo(0, 0));
  return { cards: true, actions: true, hover: true, keyboardFocus: true };
};
