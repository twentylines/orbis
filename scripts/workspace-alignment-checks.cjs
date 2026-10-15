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
          fontSize: getComputedStyle(action).fontSize,
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
    near(Number.parseFloat(action.lineHeight), Number.parseFloat(action.fontSize) * 1.35);
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
  await module.exports.inspectComfort(page);
  return {
    cards: true,
    actions: true,
    hover: true,
    keyboardFocus: true,
    sharedContentColumn: true,
    headerClearance: true,
    uptime: true,
    usage: true,
    comfort: true,
  };
};

module.exports.inspectComfort = async function inspectWorkspaceComfort(page, { textScale = 1 } = {}) {
  const report = await page.evaluate(() => {
    const rect = (node) => {
      const { x, y, right, bottom, width, height } = node.getBoundingClientRect();
      return { x, y, right, bottom, width, height };
    };
    const normalise = (value) => value.replace(/\s+/g, ' ').trim();
    const ordinary = new Set([
      'Hades',
      'Applications',
      'System status',
      'Recent operations',
      'Needs attention',
      'Media',
      'DNS',
      'Backups',
      'Healthy',
      'No healthcheck',
      'Stopped',
      'No container',
      'Pinned',
      'Update Available',
      'Edit workspace',
      'Install an app',
      'Host CPU',
      'Host memory',
    ]);
    const words = [
      ...document.querySelectorAll(
        '.workspace-heading h1,.workspace-section-heading h2,.workspace-attention h2,.workspace-app-copy strong,.workspace-app-copy small,.workspace-app .docker-health,.workspace-actions > *,.workspace-gauge > span:last-child,.workspace-recent-tasks strong,.workspace-recent-tasks b',
      ),
    ]
      .filter(
        (node) =>
          (node.matches('.workspace-app-copy strong,.workspace-app-copy small') && normalise(node.textContent)) ||
          node.matches('.workspace-recent-tasks strong,.workspace-recent-tasks b') ||
          ordinary.has(normalise(node.textContent)),
      )
      .map((node) => {
        const lines = [];
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const text = walker.currentNode;
          if (text.parentElement.closest('svg,.visually-hidden,[hidden]')) continue;
          for (let index = 0; index < text.length; index += 1) {
            const range = document.createRange();
            range.setStart(text, index);
            range.setEnd(text, index + 1);
            const bounds = range.getBoundingClientRect();
            if (!bounds.width || !bounds.height) continue;
            let line = lines.find((item) => Math.abs(item.y - bounds.y) < 1);
            if (!line) {
              line = { text: '', y: bounds.y };
              lines.push(line);
            }
            line.text += text.textContent[index];
          }
        }
        return {
          text: normalise(node.textContent),
          lines: lines.map((line) => normalise(line.text)),
          truncated: node.scrollWidth > node.clientWidth + 1,
          ellipsis: getComputedStyle(node).textOverflow === 'ellipsis' && getComputedStyle(node).overflow === 'hidden',
          title: node.getAttribute('title'),
          appName: node.matches('.workspace-app-copy strong'),
          accessible: node.closest('.workspace-app')?.getAttribute('aria-label'),
        };
      });
    const launcher = document.querySelector('.workspace-app-list');
    const cards = [...launcher.querySelectorAll('.workspace-app')];
    const copies = cards.map((card) => {
      const copy = card.querySelector('.workspace-app-copy');
      const style = getComputedStyle(card);
      return {
        card: rect(card),
        width: rect(copy).width,
        minimum: Math.min(
          card.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight),
          Number.parseFloat(getComputedStyle(copy).fontSize) * 8,
        ),
      };
    });
    const gauges = [...document.querySelectorAll('.workspace-gauge')].map((gauge) => {
      const dial = gauge.querySelector('.workspace-dial');
      const value = dial.querySelector('strong');
      const label = gauge.lastElementChild;
      const original = {
        text: value.textContent,
        progress: dial.style.getPropertyValue('--dial-progress'),
        priority: dial.style.getPropertyPriority('--dial-progress'),
      };
      try {
        value.textContent = '100%';
        dial.style.setProperty('--dial-progress', '100%');
        const bounds = rect(dial);
        const range = document.createRange();
        range.selectNodeContents(value);
        const number = range.getBoundingClientRect();
        const centre = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
        const radius = bounds.width / 2 - Number.parseFloat(getComputedStyle(dial, '::before').left);
        const corners = [
          [number.x, number.y],
          [number.right, number.y],
          [number.x, number.bottom],
          [number.right, number.bottom],
        ];
        return {
          gauge: rect(gauge),
          dial: bounds,
          label: rect(label),
          valueFont: Number.parseFloat(getComputedStyle(value).fontSize),
          innerRingRoom: radius - Math.max(...corners.map(([x, y]) => Math.hypot(x - centre.x, y - centre.y))),
        };
      } finally {
        value.textContent = original.text;
        if (original.progress) dial.style.setProperty('--dial-progress', original.progress, original.priority);
        else dial.style.removeProperty('--dial-progress');
      }
    });
    return {
      width: innerWidth,
      words,
      copies,
      appColumns: new Set(cards.map((card) => Math.round(card.getBoundingClientRect().x))).size,
      actionHeights: [...document.querySelectorAll('.workspace-actions > *')].map((node) => rect(node).height),
      gauges,
      gaugeColumns: new Set(gauges.map((item) => Math.round(item.gauge.x))).size,
    };
  });
  for (const label of [
    'Hades',
    'Applications',
    'System status',
    'Recent operations',
    'Needs attention',
    'Edit workspace',
    'Install an app',
    'Host CPU',
    'Host memory',
  ])
    assert.ok(
      report.words.some((word) => word.text === label),
      `exercise the Home comfort label: ${label}`,
    );
  for (const word of report.words) assert.equal(word.lines.join(' '), word.text, `ordinary Home words must stay whole: ${JSON.stringify(word)}`);
  for (const word of report.words.filter((word) => word.appName && word.truncated)) {
    assert.ok(
      word.ellipsis && word.title === word.text && word.accessible?.includes(word.text),
      'long launcher names need explicit ellipsis and full hover/accessibility labels',
    );
    assert.ok(!['Media', 'DNS', 'Backups'].includes(word.text), 'ordinary short app names must remain fully visible');
  }
  assert.ok(Math.max(...report.actionHeights) - Math.min(...report.actionHeights) < 1, 'Home actions must have equal comfortable heights');
  for (const copy of report.copies) assert.ok(copy.width >= copy.minimum - 1, 'app copy must wrap below its icon before becoming a narrow column');
  if ([320, 390].includes(report.width)) {
    assert.equal(report.appColumns, textScale === 2 || report.width === 320 ? 1 : 2, 'phone app columns must adapt to enlarged text');
  }
  assert.equal(report.gauges.length, 2);
  if (report.width <= 768) assert.equal(report.gaugeColumns, textScale === 2 ? 1 : 2, 'enlarged narrow gauges need their own rows');
  for (const gauge of report.gauges) {
    assert.ok(gauge.dial.width >= gauge.valueFont * 3.5, 'gauges must scale with their numbers');
    assert.ok(gauge.innerRingRoom >= 6, `100% needs clearance inside the circular inner ring: ${JSON.stringify(gauge)}`);
    assert.ok(gauge.label.x >= gauge.gauge.x - 1 && gauge.label.right <= gauge.gauge.right + 1, 'gauge labels need their own readable column');
  }
  return report;
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

module.exports.inspectPinComfort = async function inspectPinComfort(page) {
  const names = await page.locator('.workspace-pin-list button > span:not(.app-logo)').evaluateAll((elements) =>
    elements.map((element) => {
      const lines = [];
      const text = element.firstChild;
      for (let index = 0; index < text.length; index += 1) {
        const range = document.createRange();
        range.setStart(text, index);
        range.setEnd(text, index + 1);
        const bounds = range.getBoundingClientRect();
        if (!bounds.width || !bounds.height) continue;
        let line = lines.find((item) => Math.abs(item.y - bounds.y) < 1);
        if (!line) {
          line = { y: bounds.y, text: '' };
          lines.push(line);
        }
        line.text += text.textContent[index];
      }
      return { text: element.textContent, lines: lines.map((line) => line.text.trim()), width: element.getBoundingClientRect().width };
    }),
  );
  assert.ok(names.length >= 3, 'pin comfort requires installed fixture applications');
  for (const name of names) assert.equal(name.lines.join(' '), name.text, `pin picker fractures an app name: ${JSON.stringify(name)}`);
  return names;
};
