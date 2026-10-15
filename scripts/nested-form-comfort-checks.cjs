const assert = require('node:assert/strict');

module.exports = async function inspectNestedFormComfort({ page, base, capture, modes = ['light', 'dark'], textScales = [1, 2] }) {
  const origin = new URL(base);
  assert.ok(
    ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) && origin.port === '8080',
    'nested form checks require static8080 fixtures',
  );
  const width = page.viewportSize().width;
  if (width > 768) return { width, skipped: true };
  const report = { width, samples: [], blockedWrites: [] };
  let mode = 'light';
  const respond = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  const guard = (route) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())) return route.fallback();
    report.blockedWrites.push({ path: new URL(route.request().url()).pathname, method: route.request().method() });
    return route.abort('blockedbyclient');
  };
  const context = (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return respond(route, {
      version: { current: '4.10.1', latest: '4.10.1', body: '', releases: [] },
      userSettings: {
        localDomain: 'homelab.example.test',
        sslPort: 443,
        maxBackups: 5,
        guestDashboard: true,
        internalIp: '127.0.0.1',
        advancedSettings: true,
        timeZone: 'America/Argentina/Buenos_Aires',
        logLevel: 'info',
      },
      user: { id: 1, username: 'fixture@example.test', totpEnabled: false, locale: 'en', operator: true, hasSeenWelcome: true },
      apps: [],
      updatesAvailable: 0,
    });
  };
  const preferences = (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return respond(route, {
      serverName: 'Hades',
      preset: 'frost',
      mode,
      density: 'comfortable',
      wallpaper: 'sandstone',
      windows: {},
      workspace: { order: ['applications', 'activity', 'storage', 'attention'], hidden: [], wide: ['applications'], pinnedApps: [] },
    });
  };
  const app = (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== 'GET' || decodeURIComponent(url.pathname) !== '/api/apps/photos:official') return route.fallback();
    return respond(route, {
      info: {
        id: 'photos',
        urn: 'photos:official',
        name: 'Photos',
        short_desc: 'A private photo archive',
        description: 'Configure this fixture without installing it.',
        version: '1.2.3',
        author: 'Fixture maintainer',
        source: 'https://example.com/source',
        website: 'https://example.com',
        available: true,
        supported_architectures: ['amd64', 'arm64'],
        categories: ['media'],
        dynamic_config: true,
        exposable: true,
        port: 8123,
        form_fields: [
          {
            type: 'text',
            label: 'Document processing service label',
            env_variable: 'SERVICE_LABEL',
            default: 'Paperless production archive',
            required: true,
          },
          { type: 'password', label: 'Administrator authentication password', env_variable: 'ADMIN_PASSWORD', required: true },
          {
            type: 'text',
            label: 'Transcoding hardware acceleration',
            env_variable: 'HARDWARE_MODE',
            default: 'automatic',
            options: [
              { value: 'automatic', label: 'Automatic hardware acceleration (recommended)' },
              { value: 'disabled', label: 'Disable hardware acceleration' },
            ],
          },
        ],
      },
      app: null,
      metadata: { latestVersion: 2, latestDockerVersion: '1.3.0', localSubdomain: 'photos-official', composeSchemaVersion: 2, hasCustomConfig: true },
    });
  };
  await page.route('**/api/**', guard);
  await page.route('**/api/app-context', context);
  await page.route('**/api/desktop-preferences', preferences);
  await page.route('**/api/apps/**', app);
  const restore = () =>
    page.evaluate(() => {
      for (const [element, properties] of window.__nestedFormOriginalFonts ?? []) {
        if (!element.isConnected) continue;
        for (const [name, value, priority] of properties) {
          if (value) element.style.setProperty(name, value, priority);
          else element.style.removeProperty(name);
        }
      }
      window.__nestedFormOriginalFonts = [];
    });
  const scaleText = async (scale) => {
    await restore();
    if (scale === 1) return;
    await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('body,body *')]
        .filter((element) => element instanceof HTMLElement && !['SCRIPT', 'STYLE', 'LINK', 'META'].includes(element.tagName))
        .map((element) => ({
          element,
          font: Number.parseFloat(getComputedStyle(element).fontSize),
          line: getComputedStyle(element).lineHeight,
          original: ['font-size', 'line-height'].map((name) => [name, element.style.getPropertyValue(name), element.style.getPropertyPriority(name)]),
        }));
      window.__nestedFormOriginalFonts = [];
      for (const { element, font, line, original } of nodes) {
        window.__nestedFormOriginalFonts.push([element, original]);
        element.style.setProperty('font-size', `${font * 2}px`, 'important');
        if (line !== 'normal') element.style.setProperty('line-height', `${Number.parseFloat(line) * 2}px`, 'important');
      }
    });
  };
  const open = async (route) => {
    await restore();
    await page.goto(`${base}${route}`, { waitUntil: 'domcontentloaded' });
    await page.locator(`.desktop[data-desktop-mode="${mode}"]`).waitFor();
  };
  const center = async (locator) => {
    await locator.evaluate((element) => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
    await page.waitForTimeout(200);
  };
  const verticalPosition = () =>
    page.evaluate(() => ({
      page: window.scrollY,
      window: document.querySelector('.desktop-window-content')?.scrollTop ?? 0,
      tables: [...document.querySelectorAll('.table-responsive')].map((element) => element.scrollTop),
    }));
  const inspect = (locator) =>
    locator.evaluate((root) => {
      const box = (element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
      };
      const splitWords = [];
      const truncatedLabels = [
        ...root.querySelectorAll(
          '.form-label .orbis-whole-word,.settings-security-heading .orbis-whole-word,.log-terminal-controls .orbis-whole-word,.service-config-tabs .orbis-whole-word',
        ),
      ]
        .filter((element) => element.scrollWidth > element.clientWidth + 1)
        .map((element) => element.textContent);
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (node.parentElement.closest('svg,pre,code,.cm-editor,.visually-hidden,[hidden],.orbis-input-group > .input-group-text')) continue;
        for (const match of node.textContent.matchAll(/[A-Za-z]{4,}/g)) {
          const range = document.createRange();
          range.setStart(node, match.index);
          range.setEnd(node, match.index + match[0].length);
          const rows = new Set([...range.getClientRects()].filter((rect) => rect.width > 0).map((rect) => Math.round(rect.y * 10) / 10));
          if (rows.size > 1) splitWords.push(match[0]);
        }
      }
      return { box: box(root), documentWidth: document.documentElement.scrollWidth, splitWords, truncatedLabels };
    });
  const checkWords = (geometry) => {
    assert.deepEqual(geometry.splitWords, [], 'ordinary form words must stay whole');
    assert.deepEqual(geometry.truncatedLabels, [], 'ordinary labels must be visible in full');
    assert.ok(geometry.documentWidth <= width + 1, 'form controls must not expand the document');
  };
  try {
    for (const currentMode of modes)
      for (const scale of textScales) {
        mode = currentMode;
        const sample = { mode, textScale: scale };
        const prefix = `${mode}-text${scale * 100}`;
        await open('/settings?tab=logs');
        await page.locator('#log-terminal').waitFor();
        const maxLines = page.getByRole('spinbutton', { name: 'Max lines:', exact: true });
        await maxLines.fill('1001');
        await maxLines.inputValue().then((value) => assert.equal(value, '1000', 'max line clamp must remain1000'));
        await maxLines.fill('0');
        await maxLines.inputValue().then((value) => assert.equal(value, '1', 'min line clamp must remain1'));
        await maxLines.fill('1000');
        await scaleText(scale);
        await center(maxLines);
        sample.logs = await inspect(page.locator('.log-terminal-controls'));
        checkWords(sample.logs);
        sample.numeric = await maxLines.evaluate((input) => {
          const style = getComputedStyle(input);
          const probe = document.createElement('span');
          Object.assign(probe.style, {
            position: 'fixed',
            visibility: 'hidden',
            whiteSpace: 'pre',
            fontFamily: style.fontFamily,
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
            fontVariantNumeric: style.fontVariantNumeric,
            fontFeatureSettings: style.fontFeatureSettings,
            letterSpacing: style.letterSpacing,
          });
          probe.textContent = input.value;
          document.body.append(probe);
          const glyphWidth = probe.getBoundingClientRect().width;
          probe.remove();
          return {
            value: input.value,
            glyphWidth,
            usableWidth: input.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight),
          };
        });
        assert.equal(sample.numeric.value, '1000');
        assert.ok(sample.numeric.usableWidth >= sample.numeric.glyphWidth + 14, 'four digits need room for number controls');
        assert.ok(
          ['auto', 'scroll'].includes(await page.locator('#log-terminal').evaluate((element) => getComputedStyle(element).overflowY)),
          'logs must retain vertical scrolling',
        );
        for (const name of ['Follow logs', 'Wrap lines']) {
          assert.equal(await page.getByRole('checkbox', { name, exact: true }).count(), 1, 'log toggles need their own accessible labels');
        }
        await capture?.(`${prefix}-logs`, { scrollTop: false });
        await open('/settings?tab=security');
        const currentPassword = page.locator('input[name="currentPassword"]');
        await currentPassword.waitFor();
        await scaleText(scale);
        await center(currentPassword);
        sample.security = await inspect(page.locator('.settings-security'));
        checkWords(sample.security);
        for (const name of ['currentPassword', 'newPassword', 'newPasswordConfirm']) {
          const input = page.locator(`input[name="${name}"]`);
          assert.ok(
            await input.evaluate((element) => [...element.labels].some((label) => label.textContent.trim())),
            'password fields need permanent visible labels',
          );
        }
        await capture?.(`${prefix}-security`, { scrollTop: false });
        await restore();
        await page.getByRole('switch', { name: 'Enable two-factor authentication', exact: true }).click();
        const passwordDialog = page.getByRole('dialog');
        await passwordDialog.waitFor();
        await scaleText(scale);
        sample.otpPassword = await inspect(passwordDialog);
        checkWords(sample.otpPassword);
        assert.ok(
          await passwordDialog.locator('input[type="password"]').evaluate((element) => [...element.labels].some((label) => label.textContent.trim())),
          'two-factor password confirmation needs a visible label',
        );
        await capture?.(`${prefix}-two-factor-password`, { scrollTop: false });
        await page.keyboard.press('Escape');
        await open('/apps/create');
        await page.getByRole('button', { name: 'YAML Editor', exact: true }).waitFor();
        await page.locator('.service-config-tabs button').first().focus();
        await page.keyboard.press('Tab');
        assert.equal(
          await page.getByRole('button', { name: 'Environment', exact: true }).evaluate((element) => element === document.activeElement),
          true,
          'keyboard must reach the Environment tab',
        );
        await page.keyboard.press('Enter');
        const addVariable = page.getByRole('button', { name: 'Add Variable', exact: true });
        await addVariable.click();
        await scaleText(scale);
        const tabs = page.locator('.service-config-tabs');
        sample.tabs = await inspect(tabs);
        checkWords(sample.tabs);
        const tabGeometry = await tabs.evaluate((root) => {
          const parent = root.getBoundingClientRect();
          return {
            left: parent.left,
            right: parent.right,
            clientWidth: root.clientWidth,
            scrollWidth: root.scrollWidth,
            buttons: [...root.querySelectorAll('button')].map((element) => {
              const rect = element.getBoundingClientRect();
              return { left: rect.left, right: rect.right, current: element.getAttribute('aria-current') };
            }),
          };
        });
        assert.ok(tabGeometry.scrollWidth <= tabGeometry.clientWidth + 1, 'Compose navigation must wrap rather than rest partly clipped');
        assert.equal(tabGeometry.buttons.filter((button) => button.current === 'page').length, 1, 'only the selected Compose section is current');
        for (const button of tabGeometry.buttons)
          assert.ok(button.left >= tabGeometry.left - 1 && button.right <= tabGeometry.right + 1, 'whole Compose tab buttons must fit the panel');
        await center(tabs);
        await capture?.(`${prefix}-compose-tabs`, { scrollTop: false });
        await center(addVariable);
        sample.serviceHeader = await page.getByRole('button', { name: 'Add service', exact: true }).evaluate((element) => {
          const button = element.getBoundingClientRect();
          const title = (
            element.parentElement.firstElementChild.querySelector('.orbis-whole-word') ?? element.parentElement.firstElementChild
          ).getBoundingClientRect();
          const parent = element.parentElement.getBoundingClientRect();
          return {
            gap: title.bottom <= button.top ? button.top - title.bottom : button.left - title.right,
            titleRight: title.right,
            buttonRight: button.right,
            parentRight: parent.right,
          };
        });
        assert.ok(sample.serviceHeader.gap >= 8, 'Services title needs space beside or above Add service');
        assert.ok(
          sample.serviceHeader.titleRight <= sample.serviceHeader.parentRight + 1 &&
            sample.serviceHeader.buttonRight <= sample.serviceHeader.parentRight + 1,
          'Services title and control must stay inside their sidebar',
        );
        sample.environment = await inspect(page.locator('.service-config-toolbar:visible'));
        checkWords(sample.environment);
        const toolbar = await page.locator('.service-config-toolbar:visible').evaluate((root) => {
          const box = (element) => {
            const rect = element.getBoundingClientRect();
            return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom };
          };
          return { title: box(root.firstElementChild), button: box(root.querySelector('button')), parent: box(root) };
        });
        assert.ok(
          toolbar.button.x >= toolbar.parent.x - 1 && toolbar.button.right <= toolbar.parent.right + 1,
          'Add Variable must stay inside the toolbar',
        );
        assert.ok(
          toolbar.title.bottom <= toolbar.button.y - 8 || toolbar.title.right <= toolbar.button.x - 8,
          'heading and action need breathing room',
        );
        await capture?.(`${prefix}-environment`, { scrollTop: false });
        const table = page.locator('.table-responsive').filter({ has: page.locator('input[name="services.0.environment.0.key"]') });
        await table.evaluate((element) => {
          element.scrollLeft = 0;
        });
        await page.locator('input[name="services.0.environment.0.key"]').focus();
        await page.keyboard.press('Tab');
        const variableValue = page.locator('input[name="services.0.environment.0.value"]');
        assert.equal(await variableValue.evaluate((element) => element === document.activeElement), true, 'keyboard must reach the value column');
        const tablePosition = await table.evaluate((element) => ({
          left: element.scrollLeft,
          width: element.clientWidth,
          scrollWidth: element.scrollWidth,
        }));
        if (tablePosition.scrollWidth > tablePosition.width + 1)
          assert.ok(tablePosition.left > 0, 'keyboard focus must reveal horizontally scrolled value cells');
        await variableValue.fill('A long local draft value; nothing is submitted');
        const environmentVertical = await verticalPosition();
        await page.keyboard.press('Tab');
        const removeVariable = table.getByRole('button', { name: /^Remove:/ });
        assert.equal(await removeVariable.evaluate((element) => element === document.activeElement), true, 'keyboard must reach Remove variable');
        await page.waitForTimeout(100);
        assert.deepEqual(await verticalPosition(), environmentVertical, 'revealing Remove variable must preserve vertical position');
        sample.environmentAction = await removeVariable.evaluate((element) => {
          const button = element.getBoundingClientRect();
          const viewport = element.closest('.table-responsive').getBoundingClientRect();
          const glyph = element.querySelector('svg').getBoundingClientRect();
          return {
            left: button.left,
            right: button.right,
            width: button.width,
            height: button.height,
            viewportLeft: viewport.left,
            viewportRight: viewport.right,
            glyphWidth: glyph.width,
            glyphHeight: glyph.height,
          };
        });
        assert.ok(sample.environmentAction.width >= 40 && sample.environmentAction.height >= 40, 'Remove variable needs a nonshrinking40px target');
        assert.ok(sample.environmentAction.glyphWidth === 20 && sample.environmentAction.glyphHeight === 20, 'Remove glyph must retain its size');
        assert.ok(
          sample.environmentAction.left >= sample.environmentAction.viewportLeft + 3 &&
            sample.environmentAction.right <= sample.environmentAction.viewportRight - 3,
          'Remove variable and its focus ring must scroll fully into view',
        );
        await capture?.(`${prefix}-environment-row`, { scrollTop: false });
        for (const section of [
          { tab: 'Ports', add: 'Add Port', key: 'addPorts.0.hostPort', value: 'addPorts.0.containerPort' },
          { tab: 'Volumes', add: 'Add Volume', key: 'volumes.0.hostPath', value: 'volumes.0.containerPath' },
        ]) {
          await restore();
          await page.getByRole('button', { name: section.tab, exact: true }).click();
          const add = page.getByRole('button', { name: section.add, exact: true });
          await add.click();
          await scaleText(scale);
          await center(add);
          const sectionRoot = page.locator('.service-config-toolbar:visible');
          const sectionGeometry = await inspect(sectionRoot);
          checkWords(sectionGeometry);
          const spacing = await sectionRoot.evaluate((element) => {
            const title = element.firstElementChild.getBoundingClientRect();
            const button = element.querySelector('button').getBoundingClientRect();
            const parent = element.getBoundingClientRect();
            return {
              gap: title.bottom <= button.y ? button.y - title.bottom : button.x - title.right,
              left: button.left,
              right: button.right,
              parentLeft: parent.left,
              parentRight: parent.right,
            };
          });
          assert.ok(spacing.gap >= 8, `${section.add} needs room beside or below its heading`);
          assert.ok(spacing.left >= spacing.parentLeft - 1 && spacing.right <= spacing.parentRight + 1, `${section.add} must fit its toolbar`);
          const first = page.locator(`input[name="services.0.${section.key}"]`);
          const second = page.locator(`input[name="services.0.${section.value}"]`);
          const sectionTable = page.locator('.table-responsive').filter({ has: first });
          await sectionTable.evaluate((element) => {
            element.scrollLeft = 0;
          });
          await capture?.(`${prefix}-${section.tab.toLowerCase()}`, { scrollTop: false });
          await first.focus();
          await page.keyboard.press('Tab');
          assert.equal(
            await second.evaluate((element) => element === document.activeElement),
            true,
            `${section.tab} keyboard must reach the second field`,
          );
          await second.fill(section.tab === 'Ports' ? '8080' : '/srv/homelab/document-processing-archive');
          const vertical = await verticalPosition();
          const lastAction = sectionTable.locator('button').last();
          for (let index = 0; index < 6; index++) {
            if (await lastAction.evaluate((element) => element === document.activeElement)) break;
            await page.keyboard.press('Tab');
          }
          assert.equal(
            await lastAction.evaluate((element) => element === document.activeElement),
            true,
            `${section.tab} keyboard must reach the removal action`,
          );
          await page.waitForTimeout(100);
          assert.deepEqual(await verticalPosition(), vertical, `${section.tab} removal reveal must preserve vertical position`);
          const actionPosition = await lastAction.evaluate((element) => {
            const button = element.getBoundingClientRect();
            const scroller = element.closest('.table-responsive');
            const viewport = scroller.getBoundingClientRect();
            return {
              left: button.left,
              right: button.right,
              width: button.width,
              height: button.height,
              viewportLeft: viewport.left,
              viewportRight: viewport.right,
              scrollLeft: scroller.scrollLeft,
              scrollWidth: scroller.scrollWidth,
              clientWidth: scroller.clientWidth,
            };
          });
          assert.ok(actionPosition.width >= 40 && actionPosition.height >= 40, `${section.tab} removal action needs a nonshrinking40px target`);
          assert.ok(await lastAction.getAttribute('aria-label'), `${section.tab} removal needs an accessible label`);
          assert.ok(
            actionPosition.left >= actionPosition.viewportLeft + 3 && actionPosition.right <= actionPosition.viewportRight - 3,
            `${section.tab} removal action must scroll into view: ${JSON.stringify(actionPosition)}`,
          );
          await capture?.(`${prefix}-${section.tab.toLowerCase()}-row`, { scrollTop: false });
          sample[section.tab.toLowerCase()] = { geometry: sectionGeometry, spacing, actionPosition };
        }
        await open('/app-store/official/photos');
        await page.locator('.app-actions').getByRole('button', { name: 'Install', exact: true }).click();
        const dialog = page.getByRole('dialog');
        await dialog.getByRole('textbox', { name: /Document processing service label/ }).waitFor();
        await dialog.getByRole('switch', { name: /Expose app on local network/ }).click();
        await scaleText(scale);
        const subdomain = dialog.locator('input[name="localSubdomain"]');
        await center(subdomain);
        sample.install = await inspect(dialog);
        checkWords(sample.install);
        sample.installViewport = await dialog
          .locator('[data-radix-scroll-area-viewport]')
          .evaluate((element) => ({ width: element.clientWidth, scrollWidth: element.scrollWidth }));
        assert.ok(
          sample.installViewport.scrollWidth <= sample.installViewport.width + 1,
          'install body must not require hidden horizontal scrolling',
        );
        await capture?.(`${prefix}-install`, { scrollTop: false });
        const randomPort = dialog.getByRole('button', { name: 'Random', exact: true });
        await center(randomPort);
        const randomPosition = await randomPort.evaluate((element) => {
          const button = element.getBoundingClientRect();
          const viewport = element.closest('[data-radix-scroll-area-viewport]').getBoundingClientRect();
          return { left: button.left, right: button.right, viewportLeft: viewport.left, viewportRight: viewport.right };
        });
        assert.ok(
          randomPosition.left >= randomPosition.viewportLeft && randomPosition.right <= randomPosition.viewportRight,
          'Random port button must be fully reachable',
        );
        await capture?.(`${prefix}-install-port`, { scrollTop: false });
        await page.keyboard.press('Escape');
        report.samples.push(sample);
      }
    assert.deepEqual(
      report.blockedWrites.filter((request) => request.path !== '/api/desktop-preferences'),
      [],
      'no app/host/auth mutation may be attempted',
    );
    return report;
  } catch (error) {
    await capture?.('nested-form-comfort-failure', { scrollTop: false }).catch(() => undefined);
    throw error;
  } finally {
    await page.unroute('**/api/apps/**', app);
    await page.unroute('**/api/desktop-preferences', preferences);
    await page.unroute('**/api/app-context', context);
    await page.unroute('**/api/**', guard);
  }
};
