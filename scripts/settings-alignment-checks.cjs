const assert = require('node:assert/strict');

module.exports = async function inspectCurrentSettingsAlignment(page) {
  const metrics = await page.locator('.desktop-settings').evaluate((settings) => {
    const frame = settings.closest('.desktop-route-window');
    const heading = frame.querySelector('.desktop-window-bar');
    const icon = heading.querySelector('.desktop-window-icon');
    const label = heading.querySelector('.desktop-window-label');
    const title = label.querySelector('h1');
    const header = settings.querySelector('[role="tablist"] .card-header');
    const nav = header.querySelector('.nav-tabs');
    const note = settings.querySelector('.appearance-note');
    const section = settings.querySelector('.appearance-section');
    const box = (element) => {
      const r = element.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const inspectWords = (element) => {
      const fractured = [];
      const clipped = [];
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (node.parentElement.closest('svg,.visually-hidden,[hidden]')) continue;
        for (const match of node.textContent.matchAll(/[A-Za-z]{2,}/g)) {
          const range = document.createRange();
          range.setStart(node, match.index);
          range.setEnd(node, match.index + match[0].length);
          const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
          if (new Set(rects.map((r) => Math.round(r.top * 10))).size > 1) fractured.push(match[0]);
          const bounds = element.getBoundingClientRect();
          if (rects.some((r) => r.left < bounds.left - 1 || r.right > bounds.right + 1 || r.top < bounds.top - 1 || r.bottom > bounds.bottom + 1))
            clipped.push(match[0]);
        }
      }
      return { fractured, clipped };
    };
    const visibleTabs = [...nav.querySelectorAll('button')].filter((element) => element.offsetWidth > 0 && element.offsetHeight > 0);
    const navStyle = getComputedStyle(nav);
    const iconBox = box(icon);
    const centeredLabel = box(frame.dataset.windowNavigation === 'page' ? title : label);
    return {
      navigation: frame.dataset.windowNavigation,
      settings: box(settings),
      headingIcon: iconBox,
      headingTitle: box(title),
      headingLabel: box(label),
      headingCenterDelta: Math.abs(iconBox.top + iconBox.height / 2 - centeredLabel.top - centeredLabel.height / 2),
      headingWords: inspectWords(title),
      nav: box(nav),
      navMargins: Object.fromEntries(
        ['marginLeft', 'marginRight', 'marginTop', 'marginBottom'].map((name) => [name, Number.parseFloat(navStyle[name])]),
      ),
      note: box(note),
      section: box(section),
      sectionHeading: box(section.querySelector('h2')),
      divider: { ...box(header), y: header.getBoundingClientRect().bottom - Number.parseFloat(getComputedStyle(header).borderBottomWidth) / 2 },
      tabs: visibleTabs.map((element) => {
        const style = getComputedStyle(element);
        const range = document.createRange();
        range.selectNodeContents(element);
        return {
          text: element.textContent.trim(),
          active: element.dataset.state === 'active',
          box: box(element),
          ink: box({ getBoundingClientRect: () => range.getBoundingClientRect() }),
          paddingLeft: Number.parseFloat(style.paddingLeft),
          paddingRight: Number.parseFloat(style.paddingRight),
          words: inspectWords(element),
        };
      }),
    };
  });
  const near = (left, right, description) => assert.ok(Math.abs(left - right) <= 1, `${description}: ${left} vs ${right}`);
  for (const key of ['headingIcon', 'nav', 'note', 'section', 'sectionHeading'])
    near(metrics[key].left, metrics.settings.left, `${key} must share the Settings left gutter`);
  for (const key of ['nav', 'note', 'section']) near(metrics[key].right, metrics.settings.right, `${key} must share the Settings right gutter`);
  near(metrics.divider.left, metrics.settings.left, 'tab divider must share the Settings left gutter');
  near(metrics.divider.right, metrics.settings.right, 'tab divider must share the Settings right gutter');
  assert.ok(metrics.headingCenterDelta <= 1, `heading icon and label must share a vertical centre: ${metrics.headingCenterDelta}`);
  assert.ok(
    Object.values(metrics.navMargins).every((value) => value >= 0),
    `tab strip cannot inherit negative margins: ${JSON.stringify(metrics.navMargins)}`,
  );
  assert.ok(metrics.tabs.length >= 4, 'Settings must show its primary tabs');
  metrics.lastTabBottom = Math.max(...metrics.tabs.map((tab) => tab.box.bottom));
  metrics.dividerGap = metrics.divider.y - metrics.lastTabBottom;
  assert.ok(metrics.dividerGap >= 8, `divider must clear every visible tab/More row by at least8px: ${metrics.dividerGap}`);
  assert.deepEqual(metrics.headingWords, { fractured: [], clipped: [] }, 'Settings heading must keep ordinary words whole and visible');
  for (const tab of metrics.tabs) {
    assert.deepEqual(tab.words, { fractured: [], clipped: [] }, `${tab.text}: tab label must keep whole words visible`);
    assert.ok(tab.paddingLeft >= 10 && tab.paddingRight >= 10, `${tab.text}: tab must retain at least10px side padding`);
    assert.ok(
      tab.ink.left >= tab.box.left + 10 - 1 && tab.ink.right <= tab.box.right - 10 + 1,
      `${tab.text}: tab text must retain visible side room`,
    );
  }
  return metrics;
};
