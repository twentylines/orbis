const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const { chromium } = require('@playwright/test');

const installRoot = process.env.ORBIS_QA_INSTALL_ROOT || '/opt/orbis-qa/install';
const gitRoot = process.env.ORBIS_QA_STORE_ROOT || '/opt/orbis-qa/store';
const cookieFile = process.env.ORBIS_AUDIT_COOKIE_FILE;
const releaseFile = process.env.ORBIS_AUDIT_RELEASE_FILE;
const expectedTag = process.env.ORBIS_AUDIT_EXPECTED_TAG;
const expectedCommit = process.env.ORBIS_AUDIT_EXPECTED_COMMIT;
const snapshot = process.env.ORBIS_AUDIT_SNAPSHOT_DIR;
const snapshotContext = process.env.ORBIS_AUDIT_SNAPSHOT_CONTEXT;
const runId = process.env.ORBIS_AUDIT_RUN_ID;
const controlFile = process.env.ORBIS_AUDIT_CONTROL_FILE;
const deleteErrorKey = 'APP_STORE_DELETE_ERROR';
const base = new URL(process.env.ORBIS_AUDIT_URL || 'http://127.0.0.1:18080');
const dockerContext = 'colima-runtipi-test';
const vmProfile = 'runtipi-test';
const gitContainer = 'orbis-qa-git';
const fixtureSha = 'ce01d8a84ca291a35b3e236c4e8b6a75a0f51b5e';
const storeSlug = 'orbis-qa';
const storeUrl = 'http://orbis-qa-git:9418/orbis-qa.git';
const tempName = 'Orbis UI Retry';
const tempSlug = 'orbis-ui-retry';
const tempUrl = `${storeUrl}/tree/main`;
const badUrl = 'http://orbis-qa-git:9418/not-a-repo.git';
const storePath = `/api/marketplace/${storeSlug}`;
const tempPath = `/api/marketplace/${tempSlug}`;
const reportFile = process.env.ORBIS_AUDIT_REPORT_FILE || `/tmp/orbis-store-recovery-${runId}.json`;
const baselineFile = process.env.ORBIS_AUDIT_BASELINE_FILE || `/tmp/orbis-store-recovery-private-baseline-${runId}.json`;
const screenshotDir = process.env.ORBIS_AUDIT_SCREENSHOT_DIR || `/tmp/orbis-store-recovery-${runId}`;
const canonical = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item,
  );
const hash = (value) =>
  crypto
    .createHash('sha256')
    .update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonical(value))
    .digest('hex');
const clone = (value) => JSON.parse(JSON.stringify(value));
const same = (actual, expected, message) => assert.ok(isDeepStrictEqual(actual, expected), message);
const parse = (value, label) => {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
};
const privateInput = (file, cookie = false) => {
  assert.ok(path.isAbsolute(file) && path.resolve(file) === file, 'Inputs must be canonical absolute paths');
  const stat = fs.lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid(), 'Input must be an owned regular file');
  if (cookie || file === controlFile) assert.equal(stat.mode & 0o077, 0, 'Session/control files must remain private');
  const real = fs.realpathSync(file);
  assert.ok(
    cookie ? real === `${installRoot}/test-cookies.txt` && file === real : file.startsWith('/tmp/') && real.startsWith(`${fs.realpathSync('/tmp')}/`),
    'Input is outside the authorized location',
  );
  return fs.readFileSync(file, 'utf8');
};
const outputGuard = (file) => {
  assert.ok(path.isAbsolute(file) && path.resolve(file) === file && file.startsWith('/tmp/'), 'Outputs must remain under /tmp');
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    assert.ok(!stat.isSymbolicLink() && stat.uid === process.getuid(), 'Output must be owned and not a symlink');
  }
  let parent = file;
  while (!fs.existsSync(parent)) parent = path.dirname(parent);
  assert.ok(
    fs.realpathSync(parent) === fs.realpathSync('/tmp') || fs.realpathSync(parent).startsWith(`${fs.realpathSync('/tmp')}/`),
    'Output must not redirect outside /tmp',
  );
};
const protectedTrees = (includeTemp = false) => {
  const result = {};
  for (const part of ['.env', 'apps', 'app-data', 'user-config', 'repos']) {
    const root = path.join(installRoot, part);
    const walk = (file, relative) => {
      if (!includeTemp && part === 'repos' && (relative === tempSlug || relative.startsWith(`${tempSlug}/`))) return;
      const stat = fs.lstatSync(file);
      const key = `${part}/${relative}`;
      const entry = { mode: stat.mode & 0o777, uid: stat.uid, gid: stat.gid };
      if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(file);
        assert.ok(!path.isAbsolute(target) && fs.realpathSync(file).startsWith(`${installRoot}/`), 'Protected symlink escapes the owned root');
        result[key] = { ...entry, type: 'link', hash: hash(target) };
      } else if (stat.isDirectory()) {
        result[key] = { ...entry, type: 'directory' };
        for (const name of fs.readdirSync(file).sort()) walk(path.join(file, name), relative ? `${relative}/${name}` : name);
      } else {
        assert.ok(stat.isFile(), 'Protected tree contains an unsupported entry');
        const digest = hash(fs.readFileSync(file));
        const after = fs.lstatSync(file);
        assert.ok(after.size === stat.size && after.mtimeMs === stat.mtimeMs, 'Protected file changed while hashing');
        result[key] = { ...entry, type: 'file', size: stat.size, hash: digest };
      }
    };
    walk(root, '');
  }
  return result;
};
const tempFiles = () =>
  Object.fromEntries(Object.entries(protectedTrees(true)).filter(([key]) => key === `repos/${tempSlug}` || key.startsWith(`repos/${tempSlug}/`)));

async function main() {
  let browser;
  let reader;
  let context;
  let page;
  let coreId;
  let gitId;
  let release;
  let baseline;
  let extraStore;
  let extraFiles;
  let original;
  let preferences;
  let ticket;
  let cleanupArmed = false;
  let faultRequested = false;
  let faultCleared = false;
  let preserveFailure = false;
  let stage = 'preflight';
  let noticeObserver = false;
  const report = {
    passed: false,
    runId,
    source:
      'Published beta31 real selective store API/UI recovery; actual root-prepared read-only repo bind fault. Appearance is fulfilled only inside the browser.',
    release: null,
    snapshot: null,
    cases: [],
    uiFailures: [],
    externalApiRequests: {},
    mockedPreferenceWrites: 0,
    blockedMutations: [],
    pageErrors: [],
    cleanupFailures: [],
    rollbackRequired: false,
    cleanupConfirmed: false,
    coreChecks: [],
    rootGitIsolationCleanupRequired: false,
    cleanupScope:
      'Store/app/protected-file state, app-free test removal, read-only repo bind removal, and owned Git server running. Root restores temporary Git isolation separately.',
    fileFingerprintFields: ['relativePath', 'mode', 'uid', 'gid', 'type', 'size', 'sha256'],
    volatileTaskFieldExcluded: 'sampledAt',
    stage,
  };
  const save = () => {
    outputGuard(reportFile);
    fs.writeFileSync(reportFile, `${JSON.stringify({ ...report, stage }, null, 2)}\n`, { mode: 0o600 });
  };
  const phase = (value) => {
    stage = value;
    save();
  };
  const count = (method, endpoint) => {
    const key = `${method} ${endpoint}`;
    report.externalApiRequests[key] = (report.externalApiRequests[key] || 0) + 1;
  };
  const docker = (args, label) => {
    const result = spawnSync('docker', ['--context', dockerContext, ...args], { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    assert.ok(!result.error && result.status === 0, `Owned Docker operation failed: ${label}`);
    return result.stdout.trim();
  };
  const inspect = (id, field) => parse(docker(['inspect', '--format', `{{json .${field}}}`, id], 'selected inspection'), 'Docker inspection');
  const verifySnapshot = (compareSource = false) => {
    const code =
      "import importlib.util,json,stat,sys,hashlib\nfrom pathlib import Path\nfrom datetime import datetime,timezone\np=Path(sys.argv[1]); root=Path(sys.argv[2]); tag=sys.argv[3]; context=sys.argv[4]; compare=sys.argv[5]=='1'\nmodule=Path('/opt/orbis/host-service/orbis-snapshot.py')\nassert module.is_file() and not module.is_symlink() and module.stat().st_uid==0 and stat.S_IMODE(module.stat().st_mode)&0o022==0\nassert p.parent==Path('/var/lib/orbis/snapshots') and p.name.startswith('orbis-store-recovery-beta31-') and p.resolve()==p\nassert not p.is_symlink() and p.is_dir() and p.stat().st_uid==0 and stat.S_IMODE(p.stat().st_mode)==0o700\ns=p.with_name(p.name+'.orbis.json')\nassert s.is_file() and not s.is_symlink() and s.stat().st_uid==0 and stat.S_IMODE(s.stat().st_mode)==0o600\nspec=importlib.util.spec_from_file_location('audit_snapshot',module); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)\nr=m.verify(p,root)\nassert r['sourceRoot']==str(root) and r['release']==tag and r['dockerContext']==context\nassert r['sourceRootMode']==stat.S_IMODE(root.stat().st_mode)\nage=(datetime.now(timezone.utc)-datetime.fromisoformat(r['createdAt'])).total_seconds()\nassert -60<=age<=86400\nif compare:\n for part in ['apps','app-data','user-config','repos']:\n  assert m.fingerprint(p/part)==m.fingerprint(root/part)\n for item in [p/'.env',root/'.env']:\n  assert item.is_file() and not item.is_symlink()\n assert hashlib.sha256((p/'.env').read_bytes()).digest()==hashlib.sha256((root/'.env').read_bytes()).digest()\nprint(json.dumps({k:r[k] for k in ['schema','sourceRoot','release','dockerContext','createdAt','treeSha256','entries','files','bytes','sourceRootMode']}))";
    const result = spawnSync(
      'colima',
      [
        '--profile',
        vmProfile,
        'ssh',
        '--',
        'sudo',
        '-n',
        'python3',
        '-B',
        '-c',
        code,
        snapshot,
        installRoot,
        expectedTag,
        snapshotContext,
        compareSource ? '1' : '0',
      ],
      { encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024 },
    );
    assert.ok(!result.error && result.status === 0, 'Root-owned VM rollback snapshot verification failed');
    const record = parse(result.stdout, 'Snapshot metadata');
    assert.match(record.treeSha256, /^[a-f0-9]{64}$/);
    report.snapshot = record;
    if (compareSource) report.snapshotMatchedProtectedBaseline = true;
  };
  const verifyCore = (fault = false) => {
    const ids = docker(['ps', '-q', '--filter', 'label=com.docker.compose.service=runtipi'], 'core discovery').split('\n').filter(Boolean);
    assert.equal(ids.length, 1, 'Exactly one owned running core is required');
    coreId = ids[0];
    assert.ok(inspect(coreId, 'State.Running') && inspect(coreId, 'State.Health.Status') === 'healthy', 'Owned core must be healthy');
    assert.equal(inspect(coreId, 'Config.Image'), release.image, 'Core image differs from the release checker');
    const mounts = inspect(coreId, 'Mounts');
    for (const [destination, relative] of Object.entries({
      '/data/.env': '.env',
      '/data/apps': 'apps',
      '/data/repos': 'repos',
      '/data/user-config': 'user-config',
      '/data/state': 'state',
      '/app-data': 'app-data',
    })) {
      const match = mounts.filter((mount) => mount.Destination === destination);
      assert.ok(
        match.length === 1 && match[0].Type === 'bind' && match[0].Source === path.join(installRoot, relative),
        'Core bind ownership mismatch',
      );
    }
    const overrides = mounts.filter((mount) => mount.Destination.startsWith('/data/repos/'));
    if (fault)
      assert.ok(
        overrides.length === 1 &&
          overrides[0].Destination === `/data/repos/${tempSlug}` &&
          overrides[0].Type === 'bind' &&
          overrides[0].Source === path.join(installRoot, 'repos', tempSlug) &&
          overrides[0].RW === false,
        'Only the exact app-free repo may have a read-only fault bind',
      );
    else assert.equal(overrides.length, 0, 'Unexpected repository mount override remains');
    const extraHosts = inspect(coreId, 'HostConfig.ExtraHosts') || [];
    const githubIsolated = extraHosts.some((entry) => /^github\.com[:=]127\.0\.0\.1$/.test(entry));
    report.coreChecks.push({ stage, coreIdHash: hash(coreId), readOnlyRepoFault: fault, githubIsolated });
    report.rootGitIsolationCleanupRequired = githubIsolated;
  };
  const gitGuard = () => {
    assert.equal(docker(['inspect', '--format', '{{.Id}}', gitContainer], 'Git identity'), gitId, 'Git fixture identity changed');
    const mount = inspect(gitId, 'Mounts').filter((item) => item.Destination === '/fixtures');
    assert.ok(
      mount.length === 1 && mount[0].Type === 'bind' && mount[0].Source === gitRoot && mount[0].RW === false,
      'Git fixture must use its exact read-only owned mount',
    );
  };
  const coreExec = (args) => docker(['exec', coreId, ...args], 'read owned core repository');
  const repoHead = (slug) => {
    assert.match(slug, /^[a-z0-9_-]+$/);
    const directory = `/data/repos/${slug}`;
    return coreExec(['git', '-c', `safe.directory=${directory}`, '-C', directory, 'rev-parse', 'HEAD']);
  };
  const read = async (endpoint) => {
    assert.ok(endpoint.startsWith('/api/'));
    count('GET', endpoint);
    const response = await reader.request.get(`${base.origin}${endpoint}`, { maxRedirects: 0, timeout: 20000 });
    assert.ok(response.ok(), 'Authenticated audit GET failed');
    return response.json();
  };
  const verifyBuild = async () => {
    const build = await read('/api/system/build');
    assert.ok(
      build.version === release.tag && build.commit === release.commit && build.imageDigest === release.image.split('@')[1],
      'Published build metadata differs from the exact target',
    );
  };
  const stores = async () => (await read('/api/marketplace/all')).appStores.sort((a, b) => a.slug.localeCompare(b.slug));
  const catalogue = async (slug) => {
    const data = [];
    let cursor;
    let total;
    for (let pageIndex = 0; pageIndex < 30; pageIndex++) {
      const query = new URLSearchParams({ storeId: slug, pageSize: '100' });
      if (cursor) query.set('cursor', cursor);
      const value = await read(`/api/marketplace/apps/search?${query}`);
      total ??= value.total;
      assert.equal(value.total, total, 'Catalogue changed during pagination');
      data.push(...value.data);
      if (!value.nextCursor) {
        assert.equal(data.length, total, 'Complete bounded catalogue is required');
        return { total, data: data.sort((a, b) => a.urn.localeCompare(b.urn)) };
      }
      assert.notEqual(value.nextCursor, cursor, 'Catalogue cursor did not advance');
      cursor = value.nextCursor;
    }
    throw new Error('Catalogue exceeds the audit pagination bound');
  };
  const allState = async () => {
    const rows = await stores();
    const installed = await read('/api/apps/installed');
    installed.installed.sort((a, b) => a.info.urn.localeCompare(b.info.urn));
    const apps = {};
    for (const item of installed.installed) apps[item.info.urn] = await read(`/api/apps/${encodeURIComponent(item.info.urn)}`);
    const catalogues = {};
    const heads = {};
    for (const row of rows.filter((item) => item.slug !== tempSlug)) {
      catalogues[row.slug] = await catalogue(row.slug);
      heads[row.slug] = repoHead(row.slug);
    }
    return {
      stores: rows,
      installed,
      apps,
      catalogues,
      heads,
      files: protectedTrees(),
      preferences: await read('/api/desktop-preferences'),
      tasks: await read('/api/tasks').then(({ sampledAt: _sampledAt, ...stable }) => stable),
    };
  };
  const assertState = async (enabled = original.enabled, allowExtra = Boolean(extraStore)) => {
    try {
      const current = await allState();
      const expected = clone(baseline);
      const expectedRow = expected.stores.find((row) => row.slug === storeSlug);
      expectedRow.enabled = enabled;
      if (allowExtra) expected.stores.push(extraStore);
      expected.stores.sort((a, b) => a.slug.localeCompare(b.slug));
      if (!enabled) expected.catalogues[storeSlug] = { total: 0, data: [] };
      for (const item of expected.installed.installed) {
        if (item.app?.appStore) item.app.appStore.enabled = item.app.appStoreSlug === storeSlug ? enabled : item.app.appStore.enabled;
      }
      for (const [appUrn, app] of Object.entries(expected.apps)) {
        if (app.app?.appStore && appUrn.endsWith(`:${storeSlug}`)) app.app.appStore.enabled = enabled;
      }
      same(current, expected, 'A protected store, catalogue, app, preference, task, or file changed');
      if (allowExtra) {
        assert.equal(repoHead(tempSlug), fixtureSha, 'App-free retry store source changed');
        same(tempFiles(), extraFiles, 'App-free retry repository files changed');
        assert.ok(
          !(await read('/api/apps/installed')).installed.some((item) => item.info.urn.endsWith(`:${tempSlug}`)),
          'Retry store unexpectedly acquired an installed app',
        );
      } else assert.ok(!fs.existsSync(path.join(installRoot, 'repos', tempSlug)), 'Unexpected retry repository remains');
      return current;
    } catch (error) {
      preserveFailure = true;
      report.rollbackRequired = true;
      throw error;
    }
  };
  const arm = (method, endpoint, body) => {
    assert.equal(ticket, undefined, 'A mutation ticket is already active');
    const createBodies = [
      { name: 'Orbis QA Dupe', url: storeUrl },
      { name: original?.name, url: badUrl },
      { name: tempName, url: badUrl },
      { name: tempName, url: tempUrl },
    ];
    assert.ok(
      (method === 'POST' && endpoint === '/api/marketplace/create' && createBodies.some((allowed) => isDeepStrictEqual(body, allowed))) ||
        (method === 'PATCH' &&
          endpoint === storePath &&
          [true, false].some((enabled) => isDeepStrictEqual(body, { name: original?.name, enabled }))) ||
        (method === 'DELETE' &&
          endpoint === storePath &&
          body === undefined &&
          stage === 'installed-store-delete-rejection' &&
          report.snapshot &&
          report.snapshotMatchedProtectedBaseline) ||
        (method === 'DELETE' &&
          endpoint === tempPath &&
          body === undefined &&
          cleanupArmed &&
          report.snapshot &&
          report.snapshotMatchedProtectedBaseline),
      'Mutation is outside the fixed store recovery allowlist',
    );
    ticket = { method, endpoint, body, used: false };
  };
  const consume = (method, endpoint, body) => {
    assert.ok(ticket && !ticket.used && ticket.method === method && ticket.endpoint === endpoint, 'Mutation does not match the one-use phase ticket');
    same(body, ticket.body, 'Mutation body differs from the exact ticket');
    ticket.used = true;
    count(method, endpoint);
  };
  const finishTicket = () => {
    assert.ok(ticket?.used, 'Expected UI mutation was not observed');
    ticket = undefined;
  };
  const mutate = async (method, endpoint, body) => {
    consume(method, endpoint, body);
    const response = await reader.request.fetch(`${base.origin}${endpoint}`, {
      method,
      data: body,
      maxRedirects: 0,
      headers: { Origin: base.origin },
      timeout: 120000,
    });
    finishTicket();
    return response;
  };
  const errorResponse = async (response, status, key, label) => {
    assert.equal(response.status(), status, 'Unexpected rejection status');
    const body = await response.json();
    assert.equal(body.message, key, 'Unexpected rejection key');
    report.cases.push({ case: label, status, errorKey: key, source: 'real API' });
    return body;
  };
  const startGit = async () => {
    gitGuard();
    if (!inspect(gitId, 'State.Running')) docker(['start', gitId], 'start owned Git fixture');
    for (let attempt = 0; attempt < 40; attempt++) {
      const probe = spawnSync('docker', ['--context', dockerContext, 'exec', coreId, 'git', 'ls-remote', storeUrl, 'refs/heads/main'], {
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      });
      if (!probe.error && probe.status === 0 && probe.stdout.split(/\s+/)[0] === fixtureSha) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('Owned Git fixture did not recover to its fixed source revision');
  };
  const waitControl = async (expectedPhase) => {
    const deadline = Date.now() + 600000;
    while (Date.now() < deadline) {
      const value = parse(privateInput(controlFile), 'Private root control');
      assert.equal(value.runId, runId, 'Root control belongs to another run');
      if (value.phase === expectedPhase) return;
      assert.ok(['idle', 'fault-ready', 'fault-cleared'].includes(value.phase), 'Unknown root control phase');
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error('Root-prepared fault coordination timed out');
  };
  const row = (name) => page.getByRole('row').filter({ has: page.getByRole('cell', { name, exact: true }) });
  const capture = async (name) => {
    const file = path.join(screenshotDir, `${name}.png`);
    outputGuard(file);
    await page.screenshot({ path: file, animations: 'disabled' });
  };
  const observeNotices = async () => {
    await page.evaluate(() => {
      window.__storeAuditSuccess = false;
      window.__storeAuditObserver?.disconnect();
      window.__storeAuditObserver = new MutationObserver((records) => {
        for (const record of records)
          for (const node of record.addedNodes)
            if (
              node instanceof Element &&
              (node.matches('.orbis-notification[data-notification-type="success"]') ||
                node.querySelector('.orbis-notification[data-notification-type="success"]'))
            )
              window.__storeAuditSuccess = true;
      });
      window.__storeAuditObserver.observe(document.body, { childList: true, subtree: true });
    });
    noticeObserver = true;
  };
  const verifyUiFailure = async (dialog, submit, screenshot, contains) => {
    await dialog.waitFor();
    await page.waitForFunction(
      (label) => [...document.querySelectorAll('[role="dialog"] button')].some((button) => button.textContent.trim() === label && !button.disabled),
      submit,
    );
    const error = dialog.getByRole('alert');
    await error.waitFor();
    await error.scrollIntoViewIfNeeded();
    const text = await error.innerText();
    assert.ok(!text.includes('APP_STORE_') && !text.includes('SERVER_ERROR_'), 'Error must be translated');
    if (contains) assert.ok(text.includes(contains), 'Error must identify the failed store');
    const geometry = await error.evaluate((element) => {
      const r = element.getBoundingClientRect();
      const frame = element.closest('[role="dialog"]').getBoundingClientRect();
      const probe = document.createElement('span');
      probe.style.color = 'var(--desktop-negative)';
      element.append(probe);
      const expectedColor = getComputedStyle(probe).color;
      probe.remove();
      return {
        fits:
          r.left >= frame.left &&
          r.right <= frame.right &&
          r.top >= 0 &&
          r.bottom <= innerHeight &&
          document.documentElement.scrollWidth <= innerWidth,
        themed: getComputedStyle(element.querySelector('svg')).color === expectedColor,
        ordinaryLabelsWhole: [...element.querySelectorAll('.orbis-whole-word')].every((word) => word.scrollWidth <= word.clientWidth + 1),
      };
    });
    assert.ok(
      geometry.fits &&
        geometry.themed &&
        geometry.ordinaryLabelsWhole &&
        (await dialog.isVisible()) &&
        (await dialog.getByRole('button', { name: submit, exact: true }).isEnabled()),
      'Failure must remain themed, contained, and retryable',
    );
    assert.equal(await page.evaluate(() => window.__storeAuditSuccess), false, 'Failed mutation emitted success');
    assert.equal(
      await page.locator('.orbis-notification[data-notification-type="error"]').count(),
      0,
      'Store errors must remain inline in their dialog',
    );
    report.uiFailures.push({
      phase: stage,
      screenshot,
      inlineAlert: true,
      dialogRetained: true,
      retryEnabled: true,
      noSuccessNotice: true,
      ...geometry,
    });
    await capture(screenshot);
  };
  const uiMutation = async (dialog, submit, method, endpoint, body) => {
    arm(method, endpoint, body);
    const [response] = await Promise.all([
      page.waitForResponse((value) => new URL(value.url()).pathname === endpoint && value.request().method() === method, { timeout: 120000 }),
      dialog.getByRole('button', { name: submit, exact: true }).click(),
    ]);
    finishTicket();
    return response;
  };
  try {
    assert.equal(process.env.ORBIS_ALLOW_STORE_RECOVERY_AUDIT, '1', 'Explicit real store recovery opt-in required');
    assert.equal(expectedTag, 'v0.1.0-beta.31', 'This rehearsal targets beta31 only');
    assert.match(expectedCommit || '', /^[a-f0-9]{40}$/);
    assert.match(runId || '', /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    assert.ok(
      ['127.0.0.1', 'localhost'].includes(base.hostname) &&
        base.protocol === 'http:' &&
        base.port === '18080' &&
        base.pathname === '/' &&
        !base.username &&
        !base.password &&
        !base.search &&
        !base.hash,
      'Only the owned loopback origin is allowed',
    );
    assert.equal(cookieFile, `${installRoot}/test-cookies.txt`);
    assert.equal(controlFile, `/tmp/orbis-store-recovery-control-${runId}.json`);
    assert.match(snapshot || '', /^\/var\/lib\/orbis\/snapshots\/orbis-store-recovery-beta31-[A-Za-z0-9-]{1,100}$/);
    assert.equal(snapshotContext, 'default', 'The trusted VM seal must use the explicit default context');
    assert.equal(fs.realpathSync(installRoot), installRoot);
    assert.equal(fs.realpathSync(gitRoot), gitRoot);
    const initialControl = parse(privateInput(controlFile), 'Root control');
    same(initialControl, { runId, phase: 'idle' }, 'Root control must begin idle for this fresh run');
    release = parse(privateInput(releaseFile), 'Release checker JSON');
    assert.ok(release.tag === expectedTag && release.commit === expectedCommit, 'Release checker differs from explicit guards');
    assert.match(release.image || '', /^ghcr\.io\/twentylines\/orbis@sha256:[a-f0-9]{64}$/);
    report.release = { tag: release.tag, commit: release.commit, image: release.image };
    const cookies = privateInput(cookieFile, true)
      .split('\n')
      .filter((line) => line && (!line.startsWith('#') || line.startsWith('#HttpOnly_')))
      .map((line) => {
        const fields = line.split('\t');
        assert.equal(fields.length, 7);
        const [rawDomain, , cookiePath, secure, expires, name, value] = fields;
        const domain = rawDomain.replace(/^#HttpOnly_/, '');
        assert.ok(['127.0.0.1', 'localhost', '::1', '[::1]'].includes(domain));
        return {
          domain,
          path: cookiePath,
          secure: secure === 'TRUE',
          expires: Number(expires) || -1,
          name,
          value,
          httpOnly: rawDomain.startsWith('#HttpOnly_'),
        };
      });
    assert.ok(
      cookies.some((cookie) => cookie.name === 'runtipi-sid' && cookie.domain === base.hostname),
      'Matching private session is required',
    );
    for (const file of [reportFile, baselineFile, screenshotDir]) outputGuard(file);
    assert.ok(!fs.existsSync(baselineFile), 'Private baseline must be new');
    fs.mkdirSync(screenshotDir, { recursive: true, mode: 0o700 });
    verifySnapshot(true);
    verifyCore();
    gitId = docker(['inspect', '--format', '{{.Id}}', gitContainer], 'Git discovery');
    gitGuard();
    assert.ok(inspect(gitId, 'State.Running'), 'Git fixture must begin running');
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.ORBIS_BROWSER_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    });
    reader = await browser.newContext({ serviceWorkers: 'block' });
    await reader.addCookies(cookies);
    await verifyBuild();
    baseline = await allState();
    assert.ok(
      baseline.stores.every((store) => {
        const url = new URL(store.url);
        return !url.username && !url.password && !url.search && !url.hash;
      }),
      'Store URL credentials or tokens must not enter screenshots',
    );
    original = baseline.stores.find((store) => store.slug === storeSlug);
    assert.ok(original?.enabled && original.name === 'Orbis QA' && original.url === storeUrl, 'Enabled owned QA store required');
    assert.ok(!baseline.stores.some((store) => store.slug === tempSlug || store.slug === 'orbis-qa-dupe'), 'Temporary store slug already exists');
    assert.ok(!fs.existsSync(path.join(installRoot, 'repos', tempSlug)), 'Temporary repo path already exists');
    assert.ok(
      !fs
        .readdirSync(path.join(installRoot, 'repos'))
        .some((entry) => entry === 'orbis-qa-dupe' || entry.startsWith(`.${tempSlug}-clone-`) || entry.startsWith('.orbis-qa-dupe-clone-')),
      'Previous temporary clone artifacts exist',
    );
    same(Object.keys(baseline.apps).sort(), ['rehearsal-app:orbis-qa', 'whoami:migrated'], 'Only the two expected stopped fixture apps are allowed');
    assert.ok(
      Object.values(baseline.apps).every((app) => app.app.status === 'stopped'),
      'All installed fixtures must remain stopped',
    );
    assert.equal(baseline.heads[storeSlug], fixtureSha);
    assert.equal(baseline.apps['rehearsal-app:orbis-qa'].app.version, 3);
    assert.ok(
      (baseline.tasks.tasks || []).every((task) => ['succeeded', 'failed', 'interrupted', 'unconfirmed'].includes(task.status)),
      'Fixture tasks must be terminal',
    );
    fs.writeFileSync(baselineFile, `${JSON.stringify(baseline)}\n`, { mode: 0o600, flag: 'wx' });
    report.baselineHashes = {
      stores: hash(baseline.stores),
      apps: hash(baseline.apps),
      files: hash(baseline.files),
      catalogues: hash(baseline.catalogues),
      preferences: hash(baseline.preferences),
    };
    cleanupArmed = true;
    context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    await context.addCookies(cookies);
    preferences = { ...clone(baseline.preferences), mode: 'dark', windows: {} };
    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== base.origin) return route.abort('blockedbyclient');
      if (url.pathname === '/api/desktop-preferences') {
        if (request.method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(preferences) });
        if (request.method() === 'PUT') {
          preferences = parse(request.postData() || '', 'Browser appearance fixture');
          report.mockedPreferenceWrites++;
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(preferences) });
        }
      }
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
        try {
          consume(request.method(), url.pathname, request.postData() ? parse(request.postData(), 'UI request') : undefined);
        } catch {
          report.blockedMutations.push({ method: request.method(), path: url.pathname });
          return route.abort('blockedbyclient');
        }
      } else if (url.pathname.startsWith('/api/')) count(request.method(), `${url.pathname}${url.search}`);
      return route.continue();
    });
    page = await context.newPage();
    page.on('pageerror', (error) => report.pageErrors.push(hash(error.message)));
    await page.goto(`${base.origin}/settings?tab=appstores`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Add app store', exact: true }).waitFor();
    phase('add-store-rejection-and-retry');
    await page.getByRole('button', { name: 'Add app store', exact: true }).click();
    let dialog = page.getByRole('dialog');
    const name = dialog.getByRole('textbox', { name: 'App store name', exact: true });
    const url = dialog.getByRole('textbox', { name: 'App store URL', exact: true });
    for (const test of [
      { name: 'Orbis QA Dupe', url: storeUrl, status: 409, key: 'SERVER_ERROR_APP_STORE_ALREADY_EXISTS', label: 'duplicate URL' },
      { name: original.name, url: badUrl, status: 409, key: 'SERVER_ERROR_DUPLICATE_APP_STORE_NAME', label: 'duplicate slug' },
      { name: tempName, url: badUrl, status: 400, key: 'APP_STORE_CLONE_ERROR', label: 'invalid first clone' },
    ]) {
      await name.fill(test.name);
      await url.fill(test.url);
      await observeNotices();
      await errorResponse(
        await uiMutation(dialog, 'Create new app store', 'POST', '/api/marketplace/create', { name: test.name, url: test.url }),
        test.status,
        test.key,
        test.label,
      );
      assert.equal(await name.inputValue(), test.name);
      assert.equal(await url.inputValue(), test.url);
      await verifyUiFailure(dialog, 'Create new app store', test.label.replaceAll(' ', '-'));
      await assertState(original.enabled, false);
    }
    await url.fill(tempUrl);
    await observeNotices();
    const created = await uiMutation(dialog, 'Create new app store', 'POST', '/api/marketplace/create', { name: tempName, url: tempUrl });
    assert.equal(created.status(), 201);
    extraStore = await created.json();
    same(
      { slug: extraStore.slug, name: extraStore.name, url: extraStore.url, enabled: extraStore.enabled },
      { slug: tempSlug, name: tempName, url: tempUrl, enabled: true },
      'Unexpected app-free retry store',
    );
    same(
      (await stores()).find((store) => store.slug === tempSlug),
      extraStore,
      'Created store differs from the full store row',
    );
    extraFiles = tempFiles();
    await dialog.waitFor({ state: 'hidden' });
    await row(tempName).waitFor();
    await assertState();
    report.cases.push({ case: 'same-dialog create retry', status: 201, source: 'real UI/API' });
    phase('selective-disable-offline-enable');
    await row(original.name).getByRole('button', { name: 'Edit', exact: true }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByRole('switch', { name: 'Enabled', exact: true }).click();
    assert.equal((await uiMutation(dialog, 'Save', 'PATCH', storePath, { name: original.name, enabled: false })).status(), 200);
    await dialog.waitFor({ state: 'hidden' });
    await row(original.name).getByText('Disabled', { exact: true }).waitFor();
    await assertState(false);
    gitGuard();
    docker(['stop', '--time', '5', gitId], 'stop only owned Git fixture');
    assert.equal(inspect(gitId, 'State.Running'), false);
    await row(original.name).getByRole('button', { name: 'Edit', exact: true }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByRole('switch', { name: 'Enabled', exact: true }).click();
    await observeNotices();
    const offline = await errorResponse(
      await uiMutation(dialog, 'Save', 'PATCH', storePath, { name: original.name, enabled: true }),
      502,
      'APP_STORE_REFRESH_ERROR',
      'selective offline enable',
    );
    assert.equal(offline.intlParams?.stores, original.name);
    assert.equal(await dialog.getByRole('textbox', { name: 'Name', exact: true }).inputValue(), original.name);
    assert.equal(await dialog.getByRole('switch', { name: 'Enabled', exact: true }).getAttribute('aria-checked'), 'true');
    await verifyUiFailure(dialog, 'Save', 'selective-enable-offline-error', original.name);
    await assertState(false);
    await startGit();
    assert.equal((await uiMutation(dialog, 'Save', 'PATCH', storePath, { name: original.name, enabled: true })).status(), 200);
    await dialog.waitFor({ state: 'hidden' });
    await row(original.name).getByText('Enabled', { exact: true }).waitFor();
    await assertState();
    report.cases.push({ case: 'same-dialog selective enable retry', status: 200, source: 'real UI/API', internalPullCount: 'not measured' });
    phase('installed-store-delete-rejection');
    verifySnapshot();
    await row(original.name).getByRole('button', { name: 'Delete', exact: true }).click();
    dialog = page.getByRole('dialog');
    await observeNotices();
    const rejection = await uiMutation(dialog, 'Delete', 'DELETE', storePath, undefined);
    if (rejection.status() !== 400) {
      preserveFailure = true;
      report.rollbackRequired = true;
      throw new Error('Installed-store DELETE did not reject safely');
    }
    await errorResponse(rejection, 400, 'APP_STORE_DELETE_ERROR_APPS_EXIST', 'installed-store delete');
    await verifyUiFailure(dialog, 'Delete', 'installed-store-delete-rejected');
    await assertState();
    await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await row(tempName).getByRole('button', { name: 'Delete', exact: true }).click();
    dialog = page.getByRole('dialog');
    faultRequested = true;
    phase('awaiting-readonly-fault');
    await waitControl('fault-ready');
    verifyCore(true);
    await verifyBuild();
    await assertState();
    verifySnapshot();
    phase('real-filesystem-delete-failure');
    await observeNotices();
    await errorResponse(await uiMutation(dialog, 'Delete', 'DELETE', tempPath, undefined), 500, deleteErrorKey, 'read-only repo deletion');
    await verifyUiFailure(dialog, 'Delete', 'readonly-repo-delete-error');
    await assertState();
    phase('awaiting-fault-removal');
    await waitControl('fault-cleared');
    verifyCore(false);
    await verifyBuild();
    faultCleared = true;
    await assertState();
    phase('same-dialog-delete-retry');
    const removed = await uiMutation(dialog, 'Delete', 'DELETE', tempPath, undefined);
    assert.equal(removed.status(), 200);
    assert.equal((await removed.json()).success, true);
    await dialog.waitFor({ state: 'hidden' });
    extraStore = undefined;
    await assertState(original.enabled, false);
    assert.ok(!fs.existsSync(path.join(installRoot, 'repos', tempSlug)), 'Deleted store repository remains');
    report.cases.push({
      case: 'same-dialog removal retry after real filesystem failure',
      status: 200,
      source: 'real UI/API and root-prepared bind fault',
    });
    assert.ok(!report.blockedMutations.length && !report.pageErrors.length, 'Unexpected UI mutation or browser error');
    report.passed = true;
  } catch (error) {
    report.failure = { stage, type: /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name) ? error.name : 'Error', messageHash: hash(String(error.message)) };
  } finally {
    ticket = undefined;
    if (noticeObserver && page && !page.isClosed()) await page.evaluate(() => window.__storeAuditObserver?.disconnect()).catch(() => undefined);
    if (cleanupArmed) {
      if (faultRequested && !faultCleared)
        try {
          phase('cleanup-awaiting-fault-removal');
          await waitControl('fault-cleared');
          verifyCore(false);
          faultCleared = true;
        } catch {
          report.cleanupFailures.push('root-fault-removal-unconfirmed');
        }
      try {
        await startGit();
      } catch {
        report.cleanupFailures.push('git-running-unconfirmed');
      }
      if (!preserveFailure && (!faultRequested || faultCleared)) {
        try {
          const rows = await stores();
          const extra = rows.find((store) => store.slug === tempSlug);
          if (extra) {
            assert.ok(
              !baseline.stores.some((store) => store.slug === tempSlug) && extra.name === tempName && [badUrl, tempUrl].includes(extra.url),
              'Unknown store identity; refusing cleanup',
            );
            assert.ok(
              !(await read('/api/apps/installed')).installed.some((item) => item.info.urn.endsWith(`:${tempSlug}`)),
              'App-free cleanup precondition failed',
            );
            arm('DELETE', tempPath, undefined);
            assert.equal((await mutate('DELETE', tempPath, undefined)).status(), 200);
            extraStore = undefined;
          }
          const current = (await stores()).find((store) => store.slug === storeSlug);
          assert.ok(current && current.url === original.url, 'Original store identity changed');
          if (current.name !== original.name || current.enabled !== original.enabled) {
            arm('PATCH', storePath, { name: original.name, enabled: original.enabled });
            assert.equal((await mutate('PATCH', storePath, { name: original.name, enabled: original.enabled })).status(), 200);
          }
          verifyCore(false);
          await verifyBuild();
          await assertState(original.enabled, false);
          verifySnapshot();
          gitGuard();
          assert.equal(inspect(gitId, 'State.Running'), true);
          report.cleanupConfirmed = true;
        } catch {
          report.cleanupFailures.push('global-state-restoration-unconfirmed');
          report.rollbackRequired = true;
        }
      }
    }
    if (page && !page.isClosed()) await page.close().catch(() => report.cleanupFailures.push('page-close-failed'));
    await browser?.close().catch(() => report.cleanupFailures.push('browser-close-failed'));
    if (!report.cleanupConfirmed || report.cleanupFailures.length || report.rollbackRequired) report.passed = false;
    if (release) save();
  }
  process.stdout.write(`${JSON.stringify({ ...report, stage })}\n`);
  if (!report.passed) process.exitCode = 1;
}
main().catch(() => {
  process.stderr.write('Store recovery rehearsal could not complete; private credentials/configuration/response details were omitted.\n');
  process.exitCode = 1;
});
