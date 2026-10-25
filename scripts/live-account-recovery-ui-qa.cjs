// Bounded published account recovery UI acceptance on the separate owned rehearsal only.
// Actual old/new login and own-session logout are the only permitted mutations. No reset/enrolment call is made.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const { chromium } = require('@playwright/test');
const { dom } = require('./host-devices-checks.cjs');

const installRoot = (process.env.ORBIS_QA_RECOVERY_ROOT || '/opt/orbis-qa/recovery');
const ownedCookieFile = `${installRoot}/post-reset-observer.private.cookies`;
const credentialFile = `${installRoot}/recovery-credentials.private.json`;
const dockerContext = 'colima-orbis-recovery-test';
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
  if (file === ownedCookieFile || file === credentialFile) {
    assert.equal(real, file, 'Owned credential/session path must not redirect');
    assert.equal(stat.mode & 0o077, 0, 'Owned credentials/sessions must remain private');
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

const recoveryProject = 'runtipi';
const recoveryNetwork = 'runtipi_tipi_main_network';
const expectedComposeFiles = [`${installRoot}/docker-compose.yml`, `${installRoot}/user-config/tipi-compose.yml`, `${installRoot}/orbis-compose.yml`];
const coreOwnedMounts = {
  '/data/.env': '.env',
  '/data/apps': 'apps',
  '/data/repos': 'repos',
  '/data/user-config': 'user-config',
  '/data/state': 'state',
  '/app-data': 'app-data',
};
function requireOwnedMounts(container, expected) {
  assert.ok(Array.isArray(container.mounts), 'Owned container mount inspection must be available');
  for (const [destination, relative] of Object.entries(expected)) {
    const mounts = container.mounts.filter((mount) => mount.Destination === destination);
    assert.ok(
      mounts.length === 1 && mounts[0].Type === 'bind' && mounts[0].Source === path.join(installRoot, relative),
      'Container binds do not match the separate owned recovery root',
    );
    assert.equal(
      container.mounts.filter((mount) => mount.Destination.startsWith(`${destination}/`)).length,
      0,
      'Unexpected nested override of an owned bind',
    );
  }
}
function requireRecoveryLabels(container, service) {
  assert.equal(container.project, recoveryProject, 'Recovery container must belong to the exact Compose project');
  assert.equal(container.service, service, 'Recovery container service label differs');
  assert.equal(container.workingDir, installRoot, 'Recovery Compose working directory differs from the owned root');
  assert.equal(typeof container.configFiles, 'string', 'Recovery Compose configuration labels must be present');
  samePrivate(container.configFiles.split(','), expectedComposeFiles, 'Recovery Compose configuration paths/order differ');
  assert.equal(container.running, true, 'Recovery service must be running');
  assert.equal(container.paused, false, 'Recovery service must be unpaused');
}
function unpublished(ports) {
  assert.ok(ports && typeof ports === 'object' && !Array.isArray(ports), 'Port inspection must be an object');
  return Object.values(ports).every((bindings) => bindings === null || (Array.isArray(bindings) && bindings.length === 0));
}
function requireProxyPorts(ports) {
  assert.ok(ports && typeof ports === 'object' && !Array.isArray(ports), 'Ingress port inspection must be an object');
  samePrivate(Object.keys(ports).sort(), ['443/tcp', '80/tcp'], 'Only the two reviewed ingress ports may be published');
  const result = {};
  for (const [port, expected] of [
    ['80/tcp', '18082'],
    ['443/tcp', '18446'],
  ]) {
    const bindings = ports[port];
    assert.ok(Array.isArray(bindings) && bindings.length >= 1 && bindings.length <= 2, 'Each ingress port must have a reviewed loopback binding');
    const ips = new Set();
    for (const binding of bindings) {
      assert.ok(
        binding && ['127.0.0.1', '::1'].includes(binding.HostIp) && binding.HostPort === expected,
        'Ingress must publish only the exact reviewed loopback HTTP/TLS binding',
      );
      assert.equal(ips.has(binding.HostIp), false, 'Duplicate ingress binding');
      ips.add(binding.HostIp);
    }
    result[port] = bindings
      .map((binding) => ({ HostIp: binding.HostIp, HostPort: binding.HostPort }))
      .sort((a, b) => a.HostIp.localeCompare(b.HostIp));
  }
  return result;
}
function validateRecoveryTopology(core, proxy) {
  requireRecoveryLabels(core, 'runtipi');
  requireRecoveryLabels(proxy, 'runtipi-reverse-proxy');
  assert.equal(core.health, 'healthy', 'Pinned recovery backend must be healthy');
  assert.ok(unpublished(core.ports) && unpublished(core.hostBindings), 'Recovery backend must not publish any host ports');
  requireOwnedMounts(core, coreOwnedMounts);
  requireOwnedMounts(proxy, { '/etc/traefik': 'traefik', '/shared': 'traefik/shared' });
  const socket = proxy.mounts.filter((mount) => mount.Destination === '/var/run/docker.sock');
  assert.ok(
    socket.length === 1 && socket[0].Type === 'bind' && socket[0].Source === '/var/run/docker.sock' && socket[0].RW === false,
    'Ingress Docker socket must remain the reviewed read-only bind',
  );
  assert.equal(proxy.mounts.length, 3, 'Unexpected ingress mount override');
  const published = requireProxyPorts(proxy.ports);
  samePrivate(requireProxyPorts(proxy.hostBindings), published, 'Configured and actual ingress bindings differ');
  for (const container of [core, proxy]) {
    assert.equal(container.networkMode, recoveryNetwork, 'Recovery services must use the reviewed isolated Compose network');
    assert.ok(
      Array.isArray(container.networks) && container.networks.length === 1,
      'Each recovery service must have exactly its reviewed network attachment',
    );
    assert.equal(container.networks[0].name, recoveryNetwork, 'Recovery network name differs');
    assert.match(container.networks[0].networkId || '', /^[a-f0-9]{64}$/, 'Actual Docker network identity must be present');
  }
  assert.equal(core.networks[0].networkId, proxy.networks[0].networkId, 'Pinned backend and ingress must share the actual network identity');
  return { networkIdHash: hash(core.networks[0].networkId), published, backendUnpublished: true, ownedRootAndProject: true };
}
function verifyCore(image) {
  const oneService = (service) => {
    const ids = readDocker(['ps', '-q', '--filter', `label=com.docker.compose.service=${service}`])
      .trim()
      .split('\n')
      .filter(Boolean);
    assert.equal(ids.length, 1, 'Exactly one running reviewed service is required in the separate owned Docker context');
    return ids[0];
  };
  const coreId = oneService('runtipi');
  const proxyId = oneService('runtipi-reverse-proxy');
  const format =
    '{"id":{{json .Id}},"image":{{json .Config.Image}},"imageId":{{json .Image}},"running":{{json .State.Running}},"paused":{{json .State.Paused}},"startedAt":{{json .State.StartedAt}},"health":{{with (index .State "Health")}}{{json (index . "Status")}}{{else}}null{{end}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"workingDir":{{json (index .Config.Labels "com.docker.compose.project.working_dir")}},"configFiles":{{json (index .Config.Labels "com.docker.compose.project.config_files")}},"mounts":{{json .Mounts}},"ports":{{json .NetworkSettings.Ports}},"hostBindings":{{json .HostConfig.PortBindings}},"networkMode":{{json .HostConfig.NetworkMode}},"networks":[{{range $key, $value := .NetworkSettings.Networks}}{"name":{{json $key}},"networkId":{{json $value.NetworkID}}},{{end}}null]}';
  const core = parsePrivate(readDocker(['inspect', '--format', format, coreId]), 'Owned recovery core inspection');
  const proxy = parsePrivate(readDocker(['inspect', '--format', format, proxyId]), 'Owned recovery ingress inspection');
  core.networks = core.networks.filter(Boolean);
  proxy.networks = proxy.networks.filter(Boolean);
  assert.match(core.id, /^[a-f0-9]{64}$/, 'Owned backend container identity is invalid');
  assert.match(proxy.id, /^[a-f0-9]{64}$/, 'Owned ingress container identity is invalid');
  assert.ok(Number.isFinite(Date.parse(core.startedAt)) && Number.isFinite(Date.parse(proxy.startedAt)), 'Recovery start witnesses are invalid');
  assert.equal(core.image, image, 'Owned core image differs from the expected published image');
  assert.match(core.imageId, /^sha256:[a-f0-9]{64}$/, 'Owned core image identity is invalid');
  assert.match(proxy.imageId, /^sha256:[a-f0-9]{64}$/, 'Owned ingress image identity is invalid');
  const imageDigests = parsePrivate(
    readDocker(['inspect', '--type', 'image', '--format', '{{json .RepoDigests}}', core.imageId]),
    'Owned image digests',
  );
  assert.ok(Array.isArray(imageDigests) && imageDigests.includes(image), 'Running image does not contain the pinned published digest');
  const topology = validateRecoveryTopology(core, proxy);
  return {
    idHash: hash(core.id),
    image: core.image,
    imageId: core.imageId,
    startedAt: core.startedAt,
    healthy: true,
    ownedBinds: true,
    proxyIdHash: hash(proxy.id),
    proxyImageId: proxy.imageId,
    proxyStartedAt: proxy.startedAt,
    ingress: { ...topology, httpScope: 'Plain loopback18082 only;18446 binding checked without claiming HTTPS acceptance' },
  };
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

async function restoreText(page) {
  await page.evaluate(() => {
    const state = window.__orbisRecoveryTextScale;
    if (!state) return;
    state.observer.disconnect();
    for (const [element, value] of state.entries)
      for (const [name, original, priority] of value.original) {
        if (original) element.style.setProperty(name, original, priority);
        else element.style.removeProperty(name);
      }
    delete window.__orbisRecoveryTextScale;
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
    window.__orbisRecoveryTextScale = { factor, entries, observer };
  }, factor);
  await dom.settle(page);
}

const releasePath = '/tmp/orbis-beta47-release-check.json';
const goProofPath = '/tmp/orbis-beta47-recovery-go-proof.json';
const baselinePath = '/tmp/orbis-beta47-recovery-before-ui-records.json';
const reviewedCommit = '48ffa3454aff42028c1a7cc80fb1d4ce9901e320';
const groups = [
  { width: 1440, height: 1120, textScale: 1 },
  { width: 390, height: 844, textScale: 1 },
  { width: 320, height: 800, textScale: 1 },
  { width: 320, height: 800, textScale: 2 },
];
const requiredGoChecks = [
  'canonicalAdoptionComplete',
  'originalStockCredentialsRetainedBeforeRecovery',
  'originalTotpVerifiedBeforeRecovery',
  'localCliResetComplete',
  'oldPasswordRejected',
  'newPasswordAuthenticatedWithoutTotp',
  'oldDashboardSessionsRevoked',
  'accountIdentitySaltAndUnrelatedDataPreserved',
  'originalOtherCoresUnchanged',
];
const publicPaths = new Set([
  '/',
  '/login',
  '/reset-password',
  '/dashboard',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/user-context',
  '/api/app-context',
  '/api/desktop-preferences',
  '/api/apps/installed',
  '/api/marketplace/all',
  '/api/links',
  '/api/system/build',
  '/api/sse/app',
]);
const safePath = (value) => (publicPaths.has(value) || value.startsWith('/assets/') ? value : `/[${hash(value).slice(0, 16)}]`);
function options(env, argv) {
  assert.deepEqual(argv, ['--allow-owned-published-account-recovery'], 'Explicit owned recovery UI audit argument is required');
  assert.equal(env.ORBIS_ALLOW_LIVE_ACCOUNT_RECOVERY_UI_AUDIT, '1', 'Explicit recovery UI opt-in is required');
  assert.equal(env.ORBIS_AUDIT_EXPECTED_TAG, 'v0.1.0-beta.47', 'Only reviewed beta47 is permitted');
  assert.equal(env.ORBIS_AUDIT_EXPECTED_COMMIT, reviewedCommit, 'Only the reviewed beta47 full commit is permitted');
  assert.match(env.ORBIS_AUDIT_EXPECTED_DIGEST || '', /^sha256:[a-f0-9]{64}$/, 'Exact published digest is required');
  assert.equal(env.ORBIS_AUDIT_RELEASE_FILE, releasePath, 'Only the reviewed release manifest is permitted');
  assert.equal(env.ORBIS_AUDIT_GO_PROOF_FILE, goProofPath, 'Only the reviewed post-reset GO proof is permitted');
  assert.equal(env.ORBIS_AUDIT_BASELINE_FILE, baselinePath, 'Only the reviewed pre-UI record baseline is permitted');
  assert.equal(env.ORBIS_AUDIT_CREDENTIAL_FILE, credentialFile, 'Only the owned synthetic recovery credentials are permitted');
  assert.equal(env.ORBIS_AUDIT_COOKIE_FILE, ownedCookieFile, 'Only the read-only post-reset observer cookie jar is permitted');
  const origin = new URL(env.ORBIS_AUDIT_URL || 'http://127.0.0.1:18082');
  assert.equal(origin.href, 'http://127.0.0.1:18082/', 'Only the separate owned loopback18082 is permitted');
  assert.ok(!origin.username && !origin.password, 'Origin must not carry credentials');
  const output = env.ORBIS_AUDIT_OUTPUT_DIR || '';
  assert.ok(
    output.startsWith('/tmp/') && path.isAbsolute(output) && path.resolve(output) === output,
    'Explicit normalized fresh /tmp output is required',
  );
  return { origin, output, expectedDigest: env.ORBIS_AUDIT_EXPECTED_DIGEST };
}
function proofInputs(release, proof, baselineText, digest) {
  assert.ok(
    release.tag === 'v0.1.0-beta.47' && release.commit === reviewedCommit && release.image === `ghcr.io/twentylines/orbis@${digest}`,
    'Exact release manifest differs from reviewed pins',
  );
  assert.equal(proof.schema, 'orbis.recovery-go.v1');
  assert.equal(proof.passed, true);
  assert.equal(proof.phase, 'post-local-cli-reset');
  samePrivate(
    proof.release,
    { tag: release.tag, commit: release.commit, image: release.image },
    'Post-reset proof differs from the exact published image',
  );
  assert.equal(proof.dockerContext, dockerContext);
  assert.equal(proof.root, installRoot);
  assert.equal(proof.baseUrl, 'http://127.0.0.1:18082');
  for (const key of requiredGoChecks) assert.equal(proof.checks?.[key], true, 'Independent post-reset proof is incomplete');
  assert.equal(proof.recordBaselineSha256, hash(baselineText), 'Prior full-record baseline bytes differ from the independent GO proof');
  const baseline = parsePrivate(baselineText, 'Recovery record baseline');
  for (const key of ['preferences', 'installed', 'apps', 'stores', 'links', 'userContext', 'appContext'])
    assert.ok(Object.hasOwn(baseline, key), 'Complete reviewed record snapshot required');
  return baseline;
}
function credentialsFrom(value) {
  const input = parsePrivate(value, 'Synthetic recovery credentials');
  for (const key of ['username', 'password', 'newPassword'])
    assert.ok(typeof input[key] === 'string' && input[key].length > 0, 'Required synthetic account fields are missing');
  assert.notEqual(input.password, input.newPassword, 'Old and replacement password must differ');
  // The TOTP secret is deliberately neither selected nor used by this post-reset audit.
  return { username: input.username, password: input.password, newPassword: input.newPassword };
}
function validateLoginAttempt(body, credentials, phase, result) {
  assert.ok(phase === 'old' || phase === 'new', 'An explicit expected login phase is required');
  assert.deepEqual(Object.keys(body).sort(), ['password', 'username']);
  assert.ok(
    body.username === credentials.username && body.password === (phase === 'old' ? credentials.password : credentials.newPassword),
    'Only the exact authorized synthetic account attempt is permitted',
  );
  assert.equal(result.newPasswordPosts, 0, 'Only one replacement-password login is permitted');
  assert.equal(result.oldPasswordPosts, phase === 'old' ? 0 : 1, 'Old and replacement attempts must occur exactly once in order');
}
function sanitized(value, key = '') {
  if (typeof value === 'string' && ['text', 'context', 'title'].includes(key)) return { sha256: hash(value), length: value.length };
  if (Array.isArray(value)) return value.map((item) => sanitized(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, sanitized(item, name)]));
  return value;
}
async function measureAuth(page) {
  await dom.settle(page);
  return page.locator('.desktop-auth').evaluate((root) => {
    const box = (element) => {
      const r = element.getBoundingClientRect();
      return {
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
        cx: (r.left + r.right) / 2,
        cy: (r.top + r.bottom) / 2,
      };
    };
    const ink = (element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return [...range.getClientRects()]
        .filter((r) => r.width && r.height)
        .map((r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom }));
    };
    const token = (name, property) => {
      const probe = document.createElement('span');
      probe.style[property] = `var(${name})`;
      root.append(probe);
      const result = getComputedStyle(probe)[property];
      probe.remove();
      return result;
    };
    const card = root.querySelector('.card');
    const body = card.querySelector('.card-body');
    const style = getComputedStyle(body);
    const boundary = { left: box(body).left + Number.parseFloat(style.paddingLeft), right: box(body).right - Number.parseFloat(style.paddingRight) };
    const words = [];
    const overflow = [];
    const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const parent = node.parentElement;
      if (!parent.getClientRects().length || parent.closest('svg,pre,[aria-hidden=true]')) continue;
      const owner = parent.closest('.desktop-auth-credit') || body;
      const os = getComputedStyle(owner);
      const bounds = { left: box(owner).left + Number.parseFloat(os.paddingLeft), right: box(owner).right - Number.parseFloat(os.paddingRight) };
      for (const match of node.textContent.matchAll(/[A-Za-z][A-Za-z'-]{2,}/g)) {
        const range = document.createRange();
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        const rects = [...range.getClientRects()].filter((r) => r.width && r.height);
        if (new Set(rects.map((r) => Math.round(r.top))).size > 1) words.push({ text: match[0], context: parent.textContent });
        for (const rect of rects)
          if (rect.left < bounds.left - 1 || rect.right > bounds.right + 1)
            overflow.push({ text: match[0], left: rect.left, right: rect.right, bounds });
      }
    }
    const credit = card.querySelector('.desktop-auth-credit');
    return {
      viewport: { width: innerWidth, height: innerHeight },
      documentWidth: document.documentElement.scrollWidth,
      scroll: { x: scrollX, y: scrollY },
      mode: root.dataset.desktopMode,
      preset: root.dataset.desktopPreset,
      card: box(card),
      body: box(body),
      boundary,
      padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft].map(Number.parseFloat),
      color: getComputedStyle(card).color,
      surface: getComputedStyle(card).backgroundColor,
      inkToken: token('--desktop-ink', 'color'),
      surfaceToken: token('--desktop-surface', 'backgroundColor'),
      mutedToken: token('--desktop-muted', 'color'),
      heading: box(body.querySelector('h2')),
      headingInk: ink(body.querySelector('h2')),
      words,
      overflow,
      credit: { box: box(credit), ink: ink(credit), color: getComputedStyle(credit).color, contained: card.contains(credit) },
      toolbar: [...root.querySelectorAll('.desktop-auth-toolbar button')].map((element) => ({
        box: box(element),
        glyph: element.querySelector('svg') ? box(element.querySelector('svg')) : null,
        padding: [getComputedStyle(element).paddingLeft, getComputedStyle(element).paddingRight].map(Number.parseFloat),
      })),
      inputs: [...body.querySelectorAll('input')].map((element) => {
        const label = document.querySelector(`label[for="${element.id}"]`);
        return {
          type: element.type,
          box: box(element),
          label: label ? box(label) : null,
          labelInk: label ? ink(label) : [],
          placeholder: getComputedStyle(element, '::placeholder').color,
        };
      }),
      actions: [...body.querySelectorAll('button[type=submit],a')].map((element) => ({
        box: box(element),
        ink: ink(element),
        type: element.tagName,
      })),
      code: [...body.querySelectorAll('pre')].map((element) => ({
        box: box(element),
        color: getComputedStyle(element.querySelector('code')).color,
        completeCommand: element.textContent === './runtipi-cli reset-password',
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        overflowX: getComputedStyle(element).overflowX,
      })),
    };
  });
}
function checkAuth(value, scale) {
  assert.ok(value.documentWidth <= value.viewport.width, 'Authentication page must not overflow horizontally');
  assert.ok(value.card.left >= 12 && value.card.right <= value.viewport.width - 12, 'Authentication card retains actual viewport gutters');
  assert.ok(
    value.padding.every((n) => n >= 16),
    'Authentication card body keeps at least16px padding',
  );
  assert.equal(value.color, value.inkToken, 'Authentication ink follows its actual default theme');
  assert.equal(value.surface, value.surfaceToken, 'Authentication surface follows its actual default theme');
  assert.deepEqual(value.words, [], 'Ordinary authentication words must wrap whole');
  assert.deepEqual(value.overflow, [], 'Actual authentication text must retain comfortable body/footer gutters');
  assert.ok(value.credit.contained && value.credit.box.bottom <= value.card.bottom + 1, 'Credit stays inside its themed card');
  assert.ok(
    Math.abs(value.heading.left - value.boundary.left) <= 1 && Math.abs(value.heading.right - value.boundary.right) <= 1,
    'Heading block and fields share the intended form gutter',
  );
  assert.equal(value.toolbar.length, 2, 'Authentication toolbar has the theme and language controls');
  assert.ok(Math.abs(value.toolbar[0].box.cy - value.toolbar[1].box.cy) <= 1, 'Toolbar control centre lines align');
  if (scale === 1) assert.ok(Math.abs(value.toolbar[0].box.height - value.toolbar[1].box.height) <= 1, 'Native toolbar controls share height');
  for (const control of value.toolbar) {
    assert.ok(control.box.width >= 40 && control.box.height >= 40, 'Authentication controls retain40px minimum target');
    assert.ok(control.box.left >= 8 && control.box.right <= value.viewport.width - 8, 'Toolbar controls have viewport breathing room');
    if (control.glyph) assert.ok(Math.abs(control.glyph.cy - control.box.cy) <= 1, 'Control glyph remains centred');
  }
  for (const input of value.inputs) {
    assert.ok(
      input.box.height >= 36 && Math.abs(input.box.left - value.boundary.left) <= 1 && Math.abs(input.box.right - value.boundary.right) <= 1,
      'Actual fields share the form gutter and keep a reachable height',
    );
    assert.ok(input.label && input.labelInk.length > 0, 'Every credential field has a visible associated label');
    for (const line of input.labelInk)
      assert.ok(
        line.left >= value.boundary.left - 1 && line.right <= value.boundary.right + 1 && line.bottom <= input.box.top - 3,
        'Whole label ink clears its field and form edges',
      );
    assert.equal(input.placeholder, value.mutedToken, 'Placeholders use the themed muted token');
  }
  for (const code of value.code)
    assert.ok(
      code.completeCommand && code.color === value.inkToken && code.box.left >= value.boundary.left - 1 && code.box.right <= value.boundary.right + 1,
      'Complete recovery command is themed and bounded to its form gutter',
    );
  for (const action of value.actions)
    for (const line of action.ink)
      assert.ok(
        line.left >= action.box.left &&
          line.right <= action.box.right &&
          line.left >= value.boundary.left - 1 &&
          line.right <= value.boundary.right + 1,
        'Action label remains complete and bounded',
      );
}
async function focusGeometry(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  let prior = '';
  let stable = 0;
  for (let attempt = 0; attempt < 30; attempt++) {
    const value = await page.evaluate(() => {
      const element = document.activeElement;
      const r = element.getBoundingClientRect();
      const s = getComputedStyle(element);
      const extent = s.outlineStyle === 'none' ? 0 : Number.parseFloat(s.outlineWidth) + Math.max(0, Number.parseFloat(s.outlineOffset));
      return {
        type: element.tagName,
        inputType: element.getAttribute('type'),
        href: element.getAttribute('href'),
        top: r.top,
        bottom: r.bottom,
        left: r.left,
        right: r.right,
        extent,
        focusTop: r.top - extent,
        focusBottom: r.bottom + extent,
        viewportHeight: innerHeight,
        viewportWidth: innerWidth,
        scrollY,
      };
    });
    const key = JSON.stringify(value);
    stable = key === prior ? stable + 1 : 0;
    prior = key;
    if (stable >= 3) return value;
    await page.waitForTimeout(80);
  }
  throw new Error('Native authentication focus did not settle');
}
function checkFocus(value) {
  assert.ok(value.extent > 0, 'Native authentication focus marker must be painted');
  assert.ok(
    value.focusTop >= 0 &&
      value.focusBottom <= value.viewportHeight &&
      value.left - value.extent >= 0 &&
      value.right + value.extent <= value.viewportWidth,
    'Complete native authentication focus marker must fit the viewport',
  );
}
async function inspectNotice(page) {
  const notice = page.locator('.orbis-notification[data-notification-type=error]');
  await notice.getByText('Incorrect email address or password.', { exact: true }).waitFor();
  await page.waitForFunction(() => {
    const element = document.querySelector('.orbis-notification[data-notification-type=error]');
    return (
      element &&
      getComputedStyle(element).opacity === '1' &&
      (getComputedStyle(element).transform === 'none' || new DOMMatrix(getComputedStyle(element).transform).isIdentity)
    );
  });
  return notice.evaluate((root) => {
    const r = root.getBoundingClientRect();
    const message = root.querySelector('.orbis-notification-message');
    const mr = message.getBoundingClientRect();
    const words = [];
    const range = document.createRange();
    const node = message.firstChild;
    for (const match of node.textContent.matchAll(/[A-Za-z]+/g)) {
      range.setStart(node, match.index);
      range.setEnd(node, match.index + match[0].length);
      const rects = [...range.getClientRects()].filter((r) => r.width && r.height);
      if (new Set(rects.map((r) => Math.round(r.top))).size > 1) words.push(match[0]);
      for (const rect of rects) if (rect.left < mr.left - 0.5 || rect.right > mr.right + 0.5) words.push(match[0]);
    }
    return {
      left: r.left,
      right: r.right,
      top: r.top,
      bottom: r.bottom,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      message: { left: mr.left, right: mr.right, top: mr.top, bottom: mr.bottom },
      words,
      translated: message.textContent === 'Incorrect email address or password.',
      mode: root.closest('[data-desktop-mode]')?.dataset.desktopMode,
      preset: root.closest('[data-desktop-preset]')?.dataset.desktopPreset,
    };
  });
}
async function main() {
  process.umask(0o077);
  const report = {
    passed: false,
    release: null,
    groups: [],
    assets: {},
    directReads: {},
    forwardedReads: {},
    coreChecks: [],
    blockedMutations: [],
    blockedRedirects: [],
    externalRequestsBlocked: 0,
    readFailures: [],
    assetFailures: [],
    pageErrors: [],
    priorRecordsMatched: false,
    recordsUnchanged: false,
    observerSessionRetained: false,
    cleanupFailures: [],
    cleanup: { groupContextsClosed: 0, readerClosed: false, browserClosed: false, createdSessionsClosed: 0 },
    scope: {
      actual: 'Published beta47 actual HTML/assets and unmodified responses; synthetic rehearsal account after root-owned local CLI recovery.',
      permittedMutations:
        'Exactly one old-password rejection and one new-password login in each of four fresh contexts; logout only a session created by that same audit context.',
      controlled:
        'Fresh browser default appearance and OS light preference; one320 doubled-computed-text group; document CSP connect-src header adjustment only.',
      responseSubstitutions: 0,
      preferenceWrites: 0,
      resetCalls: 0,
      totpCalls: 0,
      enrollmentCalls: 0,
      primarySessions:
        'No primary-runtime cookie, credentials, browser context or endpoint is accessed. Independent other-core proof is a prerequisite, not a new exhaustive data audit.',
      transport: 'Owned plain HTTP loopback18082 rehearsal only; no HTTPS/TLS acceptance claim.',
      screenshots: 'Empty or password-cleared fields, reset command page and successful dashboard only; natural native reading/focus positions.',
    },
  };
  const privateData = {};
  const errors = [];
  const redactions = [];
  let config;
  let release;
  let before;
  let credentials;
  let browser;
  let reader;
  let activeContext;
  let activePage;
  let outputReady = false;
  let stage = 'preflight';
  let observerSession;
  const fail = (error) => {
    let message = String(error.stack || error.message || error);
    for (const secret of redactions) if (secret) message = message.replaceAll(secret, '[private]');
    message = message
      .split('\n')
      .filter((line) => !/\b(?:cookie|authorization|headers)\b/i.test(line) && !/^\s*-?\s*[a-z][a-z0-9-]*:\s*/i.test(line))
      .join('\n');
    errors.push({ stage, type: error.name || 'Error', redactedTrace: message });
    report.failure = { stage, code: 'PUBLISHED_ACCOUNT_RECOVERY_UI_AUDIT_FAILED', messageHash: hash(message) };
  };
  const save = () => {
    if (!outputReady) return;
    privateWrite(path.join(config.output, 'private-baseline.json'), privateData);
    privateWrite(path.join(config.output, 'private-errors.json'), errors);
    privateWrite(path.join(config.output, 'report.json'), { ...report, stage });
  };
  const read = async (context, target) => {
    const address = new URL(target, config.origin);
    assert.ok(
      address.origin === config.origin.origin && !address.search && !address.hash && target.startsWith('/api/'),
      'Only fixed owned API reads are permitted',
    );
    assert.ok(
      [
        '/api/system/build',
        '/api/user-context',
        '/api/app-context',
        '/api/desktop-preferences',
        '/api/apps/installed',
        '/api/marketplace/all',
        '/api/links',
      ].includes(address.pathname) || /^\/api\/apps\/[^/]+$/.test(address.pathname),
      'Unreviewed direct API read',
    );
    const response = await context.request.get(address.href, { maxRedirects: 0, timeout: 15000 });
    report.directReads[safePath(address.pathname)] = (report.directReads[safePath(address.pathname)] || 0) + 1;
    assert.equal(response.status(), 200, 'Owned direct API GET must return200');
    return response.json();
  };
  const buildExact = async (context = reader) => {
    const build = await read(context, '/api/system/build');
    assert.ok(
      build.version === expectedTag && build.commit === reviewedCommit && build.imageDigest === config.expectedDigest,
      'Actual build differs from exact reviewed beta47 pins',
    );
  };
  const snapshot = async () => {
    const installed = await read(reader, '/api/apps/installed');
    assert.ok(Array.isArray(installed.installed), 'Full installed records must be available');
    const apps = {};
    for (const item of installed.installed) {
      const urn = item.info?.urn;
      assert.ok(typeof urn === 'string' && urn.includes(':') && !Object.hasOwn(apps, urn), 'Installed identity must be valid and unique');
      apps[urn] = await read(reader, `/api/apps/${encodeURIComponent(urn)}`);
      assert.equal(apps[urn].info?.urn, urn);
    }
    return {
      preferences: await read(reader, '/api/desktop-preferences'),
      installed,
      apps,
      stores: await read(reader, '/api/marketplace/all'),
      links: await read(reader, '/api/links'),
      userContext: await read(reader, '/api/user-context'),
      appContext: await read(reader, '/api/app-context'),
    };
  };
  const closeOwnSession = async (context, result) => {
    const session = (await context.cookies(config.origin.origin)).find((cookie) => cookie.name === 'runtipi-sid');
    if (session) {
      assert.notEqual(session.value, observerSession, 'Observer session must never enter an audit UI context');
      assert.ok(result.oldPasswordPosts + result.newPasswordPosts > 0, 'Only a session created by an authorized audit login may be closed');
      redactions.push(session.value);
      const response = await context.request.post(`${config.origin.origin}/api/auth/logout`, {
        headers: { Origin: config.origin.origin },
        maxRedirects: 0,
        timeout: 15000,
      });
      assert.equal(response.status(), 204, 'Own audit session logout must succeed');
      result.ownSessionLogoutPosts++;
      report.cleanup.createdSessionsClosed++;
    }
    assert.equal((await read(context, '/api/user-context')).isLoggedIn, false, 'Own audit session must be signed out after cleanup');
    assert.equal(
      (await context.cookies(config.origin.origin)).some((cookie) => cookie.name === 'runtipi-sid'),
      false,
      'Own session cookie must be removed',
    );
  };
  try {
    config = options(process.env, process.argv.slice(2));
    const rootStat = fs.lstatSync(installRoot);
    assert.ok(
      rootStat.isDirectory() && !rootStat.isSymbolicLink() && rootStat.uid === process.getuid() && fs.realpathSync(installRoot) === installRoot,
      'Separate owned recovery root differs',
    );
    const releaseText = readOwnedInput(releasePath);
    const proofText = readOwnedInput(goProofPath);
    const baselineText = readOwnedInput(baselinePath);
    release = parsePrivate(releaseText, 'Release manifest');
    const proof = parsePrivate(proofText, 'Post-reset GO proof');
    const reviewedRecords = proofInputs(release, proof, baselineText, config.expectedDigest);
    credentials = credentialsFrom(readOwnedInput(credentialFile));
    redactions.push(credentials.username, credentials.password, credentials.newPassword);
    const cookies = parseCookies(readOwnedInput(ownedCookieFile), config.origin.hostname);
    observerSession = cookies.find((cookie) => cookie.name === 'runtipi-sid').value;
    redactions.push(...cookies.map((cookie) => cookie.value));
    temporaryOutput(config.output);
    assert.equal(fs.existsSync(config.output), false, 'Use a fresh private audit output');
    privateDirectory(config.output);
    privateDirectory(path.join(config.output, 'screenshots'));
    outputReady = true;
    report.release = { tag: expectedTag, commit: reviewedCommit, digest: config.expectedDigest };
    report.inputProofs = {
      releaseSha256: hash(releaseText),
      postResetGoProofSha256: hash(proofText),
      priorRecordsSha256: hash(baselineText),
      postResetProofChecks: { ...proof.checks },
    };
    report.execution = {
      runnerSha256: hash(fs.readFileSync(__filename)),
      browserUtilitiesSha256: hash(fs.readFileSync(require.resolve('./host-devices-checks.cjs'))),
    };
    const core = verifyCore(release.image);
    const architecture = parsePrivate(
      readDocker(['inspect', '--type', 'image', '--format', '{{json .Architecture}}', core.imageId]),
      'Owned recovery image architecture',
    );
    assert.equal(architecture, 'arm64', 'Separate recovery VM must use the reviewed arm64 image');
    report.coreChecks.push({ ...core, architecture });
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.ORBIS_BROWSER_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    });
    reader = await browser.newContext({ serviceWorkers: 'block' });
    await reader.addCookies(cookies);
    await buildExact();
    before = await snapshot();
    privateData.before = before;
    samePrivate(before, reviewedRecords, 'Actual full records differ from the reviewed post-reset baseline');
    assert.equal(before.userContext.isLoggedIn, true, 'Read-only observer must remain authenticated');
    assert.equal(before.installed.installed.length, 0, 'The reviewed recovery rehearsal has no installed apps');
    assert.equal(before.links.links.length, 1, 'The reviewed recovery rehearsal retains its one stock link');
    assert.equal(before.appContext.user?.hasSeenWelcome, true, 'Welcome must be completed before the UI baseline');
    assert.equal(before.appContext.user?.locale, 'en', 'This bounded recovery UI audit requires actual English labels');
    report.priorRecordsMatched = true;
    save();
    for (const group of groups) {
      stage = `${group.width}x${group.height}-text${group.textScale}`;
      const result = {
        ...group,
        passed: false,
        oldPasswordPosts: 0,
        newPasswordPosts: 0,
        ownSessionLogoutPosts: 0,
        captures: [],
        cleanup: {
          ownSessionClosed: false,
          textRestored: false,
          viewportRestored: false,
          listenersRestored: false,
          routesRestored: false,
          pageClosed: false,
          contextClosed: false,
        },
      };
      report.groups.push(result);
      await buildExact();
      activeContext = await browser.newContext({
        viewport: { width: group.width, height: group.height },
        colorScheme: 'light',
        serviceWorkers: 'block',
      });
      assert.equal((await activeContext.cookies()).length, 0, 'Every UI context starts without observer or primary cookies');
      const jobs = [];
      let closing = false;
      let expectedLogin = null;
      const failed = (request) => {
        const target = new URL(request.url());
        if (
          !closing &&
          target.origin === config.origin.origin &&
          ['document', 'script', 'stylesheet', 'image', 'font'].includes(request.resourceType())
        )
          report.assetFailures.push({
            group: stage,
            path: safePath(target.pathname),
            kind: request.resourceType(),
            messageHash: hash(request.failure()?.errorText || 'Asset failed'),
          });
      };
      const responded = (response) => {
        const request = response.request();
        const target = new URL(response.url());
        if (closing || target.origin !== config.origin.origin) return;
        if (!response.ok() && response.status() !== 304 && !(target.pathname === '/api/auth/login' && response.status() === 400))
          report.readFailures.push({ group: stage, path: safePath(target.pathname), status: response.status() });
        if (response.ok() && ['document', 'script', 'stylesheet', 'image', 'font'].includes(request.resourceType()))
          jobs.push(
            response
              .body()
              .then((body) => {
                const sha256 = hash(body);
                report.assets[`${safePath(target.pathname)}:${sha256}`] = { sha256, bytes: body.length, kind: request.resourceType() };
              })
              .catch((error) => {
                if (!closing) report.assetFailures.push({ group: stage, path: safePath(target.pathname), messageHash: hash(error.message) });
              }),
          );
      };
      const handler = async (route) => {
        const request = route.request();
        const target = new URL(request.url());
        if (target.origin !== config.origin.origin) {
          report.externalRequestsBlocked++;
          return route.abort('blockedbyclient');
        }
        if (!readMethods.has(request.method())) {
          let allowed = false;
          if (request.method() === 'POST' && target.pathname === '/api/auth/login' && !target.search && !target.hash && expectedLogin) {
            try {
              const body = JSON.parse(request.postData() || '{}');
              validateLoginAttempt(body, credentials, expectedLogin, result);
              if (expectedLogin === 'old') result.oldPasswordPosts++;
              else result.newPasswordPosts++;
              expectedLogin = null;
              allowed = true;
            } catch {
              /* Credentials and request bodies are never included in public failures. */
            }
          }
          if (!allowed) {
            report.blockedMutations.push({ group: stage, method: request.method(), path: safePath(target.pathname) });
            return route.abort('blockedbyclient');
          }
        } else if (
          /^\/api\/auth\//.test(target.pathname) ||
          (/\/(?:reset-password|refresh|restart|reboot|shutdown|install|uninstall|logout)(?:\/|$)/.test(target.pathname) &&
            target.pathname.startsWith('/api/'))
        ) {
          report.blockedMutations.push({ group: stage, method: request.method(), path: safePath(target.pathname) });
          return route.abort('blockedbyclient');
        }
        if (readMethods.has(request.method()) && target.pathname.startsWith('/api/'))
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
      const pageError = (error) => report.pageErrors.push({ group: stage, type: error.name, messageHash: hash(error.message) });
      activePage.on('pageerror', pageError);
      const clearFields = async () => {
        for (const selector of ['input[name=password]', 'input[name=email]']) {
          const input = activePage.locator(selector);
          if (await input.count()) await input.fill('');
        }
      };
      const shot = async (name) => {
        assert.ok(
          await activePage.locator('input[type=password]').evaluateAll((inputs) => inputs.every((input) => input.value === '')),
          'Screenshots must not contain entered passwords',
        );
        const file = path.join(config.output, 'screenshots', `${stage}-${name}-actual-viewport.png`);
        temporaryOutput(file);
        await activePage.screenshot({ path: file, fullPage: false });
        fs.chmodSync(file, 0o600);
        result.captures.push(path.basename(file));
      };
      try {
        await activePage.goto(`${config.origin.origin}/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await activePage.locator('input[name=email]').waitFor();
        await dom.settle(activePage);
        await scaleText(activePage, group.textScale);
        assert.equal(await activePage.locator('input[name=email]').inputValue(), '');
        assert.equal(await activePage.locator('input[name=password]').inputValue(), '');
        const empty = await measureAuth(activePage);
        result.defaultAppearance = { mode: empty.mode, preset: empty.preset };
        result.emptyLogin = sanitized(empty);
        save();
        checkAuth(empty, group.textScale);
        await shot('empty-login');
        await activePage.locator('input[name=email]').focus();
        await activePage.keyboard.press('Tab');
        assert.equal(
          await activePage.evaluate(() => document.activeElement?.getAttribute('name')),
          'password',
          'Native keyboard order goes from email to password',
        );
        result.passwordFocus = await focusGeometry(activePage);
        checkFocus(result.passwordFocus);
        await activePage.keyboard.press('Tab');
        assert.equal(
          await activePage.evaluate(() => document.activeElement?.getAttribute('href')),
          '/reset-password',
          'Native Tab reaches Forgot password while empty submit is disabled',
        );
        result.forgotFocus = await focusGeometry(activePage);
        checkFocus(result.forgotFocus);
        await activePage.keyboard.press('Enter');
        await activePage.getByRole('heading', { name: 'Reset password', exact: true }).waitFor();
        const reset = await measureAuth(activePage);
        result.resetPage = sanitized(reset);
        save();
        checkAuth(reset, group.textScale);
        assert.equal(
          await activePage.locator('.desktop-auth pre code').textContent(),
          './runtipi-cli reset-password',
          'Forgot password only displays the real local CLI command',
        );
        const command = activePage.locator('.desktop-auth pre');
        const commandBox = await command.boundingBox();
        if (commandBox.y + commandBox.height > group.height - 16) {
          await activePage.mouse.move(group.width / 2, group.height - 60);
          await activePage.mouse.wheel(0, commandBox.y + commandBox.height - group.height + 24);
          await dom.settle(activePage);
        }
        await shot('forgot-password-command');
        await activePage.goBack();
        await activePage.locator('input[name=email]').waitFor();
        await dom.settle(activePage);
        await activePage.locator('input[name=email]').fill(credentials.username);
        await activePage.locator('input[name=password]').fill(credentials.password);
        expectedLogin = 'old';
        const oldResponse = activePage.waitForResponse(
          (response) => new URL(response.url()).pathname === '/api/auth/login' && response.request().method() === 'POST',
        );
        await activePage.getByRole('button', { name: 'Log in', exact: true }).click();
        const rejected = await oldResponse;
        assert.equal(rejected.status(), 400, 'Actual old password must be rejected after the local reset');
        assert.equal((await rejected.json()).message, 'AUTH_ERROR_INVALID_CREDENTIALS');
        assert.equal(new URL(activePage.url()).pathname, '/login', 'Rejected old password must stay on login');
        assert.equal((await read(activeContext, '/api/user-context')).isLoggedIn, false);
        assert.equal(
          (await activeContext.cookies(config.origin.origin)).some((cookie) => cookie.name === 'runtipi-sid'),
          false,
          'Rejected old password must not create a session',
        );
        assert.ok(
          (await activePage.locator('input[name=email]').isEnabled()) &&
            (await activePage.locator('input[name=password]').isEnabled()) &&
            (await activePage.getByRole('button', { name: 'Log in', exact: true }).isEnabled()),
          'Actual rejection must leave retry available',
        );
        assert.ok(
          (await activePage.locator('input[name=email]').inputValue()) === credentials.username &&
            (await activePage.locator('input[name=password]').inputValue()) === credentials.password,
          'Rejected input values remain in the local form draft',
        );
        const notice = await inspectNotice(activePage);
        result.rejection = { status: 400, translated: notice.translated, keptSignedOut: true, retryAvailable: true, notice };
        assert.ok(
          notice.translated && notice.left >= 8 && notice.right <= group.width - 8 && notice.top >= 0 && notice.bottom <= group.height,
          'Actual translated rejection remains visible within the viewport',
        );
        assert.deepEqual(notice.words, [], 'Error feedback wraps complete ordinary words');
        await activePage.locator('.orbis-notification[data-notification-type=error]').hover();
        await clearFields();
        await shot('old-password-rejected-cleared');
        await activePage.getByRole('button', { name: 'Dismiss notification', exact: true }).click();
        await activePage.locator('input[name=email]').fill(credentials.username);
        await activePage.locator('input[name=password]').fill(credentials.newPassword);
        expectedLogin = 'new';
        const newResponse = activePage.waitForResponse(
          (response) => new URL(response.url()).pathname === '/api/auth/login' && response.request().method() === 'POST',
        );
        await activePage.getByRole('button', { name: 'Log in', exact: true }).click();
        const accepted = await newResponse;
        assert.ok([200, 201].includes(accepted.status()), 'Actual replacement password must authenticate');
        const loginBody = await accepted.json();
        assert.ok(
          loginBody.success === true && !loginBody.totpSessionId,
          'Local recovery must authenticate without requesting the reset authenticator',
        );
        await activePage.waitForURL(`${config.origin.origin}/dashboard`);
        await activePage.locator('.workspace-grid').waitFor();
        await dom.settle(activePage);
        assert.equal(await activePage.locator('.otp-input').count(), 0, 'No TOTP form may appear after local recovery');
        assert.equal((await read(activeContext, '/api/user-context')).isLoggedIn, true);
        await buildExact(activeContext);
        const ownSession = (await activeContext.cookies(config.origin.origin)).find((cookie) => cookie.name === 'runtipi-sid');
        assert.ok(ownSession && ownSession.value !== observerSession, 'Authenticated UI context owns a distinct new session');
        redactions.push(ownSession.value);
        result.success = { status: accepted.status(), authenticated: true, noTotpChallenge: true, distinctNewSession: true };
        await shot('replacement-password-dashboard');
        result.images = await activePage.evaluate(() =>
          [...document.images].map((image) => ({
            visible: Boolean(image.getClientRects().length),
            complete: image.complete,
            loaded: image.naturalWidth > 0,
          })),
        );
        assert.ok(
          result.images.every((image) => !image.visible || (image.complete && image.loaded)),
          'Actual visible published images must load',
        );
        assert.equal(await activePage.locator('.orbis-error-panel').count(), 0);
        assert.equal(result.oldPasswordPosts, 1);
        assert.equal(result.newPasswordPosts, 1);
        result.passed = true;
      } catch (error) {
        if (await activePage.locator('.desktop-auth').count())
          result.failureGeometryBeforeClearing = sanitized(await measureAuth(activePage).catch(() => ({ unavailable: true })));
        save();
        await clearFields().catch(() => {
          result.fieldsCouldNotBeCleared = true;
        });
        await shot('failure-safe-cleared').catch(() => {
          result.failureCaptureUnavailable = true;
        });
        throw error;
      } finally {
        closing = true;
        const attempt = async (key, action) => {
          try {
            await action();
            result.cleanup[key] = true;
          } catch (error) {
            report.cleanupFailures.push(`${stage}:${key}`);
            fail(error);
          }
        };
        await attempt('ownSessionClosed', () => closeOwnSession(activeContext, result));
        await attempt('textRestored', () => restoreText(activePage));
        await attempt('viewportRestored', () => activePage.setViewportSize({ width: group.width, height: group.height }));
        closing = true;
        await Promise.all(jobs);
        await attempt('listenersRestored', async () => {
          activeContext.off('requestfailed', failed);
          activeContext.off('response', responded);
          activePage.off('pageerror', pageError);
          assert.equal(activeContext.listeners('response').includes(responded), false);
          assert.equal(activeContext.listeners('requestfailed').includes(failed), false);
          assert.equal(activePage.listeners('pageerror').includes(pageError), false);
        });
        await attempt('routesRestored', () => activeContext.unroute('**/*', handler));
        await attempt('pageClosed', () => activePage.close());
        activePage = undefined;
        await attempt('contextClosed', () => activeContext.close());
        activeContext = undefined;
        if (result.cleanup.contextClosed) report.cleanup.groupContextsClosed++;
        if (!Object.values(result.cleanup).every(Boolean)) result.passed = false;
        save();
      }
    }
    stage = 'final-records';
    privateData.after = await snapshot();
    samePrivate(privateData.after, before, 'Actual prior full records changed');
    report.recordsUnchanged = true;
    report.observerSessionRetained = privateData.after.userContext.isLoggedIn === true;
    await buildExact();
    const afterCore = verifyCore(release.image);
    report.coreChecks.push(afterCore);
    assert.equal(afterCore.idHash, report.coreChecks[0].idHash);
    assert.equal(afterCore.imageId, report.coreChecks[0].imageId);
    assert.equal(afterCore.startedAt, report.coreChecks[0].startedAt, 'Pinned backend restarted during the audit');
    assert.equal(afterCore.proxyIdHash, report.coreChecks[0].proxyIdHash, 'Recovery ingress identity changed during the audit');
    assert.equal(afterCore.proxyImageId, report.coreChecks[0].proxyImageId, 'Recovery ingress image changed during the audit');
    assert.equal(afterCore.proxyStartedAt, report.coreChecks[0].proxyStartedAt, 'Recovery ingress restarted during the audit');
    samePrivate(afterCore.ingress, report.coreChecks[0].ingress, 'Recovery ingress ports/network changed during the audit');
    assert.equal(report.groups.length, 4);
    assert.ok(report.groups.every((item) => item.passed && item.ownSessionLogoutPosts === 1));
    report.passed = true;
  } catch (error) {
    fail(error);
  } finally {
    if (reader && before)
      try {
        privateData.after = await snapshot();
        samePrivate(privateData.after, before, 'Final full records changed');
        report.recordsUnchanged = true;
        report.observerSessionRetained = privateData.after.userContext.isLoggedIn === true;
      } catch (error) {
        report.recordsUnchanged = false;
        report.cleanupFailures.push('final-record-comparison-failed');
        fail(error);
      }
    if (activeContext) {
      const result = report.groups.at(-1);
      if (result)
        try {
          await closeOwnSession(activeContext, result);
          result.cleanup.ownSessionClosed = true;
        } catch (error) {
          report.cleanupFailures.push('emergency-own-session-close-failed');
          fail(error);
        }
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
    for (const [resource, key] of [
      [reader, 'readerClosed'],
      [browser, 'browserClosed'],
    ])
      if (resource)
        await resource
          .close()
          .then(() => {
            report.cleanup[key] = true;
          })
          .catch((error) => {
            report.cleanupFailures.push(`${key}-failed`);
            fail(error);
          });
    if (
      !report.priorRecordsMatched ||
      !report.recordsUnchanged ||
      !report.observerSessionRetained ||
      !report.cleanup.readerClosed ||
      !report.cleanup.browserClosed ||
      report.cleanup.groupContextsClosed !== 4 ||
      report.cleanup.createdSessionsClosed !== 4 ||
      report.cleanupFailures.length ||
      report.blockedMutations.length ||
      report.blockedRedirects.length ||
      report.externalRequestsBlocked ||
      report.readFailures.length ||
      report.assetFailures.length ||
      report.pageErrors.length
    )
      report.passed = false;
    save();
  }
  process.stdout.write(
    `${JSON.stringify({ passed: report.passed, code: report.passed ? 'PUBLISHED_ACCOUNT_RECOVERY_UI_AUDIT_PASSED' : 'PUBLISHED_ACCOUNT_RECOVERY_UI_AUDIT_FAILED', groups: report.groups.length, ownSessionsClosed: report.cleanup.createdSessionsClosed, recordsUnchanged: report.recordsUnchanged, observerSessionRetained: report.observerSessionRetained, browserClosed: report.cleanup.browserClosed, reportFile: outputReady ? path.join(config.output, 'report.json') : null })}\n`,
  );
  if (!report.passed) process.exitCode = 1;
}
function selfCheck() {
  const env = {
    ORBIS_ALLOW_LIVE_ACCOUNT_RECOVERY_UI_AUDIT: '1',
    ORBIS_AUDIT_EXPECTED_TAG: 'v0.1.0-beta.47',
    ORBIS_AUDIT_EXPECTED_COMMIT: reviewedCommit,
    ORBIS_AUDIT_EXPECTED_DIGEST: `sha256:${'a'.repeat(64)}`,
    ORBIS_AUDIT_RELEASE_FILE: releasePath,
    ORBIS_AUDIT_GO_PROOF_FILE: goProofPath,
    ORBIS_AUDIT_BASELINE_FILE: baselinePath,
    ORBIS_AUDIT_CREDENTIAL_FILE: credentialFile,
    ORBIS_AUDIT_COOKIE_FILE: ownedCookieFile,
    ORBIS_AUDIT_OUTPUT_DIR: '/tmp/orbis-recovery-ui-guard-selfcheck',
  };
  const argv = ['--allow-owned-published-account-recovery'];
  assert.equal(options(env, argv).origin.origin, 'http://127.0.0.1:18082');
  const rejected = [
    ['ORBIS_ALLOW_LIVE_ACCOUNT_RECOVERY_UI_AUDIT', '0'],
    ['ORBIS_AUDIT_EXPECTED_TAG', 'v0.1.0-beta.46'],
    ['ORBIS_AUDIT_EXPECTED_COMMIT', 'b'.repeat(40)],
    ['ORBIS_AUDIT_EXPECTED_DIGEST', 'latest'],
    ['ORBIS_AUDIT_COOKIE_FILE', (process.env.ORBIS_QA_INSTALL_ROOT || '/opt/orbis-qa/install') + '/test-cookies.txt'],
    ['ORBIS_AUDIT_CREDENTIAL_FILE', '/tmp/unreviewed.json'],
    ['ORBIS_AUDIT_URL', 'http://127.0.0.1:18080'],
    ['ORBIS_AUDIT_URL', 'http://example.com:18082'],
    ['ORBIS_AUDIT_URL', 'http://127.0.0.1:18082/login'],
    ['ORBIS_AUDIT_OUTPUT_DIR', '/opt/orbis-qa/output'],
    ['ORBIS_AUDIT_GO_PROOF_FILE', '/tmp/unreviewed.json'],
  ];
  for (const [key, value] of rejected) assert.throws(() => options({ ...env, [key]: value }, argv));
  assert.throws(() => options(env, []));
  const release = { tag: 'v0.1.0-beta.47', commit: reviewedCommit, image: `ghcr.io/twentylines/orbis@${env.ORBIS_AUDIT_EXPECTED_DIGEST}` };
  const baseline = JSON.stringify({ preferences: {}, installed: {}, apps: {}, stores: {}, links: {}, userContext: {}, appContext: {} });
  const proof = {
    schema: 'orbis.recovery-go.v1',
    passed: true,
    phase: 'post-local-cli-reset',
    release,
    dockerContext,
    root: installRoot,
    baseUrl: 'http://127.0.0.1:18082',
    checks: Object.fromEntries(requiredGoChecks.map((key) => [key, true])),
    recordBaselineSha256: hash(baseline),
  };
  proofInputs(release, proof, baseline, env.ORBIS_AUDIT_EXPECTED_DIGEST);
  for (const change of [
    { passed: false },
    { schema: 'unreviewed' },
    { phase: 'pre-reset' },
    { dockerContext: 'default' },
    { root: (process.env.ORBIS_QA_INSTALL_ROOT || '/opt/orbis-qa/install') },
    { recordBaselineSha256: 'b'.repeat(64) },
    { checks: { ...proof.checks, localCliResetComplete: false } },
  ])
    assert.throws(() => proofInputs(release, { ...proof, ...change }, baseline, env.ORBIS_AUDIT_EXPECTED_DIGEST));
  const account = { username: 'fixture@example.invalid', password: 'old-fixture-password', newPassword: 'new-fixture-password' };
  validateLoginAttempt({ username: account.username, password: account.password }, account, 'old', { oldPasswordPosts: 0, newPasswordPosts: 0 });
  validateLoginAttempt({ username: account.username, password: account.newPassword }, account, 'new', { oldPasswordPosts: 1, newPasswordPosts: 0 });
  assert.throws(() =>
    validateLoginAttempt({ username: account.username, password: account.password }, account, 'new', { oldPasswordPosts: 1, newPasswordPosts: 0 }),
  );
  assert.throws(() =>
    validateLoginAttempt({ username: account.username, password: account.password, redirectUrl: 'https://example.com' }, account, 'old', {
      oldPasswordPosts: 0,
      newPasswordPosts: 0,
    }),
  );
  assert.throws(() =>
    validateLoginAttempt({ username: account.username, password: account.newPassword }, account, 'new', { oldPasswordPosts: 1, newPasswordPosts: 1 }),
  );
  assert.throws(() =>
    validateLoginAttempt({ username: account.username, password: account.newPassword }, account, null, { oldPasswordPosts: 1, newPasswordPosts: 0 }),
  );
  const common = {
    project: recoveryProject,
    workingDir: installRoot,
    configFiles: expectedComposeFiles.join(','),
    running: true,
    paused: false,
    networkMode: recoveryNetwork,
    networks: [{ name: recoveryNetwork, networkId: '1'.repeat(64) }],
  };
  const core = {
    ...structuredClone(common),
    service: 'runtipi',
    health: 'healthy',
    ports: { '3000/tcp': null },
    hostBindings: {},
    mounts: Object.entries(coreOwnedMounts).map(([Destination, relative]) => ({
      Destination,
      Source: path.join(installRoot, relative),
      Type: 'bind',
    })),
  };
  const proxyPorts = {
    '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '18082' }],
    '443/tcp': [{ HostIp: '127.0.0.1', HostPort: '18446' }],
  };
  const proxy = {
    ...structuredClone(common),
    service: 'runtipi-reverse-proxy',
    ports: structuredClone(proxyPorts),
    hostBindings: structuredClone(proxyPorts),
    mounts: [
      { Destination: '/etc/traefik', Source: `${installRoot}/traefik`, Type: 'bind' },
      { Destination: '/shared', Source: `${installRoot}/traefik/shared`, Type: 'bind' },
      { Destination: '/var/run/docker.sock', Source: '/var/run/docker.sock', Type: 'bind', RW: false },
    ],
  };
  assert.equal(validateRecoveryTopology(core, proxy).backendUnpublished, true);
  const dualStack = structuredClone(proxy);
  for (const map of [dualStack.ports, dualStack.hostBindings])
    for (const bindings of Object.values(map)) bindings.push({ HostIp: '::1', HostPort: bindings[0].HostPort });
  validateRecoveryTopology(core, dualStack);
  const rejectTopology = (mutate) => {
    const candidateCore = structuredClone(core);
    const candidateProxy = structuredClone(proxy);
    mutate(candidateCore, candidateProxy);
    assert.throws(() => validateRecoveryTopology(candidateCore, candidateProxy));
  };
  for (const mutate of [
    (core) => {
      core.ports['3000/tcp'] = [{ HostIp: '127.0.0.1', HostPort: '18082' }];
    },
    (core) => {
      core.hostBindings['3000/tcp'] = [{ HostIp: '127.0.0.1', HostPort: '18082' }];
    },
    (_, proxy) => {
      proxy.ports['80/tcp'][0].HostIp = '0.0.0.0';
    },
    (_, proxy) => {
      proxy.hostBindings['443/tcp'][0].HostIp = '::';
    },
    (_, proxy) => {
      proxy.ports['80/tcp'][0].HostPort = '18080';
    },
    (_, proxy) => {
      proxy.ports['443/tcp'][0].HostPort = '18445';
    },
    (_, proxy) => {
      proxy.ports['8080/tcp'] = [{ HostIp: '127.0.0.1', HostPort: '18083' }];
    },
    (_, proxy) => {
      proxy.ports['80/tcp'] = [];
    },
    (_, proxy) => {
      proxy.hostBindings['80/tcp'] = [{ HostIp: '::1', HostPort: '18082' }];
    },
    (_, proxy) => {
      proxy.ports['80/tcp'].push({ ...proxy.ports['80/tcp'][0] });
    },
    (core) => {
      core.project = 'unowned';
    },
    (_, proxy) => {
      proxy.project = 'unowned';
    },
    (_, proxy) => {
      proxy.service = 'another-service';
    },
    (core) => {
      core.workingDir = (process.env.ORBIS_QA_INSTALL_ROOT || '/opt/orbis-qa/install');
    },
    (_, proxy) => {
      proxy.configFiles = '/tmp/unreviewed-compose.yml';
    },
    (core) => {
      core.configFiles = expectedComposeFiles.slice(0, 2).join(',');
    },
    (_, proxy) => {
      proxy.configFiles = [...expectedComposeFiles, `${installRoot}/unreviewed-compose.yml`].join(',');
    },
    (_, proxy) => {
      proxy.configFiles = [...expectedComposeFiles].reverse().join(',');
    },
    (core) => {
      core.health = 'unhealthy';
    },
    (_, proxy) => {
      proxy.running = false;
    },
    (_, proxy) => {
      proxy.paused = true;
    },
    (_, proxy) => {
      proxy.networks[0].networkId = '2'.repeat(64);
    },
    (core) => {
      core.networkMode = 'host';
    },
    (_, proxy) => {
      proxy.networks.push({ name: 'other-network', networkId: '2'.repeat(64) });
    },
    (core) => {
      core.mounts[0].Source = '/tmp/unowned-env';
    },
    (core) => {
      core.mounts.push({ Destination: '/data/state/override', Source: '/tmp/unowned-state', Type: 'bind' });
    },
    (_, proxy) => {
      proxy.mounts[0].Source = '/tmp/unowned-traefik';
    },
    (_, proxy) => {
      proxy.mounts[2].RW = true;
    },
    (_, proxy) => {
      proxy.mounts.push({ Destination: '/etc/traefik/override', Source: '/tmp/unowned-config', Type: 'bind' });
    },
  ])
    rejectTopology(mutate);
  process.stdout.write('PUBLISHED_ACCOUNT_RECOVERY_UI_GUARDS_PASSED (no files, credentials, cookies, browser or runtime accessed)\n');
}
if (require.main === module) {
  if (process.argv.slice(2).length === 1 && process.argv[2] === '--self-check') selfCheck();
  else
    main().catch(() => {
      process.stderr.write('PUBLISHED_ACCOUNT_RECOVERY_UI_AUDIT_FAILED\n');
      process.exitCode = 1;
    });
}
module.exports = { main, selfCheck };
