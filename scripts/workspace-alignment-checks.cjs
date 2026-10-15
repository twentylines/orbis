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
      const bar = document.querySelector('.desktop-system-bar');
      const barBounds = bar.getBoundingClientRect();
      const logout = bar.querySelector('.desktop-icon-button').getBoundingClientRect();
      return {
        header: {
          brandLeft: bar.querySelector('.desktop-brand').getBoundingClientRect().left,
          logoutRight: logout.right,
          connectionLeft: bar.querySelector('.desktop-connection').getBoundingClientRect().left,
          connectionIsFooter: getComputedStyle(bar.querySelector('.desktop-connection')).position === 'absolute',
          logoutClearance: {
            top: logout.top - barBounds.top,
            right: barBounds.right - logout.right,
            bottom: barBounds.bottom - logout.bottom,
          },
          controlCentres: [...bar.querySelectorAll('.desktop-task-trigger, .desktop-mode-toggle, .desktop-search-trigger, .desktop-icon-button')].map(
            (control) => {
              const bounds = control.getBoundingClientRect();
              return bounds.top + bounds.height / 2 - barBounds.top;
            },
          ),
        },
        heading: box(document.querySelector('.workspace-heading')),
        title: box(document.querySelector('.workspace-heading h1')),
        appsHeading: box(document.querySelector('#workspace-apps-title')),
        grid: box(document.querySelector('.workspace-grid')),
        defaultLayout: document.querySelector('.workspace-grid').dataset.defaultLayout === 'true',
        moreApps: document.querySelector('.workspace-grid').dataset.moreApps === 'true',
        status: box(document.querySelector('.workspace-activity')),
        uptime: document.querySelector('.workspace-activity .workspace-section-heading p').textContent.trim(),
        usage: document.querySelector('.container-resources-heading').textContent.trim(),
        launcher: box(document.querySelector('.workspace-app-list')),
        launcherPanel: box(document.querySelector('.workspace-apps')),
        operations: document.querySelector('.workspace-operations') ? box(document.querySelector('.workspace-operations')) : null,
        attention: document.querySelector('.workspace-attention') ? box(document.querySelector('.workspace-attention')) : null,
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
  for (const [label, left] of [
    ['Home heading', initial.heading.left],
    ['Home title', initial.title.left],
    ['Applications heading', initial.appsHeading.left],
    ['Applications launcher', initial.launcher.left],
    ['First application card', initial.apps[0].card.left],
    ['Home grid', initial.grid.left],
  ]) {
    assert.ok(Math.abs(left - initial.header.brandLeft) <= 1, `${label} must align with the header brand content column`);
  }
  near(initial.heading.right, initial.header.logoutRight);
  near(initial.grid.right, initial.header.logoutRight);
  if (initial.defaultLayout && !initial.moreApps) {
    for (const panel of [initial.operations, initial.attention].filter(Boolean)) near(panel.left, initial.header.brandLeft);
    if (page.viewportSize().width <= 760) {
      near(initial.status.left, initial.header.brandLeft);
      near(initial.status.right, initial.header.logoutRight);
    }
  }
  const clearances = Object.values(initial.header.logoutClearance);
  assert.ok(Math.max(...clearances) - Math.min(...clearances) <= 1, 'logout top, right and bottom clearance must match');
  if (initial.header.connectionIsFooter) near(initial.header.connectionLeft, initial.header.brandLeft);
  assert.ok(
    initial.header.controlCentres.every((centre) => Math.abs(centre - initial.header.controlCentres[0]) <= 1),
    'header controls must share one centre line',
  );
  assert.equal(initial.uptime, 'Uptime 4d 0h 0m', 'Home must show the host uptime fixture');
  assert.equal(initial.usage, 'Usage', 'container resource heading must use the practical Usage label');
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
  if (initial.operations && initial.attention && Math.abs(initial.operations.top - initial.attention.top) < 0.1) {
    near(initial.launcherPanel.left, initial.operations.left);
    near(initial.launcherPanel.right, initial.attention.right);
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
  await module.exports.inspectTextContainment(page);
  return {
    cards: true,
    actions: true,
    hover: true,
    keyboardFocus: true,
    sharedContentColumn: true,
    headerClearance: true,
    uptime: true,
    usage: true,
  };
};

module.exports.inspectTextContainment = async function inspectWorkspaceTextContainment(page) {
  const measurements = await page.evaluate(() => {
    const rect = (node) => {
      const { left, right, top, bottom } = node.getBoundingClientRect();
      return { left, right, top, bottom };
    };
    const targets = [
      ['.workspace-heading h1', '.workspace-heading', false],
      ['#workspace-apps-title', '.workspace-apps', true],
      ['.workspace-actions > *', null, true],
      ['.workspace-app .docker-health', '.workspace-app', true],
      ['.workspace-status-storage strong', '.workspace-status-storage', true],
      ['.container-resource-values b', '.container-resource-list li', true],
      ['.desktop-brand', '.desktop-brand', true],
    ];
    return targets.flatMap(([selector, parentSelector, vertical]) =>
      [...document.querySelectorAll(selector)].map((node) => {
        const container = rect(parentSelector ? node.closest(parentSelector) : node);
        const parts = [];
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const text = walker.currentNode;
          const parent = text.parentElement;
          const bounds = parent.getBoundingClientRect();
          if (
            !text.textContent.trim() ||
            parent.closest('svg,.visually-hidden,[hidden]') ||
            bounds.width === 0 ||
            bounds.height === 0 ||
            getComputedStyle(parent).visibility === 'hidden'
          )
            continue;
          const range = document.createRange();
          range.selectNodeContents(text);
          for (const part of range.getClientRects()) parts.push(rect({ getBoundingClientRect: () => part }));
        }
        return {
          selector,
          text: node.textContent.trim(),
          ariaLabel: node.getAttribute('aria-label'),
          container,
          parts,
          contained: parts.every(
            (part) =>
              part.left >= container.left - 1 &&
              part.right <= container.right + 1 &&
              (!vertical || (part.top >= container.top - 1 && part.bottom <= container.bottom + 1)),
          ),
        };
      }),
    );
  });
  for (const measurement of measurements) {
    if (measurement.selector === '.desktop-brand' && measurement.parts.length === 0) {
      assert.match(measurement.ariaLabel, /Orbis workspace/, 'the compact logo must retain its accessible brand name');
      continue;
    }
    assert.ok(measurement.parts.length > 0, `Home text must remain visible: ${measurement.selector}`);
    assert.ok(measurement.contained, `Home text escaped its surface: ${JSON.stringify(measurement)}`);
  }
  return measurements;
};
