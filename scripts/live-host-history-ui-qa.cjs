// Published device-history acceptance reads actual API bodies and requires explicit release pins.
// Actual response bodies are unchanged; no browser mutation is forwarded.
// Requires ORBIS_ALLOW_LIVE_HOST_HISTORY_AUDIT=1, exact ORBIS_AUDIT_EXPECTED_TAG/COMMIT/DIGEST,
// ORBIS_AUDIT_RELEASE_FILE=/tmp/orbis-beta45-release-check.json, the fixed owned cookie file,
// and a fresh absolute ORBIS_AUDIT_OUTPUT_DIR under /tmp. The explicit CLI opt-in is checked below.
// ORBIS_AUDIT_HISTORY_DESKTOP_DIAGNOSTIC=1 restricts the run to native1440 and observes reading anchors.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const { chromium } = require('@playwright/test');
const { dom } = require('./host-devices-checks.cjs');
const { dom: historyDom } = require('./host-device-history-checks.cjs');

const installRoot = (process.env.ORBIS_QA_INSTALL_ROOT || '/opt/orbis-qa/install');
const ownedCookieFile = `${installRoot}/test-cookies.txt`;
const dockerContext = 'colima-runtipi-test';
const expectedTag = process.env.ORBIS_AUDIT_EXPECTED_TAG;
const readMethods = new Set(['GET', 'HEAD']);
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const samePrivate = (actual, expected, message) => assert.ok(isDeepStrictEqual(actual, expected), message);

function parsePrivate(value, label) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function readOwnedInput(file) {
  assert.ok(path.isAbsolute(file) && path.resolve(file) === file, 'Audit input must be an absolute normalized path');
  const stat = fs.lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid(), 'Audit input must be an owned regular file');
  const real = fs.realpathSync(file);
  if (file === ownedCookieFile) {
    assert.equal(real, file, 'Owned cookie path must not redirect');
    assert.equal(stat.mode & 0o077, 0, 'Owned cookies must remain private');
  } else {
    assert.ok(file.startsWith('/tmp/') && real.startsWith(`${fs.realpathSync('/tmp')}/`), 'Release manifest must remain under /tmp');
    assert.equal(stat.mode & 0o077, 0, 'Release manifest must remain private');
  }
  return fs.readFileSync(file, 'utf8');
}

function temporaryOutput(file) {
  assert.ok(path.isAbsolute(file) && path.resolve(file) === file && file.startsWith('/tmp/'), 'Audit output must remain under /tmp');
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    assert.ok(!stat.isSymbolicLink() && stat.uid === process.getuid(), 'Audit output must be owned and must not be a symlink');
  }
  let parent = file;
  while (!fs.existsSync(parent)) parent = path.dirname(parent);
  const real = fs.realpathSync(parent);
  const temporaryRoot = fs.realpathSync('/tmp');
  assert.ok(real === temporaryRoot || real.startsWith(`${temporaryRoot}/`), 'Audit output must not redirect outside /tmp');
}

function privateDirectory(directory) {
  temporaryOutput(directory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assert.ok(fs.lstatSync(directory).isDirectory(), 'Audit output directory is not a directory');
  fs.chmodSync(directory, 0o700);
}

function privateWrite(file, value) {
  temporaryOutput(file);
  const descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
  } finally {
    fs.closeSync(descriptor);
  }
}

function readDocker(args) {
  assert.ok(['ps', 'inspect'].includes(args[0]), 'Only read-only Docker inspection is permitted');
  const result = spawnSync('docker', ['--context', dockerContext, ...args], { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
  assert.ok(!result.error && result.status === 0, 'Owned Docker inspection failed');
  return result.stdout;
}

function verifyCore(image) {
  const ids = readDocker(['ps', '-q', '--filter', 'label=com.docker.compose.service=runtipi']).trim().split('\n').filter(Boolean);
  assert.equal(ids.length, 1, 'Exactly one running core is required in the owned Docker context');
  const format =
    '{"image":{{json .Config.Image}},"imageId":{{json .Image}},"running":{{json .State.Running}},"paused":{{json .State.Paused}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}},"mounts":{{json .Mounts}},"ports":{{json .NetworkSettings.Ports}}}';
  const core = parsePrivate(readDocker(['inspect', '--format', format, ids[0]]), 'Owned core inspection');
  assert.equal(core.image, image, 'Owned core image differs from the expected published image');
  assert.match(core.imageId, /^sha256:[a-f0-9]{64}$/, 'Owned core image identity is invalid');
  const imageDigests = parsePrivate(
    readDocker(['inspect', '--type', 'image', '--format', '{{json .RepoDigests}}', core.imageId]),
    'Owned image digests',
  );
  assert.ok(Array.isArray(imageDigests) && imageDigests.includes(image), 'Running image does not contain the pinned published digest');
  assert.ok(core.running && !core.paused && core.health === 'healthy', 'Owned core must be running, unpaused and healthy');
  const loopbackBinds = Object.values(core.ports || {})
    .flat()
    .filter((binding) => binding?.HostPort === '18080');
  assert.ok(
    loopbackBinds.length > 0 && loopbackBinds.every((binding) => ['127.0.0.1', '::1'].includes(binding.HostIp)),
    'Owned HTTP binding must remain loopback18080',
  );
  for (const [destination, relative] of Object.entries({
    '/data/.env': '.env',
    '/data/apps': 'apps',
    '/data/repos': 'repos',
    '/data/user-config': 'user-config',
    '/data/state': 'state',
    '/app-data': 'app-data',
  })) {
    const mounts = core.mounts.filter((mount) => mount.Destination === destination);
    assert.ok(
      mounts.length === 1 && mounts[0].Type === 'bind' && mounts[0].Source === path.join(installRoot, relative),
      'Core bind ownership does not match the owned rehearsal root',
    );
  }
  assert.equal(
    core.mounts.filter((mount) => /^\/(?:data\/(?:apps|repos|user-config|state)|app-data)\//.test(mount.Destination)).length,
    0,
    'Unexpected owned-tree mount override',
  );
  return { idHash: hash(ids[0]), image: core.image, imageId: core.imageId, healthy: true, ownedBinds: true };
}

function parseCookies(value, hostname) {
  const cookies = value
    .split('\n')
    .filter((line) => line && (!line.startsWith('#') || line.startsWith('#HttpOnly_')))
    .map((line) => {
      const fields = line.split('\t');
      assert.equal(fields.length, 7, 'Cookie entry is malformed');
      const [rawDomain, , cookiePath, secure, expires, name, cookieValue] = fields;
      const domain = rawDomain.replace(/^#HttpOnly_/, '');
      assert.ok(['127.0.0.1', 'localhost'].includes(domain), 'Only loopback cookies are allowed');
      assert.ok(cookiePath.startsWith('/') && name && cookieValue, 'Cookie entry is incomplete');
      return {
        domain,
        path: cookiePath,
        secure: secure === 'TRUE',
        expires: Number(expires) || -1,
        name,
        value: cookieValue,
        httpOnly: rawDomain.startsWith('#HttpOnly_'),
      };
    });
  assert.ok(
    cookies.some((cookie) => cookie.name === 'runtipi-sid' && cookie.domain === hostname),
    'Matching owned session cookie is required',
  );
  return cookies;
}

const endpoint = '/api/system/host-history';
const releasePath = '/tmp/orbis-beta45-release-check.json';
const groups = [
  { width: 1440, height: 1120, textScale: 1, poll: true },
  { width: 768, height: 1024, textScale: 1, poll: false },
  { width: 390, height: 844, textScale: 1, poll: false },
  { width: 320, height: 800, textScale: 1, poll: false },
  { width: 320, height: 800, textScale: 2, poll: true },
];
const durations = { '5m': 300000, '1h': 3600000, '24h': 86400000, '7d': 604800000 };
const keyOf = ({ kind, name }) => `${kind}:${name}`;
const publicApiPaths = new Set([
  '/api/user-context',
  '/api/app-context',
  '/api/desktop-preferences',
  '/api/apps/installed',
  '/api/marketplace/all',
  '/api/system/build',
  '/api/system/history',
  '/api/system/host-history',
  '/api/system/host-telemetry',
  '/api/system/host-processes',
  '/api/system/containers',
  '/api/sse/app',
]);
const safePath = (value) =>
  publicApiPaths.has(value) || value.startsWith('/assets/') || ['/', '/monitor', '/favicon.ico'].includes(value)
    ? value
    : `/${value.startsWith('/api/') ? 'api' : 'asset'}/[${hash(value).slice(0, 16)}]`;
const formatValue = (value, unit) => {
  if (value === null) return 'Unavailable';
  if (unit === 'percent') return `${value.toFixed(1)}%`;
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s', 'TB/s'];
  const index = Math.min(4, Math.floor(Math.log2(Math.max(1, value)) / 10));
  return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
};
function historyPath(range, device = null) {
  assert.ok(Object.hasOwn(durations, range), 'Reviewed history range required');
  const query = new URLSearchParams({ range });
  if (device) {
    const name = keyOf(device);
    assert.ok(
      /^(?:network|disk):[a-zA-Z0-9_.:@+!-]{1,128}$/.test(name) && !/^(?:network|disk):\.{1,2}$/.test(name),
      'Canonical selected device required',
    );
    query.set('device', name);
  }
  return `${endpoint}?${query}`;
}
function validateHistory(body, range, device = null) {
  assert.ok(body && body.range === range && Object.hasOwn(durations, body.range), 'Actual response range differs');
  assert.equal(Date.parse(body.to) - Date.parse(body.from), durations[range], 'Actual history covers the selected time window');
  assert.ok(
    Array.isArray(body.devices) && body.devices.length <= 64 && Array.isArray(body.points) && body.points.length <= 720,
    'Actual history exceeds its bounds',
  );
  assert.equal(body.sampledEverySeconds, 10);
  assert.equal(body.retentionDays, 7);
  if (device) samePrivate(body.selected, device, 'Actual selected device differs from requested device');
  for (const item of body.devices) historyPath(range, { kind: item.kind, name: item.name });
  let last = Number.NEGATIVE_INFINITY;
  for (const point of body.points) {
    const at = Date.parse(point.at);
    assert.ok(Number.isFinite(at) && at > last && Date.parse(point.until) >= at, 'Actual point times must remain ordered');
    last = at;
    assert.ok(point.sourceId === null || /^[a-f0-9]{64}$/.test(point.sourceId), 'Actual generation identity must be opaque');
    for (const key of ['inbound', 'outbound', 'busy']) {
      const metric = point[key];
      assert.ok(Number.isSafeInteger(metric.samples) && metric.samples >= 0, 'Actual sample counts must be valid');
      assert.ok(
        metric.average === null
          ? metric.peak === null && metric.samples === 0
          : Number.isFinite(metric.average) &&
              metric.average >= 0 &&
              Number.isFinite(metric.peak) &&
              metric.peak >= metric.average &&
              metric.samples > 0,
        'Actual summary must contain measured values or explicit missing values',
      );
      if (key === 'busy' && metric.average !== null) assert.ok(metric.peak <= 100, 'Actual active time must remain within its percent scale');
    }
  }
  return {
    range,
    points: body.points.length,
    devices: body.devices.length,
    selectedKind: body.selected?.kind ?? null,
    selectedNameHash: body.selected ? hash(body.selected.name) : null,
    selectedNameLength: body.selected?.name.length ?? 0,
    collectorAvailable: body.collectorAvailable,
    storage: body.storage,
    lastSampleAt: body.lastSampleAt,
    persistedThrough: body.persistedThrough,
    responseHash: hash(JSON.stringify(body)),
  };
}
function sanitized(value, key = '') {
  if (typeof value === 'string' && ['text', 'title', 'accessibleName', 'context'].includes(key)) return { sha256: hash(value), length: value.length };
  if (Array.isArray(value)) return value.map((item) => sanitized(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, sanitized(item, name)]));
  return value;
}
async function warmup(read) {
  const began = Date.now();
  let attempts = 0;
  do {
    const catalogue = await read(historyPath('5m'));
    validateHistory(catalogue, '5m');
    attempts++;
    const selected = ['network', 'disk'].map((kind) => catalogue.devices.find((device) => device.kind === kind && device.present));
    if (catalogue.collectorAvailable && selected.every(Boolean)) {
      const samples = [];
      for (const device of selected) {
        const body = await read(historyPath('5m', { kind: device.kind, name: device.name }));
        validateHistory(body, '5m', { kind: device.kind, name: device.name });
        samples.push(body);
      }
      if (
        samples.every(
          (body) => body.collectorAvailable && body.points.some((point) => point.inbound.average !== null || point.outbound.average !== null),
        )
      )
        return { samples, attempts, elapsed: Date.now() - began };
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  } while (Date.now() - began < 45000);
  throw new Error('Actual network and disk history did not become available during bounded warmup');
}
async function restoreText(page) {
  await page.evaluate(() => {
    const state = window.__orbisHostHistoryTextScale;
    if (!state) return;
    state.observer.disconnect();
    for (const [element, value] of state.entries)
      for (const [name, original, priority] of value.original) {
        if (original) element.style.setProperty(name, original, priority);
        else element.style.removeProperty(name);
      }
    delete window.__orbisHostHistoryTextScale;
  });
}

async function scaleText(page, factor) {
  await restoreText(page);
  if (factor === 1) return;
  await page.evaluate((factor) => {
    const entries = new Map();
    const suitable = (element) => element instanceof HTMLElement && !element.matches('script,style,link,meta');
    const remember = (elements) => {
      const values = elements.map((element) => {
        const style = getComputedStyle(element);
        return [
          element,
          {
            font: Number.parseFloat(style.fontSize),
            line: style.lineHeight,
            original: ['font-size', 'line-height'].map((name) => [
              name,
              element.style.getPropertyValue(name),
              element.style.getPropertyPriority(name),
            ]),
          },
        ];
      });
      for (const [element, value] of values) entries.set(element, value);
    };
    const apply = () => {
      for (const [element, value] of entries)
        if (element.isConnected) {
          if (Number.isFinite(value.font)) element.style.setProperty('font-size', `${value.font * factor}px`, 'important');
          if (value.line !== 'normal') element.style.setProperty('line-height', `${Number.parseFloat(value.line) * factor}px`, 'important');
        }
    };
    remember([...document.querySelectorAll('body,body *')].filter(suitable));
    apply();
    const observer = new MutationObserver((records) => {
      const added = new Set();
      for (const record of records)
        for (const node of record.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (suitable(node) && node.isConnected && !entries.has(node)) added.add(node);
          for (const child of node.querySelectorAll('*')) if (suitable(child) && child.isConnected && !entries.has(child)) added.add(child);
        }
      if (!added.size) return;
      observer.disconnect();
      try {
        const pending = [...added];
        const roots = pending.filter((element) => {
          for (let parent = element.parentElement; parent; parent = parent.parentElement) if (added.has(parent)) return false;
          return true;
        });
        for (const root of roots) {
          const wrapper = document.createElement('div');
          wrapper.style.cssText = `position:fixed;left:-100000px;top:0;width:${innerWidth}px;visibility:hidden;pointer-events:none;contain:layout style paint;`;
          const chain = [];
          for (let ancestor = root.parentElement; ancestor && ancestor !== document.documentElement; ancestor = ancestor.parentElement)
            chain.unshift(ancestor);
          let destination = wrapper;
          const restoreClone = (source, target) => {
            const value = entries.get(source);
            if (value)
              for (const [name, original, priority] of value.original) {
                if (original) target.style.setProperty(name, original, priority);
                else target.style.removeProperty(name);
              }
          };
          for (const ancestor of chain) {
            const copy = ancestor.cloneNode(false);
            restoreClone(ancestor, copy);
            destination.append(copy);
            destination = copy;
          }
          const subtree = root.cloneNode(true);
          const originalElements = [root, ...root.querySelectorAll('*')];
          const copyElements = [subtree, ...subtree.querySelectorAll('*')];
          for (const [index, source] of originalElements.entries()) if (source instanceof HTMLElement) restoreClone(source, copyElements[index]);
          destination.append(subtree);
          document.body.append(wrapper);
          try {
            for (const [index, element] of originalElements.entries())
              if (added.has(element)) {
                const style = getComputedStyle(copyElements[index]);
                entries.set(element, {
                  font: Number.parseFloat(style.fontSize),
                  line: style.lineHeight,
                  original: ['font-size', 'line-height'].map((name) => [
                    name,
                    element.style.getPropertyValue(name),
                    element.style.getPropertyPriority(name),
                  ]),
                });
              }
          } finally {
            wrapper.remove();
          }
        }
        for (const element of added) {
          const value = entries.get(element);
          if (Number.isFinite(value.font)) element.style.setProperty('font-size', `${value.font * factor}px`, 'important');
          if (value.line !== 'normal') element.style.setProperty('line-height', `${Number.parseFloat(value.line) * factor}px`, 'important');
        }
      } finally {
        observer.observe(document.body, { childList: true, subtree: true });
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    window.__orbisHostHistoryTextScale = { factor, entries, observer };
  }, factor);
  await dom.settle(page);
}

function fieldsFor(device) {
  return device.kind === 'disk'
    ? [
        ['inbound', 'Read', 'bytesPerSecond'],
        ['outbound', 'Write', 'bytesPerSecond'],
        ['busy', 'Active time', 'percent'],
      ]
    : [
        ['inbound', 'Download', 'bytesPerSecond'],
        ['outbound', 'Upload', 'bytesPerSecond'],
      ];
}
async function assertRendered(page, body, device, range) {
  const summary = validateHistory(body, range, device);
  const fields = fieldsFor(device);
  const expected = fields.map(([field, label, unit]) => ({
    field,
    label,
    value: formatValue(body.points.at(-1)?.[field].average ?? null, unit),
    accessible: `Inspect ${device.name} ${label.toLowerCase()} history`,
  }));
  await page.waitForFunction(
    ({ expected, title, points }) => {
      const root = document.querySelector('.host-device-history');
      const charts = [...(root?.querySelectorAll('.host-history-chart') || [])];
      return (
        root?.getAttribute('aria-busy') === 'false' &&
        root.querySelector('[role=combobox]')?.title === title &&
        charts.length === expected.length &&
        charts.every(
          (chart, index) =>
            chart.querySelector('h3')?.textContent === expected[index].label &&
            chart.querySelector('header output')?.textContent === expected[index].value &&
            chart.querySelector('.metric-chart')?.dataset.metric === `host-${expected[index].field}` &&
            chart.querySelector('[role=slider]')?.getAttribute('aria-label') === expected[index].accessible &&
            chart.querySelector('[role=slider]')?.getAttribute('aria-valuemax') === String(Math.max(0, points - 1)),
        )
      );
    },
    { expected, title: `${device.kind === 'disk' ? 'Disk' : 'Network'}: ${device.name}`, points: body.points.length },
    { timeout: 8000 },
  );
  const url = new URL(page.url());
  samePrivate(url.searchParams.get('hostDevice'), keyOf(device), 'Published URL must retain the exact selected device');
  assert.equal(url.searchParams.get('range'), range, 'Published URL must retain the exact range');
  const times = await page.locator('.host-history-chart:first-child .metric-chart-times span').allTextContents();
  const expectedTimes = await page.evaluate(
    ({ from, to }) => {
      const options =
        to - from > 86400000 ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit' };
      return [from, from + (to - from) / 2, to].map((at) => new Date(at).toLocaleString(undefined, options));
    },
    { from: Date.parse(body.from), to: Date.parse(body.to) },
  );
  samePrivate(times, expectedTimes, 'Actual chart endpoints/midpoint must correspond to the response window');
  return { ...summary, exactValuesAndLabels: true, exactTimes: true, exactUrl: true };
}
async function latestRendered(page, responses, device, range) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const entries = () => responses.filter((item) => item.body.range === range && item.body.selected && keyOf(item.body.selected) === keyOf(device));
    const prior = entries().at(-1);
    assert.ok(prior, 'An actual preceding selected history response is required');
    try {
      const proof = await assertRendered(page, prior.body, device, range);
      if (entries().at(-1) === prior) return { proof, entry: prior };
    } catch (error) {
      if (entries().at(-1) === prior) throw error;
    }
  }
  throw new Error('Actual device history changed too frequently to establish correspondence');
}
async function assertPoint(page, chart, body, device, field, unit) {
  const index = Number(await chart.locator('[role=slider]').getAttribute('aria-valuenow'));
  const point = body.points[index];
  assert.ok(point, 'Selected chart index must correspond to an actual API point');
  const metric = point[field];
  const value = formatValue(metric.average, unit);
  const accessible = await chart.locator('[role=slider]').getAttribute('aria-valuetext');
  assert.ok(
    accessible.includes(device.name) && accessible.includes(value) && accessible.includes(`${metric.samples} sample`),
    'Accessible chart reading must match actual device/value/count',
  );
  if (metric.samples > 1)
    assert.ok(accessible.includes(`peak ${formatValue(metric.peak, unit)}`), 'Accessible chart peak must match actual response');
  const tooltip = chart.locator('.metric-chart-tooltip');
  samePrivate(await tooltip.locator('time').getAttribute('dateTime'), point.at, 'Chart inspection date must match actual sample');
  const text = await tooltip.textContent();
  assert.ok(text.includes(value), 'Visible chart inspection must contain actual measured value');
  if (metric.samples > 1)
    assert.ok(text.includes(`Peak ${formatValue(metric.peak, unit)} · ${metric.samples} samples`), 'Visible chart peak/count must match actual API');
  const time = await page.evaluate(
    ({ at, until }) => `${new Date(at).toLocaleString()}${until !== at ? ` – ${new Date(until).toLocaleTimeString()}` : ''}`,
    point,
  );
  samePrivate(await tooltip.locator('time').textContent(), time, 'Visible full chart interval must correspond to actual sample span');
  return { index, at: point.at, until: point.until, metric: { ...metric }, exactAccessibleAndVisibleReading: true };
}
async function chooseDevice(page, device) {
  const combo = page.locator('.host-device-history').getByRole('combobox', { name: 'Host device', exact: true });
  await combo.focus();
  await page.keyboard.press('Space');
  await page.getByRole('listbox').waitFor();
  const labels = await page.getByRole('option').evaluateAll((options) => options.map((option) => option.getAttribute('aria-label')));
  const target = `${device.kind === 'disk' ? 'Disk' : 'Network'} ${device.name}`;
  const position = labels.indexOf(target);
  assert.ok(position >= 0 && labels.length <= 64, 'Actual requested device must be present in the bounded selector');
  await page.keyboard.press('Home');
  await page.waitForFunction((name) => document.activeElement?.getAttribute('aria-label') === name, labels[0]);
  for (let index = 1; index <= position; index++) {
    await page.keyboard.press('ArrowDown');
    await page.waitForFunction((name) => document.activeElement?.getAttribute('aria-label') === name, labels[index]);
  }
  await page.keyboard.press('Enter');
  await page.getByRole('listbox').waitFor({ state: 'hidden' });
  await page.waitForFunction((key) => new URL(location.href).searchParams.get('hostDevice') === key, keyOf(device));
}
async function chrome(page) {
  const result = await page.evaluate(() => {
    const style = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const css = getComputedStyle(element);
      return {
        background: css.backgroundColor,
        blur: css.backdropFilter,
        borders: [css.borderTopColor, css.borderRightColor, css.borderBottomColor, css.borderLeftColor],
        shadow: css.boxShadow,
      };
    };
    return {
      navigation: document.querySelector('.desktop-route-window')?.dataset.windowNavigation,
      bar: style('.desktop-system-bar'),
      dock: style('.desktop-dock'),
      header: style('.desktop-window-bar'),
      frame: style('.desktop-route-window'),
    };
  });
  for (const item of [result.bar, result.dock]) {
    assert.equal(item.blur, 'blur(28px) saturate(1.45)', 'Actual bar/dock must retain matching28px blur');
    assert.ok(item.background.startsWith('rgba(') && !item.background.endsWith(', 1)'), 'Actual chrome remains translucent');
    assert.ok(
      item.borders.every((value) => value === 'rgba(0, 0, 0, 0)') && !item.shadow.includes('inset'),
      'Actual chrome must not have bright rims',
    );
  }
  if (result.navigation === 'desktop') {
    assert.equal(result.header.blur, result.dock.blur, 'Actual coloured titlebar shares dock glass');
    assert.equal(result.frame.background, 'rgba(0, 0, 0, 0)', 'Actual desktop frame must remain transparent');
    assert.ok(
      result.frame.borders.every((value) => value === 'rgba(0, 0, 0, 0)') && !result.frame.shadow.includes('inset'),
      'Actual frame has no bright rim',
    );
  } else assert.equal(await page.locator('.desktop-window-controls').count(), 0, 'Phone/tablet uses ordinary page navigation');
  return result;
}

async function readingGeometry(page) {
  const result = await page.evaluate(() => {
    const content = document.querySelector('.desktop-window-content');
    const frame = document.querySelector('.desktop-route-window');
    const rectangle = (element) => {
      if (!element) return null;
      const box = element.getBoundingClientRect();
      const contentBox = content.getBoundingClientRect();
      return {
        top: box.top,
        bottom: box.bottom,
        left: box.left,
        right: box.right,
        height: box.height,
        width: box.width,
        documentTop: box.top + scrollY,
        contentTop: box.top + content.scrollTop - contentBox.top,
      };
    };
    const scroller = (element) => {
      const style = getComputedStyle(element);
      return {
        scrollTop: element.scrollTop,
        scrollLeft: element.scrollLeft,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
        maxScroll: element.scrollHeight - element.clientHeight,
        overflowAnchor: style.overflowAnchor,
        scrollBehavior: style.scrollBehavior,
        box: rectangle(element),
      };
    };
    const plot = document.querySelector('.host-history-chart:first-child .metric-chart-plot');
    return {
      at: Date.now(),
      scroll: { x: scrollX, y: scrollY, frame: frame.scrollTop, content: content.scrollTop },
      scrollers: { document: scroller(document.scrollingElement), frame: scroller(frame), content: scroller(content) },
      navigation: frame.dataset.windowNavigation,
      focusedPlot: document.activeElement === plot,
      selectedAt: document.querySelector('.host-history-chart:first-child .metric-chart-tooltip time')?.getAttribute('datetime'),
      anchors: Object.fromEntries(
        [
          ['history', '.host-device-history'],
          ['heading', '#host-device-history-title'],
          ['chart', '.host-history-chart:first-child'],
          ['plot', '.host-history-chart:first-child .metric-chart-plot'],
          ['svg', '.host-history-chart:first-child svg'],
          ['inspection', '.host-history-chart:first-child .metric-chart-tooltip'],
          ['docker', '.container-resources'],
        ].map(([name, selector]) => [name, rectangle(document.querySelector(selector))]),
      ),
      upstream: [...document.querySelector('.desktop-monitor').children].map((element) => ({
        tag: element.tagName,
        classes: element.className,
        box: rectangle(element),
      })),
      containers: [...document.querySelectorAll('.container-resource-list > li')].map((element) => ({
        identity: element.dataset.container,
        box: rectangle(element),
      })),
      traces: window.__orbisHistoryReadingDiagnostic?.events.slice() || [],
      diagnosticHooks: window.__orbisHistoryReadingDiagnostic
        ? {
            installed: true,
            wrappersIntact: window.__orbisHistoryReadingDiagnostic.originals.every(({ owner, method, wrapper }) => owner[method] === wrapper),
          }
        : { installed: false },
    };
  });
  for (const item of result.containers) item.identity = hash(item.identity || '');
  return result;
}

async function installReadingDiagnostic(page) {
  await page.evaluate(() => {
    const events = [];
    const originals = [];
    const record = (method, args) => {
      const content = document.querySelector('.desktop-window-content');
      const plot = document.querySelector('.host-history-chart:first-child .metric-chart-plot');
      const bounds = plot?.getBoundingClientRect();
      events.push({
        at: Date.now(),
        method,
        arguments: args,
        contentScroll: content?.scrollTop,
        documentScroll: scrollY,
        focusedPlot: document.activeElement === plot,
        plotTop: bounds?.top,
        plotHeight: bounds?.height,
      });
      if (events.length > 160) events.shift();
    };
    for (const [owner, method] of [
      [window, 'scrollBy'],
      [window, 'scrollTo'],
      [Element.prototype, 'scrollIntoView'],
      [Element.prototype, 'scrollTo'],
      [Element.prototype, 'scrollBy'],
      [HTMLElement.prototype, 'focus'],
    ]) {
      const original = owner[method];
      if (typeof original !== 'function') continue;
      const wrapper = function (...args) {
        record(
          method,
          args.map((value) => (typeof value === 'object' ? { ...value } : value)),
        );
        return Reflect.apply(original, this, args);
      };
      originals.push({ owner, method, original, wrapper });
      owner[method] = wrapper;
    }
    const onScroll = () => record('native-scroll-event', []);
    const onFocus = () => record('native-focusin-event', []);
    document.addEventListener('scroll', onScroll, true);
    document.addEventListener('focusin', onFocus, true);
    const state = { events, originals, onScroll, onFocus, frame: null };
    let prior = '';
    const measure = () => {
      const content = document.querySelector('.desktop-window-content');
      const plot = document.querySelector('.host-history-chart:first-child .metric-chart-plot');
      const geometry = {
        contentScroll: content.scrollTop,
        contentHeight: content.scrollHeight,
        maxScroll: content.scrollHeight - content.clientHeight,
        historyTop: document.querySelector('.host-device-history').getBoundingClientRect().top,
        plotTop: plot.getBoundingClientRect().top,
        plotHeight: plot.getBoundingClientRect().height,
        processHeight: document.querySelector('.host-processes').getBoundingClientRect().height,
        dockerHeight: document.querySelector('.container-resources').getBoundingClientRect().height,
      };
      const key = JSON.stringify(geometry);
      if (key !== prior) {
        record('passive-layout-change', [geometry]);
        prior = key;
      }
      state.frame = requestAnimationFrame(measure);
    };
    window.__orbisHistoryReadingDiagnostic = state;
    state.frame = requestAnimationFrame(measure);
  });
}

async function restoreReadingDiagnostic(page) {
  await page.evaluate(() => {
    const state = window.__orbisHistoryReadingDiagnostic;
    if (!state) return;
    document.removeEventListener('scroll', state.onScroll, true);
    document.removeEventListener('focusin', state.onFocus, true);
    cancelAnimationFrame(state.frame);
    for (const { owner, method, original, wrapper } of state.originals) {
      if (owner[method] !== wrapper) throw new Error('Diagnostic scrolling hook was replaced before cleanup');
      owner[method] = original;
    }
    delete window.__orbisHistoryReadingDiagnostic;
  });
}

async function main() {
  process.umask(0o077);
  const desktopDiagnostic = process.env.ORBIS_AUDIT_HISTORY_DESKTOP_DIAGNOSTIC === '1';
  const auditGroups = desktopDiagnostic ? groups.slice(0, 1) : groups;
  const expectedCommit = process.env.ORBIS_AUDIT_EXPECTED_COMMIT;
  const expectedDigest = process.env.ORBIS_AUDIT_EXPECTED_DIGEST;
  const output = process.env.ORBIS_AUDIT_OUTPUT_DIR || '';
  const reportFile = path.join(output, 'report.json');
  const baselineFile = path.join(output, 'private-baseline.json');
  const errorFile = path.join(output, 'private-errors.json');
  const screenshots = path.join(output, 'screenshots');
  const report = {
    passed: false,
    release: null,
    groups: [],
    assets: {},
    forwardedReads: {},
    directReads: {},
    coreChecks: [],
    source: {
      live: [
        'Actual published HTML, JavaScript, stylesheets, images and authenticated GET responses',
        'Actual network/disk history responses, selected device/range, recorded values and timestamps; existing account preferences',
      ],
      controlled: [
        desktopDiagnostic ? 'One native1440 desktop diagnostic; no enlarged-text group' : 'One320px doubled-computed-text group',
        'Browser-only same-origin CSP header adjustment and OS dark media preference; all response bodies unchanged',
      ],
      desktopDiagnostic,
      diagnosticInstrumentation: desktopDiagnostic
        ? 'Pass-through scrolling/focus hooks and passive layout/frame observations; originals restored'
        : null,
      responseSubstitutions: 0,
      preferenceShadows: 0,
      realWrites: 0,
      captures: 'Private native viewport captures at actual focused/wheel reading positions; no scroll reset',
      privacy: 'Raw logical device identifiers/history samples and account baseline remain in0600 private files; public metrics contain hashes',
    },
    blockedMutations: [],
    blockedRedirects: [],
    externalRequestsBlocked: 0,
    readFailures: [],
    assetFailures: [],
    pageErrors: [],
    recordsUnchanged: false,
    cleanupFailures: [],
    cleanup: { groupContextsClosed: 0, readerClosed: false, anonymousClosed: false, browserClosed: false },
  };
  const baseline = { historySamples: [] };
  const rawErrors = [];
  let browser;
  let reader;
  let anonymous;
  let activeContext;
  let activePage;
  let origin;
  let release;
  let before;
  let outputReady = false;
  let stage = 'preflight';
  let cookieValues = [];
  const fail = (error) => {
    let message = String(error.stack || error.message || error);
    for (const value of cookieValues) message = message.replaceAll(value, '[private]');
    message = message
      .split('\n')
      .filter((line) => !/\b(?:cookie|authorization|headers)\b/i.test(line) && !/^\s*-?\s*[a-z][a-z0-9-]*:\s*/i.test(line))
      .join('\n');
    rawErrors.push({ stage, type: error.name || 'Error', redactedTrace: message });
    report.failure = { stage, code: 'PUBLISHED_HOST_HISTORY_UI_AUDIT_FAILED', messageHash: hash(message) };
  };
  const read = async (target) => {
    const address = new URL(target, origin.origin);
    assert.ok(
      target.startsWith('/api/') && address.origin === origin.origin && !address.hash && !/[\r\n]/.test(target),
      'Direct reads require owned API paths',
    );
    if (address.pathname === endpoint) {
      assert.ok(
        [...address.searchParams.keys()].every((key) => ['range', 'device'].includes(key)),
        'Only reviewed history queries are permitted',
      );
      assert.ok(Object.hasOwn(durations, address.searchParams.get('range') || '1h'), 'Reviewed history range required');
      if (address.searchParams.has('device')) {
        const value = address.searchParams.get('device');
        assert.equal(
          historyPath(address.searchParams.get('range') || '1h', {
            kind: value.slice(0, value.indexOf(':')),
            name: value.slice(value.indexOf(':') + 1),
          }),
          `${address.pathname}${address.search}`,
          'Canonical fixed history lookup required',
        );
      }
    } else
      assert.ok(
        !address.search &&
          (/^\/api\/apps\/[^/]+$/.test(address.pathname) ||
            ['/api/user-context', '/api/app-context', '/api/system/build', '/api/desktop-preferences', '/api/marketplace/all'].includes(
              address.pathname,
            )),
        'Only reviewed baseline API reads are permitted',
      );
    const response = await reader.request.get(`${origin.origin}${target}`, { maxRedirects: 0, timeout: 15000 });
    report.directReads[safePath(address.pathname)] = (report.directReads[safePath(address.pathname)] || 0) + 1;
    if (response.status() !== 200) report.readFailures.push({ source: 'direct', path: safePath(address.pathname), status: response.status() });
    assert.equal(response.status(), 200, 'Owned authenticated GET must return200');
    return response.json();
  };
  const buildExact = async () => {
    const build = await read('/api/system/build');
    assert.ok(
      build.version === expectedTag && build.commit === expectedCommit && build.imageDigest === expectedDigest,
      'Actual build differs from exact release pins',
    );
  };
  const snapshot = async () => {
    const installed = await read('/api/apps/installed');
    assert.ok(Array.isArray(installed.installed), 'Installed records must be available');
    const apps = {};
    for (const item of installed.installed) {
      const urn = item.info?.urn;
      assert.ok(typeof urn === 'string' && urn.includes(':') && !Object.hasOwn(apps, urn), 'Installed identity must be valid and unique');
      apps[urn] = await read(`/api/apps/${encodeURIComponent(urn)}`);
      assert.ok(apps[urn].info?.urn === urn, 'Full installed record identity differs');
    }
    return { preferences: await read('/api/desktop-preferences'), installed, apps, stores: await read('/api/marketplace/all') };
  };
  const save = () => {
    privateWrite(baselineFile, baseline);
    privateWrite(errorFile, rawErrors);
    privateWrite(reportFile, { ...report, stage });
  };
  try {
    assert.deepEqual(process.argv.slice(2), ['--allow-owned-published-host-history'], 'Explicit owned published audit argument is required');
    assert.equal(process.env.ORBIS_ALLOW_LIVE_HOST_HISTORY_AUDIT, '1', 'Explicit published history audit opt-in is required');
    assert.equal(expectedTag, 'v0.1.0-beta.45', 'Only reviewed beta45 is permitted');
    assert.match(expectedCommit || '', /^[a-f0-9]{40}$/, 'Exact reviewed full commit is required');
    assert.ok(output && path.isAbsolute(output), 'Explicit fresh audit output path is required');
    assert.match(expectedDigest || '', /^sha256:[a-f0-9]{64}$/, 'Exact reviewed published digest is required');
    assert.equal(process.env.ORBIS_AUDIT_COOKIE_FILE, ownedCookieFile, 'Only the owned private cookie jar is permitted');
    assert.equal(process.env.ORBIS_AUDIT_RELEASE_FILE, releasePath, 'Only the reviewed private release manifest is permitted');
    origin = new URL(process.env.ORBIS_AUDIT_URL || 'http://127.0.0.1:18080');
    assert.ok(origin.href === 'http://127.0.0.1:18080/' && !origin.username && !origin.password, 'Only owned loopback18080 is permitted');
    const stat = fs.lstatSync(installRoot);
    assert.ok(
      stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && fs.realpathSync(installRoot) === installRoot,
      'Owned installation root differs',
    );
    release = parsePrivate(readOwnedInput(releasePath), 'Release manifest');
    assert.ok(
      release.tag === expectedTag && release.commit === expectedCommit && release.image === `ghcr.io/twentylines/orbis@${expectedDigest}`,
      'Release manifest and exact pins differ',
    );
    const cookies = parseCookies(readOwnedInput(ownedCookieFile), origin.hostname);
    cookieValues = cookies.map((cookie) => cookie.value);
    temporaryOutput(output);
    assert.ok(!fs.existsSync(output), 'Use a new private evidence directory');
    privateDirectory(output);
    privateDirectory(screenshots);
    outputReady = true;
    report.release = { tag: expectedTag, commit: expectedCommit, digest: expectedDigest };
    const core = verifyCore(release.image);
    const architecture = parsePrivate(
      readDocker(['inspect', '--type', 'image', '--format', '{{json .Architecture}}', core.imageId]),
      'Owned image architecture',
    );
    assert.equal(architecture, 'arm64', 'The owned running image must be arm64');
    report.coreChecks.push({ ...core, architecture });
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.ORBIS_BROWSER_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    });
    reader = await browser.newContext({ serviceWorkers: 'block' });
    await reader.addCookies(cookies);
    await buildExact();
    assert.equal((await read('/api/user-context')).isLoggedIn, true, 'Owned session must authenticate');
    const appContext = await read('/api/app-context');
    assert.ok(appContext.user?.hasSeenWelcome && appContext.user?.locale === 'en', 'Existing English account onboarding must be complete');
    before = await snapshot();
    baseline.before = before;
    assert.ok(
      ['light', 'dark', 'system'].includes(before.preferences.mode) &&
        ['frost', 'graphite', 'forest', 'stone', 'ocean', 'blush'].includes(before.preferences.preset),
      'Existing valid real appearance preferences required; audit will not change them',
    );
    anonymous = await browser.newContext({ serviceWorkers: 'block' });
    const unauthenticated = await anonymous.request.get(`${origin.origin}${endpoint}`, { maxRedirects: 0, timeout: 15000 });
    assert.equal(unauthenticated.status(), 401, 'Unauthenticated history GET must return401');
    report.unauthenticatedStatus = unauthenticated.status();
    await anonymous.close();
    anonymous = undefined;
    report.cleanup.anonymousClosed = true;
    stage = 'actual-history-warmup';
    const warmed = await warmup(read);
    const selectedDevices = warmed.samples.map((sample) => ({ ...sample.selected }));
    report.warmup = {
      attempts: warmed.attempts,
      elapsed: warmed.elapsed,
      samples: warmed.samples.map((sample) => validateHistory(sample, '5m', sample.selected)),
    };
    baseline.historySamples.push(...warmed.samples);
    save();
    for (const group of auditGroups) {
      stage = `${group.width}x${group.height}-text${group.textScale}`;
      const result = {
        ...group,
        passed: false,
        actualHistoryReads: 0,
        captures: [],
        cleanup: {
          textRestored: false,
          viewportRestored: false,
          pageClosed: false,
          routesRestored: false,
          listenersRestored: false,
          diagnosticRestored: false,
          contextClosed: false,
        },
      };
      report.groups.push(result);
      await buildExact();
      activeContext = await browser.newContext({
        viewport: { width: group.width, height: group.height },
        colorScheme: 'dark',
        serviceWorkers: 'block',
      });
      await activeContext.addCookies(cookies);
      const jobs = [];
      const responses = [];
      let closing = false;
      const failed = (request) => {
        const target = new URL(request.url());
        if (!closing && target.origin === origin.origin && ['document', 'script', 'stylesheet', 'image', 'font'].includes(request.resourceType()))
          report.assetFailures.push({
            group: stage,
            path: safePath(target.pathname),
            kind: request.resourceType(),
            messageHash: hash(request.failure()?.errorText || 'Asset failed'),
          });
      };
      const responded = (response) => {
        const request = response.request();
        const target = new URL(request.url());
        if (target.origin !== origin.origin) return;
        if (!response.ok() && response.status() !== 304)
          report.readFailures.push({ group: stage, path: safePath(target.pathname), status: response.status() });
        if (target.pathname === endpoint && response.ok())
          jobs.push(
            response
              .json()
              .then((body) => {
                responses.push({ at: Date.now(), body });
                baseline.historySamples.push(body);
                result.actualHistoryReads++;
              })
              .catch((error) => {
                if (!closing) report.readFailures.push({ group: stage, path: endpoint, messageHash: hash(error.message) });
              }),
          );
        if (desktopDiagnostic && ['/api/system/containers', '/api/system/host-processes'].includes(target.pathname) && response.ok())
          jobs.push(
            response
              .json()
              .then((body) => {
                baseline.upstreamSamples ??= [];
                baseline.upstreamSamples.push({ at: Date.now(), path: target.pathname, body });
              })
              .catch((error) => {
                if (!closing) report.readFailures.push({ group: stage, path: target.pathname, messageHash: hash(error.message) });
              }),
          );
        const kind = request.resourceType();
        if (response.ok() && ['document', 'script', 'stylesheet', 'image', 'font'].includes(kind))
          jobs.push(
            response
              .body()
              .then((body) => {
                report.assets[`${safePath(target.pathname)}:${hash(body)}`] = { kind, bytes: body.length, sha256: hash(body) };
              })
              .catch((error) => {
                if (!closing) report.assetFailures.push({ group: stage, path: safePath(target.pathname), kind, messageHash: hash(error.message) });
              }),
          );
      };
      const handler = async (route) => {
        const request = route.request();
        const target = new URL(request.url());
        if (target.origin !== origin.origin) {
          report.externalRequestsBlocked++;
          return route.abort('blockedbyclient');
        }
        if (
          !readMethods.has(request.method()) ||
          /^\/api\/auth\//.test(target.pathname) ||
          /\/(?:refresh|restart|reboot|shutdown|install|uninstall|logout)(?:\/|$)/.test(target.pathname)
        ) {
          report.blockedMutations.push({ group: stage, method: request.method(), path: safePath(target.pathname) });
          return route.abort('blockedbyclient');
        }
        if (target.pathname.startsWith('/api/'))
          report.forwardedReads[safePath(target.pathname)] = (report.forwardedReads[safePath(target.pathname)] || 0) + 1;
        if (target.pathname === '/api/sse/app' && !target.search) return route.continue();
        try {
          const response = await route.fetch({ maxRedirects: 0, timeout: 15000 });
          if (response.status() >= 300 && response.status() < 400 && response.status() !== 304) {
            report.blockedRedirects.push({ group: stage, path: safePath(target.pathname), status: response.status() });
            return route.abort('blockedbyclient');
          }
          const headers = response.headers();
          if (request.resourceType() === 'document')
            headers['content-security-policy'] = headers['content-security-policy']
              ? `${headers['content-security-policy']}, connect-src 'self'`
              : "connect-src 'self'";
          return route.fulfill({ response, headers });
        } catch (error) {
          if (!closing) report.readFailures.push({ group: stage, path: safePath(target.pathname), messageHash: hash(error.message) });
          return route.abort('failed').catch(() => undefined);
        }
      };
      activeContext.on('requestfailed', failed);
      activeContext.on('response', responded);
      await activeContext.route('**/*', handler);
      activePage = await activeContext.newPage();
      activePage.on('pageerror', (error) => report.pageErrors.push({ group: stage, type: error.name, messageHash: hash(error.message) }));
      const shot = async (name) => {
        const file = path.join(screenshots, `${stage}-${name}-actual-viewport.png`);
        temporaryOutput(file);
        await activePage.screenshot({ path: file, fullPage: false });
        fs.chmodSync(file, 0o600);
        result.captures.push(path.basename(file));
      };
      const root = () => activePage.locator('.host-device-history');
      const focusClear = async () => {
        const metrics = await dom.focusMetrics(activePage);
        assert.ok(metrics.top >= metrics.chromeBottom + 3 && metrics.bottom <= metrics.dockTop - 3, 'Actual native focus must clear chrome');
        assert.ok(!metrics.outline.startsWith('0px') || metrics.shadow !== 'none', 'Actual focus must have a visible marker');
        const { text, ...publicFocus } = metrics;
        return { ...publicFocus, textHash: hash(text), textLength: text.length };
      };
      try {
        const network = selectedDevices.find((device) => device.kind === 'network');
        const expectedResponse = (range, device) =>
          activePage.waitForResponse(
            (response) => {
              const target = new URL(response.url());
              return (
                target.pathname === endpoint &&
                target.searchParams.get('range') === range &&
                target.searchParams.get('device') === keyOf(device) &&
                response.status() === 200
              );
            },
            { timeout: 15000 },
          );
        const initialResponse = expectedResponse('5m', network);
        void initialResponse.catch(() => undefined);
        const selectedUrl = new URL('/monitor', origin.origin);
        selectedUrl.searchParams.set('range', '5m');
        selectedUrl.searchParams.set('hostDevice', keyOf(network));
        await activePage.goto(selectedUrl.href, { waitUntil: 'domcontentloaded' });
        const initialSample = await (await initialResponse).json();
        validateHistory(initialSample, '5m', network);
        await root().waitFor();
        await dom.settle(activePage);
        await Promise.all(jobs);
        result.initial = (await latestRendered(activePage, responses, network, '5m')).proof;
        await scaleText(activePage, group.textScale);
        const initialMetrics = await historyDom.measure(activePage);
        historyDom.check(initialMetrics);
        result.initialMetrics = sanitized(initialMetrics);
        result.chrome = await chrome(activePage);
        const appearance = await activePage
          .locator('.desktop')
          .evaluate((element) => ({ mode: element.dataset.desktopMode, preset: element.dataset.desktopPreset }));
        assert.equal(appearance.preset, before.preferences.preset, 'Actual preset must remain unchanged');
        assert.equal(
          appearance.mode,
          before.preferences.mode === 'system' ? 'dark' : before.preferences.mode,
          'Actual resolved mode must match existing preference',
        );
        result.appearance = appearance;
        await shot('initial');
        result.selections = [];
        for (const device of selectedDevices) {
          if (device.kind !== 'network') {
            const selectedResponse = expectedResponse('5m', device);
            void selectedResponse.catch(() => undefined);
            await chooseDevice(activePage, device);
            await selectedResponse;
            await dom.settle(activePage);
            await Promise.all(jobs);
          }
          const item = { kind: device.kind, nameHash: hash(device.name), nameLength: device.name.length, ranges: [], keyboard: [], captures: [] };
          result.selections.push(item);
          item.ranges.push((await latestRendered(activePage, responses, device, '5m')).proof);
          const rangeGroup = root().getByRole('group', { name: 'Device history time range', exact: true });
          const hourResponse = expectedResponse('1h', device);
          void hourResponse.catch(() => undefined);
          await rangeGroup.getByRole('button', { name: '1 hour', exact: true }).focus();
          await activePage.keyboard.press('Enter');
          await hourResponse;
          await dom.settle(activePage);
          await Promise.all(jobs);
          item.ranges.push((await latestRendered(activePage, responses, device, '1h')).proof);
          await rangeGroup.getByRole('button', { name: '5 min', exact: true }).focus();
          await activePage.keyboard.press('Enter');
          await dom.settle(activePage);
          await Promise.all(jobs);
          await latestRendered(activePage, responses, device, '5m');
          const combo = root().getByRole('combobox', { name: 'Host device', exact: true });
          await combo.focus();
          await activePage.keyboard.press('Tab');
          assert.equal(
            await rangeGroup.getByRole('button', { name: '5 min', exact: true }).evaluate((element) => element === document.activeElement),
            true,
            'Actual native Tab reaches time range',
          );
          for (let index = 0; index < 4; index++) await activePage.keyboard.press('Tab');
          const firstPlot = root().getByRole('slider').first();
          assert.equal(
            await firstPlot.evaluate((element) => element === document.activeElement),
            true,
            'Actual native Tab reaches the first device chart',
          );
          item.nativeTabFocus = await focusClear();
          for (const [index, [field, , unit]] of fieldsFor(device).entries()) {
            const chart = root().locator('.host-history-chart').nth(index);
            const plot = chart.getByRole('slider');
            await plot.focus();
            for (const key of ['Home', 'ArrowRight', 'End']) {
              let proved = false;
              for (let attempt = 0; attempt < 3; attempt++) {
                await Promise.all(jobs);
                const prior = await latestRendered(activePage, responses, device, '5m');
                const beforeIndex = Number(await plot.getAttribute('aria-valuenow'));
                await activePage.keyboard.press(key);
                await dom.settle(activePage);
                await Promise.all(jobs);
                const current = responses
                  .filter((value) => value.body.range === '5m' && value.body.selected && keyOf(value.body.selected) === keyOf(device))
                  .at(-1);
                if (current !== prior.entry) continue;
                const expectedIndex =
                  key === 'Home' ? 0 : key === 'End' ? current.body.points.length - 1 : Math.min(current.body.points.length - 1, beforeIndex + 1);
                assert.equal(
                  Number(await plot.getAttribute('aria-valuenow')),
                  expectedIndex,
                  'Actual native key selects the correct recorded sample',
                );
                item.keyboard.push({
                  field,
                  key,
                  attempts: attempt + 1,
                  proof: await assertPoint(activePage, chart, current.body, device, field, unit),
                });
                proved = true;
                break;
              }
              assert.ok(proved, 'Actual recorded chart remains inspectable across native keys');
            }
            item.keyboard.at(-1).focus = await focusClear();
            const metrics = await historyDom.measure(activePage);
            historyDom.check(metrics);
            item.keyboard.at(-1).metrics = sanitized(metrics);
          }
          await historyDom.wheelReveal(activePage, `.host-history-chart:nth-child(${fieldsFor(device).length}) .metric-chart-tooltip`);
          await shot(`${device.kind}-inspection`);
          if (group.poll && device.kind === 'network') {
            if (desktopDiagnostic) await installReadingDiagnostic(activePage);
            await firstPlot.focus();
            await activePage.keyboard.press('End');
            await dom.settle(activePage);
            await historyDom.wheelReveal(activePage, '.host-history-chart:first-child .metric-chart-tooltip');
            await shot('network-before-poll');
            const beforeGeometry = await readingGeometry(activePage);
            const beforeScroll = beforeGeometry.scroll;
            const selectedAt = await root().locator('.host-history-chart:first-child .metric-chart-tooltip time').getAttribute('dateTime');
            const prior = (await latestRendered(activePage, responses, device, '5m')).entry;
            item.refresh = { before: beforeScroll, beforeGeometry, checkpoints: [], passed: false };
            save();
            let previousReceipt = null;
            let distinct = false;
            for (let attempt = 0; attempt < 2; attempt++) {
              const nextResponse = await expectedResponse('5m', device);
              const nextBody = await nextResponse.json();
              const receivedAt = Date.now();
              validateHistory(nextBody, '5m', device);
              assert.ok(nextBody.collectorAvailable, 'Actual background collector remains available during refresh');
              const interval = previousReceipt === null ? null : receivedAt - previousReceipt;
              if (interval !== null) assert.ok(interval >= 9000 && interval <= 12500, 'Actual active history polls retain the ten-second cadence');
              previousReceipt = receivedAt;
              await dom.settle(activePage);
              await Promise.all(jobs);
              const afterGeometry = await readingGeometry(activePage);
              const afterScroll = afterGeometry.scroll;
              const checkpoint = {
                actualResponse200: true,
                intervalFromPriorPoll: interval,
                before: beforeScroll,
                after: afterScroll,
                beforeGeometry,
                afterGeometry,
              };
              item.refresh.checkpoints.push(checkpoint);
              save();
              await shot(`network-poll-${attempt + 1}`);
              samePrivate(afterScroll, beforeScroll, 'Actual history polling preserves exact natural reading position');
              assert.equal(
                await firstPlot.evaluate((element) => element === document.activeElement),
                true,
                'Actual history polling preserves focused chart',
              );
              samePrivate(
                await root().locator('.host-history-chart:first-child .metric-chart-tooltip time').getAttribute('dateTime'),
                selectedAt,
                'Actual refresh retains the inspected sample time',
              );
              const actual = await latestRendered(activePage, responses, device, '5m');
              const metrics = await historyDom.measure(activePage);
              historyDom.check(metrics);
              Object.assign(checkpoint, {
                proof: actual.proof,
                metrics: sanitized(metrics),
              });
              distinct ||= nextBody.lastSampleAt !== prior.body.lastSampleAt;
            }
            assert.ok(distinct, 'Actual background collection advances within two active ten-second polls');
            item.refresh.distinctSample = distinct;
            item.refresh.passed = true;
            await shot('network-refreshed');
          }
        }
        result.images = await activePage.evaluate(() =>
          [...document.images].map((image) => ({
            visible: Boolean(image.getClientRects().length),
            complete: image.complete,
            loaded: image.naturalWidth > 0,
          })),
        );
        assert.ok(
          result.images.every((image) => !image.visible || (image.complete && image.loaded)),
          'All actual visible images must load',
        );
        assert.equal(await activePage.locator('.orbis-error-panel').count(), 0, 'Actual published Monitor must not show fallback');
        result.passed = true;
      } catch (error) {
        await shot('failure').catch(() => {
          result.failureCaptureUnavailable = true;
        });
        throw error;
      } finally {
        const attempt = async (key, action) => {
          try {
            await action();
            result.cleanup[key] = true;
          } catch (error) {
            report.cleanupFailures.push(`${stage}:${key}`);
            fail(error);
          }
        };
        await attempt('textRestored', () => restoreText(activePage));
        await attempt('diagnosticRestored', () => restoreReadingDiagnostic(activePage));
        await attempt('viewportRestored', () => activePage.setViewportSize({ width: group.width, height: group.height }));
        closing = true;
        await Promise.all(jobs);
        await attempt('pageClosed', () => activePage.close());
        activePage = undefined;
        await attempt('routesRestored', () => activeContext.unroute('**/*', handler));
        await attempt('listenersRestored', async () => {
          activeContext.off('requestfailed', failed);
          activeContext.off('response', responded);
          assert.equal(activeContext.listeners('requestfailed').includes(failed), false);
          assert.equal(activeContext.listeners('response').includes(responded), false);
        });
        await attempt('contextClosed', () => activeContext.close());
        activeContext = undefined;
        if (result.cleanup.contextClosed) report.cleanup.groupContextsClosed++;
        if (!Object.values(result.cleanup).every(Boolean)) result.passed = false;
        save();
      }
    }
    stage = 'final-records';
    baseline.after = await snapshot();
    samePrivate(baseline.after, before, 'Actual preferences/app/store records changed');
    report.recordsUnchanged = true;
    await buildExact();
    const afterCore = verifyCore(release.image);
    report.coreChecks.push(afterCore);
    assert.equal(afterCore.imageId, report.coreChecks[0].imageId, 'Actual image identity changed during audit');
    assert.equal(afterCore.idHash, report.coreChecks[0].idHash, 'Actual core container identity changed during audit');
    assert.equal(report.groups.length, auditGroups.length);
    assert.ok(report.groups.every((group) => group.passed));
    report.passed = true;
  } catch (error) {
    fail(error);
  } finally {
    if (reader && before)
      try {
        baseline.after = await snapshot();
        samePrivate(baseline.after, before, 'Final actual records changed');
        report.recordsUnchanged = true;
      } catch (error) {
        report.recordsUnchanged = false;
        report.cleanupFailures.push('final-record-comparison-failed');
        fail(error);
      }
    if (activePage)
      await activePage.close().catch((error) => {
        report.cleanupFailures.push('active-page-close-failed');
        fail(error);
      });
    if (activeContext)
      await activeContext.close().catch((error) => {
        report.cleanupFailures.push('active-context-close-failed');
        fail(error);
      });
    if (anonymous)
      await anonymous
        .close()
        .then(() => {
          report.cleanup.anonymousClosed = true;
        })
        .catch((error) => {
          report.cleanupFailures.push('anonymous-close-failed');
          fail(error);
        });
    if (reader)
      await reader
        .close()
        .then(() => {
          report.cleanup.readerClosed = true;
        })
        .catch((error) => {
          report.cleanupFailures.push('reader-close-failed');
          fail(error);
        });
    if (browser)
      await browser
        .close()
        .then(() => {
          report.cleanup.browserClosed = true;
        })
        .catch((error) => {
          report.cleanupFailures.push('browser-close-failed');
          fail(error);
        });
    if (
      !report.recordsUnchanged ||
      !report.cleanup.readerClosed ||
      !report.cleanup.anonymousClosed ||
      !report.cleanup.browserClosed ||
      report.cleanup.groupContextsClosed !== auditGroups.length ||
      report.cleanupFailures.length ||
      report.blockedMutations.length ||
      report.blockedRedirects.length ||
      report.externalRequestsBlocked ||
      report.readFailures.length ||
      report.assetFailures.length ||
      report.pageErrors.length
    )
      report.passed = false;
    if (outputReady) save();
  }
  process.stdout.write(
    `${JSON.stringify({ passed: report.passed, code: report.passed ? 'PUBLISHED_HOST_HISTORY_UI_AUDIT_PASSED' : 'PUBLISHED_HOST_HISTORY_UI_AUDIT_FAILED', groups: report.groups.length, recordsUnchanged: report.recordsUnchanged, browserClosed: report.cleanup.browserClosed, reportFile: outputReady ? reportFile : null })}\n`,
  );
  if (!report.passed) process.exitCode = 1;
}
if (require.main === module)
  main().catch(() => {
    process.stderr.write('PUBLISHED_HOST_HISTORY_UI_AUDIT_FAILED\n');
    process.exitCode = 1;
  });
module.exports = { main };
