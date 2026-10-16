const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const { chromium } = require('@playwright/test');

const installRoot = '/Users/sai/.codex/tmp/orbis-stock-20261015';
const gitRoot = '/Users/sai/.codex/tmp/orbis-store-qa-20261015';
const cookieFile = process.env.ORBIS_AUDIT_COOKIE_FILE;
const releaseFile = process.env.ORBIS_AUDIT_RELEASE_FILE;
const expectedTag = process.env.ORBIS_AUDIT_EXPECTED_TAG;
const expectedCommit = process.env.ORBIS_AUDIT_EXPECTED_COMMIT;
const snapshot = process.env.ORBIS_AUDIT_SNAPSHOT_DIR;
const snapshotContext = process.env.ORBIS_AUDIT_SNAPSHOT_CONTEXT;
const runId = process.env.ORBIS_AUDIT_RUN_ID;
const controlFile = process.env.ORBIS_AUDIT_CONTROL_FILE;
const base = new URL(process.env.ORBIS_AUDIT_URL || 'http://127.0.0.1:18080');
const dockerContext = 'colima-runtipi-test';
const vmProfile = 'runtipi-test';
const gitContainer = 'orbis-qa-git';
const fixtureSha = 'ce01d8a84ca291a35b3e236c4e8b6a75a0f51b5e';
const storeSlug = 'orbis-qa';
const storeUrl = 'http://orbis-qa-git:9418/orbis-qa.git';
const tempName = 'Orbis Net Retry';
const tempSlug = 'orbis-net-retry';
const tempUrl = `${storeUrl}/tree/main`;
const expectedGitId = 'f3ee4bc4bc21637193f1425c95dfc8e5c007b7c2e66020ecc88d137f3f42ceb2';
const expectedSourceCommit = '350e219d0c0b95786c7246342936f4bc0a07ed1f';
const storePath = `/api/marketplace/${storeSlug}`;
const tempPath = `/api/marketplace/${tempSlug}`;
const reportFile = process.env.ORBIS_AUDIT_REPORT_FILE || `/tmp/orbis-store-network-${runId}.json`;
const baselineFile = process.env.ORBIS_AUDIT_BASELINE_FILE || `/tmp/orbis-store-network-${runId}-private-baseline.json`;
const screenshotDir = process.env.ORBIS_AUDIT_SCREENSHOT_DIR || `/tmp/orbis-store-network-${runId}`;
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
        assert.ok(
          after.isFile() &&
            after.size === stat.size &&
            after.mtimeMs === stat.mtimeMs &&
            after.ino === stat.ino &&
            after.dev === stat.dev &&
            after.mode === stat.mode &&
            after.uid === stat.uid &&
            after.gid === stat.gid,
          'Protected file changed while hashing',
        );
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
  let extraCatalogue;
  let gitImage;
  let original;
  let preferences;
  let ticket;
  let cleanupArmed = false;
  let pauseRequested = false;
  let gitResumed = false;
  let cleanupMode = false;
  const inFlightMutations = new Set();
  let preserveFailure = false;
  let stage = 'preflight';
  let noticeObserver = false;
  const report = {
    passed: false,
    runId,
    source:
      'Published beta32 real complete clone and selective-enable network timeout/retry; root pauses/resumes only the owned Git fixture. Browser appearance writes are fulfilled locally.',
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
    rootControlRequired: false,
    mutationLedger: [],
    cleanupScope:
      'The helper may restore the original enabled flag and remove only its exact app-free test store after protected-state checks. Only root pauses/resumes Git, restores temporary Git isolation, or performs rollback.',
    fileFingerprintFields: ['relativePath', 'mode', 'uid', 'gid', 'type', 'size', 'sha256'],
    volatileTaskFieldExcluded: 'sampledAt',
    stage,
  };
  const save = () => {
    outputGuard(reportFile);
    fs.writeFileSync(reportFile, `${JSON.stringify({ ...report, stage }, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(reportFile, 0o600);
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
    assert.ok(['inspect', 'ps', 'exec'].includes(args[0]), 'The helper may only inspect Docker or run read-only Git checks');
    if (args[0] === 'exec') assert.ok(args[1] === coreId && args[2] === 'git', 'Only read-only Git checks in the owned core are permitted');
    const result = spawnSync('docker', ['--context', dockerContext, ...args], { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    assert.ok(!result.error && result.status === 0, `Owned Docker operation failed: ${label}`);
    return result.stdout.trim();
  };
  const inspect = (id, field) => parse(docker(['inspect', '--format', `{{json .${field}}}`, id], 'selected inspection'), 'Docker inspection');
  const verifySnapshot = (compareSource = false) => {
    const code =
      "import importlib.util,json,stat,sys,hashlib\nfrom pathlib import Path\nfrom datetime import datetime,timezone\np=Path(sys.argv[1]); root=Path(sys.argv[2]); tag=sys.argv[3]; context=sys.argv[4]; compare=sys.argv[5]=='1'\nmodule=Path('/opt/orbis/host-service/orbis-snapshot.py')\nassert module.is_file() and not module.is_symlink() and module.stat().st_uid==0 and stat.S_IMODE(module.stat().st_mode)&0o022==0\nassert p.parent==Path('/var/lib/orbis/snapshots') and p.name=='orbis-store-network-beta32-'+sys.argv[6] and p.resolve()==p\nassert not p.is_symlink() and p.is_dir() and p.stat().st_uid==0 and stat.S_IMODE(p.stat().st_mode)==0o700\ns=p.with_name(p.name+'.orbis.json')\nassert s.is_file() and not s.is_symlink() and s.stat().st_uid==0 and stat.S_IMODE(s.stat().st_mode)==0o600\nspec=importlib.util.spec_from_file_location('audit_snapshot',module); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)\nr=m.verify(p,root)\nassert r['schema']=='orbis.snapshot.v1' and r['sourceRoot']==str(root) and r['release']==tag and r['dockerContext']==context\nassert r['sourceRootMode']==stat.S_IMODE(root.stat().st_mode)\nage=(datetime.now(timezone.utc)-datetime.fromisoformat(r['createdAt'])).total_seconds()\nassert -60<=age<=21600\nif compare:\n for part in ['apps','app-data','user-config','repos']:\n  assert m.fingerprint(p/part)==m.fingerprint(root/part)\n for item in [p/'.env',root/'.env']:\n  assert item.is_file() and not item.is_symlink()\n assert hashlib.sha256((p/'.env').read_bytes()).digest()==hashlib.sha256((root/'.env').read_bytes()).digest()\nprint(json.dumps({k:r[k] for k in ['schema','sourceRoot','release','dockerContext','createdAt','treeSha256','entries','files','bytes','sourceRootMode']}))";
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
        runId,
      ],
      { encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024 },
    );
    assert.ok(!result.error && result.status === 0, 'Root-owned VM rollback snapshot verification failed');
    const record = parse(result.stdout, 'Snapshot metadata');
    assert.match(record.treeSha256, /^[a-f0-9]{64}$/);
    report.snapshot = record;
    if (compareSource) report.snapshotMatchedProtectedBaseline = true;
  };
  const verifyCore = () => {
    const ids = docker(['ps', '-q', '--filter', 'label=com.docker.compose.service=runtipi'], 'core discovery').split('\n').filter(Boolean);
    assert.equal(ids.length, 1, 'Exactly one owned running core is required');
    if (coreId) assert.equal(ids[0], coreId, 'Core identity changed during the network rehearsal');
    coreId = ids[0];
    assert.ok(
      inspect(coreId, 'State.Running') && !inspect(coreId, 'State.Paused') && inspect(coreId, 'State.Health.Status') === 'healthy',
      'Owned core must be healthy and unpaused',
    );
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
    assert.equal(mounts.filter((mount) => mount.Destination.startsWith('/data/repos/')).length, 0, 'Unexpected repository mount override');
    const extraHosts = inspect(coreId, 'HostConfig.ExtraHosts') || [];
    const githubIsolated = extraHosts.some((entry) => /^github\.com[:=]127\.0\.0\.1$/.test(entry));
    report.coreChecks.push({ stage, coreIdHash: hash(coreId), githubIsolated });
    report.rootGitIsolationCleanupRequired = githubIsolated;
  };
  const gitGuard = (paused) => {
    assert.equal(docker(['inspect', '--format', '{{.Id}}', gitContainer], 'Git identity'), expectedGitId, 'Git fixture identity changed');
    assert.equal(gitId, expectedGitId, 'Git fixture differs from the reviewed coordinator plan');
    const mount = inspect(gitId, 'Mounts').filter((item) => item.Destination === '/fixtures');
    assert.ok(
      mount.length === 1 && mount[0].Type === 'bind' && mount[0].Source === gitRoot && mount[0].RW === false,
      'Git fixture must use its exact read-only owned mount',
    );
    if (gitImage) assert.equal(inspect(gitId, 'Config.Image'), gitImage, 'Git fixture image changed');
    assert.equal(inspect(gitId, 'State.Running'), true, 'Git fixture must remain running');
    if (paused !== undefined) assert.equal(inspect(gitId, 'State.Paused'), paused, 'Git pause state differs from the root control phase');
  };
  const appContainers = () => {
    const result = {};
    for (const urn of ['rehearsal-app:orbis-qa', 'whoami:migrated']) {
      const ids = docker(['ps', '-aq', '--filter', `label=runtipi.appurn=${urn}`], 'fixture container discovery')
        .split('\n')
        .filter(Boolean)
        .sort();
      result[urn] = ids.map((id) => {
        const labels = inspect(id, 'Config.Labels');
        assert.equal(labels['runtipi.appurn'], urn, 'Application container ownership mismatch');
        assert.equal(inspect(id, 'State.Running'), false, 'Application fixture must remain stopped');
        assert.equal(inspect(id, 'State.Paused'), false, 'Application fixture must not be paused');
        return { idHash: hash(id), image: inspect(id, 'Config.Image'), labels, status: inspect(id, 'State.Status') };
      });
    }
    return result;
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
      containers: appContainers(),
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
        const directory = path.join(installRoot, 'repos', tempSlug);
        assert.ok(
          fs.lstatSync(directory).isDirectory() && !fs.lstatSync(directory).isSymbolicLink() && fs.realpathSync(directory) === directory,
          'App-free retry repository must be its exact canonical owned directory',
        );
        assert.equal(repoHead(tempSlug), fixtureSha, 'App-free retry store source changed');
        same(tempFiles(), extraFiles, 'App-free retry repository files changed');
        same(await catalogue(tempSlug), extraCatalogue, 'App-free retry catalogue changed');
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
    const createAllowed =
      method === 'POST' &&
      endpoint === '/api/marketplace/create' &&
      stage === 'healthy-clone' &&
      isDeepStrictEqual(body, { name: tempName, url: tempUrl });
    const patchAllowed =
      method === 'PATCH' &&
      endpoint === storePath &&
      ((stage === 'selective-disable' && isDeepStrictEqual(body, { name: original?.name, enabled: false })) ||
        (['selective-enable-timeout', 'same-dialog-enable-retry', 'cleanup-restore-enabled'].includes(stage) &&
          isDeepStrictEqual(body, { name: original?.name, enabled: original?.enabled })));
    const deleteAllowed =
      method === 'DELETE' &&
      endpoint === tempPath &&
      body === undefined &&
      cleanupArmed &&
      ['healthy-clone-removal', 'cleanup-remove-test-store'].includes(stage);
    assert.ok(createAllowed || patchAllowed || deleteAllowed, 'Mutation is outside the fixed network rehearsal allowlist');
    assert.ok(report.snapshot && report.snapshotMatchedProtectedBaseline, 'A verified rollback checkpoint is required before any mutation');
    ticket = { phase: stage, method, endpoint, body, used: false };
  };
  const consume = (method, endpoint, body) => {
    assert.ok(
      ticket && !ticket.used && ticket.phase === stage && ticket.method === method && ticket.endpoint === endpoint,
      'Mutation does not match the one-use phase ticket',
    );
    same(body, ticket.body, 'Mutation body differs from the exact ticket');
    ticket.used = true;
    ticket.startedAt = performance.now();
    count(method, endpoint);
  };
  const finishTicket = (status, receivedAt = performance.now()) => {
    assert.ok(ticket?.used, 'Expected mutation was not observed');
    const elapsedMs = receivedAt - ticket.startedAt;
    report.mutationLedger.push({
      phase: ticket.phase,
      method: ticket.method,
      endpoint: ticket.endpoint,
      bodyHash: hash(ticket.body ?? null),
      status,
      elapsedMs,
      source: cleanupMode ? 'cleanup API' : 'real UI/API',
    });
    ticket = undefined;
    return elapsedMs;
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
    finishTicket(response.status());
    return response;
  };
  const errorResponse = async (response, status, key, label) => {
    assert.equal(response.status(), status, 'Unexpected rejection status');
    const body = await response.json();
    assert.equal(body.message, key, 'Unexpected rejection key');
    report.cases.push({ case: label, status, errorKey: key, source: 'real API' });
    return body;
  };
  const verifyGitReachable = async () => {
    gitGuard(false);
    const probe = spawnSync('docker', ['--context', dockerContext, 'exec', coreId, 'git', 'ls-remote', storeUrl, 'refs/heads/main'], {
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    });
    assert.ok(
      !probe.error && probe.status === 0 && probe.stdout.trim().split(/\s+/)[0] === fixtureSha,
      'Owned Git fixture is not reachable at its exact source revision',
    );
  };
  const waitControl = async (expectedPhase) => {
    const deadline = Date.now() + 600000;
    while (Date.now() < deadline) {
      const value = parse(privateInput(controlFile), 'Private root control');
      assert.equal(value.runId, runId, 'Root control belongs to another run');
      assert.ok(['idle', 'git-paused', 'git-resumed'].includes(value.phase), 'Unknown root control phase');
      if (value.phase === expectedPhase) return;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error('Root Git pause/resume coordination timed out');
  };
  const resumeThroughRoot = async () => {
    report.rootControlRequired = true;
    phase('awaiting-git-resume');
    await waitControl('git-resumed');
    gitGuard(false);
    await verifyGitReachable();
    gitResumed = true;
    report.rootControlRequired = false;
  };
  const waitMutationsSettled = async () => {
    const deadline = Date.now() + 90000;
    while (inFlightMutations.size && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(inFlightMutations.size, 0, 'A browser mutation is still in flight; cleanup must not race it');
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
  const uiMutation = async (dialog, submit, method, endpoint, body, pendingCapture) => {
    arm(method, endpoint, body);
    const responsePromise = page
      .waitForResponse(
        (value) => new URL(value.url()).origin === base.origin && new URL(value.url()).pathname === endpoint && value.request().method() === method,
        { timeout: 120000 },
      )
      .then((response) => ({ response, receivedAt: performance.now() }));
    responsePromise.catch(() => undefined);
    await dialog.getByRole('button', { name: submit, exact: true }).click();
    if (pendingCapture) {
      await page.waitForFunction(
        (label) => [...document.querySelectorAll('[role="dialog"] button')].some((button) => button.textContent.trim() === label && button.disabled),
        submit,
      );
      assert.ok(ticket?.used, 'Pending UI request was not sent');
      assert.ok(await dialog.getByRole('textbox', { name: 'Name', exact: true }).isDisabled(), 'Pending name input must be disabled');
      assert.ok(await dialog.getByRole('switch', { name: 'Enabled', exact: true }).isDisabled(), 'Pending switch must be disabled');
      assert.equal(await dialog.getByRole('alert').count(), 0, 'Pending retry must not show a stale error');
      assert.equal(await page.evaluate(() => window.__storeAuditSuccess), false, 'Pending mutation emitted success');
      await capture(pendingCapture);
      report.cases.push({ case: 'pending selective enable', source: 'real UI/API', screenshot: pendingCapture, controlsDisabled: true });
    }
    const { response, receivedAt } = await responsePromise;
    const elapsedMs = finishTicket(response.status(), receivedAt);
    await response.finished();
    await waitMutationsSettled();
    return { response, elapsedMs };
  };
  try {
    assert.equal(process.env.ORBIS_ALLOW_STORE_NETWORK_AUDIT, '1', 'Explicit real store network opt-in required');
    assert.equal(expectedTag, 'v0.1.0-beta.32', 'This rehearsal targets beta32 only');
    assert.equal(expectedCommit, expectedSourceCommit, 'This rehearsal requires the exact tagged beta32 source commit');
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
    assert.equal(controlFile, `/tmp/orbis-store-network-control-${runId}.json`);
    assert.equal(snapshot, `/var/lib/orbis/snapshots/orbis-store-network-beta32-${runId}`);
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
    gitImage = inspect(gitId, 'Config.Image');
    gitGuard(false);
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
    assert.ok(
      !baseline.stores.some((store) => store.slug === tempSlug || store.name === tempName || store.url === tempUrl),
      'Temporary store identity already exists',
    );
    assert.ok(!fs.existsSync(path.join(installRoot, 'repos', tempSlug)), 'Temporary repo path already exists');
    assert.ok(
      !fs.readdirSync(path.join(installRoot, 'repos')).some((entry) => entry.startsWith(`.${tempSlug}-clone-`)),
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
      tasks: hash(baseline.tasks),
      heads: hash(baseline.heads),
      installed: hash(baseline.installed),
      containers: hash(baseline.containers),
    };
    await verifyGitReachable();
    assert.ok(baseline.catalogues[storeSlug].total > 0, 'Owned source catalogue must be nonempty');
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
          assert.ok(!url.search, 'Mutation query parameters are not allowed');
          consume(request.method(), url.pathname, request.postData() ? parse(request.postData(), 'UI request') : undefined);
          inFlightMutations.add(request);
        } catch {
          report.blockedMutations.push({ method: request.method(), path: url.pathname });
          return route.abort('blockedbyclient');
        }
      } else if (url.pathname.startsWith('/api/')) count(request.method(), `${url.pathname}${url.search}`);
      return route.continue();
    });
    page = await context.newPage();
    page.on('pageerror', (error) => report.pageErrors.push(hash(error.message)));
    page.on('requestfinished', (request) => inFlightMutations.delete(request));
    page.on('requestfailed', (request) => inFlightMutations.delete(request));
    await page.goto(`${base.origin}/settings?tab=appstores`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Add app store', exact: true }).waitFor();
    phase('healthy-clone');
    await page.getByRole('button', { name: 'Add app store', exact: true }).click();
    let dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox', { name: 'App store name', exact: true }).fill(tempName);
    await dialog.getByRole('textbox', { name: 'App store URL', exact: true }).fill(tempUrl);
    const created = (await uiMutation(dialog, 'Create new app store', 'POST', '/api/marketplace/create', { name: tempName, url: tempUrl })).response;
    assert.equal(created.status(), 201, 'Healthy complete clone must create the app-free store');
    extraStore = await created.json();
    same(
      { slug: extraStore.slug, name: extraStore.name, url: extraStore.url, enabled: extraStore.enabled },
      { slug: tempSlug, name: tempName, url: tempUrl, enabled: true },
      'Unexpected app-free network store',
    );
    same(
      (await stores()).find((store) => store.slug === tempSlug),
      extraStore,
      'Created store differs from the full API row',
    );
    extraFiles = tempFiles();
    extraCatalogue = await catalogue(tempSlug);
    const normalized = extraCatalogue.data.map((item) => {
      assert.ok(item.urn.endsWith(`:${tempSlug}`), 'Cloned catalogue identity is invalid');
      return { ...item, urn: `${item.urn.slice(0, -tempSlug.length)}${storeSlug}` };
    });
    same(
      { total: extraCatalogue.total, data: normalized },
      baseline.catalogues[storeSlug],
      'Healthy clone catalogue is incomplete or differs from the fixed fixture',
    );
    assert.equal(repoHead(tempSlug), fixtureSha, 'Healthy clone HEAD differs from the fixture');
    const directory = `/data/repos/${tempSlug}`;
    coreExec(['git', '-c', `safe.directory=${directory}`, '-C', directory, 'fsck', '--no-dangling']);
    await dialog.waitFor({ state: 'hidden' });
    await row(tempName).waitFor();
    await assertState();
    await capture('healthy-clone-complete');
    report.cases.push({
      case: 'healthy complete selective clone',
      status: 201,
      source: 'real UI/API and Git fsck',
      catalogueCount: extraCatalogue.total,
      head: fixtureSha,
    });
    phase('healthy-clone-removal');
    await row(tempName).getByRole('button', { name: 'Delete', exact: true }).click();
    dialog = page.getByRole('dialog');
    const removed = (await uiMutation(dialog, 'Delete', 'DELETE', tempPath, undefined)).response;
    assert.equal(removed.status(), 200);
    assert.equal((await removed.json()).success, true);
    await dialog.waitFor({ state: 'hidden' });
    extraStore = undefined;
    await assertState(original.enabled, false);
    report.cases.push({ case: 'healthy app-free clone removal', status: 200, source: 'real UI/API' });
    phase('selective-disable');
    await row(original.name).getByRole('button', { name: 'Edit', exact: true }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByRole('switch', { name: 'Enabled', exact: true }).click();
    const disabled = (await uiMutation(dialog, 'Save', 'PATCH', storePath, { name: original.name, enabled: false })).response;
    assert.equal(disabled.status(), 200);
    await dialog.waitFor({ state: 'hidden' });
    await row(original.name).getByText('Disabled', { exact: true }).waitFor();
    await assertState(false, false);
    await row(original.name).getByRole('button', { name: 'Edit', exact: true }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByRole('switch', { name: 'Enabled', exact: true }).click();
    await dialog.evaluate((element, id) => {
      element.dataset.networkAuditDialog = id;
    }, runId);
    pauseRequested = true;
    report.rootControlRequired = true;
    phase('awaiting-git-pause');
    await waitControl('git-paused');
    gitGuard(true);
    verifyCore();
    await verifyBuild();
    await assertState(false, false);
    phase('selective-enable-timeout');
    await observeNotices();
    const timedOut = await uiMutation(dialog, 'Save', 'PATCH', storePath, { name: original.name, enabled: true }, 'selective-enable-pending-390');
    assert.ok(timedOut.elapsedMs >= 25000 && timedOut.elapsedMs <= 60000, 'Real idle timeout must complete between 25 and 60 seconds');
    const failure = await errorResponse(timedOut.response, 502, 'APP_STORE_REFRESH_ERROR', 'real paused Git selective enable timeout');
    assert.equal(failure.intlParams?.stores, original.name, 'Timeout must identify the owned store');
    assert.equal(await dialog.getAttribute('data-network-audit-dialog'), runId, 'The original Edit dialog must remain mounted');
    assert.equal(await dialog.getByRole('textbox', { name: 'Name', exact: true }).inputValue(), original.name);
    assert.equal(await dialog.getByRole('switch', { name: 'Enabled', exact: true }).getAttribute('aria-checked'), 'true');
    await verifyUiFailure(dialog, 'Save', 'selective-enable-timeout-390', original.name);
    await assertState(false, false);
    gitGuard(true);
    report.cases.push({
      case: 'network idle bound',
      elapsedMs: timedOut.elapsedMs,
      acceptedRangeMs: [25000, 60000],
      source: 'real API with root-paused Git',
    });
    await resumeThroughRoot();
    await assertState(false, false);
    assert.equal(await dialog.getAttribute('data-network-audit-dialog'), runId, 'Retry must use the same open Edit dialog');
    phase('same-dialog-enable-retry');
    const retried = (await uiMutation(dialog, 'Save', 'PATCH', storePath, { name: original.name, enabled: true })).response;
    assert.equal(retried.status(), 200);
    assert.equal((await retried.json()).success, true);
    await dialog.waitFor({ state: 'hidden' });
    await row(original.name).getByText('Enabled', { exact: true }).waitFor();
    await assertState(original.enabled, false);
    await capture('selective-enable-retry-success-390');
    report.cases.push({
      case: 'same-dialog enable retry after real network timeout',
      status: 200,
      source: 'real UI/API',
      internalPullCount: 'not measured',
    });
    assert.ok(!report.blockedMutations.length && !report.pageErrors.length, 'Unexpected UI mutation or browser error');
    report.passed = true;
  } catch (error) {
    report.failure = { stage, type: /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name) ? error.name : 'Error', messageHash: hash(String(error.message)) };
  } finally {
    cleanupMode = true;
    ticket = undefined;
    if (noticeObserver && page && !page.isClosed()) await page.evaluate(() => window.__storeAuditObserver?.disconnect()).catch(() => undefined);
    if (cleanupArmed) {
      if (pauseRequested && !gitResumed) {
        try {
          await resumeThroughRoot();
        } catch {
          report.cleanupFailures.push('root-git-resume-unconfirmed');
          report.rootControlRequired = true;
        }
      }
      try {
        gitGuard(false);
        await verifyGitReachable();
        await waitMutationsSettled();
      } catch {
        report.cleanupFailures.push('git-running-or-inflight-settlement-unconfirmed');
      }
      if (!preserveFailure && !report.cleanupFailures.length) {
        try {
          const rows = await stores();
          const current = rows.find((store) => store.slug === storeSlug);
          assert.ok(
            current && current.url === original.url && current.name === original.name && typeof current.enabled === 'boolean',
            'Original store identity changed; refusing repair',
          );
          const extra = rows.find((store) => store.slug === tempSlug);
          if (extra) {
            assert.ok(
              !baseline.stores.some((store) => store.slug === tempSlug) && extra.name === tempName && extra.url === tempUrl && extra.enabled,
              'Unknown store identity; refusing cleanup',
            );
            assert.ok(
              !(await read('/api/apps/installed')).installed.some((item) => item.info.urn.endsWith(`:${tempSlug}`)),
              'App-free cleanup precondition failed',
            );
            extraStore ??= extra;
            extraFiles ??= tempFiles();
            extraCatalogue ??= await catalogue(tempSlug);
          } else extraStore = undefined;
          await assertState(current.enabled, Boolean(extra));
          if (extra) {
            phase('cleanup-remove-test-store');
            arm('DELETE', tempPath, undefined);
            const response = await mutate('DELETE', tempPath, undefined);
            assert.equal(response.status(), 200);
            assert.equal((await response.json()).success, true);
            extraStore = undefined;
            await assertState(current.enabled, false);
          }
          if (current.enabled !== original.enabled) {
            phase('cleanup-restore-enabled');
            arm('PATCH', storePath, { name: original.name, enabled: original.enabled });
            const response = await mutate('PATCH', storePath, { name: original.name, enabled: original.enabled });
            assert.equal(response.status(), 200);
            assert.equal((await response.json()).success, true);
          }
          verifyCore();
          await verifyBuild();
          await assertState(original.enabled, false);
          verifySnapshot();
          gitGuard(false);
          report.cleanupConfirmed = true;
        } catch {
          report.cleanupFailures.push('protected-state-restoration-unconfirmed');
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
  process.stderr.write('Store network rehearsal could not complete; private credentials/configuration/response details were omitted.\n');
  process.exitCode = 1;
});
