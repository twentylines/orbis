const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { isDeepStrictEqual } = require('node:util');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { chromium } = require('@playwright/test');
const backendRequire = createRequire(path.join(__dirname, '../packages/backend/package.json'));
const yaml = backendRequire('yaml');

const urn = 'rehearsal-app:orbis-qa';
const dockerContext = 'colima-runtipi-test';
const installRoot = process.env.ORBIS_QA_INSTALL_ROOT || '/opt/orbis-qa/install';
const sourceImage = 'nginx:1.28.0-alpine';
const targetImage = 'nginx:1.28.1-alpine';
const privateNetworkKey = 'rehearsal-app_orbis-qa_network';
const sharedNetworkName = 'runtipi_tipi_main_network';
const composeProject = 'rehearsal-app_orbis-qa';
const repoDirectory = '/data/repos/orbis-qa';
const fixtureRepo = 'http://orbis-qa-git:9418/orbis-qa.git';
const expectedSha = process.env.ORBIS_STORE_EXPECTED_SHA;
const releaseFile = process.env.ORBIS_AUDIT_RELEASE_FILE;
const cookieFile = process.env.ORBIS_AUDIT_COOKIE_FILE;
const baselineFile = '/tmp/orbis-store-v2-before.json';
const base = process.env.ORBIS_AUDIT_URL || 'http://127.0.0.1:18080';
const url = (() => {
  try {
    return new URL(base);
  } catch {
    throw new Error('Audit URL is invalid');
  }
})();
const refreshMethod = process.env.ORBIS_STORE_REFRESH_METHOD || 'ui';
const screenshotDir = process.env.ORBIS_AUDIT_SCREENSHOT_DIR || '/tmp/orbis-store-upgrade-v2-v3-live';
const fileNames = [
  'app-data/orbis-qa/rehearsal-app/data/marker.txt',
  'user-config/orbis-qa/rehearsal-app/app.env',
  'user-config/orbis-qa/rehearsal-app/docker-compose.yml',
];

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const parsePrivate = (value, label) => {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
};
const canonical = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item,
  );
const input = (file) => {
  assert.ok(path.isAbsolute(file), 'Audit input paths must be absolute');
  const stat = fs.lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid(), 'Audit input must be an owned regular file');
  const real = fs.realpathSync(file);
  assert.ok(
    file === cookieFile ? real === file : file.startsWith('/tmp/') && real.startsWith(`${fs.realpathSync('/tmp')}/`),
    'Audit input must remain in its authorized location',
  );
  return fs.readFileSync(file, 'utf8');
};
const validateScreenshotDirectory = () => {
  assert.ok(
    path.isAbsolute(screenshotDir) && path.resolve(screenshotDir) === screenshotDir && screenshotDir.startsWith('/tmp/'),
    'Screenshots must remain under /tmp',
  );
  let ancestor = screenshotDir;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const real = fs.realpathSync(ancestor);
  const temporaryRoot = fs.realpathSync('/tmp');
  assert.ok(real === temporaryRoot || real.startsWith(`${temporaryRoot}/`), 'Screenshot directory must not redirect outside /tmp');
  if (fs.existsSync(screenshotDir)) {
    const stat = fs.lstatSync(screenshotDir);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid(), 'Screenshot output must be an owned directory');
  }
};
const ownedFile = (relative) => {
  assert.ok(!path.isAbsolute(relative) && !relative.split('/').includes('..'), 'Unsafe fixture-relative path');
  const full = path.join(installRoot, relative);
  const real = fs.realpathSync(full);
  const stat = fs.lstatSync(full);
  assert.ok(real.startsWith(`${installRoot}/`) && stat.isFile() && !stat.isSymbolicLink(), 'Fixture file must remain inside the owned install root');
  return real;
};
let release;
let baseline;
let cookies;
const preflight = () => {
  assert.equal(process.env.ORBIS_ALLOW_LIFECYCLE_AUDIT, '1', 'Explicit disposable lifecycle opt-in required');
  assert.ok(releaseFile && cookieFile, 'Explicit release and cookie files required');
  assert.match(expectedSha || '', /^[a-f0-9]{40}$/, 'Exact fixture v3 Git SHA required');
  assert.equal(cookieFile, `${installRoot}/test-cookies.txt`, 'Only the owned fixture cookie file is allowed');
  assert.ok(
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.protocol === 'http:' && url.port === '18080',
    'Only loopback HTTP port 18080 is allowed',
  );
  assert.ok(!url.username && !url.password && url.pathname === '/' && !url.search && !url.hash, 'Audit URL must be an origin');
  assert.equal(process.env.ORBIS_AUDIT_APP_URN || urn, urn, 'The fixture URN cannot be changed');
  assert.equal(process.env.ORBIS_DOCKER_CONTEXT || dockerContext, dockerContext, 'The disposable Docker context cannot be changed');
  assert.equal(process.env.ORBIS_AUDIT_INSTALL_ROOT || installRoot, installRoot, 'The owned install root cannot be changed');
  assert.equal(refreshMethod, 'ui', 'This rehearsal requires the real Settings Actions refresh UI');
  validateScreenshotDirectory();

  assert.equal(fs.realpathSync(installRoot), installRoot, 'Owned install root must not be redirected by a symlink');
  release = parsePrivate(input(releaseFile), 'Release input');
  baseline = parsePrivate(input(baselineFile), 'Baseline input');
  assert.equal(release.tag, 'v0.1.0-beta.29', 'This rehearsal targets published beta29 only');
  assert.equal(release.commit, '1697920a0fe14ccea2cc791cc26b6d06244eee12', 'Unexpected beta29 release commit');
  assert.match(release.image || '', /^ghcr\.io\/twentylines\/orbis@sha256:[a-f0-9]{64}$/);
  assert.equal(baseline.urn, urn);
  assert.equal(baseline.app?.version, 2);
  assert.equal(baseline.app?.status, 'stopped');
  assert.equal(baseline.app?.maxBackups, null, 'Baseline retention must inherit the system default');
  assert.ok(baseline.app.config && !Object.hasOwn(baseline.app.config, 'maxBackups'), 'Raw baseline config must omit retention');
  assert.ok(!Object.hasOwn(baseline.app.config, 'NEW_V3_OPTION'), 'Raw baseline config must not contain the new v3 default');
  assert.equal(baseline.app?.pendingRestart, false, 'Root must clear the baseline pending restart before this rehearsal');
  assert.equal(baseline.infoVersion, '2.0.0');
  assert.equal(baseline.containerImage, sourceImage);
  assert.equal(baseline.app?.port, 18991);
  assert.equal(baseline.app?.appStore?.url, fixtureRepo);
  assert.deepEqual(Object.keys(baseline.fileHashes || {}).sort(), [...fileNames].sort());
  for (const hash of [...Object.values(baseline.fileHashes), baseline.generatedValueHash]) assert.match(hash, /^[a-f0-9]{64}$/);

  cookies = input(cookieFile)
    .split('\n')
    .filter((line) => line && (!line.startsWith('#') || line.startsWith('#HttpOnly_')))
    .map((line) => {
      const fields = line.split('\t');
      assert.equal(fields.length, 7, 'Cookie jar entry is malformed');
      const [rawDomain, , cookiePath, secure, expires, name, value] = fields;
      const domain = rawDomain.replace(/^#HttpOnly_/, '');
      assert.ok(['127.0.0.1', 'localhost', '::1', '[::1]'].includes(domain), 'Cookie jar must contain only loopback cookies');
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
    cookies.some((cookie) => cookie.name === 'runtipi-sid' && cookie.domain === url.hostname),
    'Matching fixture session cookie is required',
  );
};

// Docker output is captured in-process; never include stderr or full Config.Env in an error.
const docker = (args, label) => {
  const result = spawnSync('docker', ['--context', dockerContext, ...args], { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  assert.ok(!result.error && result.status === 0, `Owned Docker read failed: ${label}`);
  return result.stdout;
};
const inspect = (container, includeEnvironment = false) => {
  const format = `{"Id":{{json .Id}},"Name":{{json .Name}},"Config":{"Image":{{json .Config.Image}},"Labels":{{json .Config.Labels}}${includeEnvironment ? ',"Env":{{json .Config.Env}}' : ''}},"State":{"Running":{{json .State.Running}},"Health":{"Status":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}}}},"Mounts":{{json .Mounts}},"NetworkSettings":{"Networks":{{json .NetworkSettings.Networks}}}}`;
  return parsePrivate(docker(['inspect', '--format', format, container], 'container inspection'), 'Owned container inspection');
};
const fields = (record) => Object.fromEntries(Object.entries(record).filter(([key]) => !['status', 'updatedAt', 'version'].includes(key)));
const equalPrivate = (actual, expected, message) => assert.ok(isDeepStrictEqual(actual, expected), message);
const fileHashes = () => Object.fromEntries(fileNames.map((file) => [file, sha256(fs.readFileSync(ownedFile(file)))]));
const installedFiles = () =>
  Object.fromEntries(
    ['config.json', 'docker-compose.yml', 'docker-compose.generated.yml'].map((file) => {
      const relative = `apps/orbis-qa/rehearsal-app/${file}`;
      return [file, sha256(fs.readFileSync(ownedFile(relative)))];
    }),
  );
const environment = (lines, runtime = false) => {
  const values = new Map(
    lines
      .filter((line) => !line.startsWith('#') && line.indexOf('=') > 0)
      .map((line) => {
        const split = line.indexOf('=');
        return [line.slice(0, split), line.slice(split + 1)];
      }),
  );
  const random = values.get('STABLE_RANDOM');
  assert.ok(typeof random === 'string' && random.length > 0, 'Generated fixture value is absent');
  return {
    generatedValueHash: sha256(random),
    SERVICE_LABEL: values.get('SERVICE_LABEL'),
    NEW_OPTION: values.get('NEW_OPTION'),
    NEW_V3_OPTION: values.get('NEW_V3_OPTION'),
    APP_PORT: values.get('APP_PORT'),
    APP_IMAGE_TAG: values.get('APP_IMAGE_TAG'),
    ...(runtime ? { CUSTOM_OVERRIDE: values.get('CUSTOM_OVERRIDE'), USER_ENV_MARKER: values.get('USER_ENV_MARKER') } : {}),
  };
};
const generatedEnvironment = () => environment(fs.readFileSync(ownedFile('app-data/orbis-qa/rehearsal-app/app.env'), 'utf8').split('\n'));
const verifyEnvironment = (selected, version, runtime = false) => {
  assert.equal(selected.generatedValueHash, baseline.generatedValueHash, 'Generated value changed');
  assert.equal(selected.SERVICE_LABEL, 'preserved Orbis label');
  assert.equal(selected.NEW_OPTION, 'v2-default', 'The existing v2 default changed');
  assert.equal(selected.NEW_V3_OPTION, version === 3 ? 'v3-default' : undefined, 'The generated v3 default is incorrect');
  if (!runtime) {
    assert.equal(selected.APP_PORT, '18991');
    assert.equal(selected.APP_IMAGE_TAG, `${version}.0.0`);
  }
  if (runtime) {
    assert.equal(selected.CUSTOM_OVERRIDE, 'user-compose-preserved');
    assert.equal(selected.USER_ENV_MARKER, 'user-env-preserved');
  }
};
const generatedCompose = () => {
  try {
    return yaml.parse(fs.readFileSync(ownedFile('apps/orbis-qa/rehearsal-app/docker-compose.generated.yml'), 'utf8'));
  } catch {
    throw new Error('Generated fixture Compose is unreadable');
  }
};
const networkNames = (value) => (Array.isArray(value) ? value : Object.keys(value || {}));
const ipv4Range = (cidr) => {
  const match = typeof cidr === 'string' && cidr.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/);
  if (!match) return null;
  const octets = match.slice(1, 5).map(Number);
  const prefix = Number(match[5]);
  if (octets.some((value) => value > 255) || prefix > 32) return null;
  const address = octets.reduce((result, value) => result * 256 + value, 0);
  const size = 2 ** (32 - prefix);
  const first = Math.floor(address / size) * size;
  return [first, first + size - 1];
};
const overlaps = (left, right) => {
  const a = ipv4Range(left);
  const b = ipv4Range(right);
  return Boolean(a && b && a[0] <= b[1] && b[0] <= a[1]);
};
const dockerNetworks = () => {
  const ids = docker(['network', 'ls', '-q'], 'network discovery').trim().split('\n').filter(Boolean);
  if (!ids.length) return [];
  const format = '{"Id":{{json .Id}},"Name":{{json .Name}},"Labels":{{json .Labels}},"IPAM":{{json .IPAM}},"Containers":{{json .Containers}}}';
  return docker(['network', 'inspect', '--format', format, ...ids], 'network inspection')
    .trim()
    .split('\n')
    .map((line) => parsePrivate(line, 'Owned network inspection'));
};
const activeTaskStatuses = new Set(['queued', 'running', 'unconfirmed']);
const terminalTaskStatuses = new Set(['succeeded', 'failed', 'interrupted']);
const requestId = (value) => {
  assert.match(value || '', /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/, 'Lifecycle task ID is missing or malformed');
  return value;
};

(async () => {
  let browser;
  let context;
  let page;
  let cleanupArmed = false;
  let originalPreferences;
  let browserPreferences;
  let browserPreferenceWrites = 0;
  let primaryFailure;
  let report;
  let stage = 'preflight';
  let cleanupConfirmed = false;
  const cleanupFailures = [];
  const errors = [];
  const updateRequests = [];
  const unexpectedMutations = [];
  let allowUpdate = false;
  let allowRefresh = false;
  let refreshRequests = 0;
  let updateTask;
  let startTask;
  let stopTask;
  let updateDispatched = false;
  let updateRejected = false;
  let startDispatched = false;
  let startRejected = false;
  let explicitStartRequests = 0;
  let previousTaskIds = new Set();
  const recoveredTaskReceipts = [];
  const appPath = `/api/apps/${encodeURIComponent(urn)}`;
  const lifecyclePath = `/api/app-lifecycle/${encodeURIComponent(urn)}`;
  const rawUpdatePath = `/api/app-lifecycle/${urn}/update`;
  const read = async (endpoint) => {
    assert.ok(endpoint.startsWith('/api/'), 'Only fixed API paths may be read');
    const response = await context.request.get(`${url.origin}${endpoint}`, { timeout: 15000, maxRedirects: 0 });
    assert.ok(response.ok(), `Audit read returned HTTP ${response.status()}`);
    return response.json();
  };
  const waitFor = async (condition, label, timeout = 180000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const result = await condition();
      if (result) return result;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(label);
  };
  const buildMatches = (build) => {
    assert.equal(build.version, release.tag, 'Published release version mismatch');
    assert.equal(build.commit, release.commit, 'Published release commit mismatch');
    assert.equal(build.imageDigest, release.image.split('@')[1], 'Published release image digest mismatch');
  };
  const appContainers = () => {
    const ids = docker(['ps', '-aq', '--filter', `label=runtipi.appurn=${urn}`], 'fixture container discovery')
      .trim()
      .split('\n')
      .filter(Boolean);
    return ids.map((id) => {
      const container = inspect(id, true);
      assert.equal(container.Config.Labels?.['runtipi.appurn'], urn, 'Container belongs to another app');
      assert.equal(container.Config.Labels?.['com.docker.compose.project'], composeProject, 'Unexpected fixture Compose project');
      assert.ok(['web', 'helper'].includes(container.Config.Labels?.['com.docker.compose.service']), 'Unexpected fixture service');
      assert.ok(
        container.Mounts.filter((mount) => mount.Type === 'bind').every((mount) => mount.Source.startsWith(`${installRoot}/`)),
        'Fixture bind mount ownership mismatch',
      );
      return container;
    });
  };
  const assertStoppedContainers = () => {
    assert.equal(
      docker(['ps', '-q', '--filter', `label=runtipi.appurn=${urn}`], 'stopped fixture check').trim(),
      '',
      'A fixture container is running',
    );
  };
  const fixtureTasks = async () => {
    const history = await read('/api/tasks');
    assert.equal(history.storage, 'persistent', 'Persistent task history is required');
    const own = history.tasks.filter((task) => task.appUrn === urn);
    return { history, own, added: own.filter((task) => !previousTaskIds.has(task.id)) };
  };
  const waitTaskSuccess = async (id, action) =>
    waitFor(async () => {
      const snapshot = await fixtureTasks();
      const task = snapshot.own.find((item) => item.id === id);
      if (!task) return false;
      assert.equal(task.action, action, 'Lifecycle receipt action does not match its task');
      assert.ok(!['failed', 'interrupted'].includes(task.status), 'A required lifecycle task did not succeed');
      return task.status === 'succeeded' ? snapshot : false;
    }, 'Lifecycle receipt did not reach a succeeded task');
  const acceptedTaskRefs = () => [
    ...(updateTask ? [{ id: updateTask, action: 'update' }] : []),
    ...(startTask ? [{ id: startTask, action: 'start' }] : []),
    ...(stopTask ? [{ id: stopTask, action: 'stop' }] : []),
  ];
  const waitFixtureQuiet = async ({ expectedStatus, exactNewTasks = false, requireSuccess = false, timeout = 180000 } = {}) => {
    let signature;
    let quietSince = 0;
    return waitFor(
      async () => {
        const snapshot = await fixtureTasks();
        const expected = acceptedTaskRefs();
        for (const receipt of expected) {
          const task = snapshot.own.find((item) => item.id === receipt.id);
          if (!task) return false;
          assert.equal(task.action, receipt.action, 'Tracked lifecycle task has the wrong action');
        }
        if (requireSuccess)
          assert.ok(!snapshot.added.some((task) => ['failed', 'interrupted', 'unconfirmed'].includes(task.status)), 'A fixture task failed');
        if (exactNewTasks)
          equalPrivate(
            snapshot.added.map(({ id, action }) => ({ id, action })).sort((a, b) => a.id.localeCompare(b.id)),
            [...expected].sort((a, b) => a.id.localeCompare(b.id)),
            'Unexpected automatic or duplicate fixture lifecycle task',
          );
        const record = await read(appPath);
        if (
          snapshot.own.some((task) => activeTaskStatuses.has(task.status) || !terminalTaskStatuses.has(task.status)) ||
          !['stopped', 'running'].includes(record.app?.status) ||
          (expectedStatus && record.app.status !== expectedStatus)
        ) {
          signature = undefined;
          quietSince = 0;
          return false;
        }
        const next = canonical({
          tasks: snapshot.own.map(({ id, action, status, updatedAt }) => ({ id, action, status, updatedAt })),
          status: record.app.status,
          version: record.app.version,
          updatedAt: record.app.updatedAt,
        });
        if (next !== signature) {
          signature = next;
          quietSince = Date.now();
        }
        return Date.now() - quietSince >= 5000 ? { ...snapshot, record, quietMs: Date.now() - quietSince } : false;
      },
      'Fixture lifecycle tasks or app state did not become terminal and quiet',
      timeout,
    );
  };
  const validateSubnet = async (record, version, running = false) => {
    const subnet = record.subnet;
    assert.match(
      subnet || '',
      /^10\.(?:12[8-9]|1[3-9]\d|2[0-4]\d|25[0-4])\.(?:[0-9]|[1-9]\d|1\d\d|2[0-4]\d|25[0-4])\.0\/24$/,
      'Invalid derived app subnet',
    );
    const installed = await read('/api/apps/installed');
    const others = installed.installed.filter((item) => item.info.urn !== urn);
    assert.ok(Number(subnet.split('.')[1]) > 128 || Number(subnet.split('.')[2]) >= 10, 'Derived subnet uses a reserved allocation');
    assert.ok(
      others.every((item) => Object.hasOwn(item.app, 'subnet')),
      'Installed app records must expose allocations for uniqueness verification',
    );
    assert.ok(
      others.every((item) => item.app.subnet === null || (ipv4Range(item.app.subnet) && !overlaps(item.app.subnet, subnet))),
      'Derived subnet overlaps another app allocation',
    );
    const compose = generatedCompose();
    const privateConfig = compose.networks?.[privateNetworkKey];
    const networks = dockerNetworks();
    const privateNetworks = networks.filter(
      (network) =>
        network.Labels?.['com.docker.compose.project'] === composeProject && network.Labels?.['com.docker.compose.network'] === privateNetworkKey,
    );
    const allocated = networks.filter((network) => network.IPAM?.Config?.some((item) => overlaps(item.Subnet, subnet)));
    if (version === 2) {
      assert.equal(Object.keys(compose.services).length, 1, 'Baseline v2 must remain a single-service fixture');
      assert.equal(privateConfig, undefined, 'Single-service v2 must not declare private IPAM');
      assert.equal(privateNetworks.length, 0, 'Stopped v2 must not have a private network');
      assert.equal(allocated.length, 0, 'Unused baseline allocation conflicts with a Docker network');
      return { subnet, validation: 'single-service unused allocation: valid and unique across app records and Docker networks' };
    }
    equalPrivate(Object.keys(compose.services).sort(), ['helper', 'web'], 'v3 must declare web and helper services');
    assert.equal(privateConfig?.ipam?.config?.length, 1, 'v3 must declare one private IPAM subnet');
    assert.equal(privateConfig.ipam.config[0].subnet, subnet, 'Generated private IPAM differs from the app allocation');
    equalPrivate(
      networkNames(compose.services.web.networks).sort(),
      [privateNetworkKey, 'tipi_main_network'].sort(),
      'Web generated network attachments differ',
    );
    equalPrivate(networkNames(compose.services.helper.networks), [privateNetworkKey], 'Helper must use only the private network');
    assert.equal(compose.networks.tipi_main_network?.name, sharedNetworkName);
    if (!running) {
      assert.equal(privateNetworks.length, 0, 'A stopped update must not create a private runtime network');
      assert.equal(allocated.length, 0, 'Stopped allocation conflicts with a Docker network');
      return { subnet, validation: 'generated private IPAM matches app; allocation unique; runtime network absent while stopped' };
    }
    assert.equal(privateNetworks.length, 1, 'Exactly one owned private runtime network is required');
    const privateNetwork = privateNetworks[0];
    assert.equal(privateNetwork.IPAM?.Config?.length, 1);
    assert.equal(privateNetwork.IPAM.Config[0].Subnet, subnet, 'Docker private IPAM differs from app and generated Compose');
    assert.equal(allocated.length, 1, 'Private subnet conflicts with another Docker network');
    assert.equal(allocated[0].Id, privateNetwork.Id);
    assert.equal(Object.keys(privateNetwork.Containers || {}).length, 2, 'Private network contains an unexpected container');
    const containers = appContainers();
    equalPrivate(
      containers.map((container) => container.Config.Labels['com.docker.compose.service']).sort(),
      ['helper', 'web'],
      'Expected exactly two v3 services',
    );
    const prefix = subnet.split('.').slice(0, 3).join('.');
    for (const container of containers) {
      const service = container.Config.Labels['com.docker.compose.service'];
      equalPrivate(
        Object.keys(container.NetworkSettings.Networks).sort(),
        (service === 'web' ? [privateNetwork.Name, sharedNetworkName] : [privateNetwork.Name]).sort(),
        'Runtime network attachment mismatch',
      );
      const attachment = container.NetworkSettings.Networks[privateNetwork.Name];
      assert.equal(attachment.NetworkID, privateNetwork.Id);
      const host = Number(attachment.IPAddress.split('.').at(-1));
      assert.ok(
        attachment.IPAddress.startsWith(`${prefix}.`) && host > 1 && host < 255 && attachment.IPPrefixLen === 24,
        'Container is outside its private subnet',
      );
      assert.ok(attachment.Aliases.includes(service), 'Service DNS alias is missing');
      assert.ok(Object.hasOwn(privateNetwork.Containers, container.Id), 'Private network does not contain the owned service');
    }
    assert.equal(
      new Set(containers.map((container) => container.NetworkSettings.Networks[privateNetwork.Name].IPAddress)).size,
      2,
      'Services share a private IP address',
    );
    return {
      subnet,
      network: privateNetwork.Name,
      validation: 'app/generated IPAM/Docker IPAM and both owned service attachments agree; subnet unique',
    };
  };
  const assertPreserved = (record, network) => {
    assert.equal(network.subnet, record.subnet, 'Derived subnet must be validated before normalization');
    equalPrivate(
      { ...fields(record), subnet: baseline.app.subnet },
      fields(baseline.app),
      'Operational settings changed apart from the validated derived subnet',
    );
    equalPrivate(record.config, baseline.app.config, 'Raw stored config changed');
    assert.equal(record.maxBackups, null, 'Stored inherited retention changed');
    assert.ok(
      !Object.hasOwn(record.config, 'maxBackups') && !Object.hasOwn(record.config, 'NEW_V3_OPTION'),
      'Update persisted an omitted raw config field',
    );
  };
  const httpVersion = async (version) => {
    const endpoint = new URL(base);
    endpoint.port = '18991';
    const response = await fetch(endpoint.origin, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200, 'Fixture HTTP endpoint is unavailable');
    assert.equal(response.headers.get('x-orbis-fixture-version'), String(version));
    assert.equal(await response.text(), `Orbis fixture v${version}\n`);
  };
  try {
    preflight();
    const coreIds = docker(['ps', '-q', '--filter', 'label=com.docker.compose.service=runtipi'], 'core discovery').trim().split('\n').filter(Boolean);
    assert.equal(coreIds.length, 1, 'Exactly one core is required in the owned Docker context');
    const coreId = coreIds[0];
    const core = inspect(coreId);
    const requiredMounts = {
      '/data/.env': '.env',
      '/data/apps': 'apps',
      '/data/repos': 'repos',
      '/data/user-config': 'user-config',
      '/data/state': 'state',
      '/app-data': 'app-data',
    };
    for (const [destination, relative] of Object.entries(requiredMounts)) {
      const matches = core.Mounts.filter((mount) => mount.Destination === destination);
      assert.ok(
        matches.length === 1 && matches[0].Type === 'bind' && matches[0].Source === path.join(installRoot, relative),
        `Core ${destination} bind is not the exact owned fixture path`,
      );
    }
    assert.equal(core.Config.Image, release.image, 'Owned core image differs from the supplied release');
    assert.equal(core.State.Health.Status, 'healthy', 'Published beta29 core must be healthy');
    const coreExec = (args, label) => docker(['exec', coreId, ...args], label);
    const git = (...args) => coreExec(['git', '-c', `safe.directory=${repoDirectory}`, ...args], 'fixture Git read').trim();

    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.ORBIS_BROWSER_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    });
    context = await browser.newContext({ viewport: { width: 1440, height: 1120 } });
    await context.addCookies(cookies);
    buildMatches(await read('/api/system/build'));
    stage = 'baseline';
    const before = await read(appPath);
    assert.equal(before.app?.version, 2, 'Fixture must be fresh v2; refusing a repeated mutation');
    assert.equal(before.info?.version, '2.0.0');
    assert.equal(before.app?.status, 'stopped', 'Root must stop v2 before running this audit');
    equalPrivate(fields(before.app), fields(baseline.app), 'Fixture app record differs from its baseline');
    equalPrivate(fileHashes(), baseline.fileHashes, 'Fixture data or user overrides differ from baseline');
    const baselineNetwork = await validateSubnet(before.app, 2);
    assertStoppedContainers();
    verifyEnvironment(generatedEnvironment(), 2);

    const previousCloneSha = git('-C', repoDirectory, 'rev-parse', 'HEAD');
    assert.notEqual(previousCloneSha, expectedSha, 'Fixture was already refreshed; require a new owned fixture commit');
    const remote = git('ls-remote', fixtureRepo, 'refs/heads/main').split(/\s+/);
    assert.equal(remote[0], expectedSha, 'Remote fixture must expose the exact v3 commit before refreshing');
    assert.equal(remote[1], 'refs/heads/main');
    const beforeInstalled = installedFiles();
    const beforeEnvHash = sha256(fs.readFileSync(ownedFile('app-data/orbis-qa/rehearsal-app/app.env')));
    originalPreferences = await read('/api/desktop-preferences');
    browserPreferences = { ...JSON.parse(JSON.stringify(originalPreferences)), windows: {} };
    await context.addInitScript(
      ({ origin, preferences }) => {
        if (window !== window.top || location.origin !== origin) return;
        localStorage.setItem('server-desktop-preferences-v1', JSON.stringify(preferences));
      },
      { origin: url.origin, preferences: browserPreferences },
    );
    const beforeBackups = await read(`/api/backups/${encodeURIComponent(urn)}?pageSize=100`);
    assert.ok(beforeBackups.total <= 100, 'Fixture backup history exceeds the bounded audit window');
    const previousBackupIds = new Set(beforeBackups.data.map((backup) => backup.id));
    const beforeTasks = await read('/api/tasks');
    assert.equal(beforeTasks.storage, 'persistent');
    assert.ok(
      !beforeTasks.tasks.some((task) => task.appUrn === urn && ['queued', 'running', 'unconfirmed'].includes(task.status)),
      'Fixture has an unfinished lifecycle operation',
    );
    previousTaskIds = new Set(beforeTasks.tasks.map((task) => task.id));
    cleanupArmed = true;

    await context.route('**/*', async (route) => {
      const request = route.request();
      const target = new URL(request.url());
      const pathname = decodeURIComponent(target.pathname);
      if (target.origin !== url.origin) return route.abort('blockedbyclient');
      if (pathname === '/api/desktop-preferences') {
        if (request.method() === 'GET')
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(browserPreferences) });
        if (request.method() === 'PUT') {
          browserPreferences = parsePrivate(request.postData() || '{}', 'Browser-only preferences');
          browserPreferenceWrites++;
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(browserPreferences) });
        }
      }
      if (['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return route.continue();
      if (request.method() === 'POST' && pathname === '/api/marketplace/pull' && allowRefresh) {
        refreshRequests++;
        if (refreshRequests === 1) return route.continue();
      }
      if (request.method() === 'PATCH' && pathname === rawUpdatePath && allowUpdate) {
        const body = parsePrivate(request.postData() || '{}', 'Update request');
        updateRequests.push(body);
        if (updateRequests.length === 1 && isDeepStrictEqual(body, { performBackup: true })) {
          updateDispatched = true;
          return route.continue();
        }
      }
      unexpectedMutations.push({ method: request.method(), path: pathname });
      return route.abort('blockedbyclient');
    });
    page = await context.newPage();
    page.on('pageerror', () => errors.push('Browser page error (details omitted to protect configuration)'));
    allowRefresh = true;
    stage = 'store-refresh';
    await page.goto(`${url.origin}/settings?tab=actions`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    const [refreshResponse] = await Promise.all([
      page.waitForResponse((response) => new URL(response.url()).pathname === '/api/marketplace/pull' && response.request().method() === 'POST', {
        timeout: 120000,
      }),
      page.getByRole('dialog').getByRole('button', { name: 'Refresh', exact: true }).click(),
    ]);
    allowRefresh = false;
    assert.ok(refreshResponse.ok(), `Manual refresh returned HTTP ${refreshResponse.status()}`);
    assert.equal((await refreshResponse.json()).success, true);
    assert.equal(refreshRequests, 1, 'Manual refresh must make one request');
    assert.equal(git('-C', repoDirectory, 'rev-parse', 'HEAD'), expectedSha, 'Checked-out store SHA differs from the v3 fixture');
    const refreshed = await read(appPath);
    assert.equal(refreshed.metadata?.latestVersion, 3, 'Catalogue v3 is required before update');
    assert.equal(refreshed.metadata?.latestDockerVersion, '3.0.0');
    assert.equal(refreshed.app?.version, 2, 'Refresh must not update the installed app');
    assert.equal(refreshed.app?.status, 'stopped');
    assert.equal(refreshed.info?.version, '2.0.0');
    equalPrivate(fields(refreshed.app), fields(before.app), 'Refresh changed fixture settings');
    equalPrivate(installedFiles(), beforeInstalled, 'Refresh changed installed v2 files');
    equalPrivate(fileHashes(), baseline.fileHashes, 'Refresh changed data or overrides');
    assert.equal(
      sha256(fs.readFileSync(ownedFile('app-data/orbis-qa/rehearsal-app/app.env'))),
      beforeEnvHash,
      'Refresh changed generated v2 environment',
    );
    assertStoppedContainers();
    const configDiff = await read(`${appPath}/config-diff`);
    assert.equal(parsePrivate(configDiff.current, 'Current config review').tipi_version, 2);
    const nextConfig = parsePrivate(configDiff.new, 'New config review');
    assert.equal(nextConfig.tipi_version, 3);
    assert.equal(nextConfig.version, '3.0.0');
    assert.ok(
      nextConfig.form_fields.some((field) => field.env_variable === 'NEW_OPTION' && field.default === 'v2-default'),
      'v3 must preserve the existing v2 default',
    );
    assert.ok(
      nextConfig.form_fields.some((field) => field.env_variable === 'NEW_V3_OPTION' && field.default === 'v3-default'),
      'v3 default is missing',
    );
    const composeDiff = await read(`${appPath}/compose-diff`);
    assert.ok(composeDiff.current.includes(sourceImage) && composeDiff.new.includes(targetImage), 'Compose diff must show the v2-to-v3 image change');
    const nextSource = parsePrivate(composeDiff.new, 'New Compose review');
    equalPrivate(Object.keys(nextSource.services).sort(), ['helper', 'web'], 'v3 source must declare both owned services');
    assert.ok(
      Object.values(nextSource.services).every((service) => service.image === targetImage),
      'Both v3 services must use the target image',
    );

    stage = 'update-review';
    fs.mkdirSync(screenshotDir, { recursive: true, mode: 0o700 });
    const wizard = () => page.getByTestId('app-update');
    const active = () => wizard().locator('.breadcrumb button[aria-current="step"]').innerText();
    const backup = () => wizard().getByRole('switch', { name: 'Create backup before updating', exact: true });
    const open = async () => {
      await page.goto(`${base}/apps/orbis-qa/rehearsal-app/update`, { waitUntil: 'domcontentloaded' });
      await wizard().waitFor();
      assert.deepEqual(await wizard().locator('.breadcrumb > li > button').allTextContents(), [
        'Information',
        'Configuration',
        'Compose file',
        'Backup',
      ]);
      assert.equal(await active(), 'Information');
    };
    const step = async (name) => {
      await wizard().getByRole('button', { name, exact: true }).click();
      assert.equal(await active(), name);
    };
    const reviewText = async () => {
      const editor = wizard().locator('.cm-editor');
      await editor.waitFor();
      let text = '';
      for (const portion of [0, 0.5, 1]) {
        await editor.locator('.cm-scroller').evaluate((element, part) => {
          element.scrollTop = (element.scrollHeight - element.clientHeight) * part;
        }, portion);
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        text += await editor.innerText();
      }
      return text;
    };
    const capture = async (name) => {
      const footer = wizard().locator('.app-update-footer');
      await footer.scrollIntoViewIfNeeded();
      const fit = await footer.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const dock = document.querySelector('.desktop-dock').getBoundingClientRect();
        return {
          overflow: document.documentElement.scrollWidth > innerWidth,
          buttons: [...element.querySelectorAll('button')].map((button) => {
            const rect = button.getBoundingClientRect();
            return rect.height >= 40 && rect.x >= bounds.x - 1 && rect.right <= bounds.right + 1 && rect.y >= 0 && rect.bottom <= dock.y - 4;
          }),
        };
      });
      assert.ok(!fit.overflow && fit.buttons.every(Boolean), 'Update footer has clipped or unreachable controls');
      await page.screenshot({ path: path.join(screenshotDir, `${name}.png`), animations: 'disabled' });
    };

    await open();
    await wizard().getByRole('button', { name: 'Cancel', exact: true }).click();
    await wizard().waitFor({ state: 'hidden' });
    assert.equal(updateRequests.length, 0, 'Cancel must not PATCH the app');
    assert.equal(unexpectedMutations.length, 0, 'Cancel attempted an unexpected mutation');
    for (const viewport of [
      { name: 'desktop', width: 1440, height: 1120 },
      { name: 'mobile', width: 390, height: 844 },
      { name: 'narrow', width: 320, height: 800 },
    ]) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await open();
      await capture(`${viewport.name}-information`);
      await step('Configuration');
      await wizard().locator('.cm-content').first().waitFor();
      const configText = await reviewText();
      assert.ok(
        configText.includes('3.0.0') && configText.includes('NEW_OPTION') && configText.includes('NEW_V3_OPTION'),
        'Configuration review does not show fixture v3',
      );
      await capture(`${viewport.name}-configuration`);
      await step('Compose file');
      await wizard().locator('.cm-content').first().waitFor();
      assert.ok((await reviewText()).includes(targetImage), 'Compose review does not show the v3 image');
      await capture(`${viewport.name}-compose`);
      await step('Backup');
      assert.equal(await backup().getAttribute('aria-checked'), 'true', 'Backup must default to enabled');
      await backup().click();
      assert.equal(await backup().getAttribute('aria-checked'), 'false');
      await page.getByRole('button', { name: 'Minimize Applications', exact: true }).click();
      await page.locator('.desktop-route-window').waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: 'Restore Applications', exact: true }).click();
      await wizard().waitFor();
      assert.equal(await active(), 'Backup');
      assert.equal(await backup().getAttribute('aria-checked'), 'false', 'Minimize/restore lost the backup choice');
      await backup().click();
      assert.equal(await backup().getAttribute('aria-checked'), 'true');
      await capture(`${viewport.name}-backup`);
      assert.equal(updateRequests.length, 0, 'Review and minimize/restore must not submit an update');
      assert.equal(unexpectedMutations.length, 0, 'Review attempted an unexpected mutation');
    }
    await page.waitForFunction(() => !document.querySelector('[data-testid="app-update"] .app-update-navigation button:last-child')?.disabled);
    stage = 'stopped-update';
    allowUpdate = true;
    const [updateResponse] = await Promise.all([
      page.waitForResponse(
        (response) => decodeURIComponent(new URL(response.url()).pathname) === rawUpdatePath && response.request().method() === 'PATCH',
      ),
      wizard().getByRole('button', { name: 'Update', exact: true }).click(),
    ]);
    allowUpdate = false;
    updateRejected = !updateResponse.ok();
    assert.ok(updateResponse.ok(), `App upgrade returned HTTP ${updateResponse.status()}`);
    updateTask = requestId((await updateResponse.json()).requestId);
    equalPrivate(updateRequests, [{ performBackup: true }], 'Expected exactly one backed-up app upgrade request');
    await waitTaskSuccess(updateTask, 'update');
    await waitFor(async () => {
      const record = await read(appPath);
      return record.app?.version === 3 && record.app?.status === 'stopped';
    }, 'Stopped update did not reach installed v3 without an automatic start');
    const stoppedUpdate = await waitFixtureQuiet({ expectedStatus: 'stopped', exactNewTasks: true, requireSuccess: true });
    assert.equal(stoppedUpdate.added.length, 1, 'Stopped update must create only its explicit update task');
    assertStoppedContainers();
    assert.equal(appContainers().length, 0, 'Stopped update unexpectedly created a runtime container');
    const stoppedNetwork = await validateSubnet(stoppedUpdate.record.app, 3);
    assertPreserved(stoppedUpdate.record.app, stoppedNetwork);
    assert.equal(stoppedUpdate.record.info.version, '3.0.0');
    assert.equal(stoppedUpdate.record.metadata.latestVersion, 3);
    assert.equal(parsePrivate(fs.readFileSync(ownedFile('apps/orbis-qa/rehearsal-app/config.json'), 'utf8'), 'Installed v3 config').tipi_version, 3);
    const installedSource = yaml.parse(fs.readFileSync(ownedFile('apps/orbis-qa/rehearsal-app/docker-compose.yml'), 'utf8'));
    equalPrivate(Object.keys(installedSource.services).sort(), ['helper', 'web'], 'Installed v3 source is missing a service');
    assert.ok(
      Object.values(installedSource.services).every((service) => service.image === targetImage),
      'Installed v3 source has an unexpected image',
    );
    equalPrivate(fileHashes(), baseline.fileHashes, 'App data or user overrides changed during upgrade');
    stage = 'generated-environment-before-start';
    assert.equal(explicitStartRequests, 0, 'No start may precede the post-copy generated environment check');
    const selectedGeneratedEnvironment = generatedEnvironment();
    verifyEnvironment(selectedGeneratedEnvironment, 3);
    const generatedEnvironmentHashBeforeStart = sha256(fs.readFileSync(ownedFile('app-data/orbis-qa/rehearsal-app/app.env')));
    assert.equal(
      (await fixtureTasks()).added.some((task) => task.action === 'start'),
      false,
      'Automatic start could mask missing environment generation',
    );

    stage = 'explicit-v3-start';
    explicitStartRequests++;
    startDispatched = true;
    const startResponse = await context.request.post(`${url.origin}${lifecyclePath}/start`, {
      headers: { Origin: url.origin },
      data: {},
      timeout: 15000,
      maxRedirects: 0,
    });
    startRejected = !startResponse.ok();
    assert.ok(startResponse.ok(), 'Explicit v3 start request failed');
    startTask = requestId((await startResponse.json()).requestId);
    await waitTaskSuccess(startTask, 'start');
    let after;
    let runningContainers;
    await waitFor(async () => {
      after = await read(appPath);
      if (after.app?.version !== 3 || after.app?.status !== 'running') return false;
      runningContainers = appContainers();
      return (
        runningContainers.length === 2 &&
        runningContainers.every(
          (container) => container.Config.Image === targetImage && container.State.Running && container.State.Health.Status === 'healthy',
        )
      );
    }, 'Explicit start did not reach installed v3 with two healthy target-image containers');
    await httpVersion(3);
    const runtimeNetwork = await validateSubnet(after.app, 3, true);
    assertPreserved(after.app, runtimeNetwork);
    const web = runningContainers.find((container) => container.Config.Labels['com.docker.compose.service'] === 'web');
    const selectedEnvironment = environment(web.Config.Env || [], true);
    verifyEnvironment(selectedEnvironment, 3, true);
    assert.equal(
      docker(['exec', web.Id, 'wget', '-qO-', 'http://helper/'], 'owned cross-container DNS/HTTP read'),
      'Orbis helper v3\n',
      'Helper DNS/HTTP body mismatch',
    );
    const started = await waitFixtureQuiet({ expectedStatus: 'running', exactNewTasks: true, requireSuccess: true });
    assert.equal(started.added.length, 2, 'Expected exactly one update and one explicit start task before cleanup');
    assert.equal(explicitStartRequests, 1);
    equalPrivate(fileHashes(), baseline.fileHashes, 'Explicit start changed protected data or user overrides');
    const tasks = started.history;
    stage = 'backup-evidence';
    const afterBackups = await read(`/api/backups/${encodeURIComponent(urn)}?pageSize=100`);
    const added = afterBackups.data.filter((backup) => !previousBackupIds.has(backup.id));
    assert.equal(added.length, 1, 'Exactly one new upgrade backup is required');
    const backupRecord = added[0];
    assert.match(backupRecord.id, /^[a-zA-Z0-9._-]+\.tar\.gz$/);
    const backupRelative = `backups/orbis-qa/rehearsal-app/${backupRecord.id}`;
    const backupSize = fs.statSync(ownedFile(backupRelative)).size;
    assert.ok(backupSize > 0 && backupRecord.size > 0, 'Upgrade backup is empty');
    const rawEntries = coreExec(['tar', '-tzf', `/data/${backupRelative}`], 'backup listing')
      .split('\n')
      .filter(Boolean);
    const entries = rawEntries.map((entry) => entry.replace(/^\.\//, ''));
    assert.ok(
      entries.every((entry) => !entry.startsWith('/') && !entry.split('/').includes('..')),
      'Backup has unsafe entry paths',
    );
    const requiredEntries = [
      'app/config.json',
      'app/docker-compose.yml',
      'app-data/data/marker.txt',
      'app-data/app.env',
      'user-config/app.env',
      'user-config/docker-compose.yml',
    ];
    for (const entry of requiredEntries) assert.ok(entries.includes(entry), 'Upgrade backup is missing a required fixture entry');
    const archived = (entry) => {
      const matching = rawEntries.filter((candidate) => candidate.replace(/^\.\//, '') === entry);
      assert.equal(matching.length, 1, 'Selected archive member must be unique');
      assert.ok(!entry.endsWith('/app.env') || entry === 'user-config/app.env', 'Never read archived generated environment');
      return coreExec(['tar', '-xOf', `/data/${backupRelative}`, matching[0]], 'selected archive inspection');
    };
    const archivedConfig = archived('app/config.json');
    assert.equal(parsePrivate(archivedConfig, 'Archived app config').tipi_version, 2, 'Backup must contain installed v2 configuration');
    assert.equal(sha256(archivedConfig), beforeInstalled['config.json'], 'Archived v2 config differs from the pre-upgrade file');
    const archivedSource = archived('app/docker-compose.yml');
    assert.ok(archivedSource.includes(sourceImage), 'Backup must contain the v2 source image');
    assert.equal(sha256(archivedSource), beforeInstalled['docker-compose.yml'], 'Archived v2 source differs from the pre-upgrade file');
    const archiveHashes = {
      'app-data/data/marker.txt': sha256(archived('app-data/data/marker.txt')),
      'user-config/app.env': sha256(archived('user-config/app.env')),
      'user-config/docker-compose.yml': sha256(archived('user-config/docker-compose.yml')),
    };
    assert.equal(archiveHashes['app-data/data/marker.txt'], baseline.fileHashes[fileNames[0]], 'Archived data marker differs from baseline');
    assert.equal(archiveHashes['user-config/app.env'], baseline.fileHashes[fileNames[1]], 'Archived user environment differs from baseline');
    assert.equal(archiveHashes['user-config/docker-compose.yml'], baseline.fileHashes[fileNames[2]], 'Archived user Compose differs from baseline');
    buildMatches(await read('/api/system/build'));
    assert.equal(errors.length, 0, 'Browser reported an error');
    equalPrivate(unexpectedMutations, [], 'An unexpected mutation was blocked');
    report = {
      passed: true,
      release: release.tag,
      commit: release.commit,
      digest: release.image.split('@')[1],
      urn,
      refresh: {
        method: 'Settings Actions UI',
        requests: refreshRequests,
        previousCloneSha,
        cloneSha: expectedSha,
        installedV2Unchanged: true,
      },
      review: { widths: [1440, 390, 320], cancelWithoutPatch: true, defaultBackup: true, minimizeRestoreChoice: true },
      upgrade: {
        requests: updateRequests.length,
        performBackup: true,
        fromVersion: 2,
        version: 3,
        updateTask,
        completedStopped: true,
        automaticStartTasks: 0,
        terminalQuietMsBeforeStart: stoppedUpdate.quietMs,
      },
      generatedEnvironmentBeforeStart: {
        checkedBeforeAnyStart: true,
        fileHash: generatedEnvironmentHashBeforeStart,
        selected: selectedGeneratedEnvironment,
      },
      explicitStart: {
        requests: explicitStartRequests,
        task: startTask,
        image: targetImage,
        healthyServices: ['web', 'helper'],
        httpMarker: 'Orbis fixture v3',
        helperDnsHttp: 'Orbis helper v3',
      },
      subnet: { baseline: baselineNetwork, stoppedUpdate: stoppedNetwork, running: runtimeNetwork },
      preserved: {
        appRecordHash: sha256(canonical(fields(after.app))),
        configHash: sha256(canonical(after.app.config)),
        fileHashes: fileHashes(),
        selectedEnvironment,
      },
      backup: {
        id: backupRecord.id,
        bytes: backupSize,
        requiredEntries,
        version: 2,
        sourceImage,
        selectedFileHashes: archiveHashes,
        validation: 'listing and selected stdout-only members; no filesystem extraction or generated environment reads',
      },
      tasks: tasks.tasks
        .filter((task) => task.appUrn === urn && !previousTaskIds.has(task.id))
        .map(({ id, action, status }) => ({ id, action, status })),
      pageErrors: [],
    };
  } catch (error) {
    primaryFailure = error;
  } finally {
    allowUpdate = false;
    allowRefresh = false;
    if (page && !page.isClosed()) await page.close().catch(() => cleanupFailures.push('Browser page cleanup failed'));
    if (cleanupArmed && context) {
      try {
        await waitFor(
          async () => {
            const snapshot = await fixtureTasks();
            for (const action of ['update', 'start']) {
              const pending =
                action === 'update' ? updateDispatched && !updateRejected && !updateTask : startDispatched && !startRejected && !startTask;
              if (!pending) continue;
              const matching = snapshot.added.filter((task) => task.action === action);
              if (matching.length !== 1) return false;
              if (action === 'update') updateTask = matching[0].id;
              else startTask = matching[0].id;
              recoveredTaskReceipts.push({ action, id: matching[0].id, source: 'unique new owned task after a lost API receipt' });
            }
            return true;
          },
          'Dispatched lifecycle request has no uniquely confirmed task receipt',
          120000,
        );
        await waitFixtureQuiet();
        const idle = await read(appPath);
        const running = docker(['ps', '-q', '--filter', `label=runtipi.appurn=${urn}`], 'cleanup running fixture check').trim();
        if (idle.app.status !== 'stopped' || running) {
          const response = await context.request.post(`${url.origin}${lifecyclePath}/stop`, {
            headers: { Origin: url.origin },
            data: {},
            timeout: 15000,
            maxRedirects: 0,
          });
          assert.ok(response.ok(), 'Final fixture stop request failed');
          stopTask = requestId((await response.json()).requestId);
          await waitTaskSuccess(stopTask, 'stop');
        }
        const final = await waitFixtureQuiet({ expectedStatus: 'stopped' });
        assertStoppedContainers();
        const finalNetwork = await validateSubnet(final.record.app, final.record.app.version);
        assertPreserved(final.record.app, finalNetwork);
        equalPrivate(fileHashes(), baseline.fileHashes, 'Final stop changed data or user overrides');
        if (report) {
          assert.equal(final.record.app.version, 3, 'Final stopped fixture lost v3');
          verifyEnvironment(generatedEnvironment(), 3);
          report.subnet.finalStopped = finalNetwork;
          report.tasks = final.added.map(({ id, action, status }) => ({ id, action, status }));
          equalPrivate(
            report.tasks.map(({ id, action }) => ({ id, action })).sort((a, b) => a.id.localeCompare(b.id)),
            acceptedTaskRefs().sort((a, b) => a.id.localeCompare(b.id)),
            'Final task list includes an unexpected operation',
          );
          report.cleanupQuietMs = final.quietMs;
        }
        cleanupConfirmed = true;
      } catch {
        cleanupFailures.push('Fixture cleanup is unconfirmed: terminal tasks, quiet state and final stopped Docker state were not all established');
      }
    }
    if (originalPreferences && context) {
      try {
        equalPrivate(await read('/api/desktop-preferences'), originalPreferences, 'Actual server preferences changed');
      } catch {
        cleanupFailures.push('Actual fixture preference comparison failed');
      }
    }
    if (browser) await browser.close().catch(() => cleanupFailures.push('Browser cleanup failed'));
  }
  const failed = Boolean(primaryFailure || cleanupFailures.length);
  const location = primaryFailure?.stack?.match(/live-store-upgrade-qa\.cjs:(\d+):(\d+)/);
  process.stdout.write(
    `${JSON.stringify({
      ...report,
      passed: !failed && Boolean(report),
      finalStatus: cleanupConfirmed ? 'stopped' : cleanupArmed ? 'unconfirmed' : 'not-checked',
      cleanupConfirmed,
      finalStopTask: stopTask || null,
      browserOnlyPreferenceWrites: browserPreferenceWrites,
      actualPreferencesUnchanged: Boolean(originalPreferences) && !cleanupFailures.includes('Actual fixture preference comparison failed'),
      recoveredTaskReceipts,
      cleanupFailures,
      ...(primaryFailure
        ? {
            failure: {
              stage,
              type: /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(primaryFailure.name) ? primaryFailure.name : 'Error',
              line: location ? Number(location[1]) : null,
              messageHash: sha256(String(primaryFailure.message)),
            },
          }
        : {}),
    })}\n`,
  );
  if (failed) {
    process.stderr.write(`Live store upgrade audit failed during ${stage}; credential and configuration details are redacted.\n`);
    process.exitCode = 1;
  }
})().catch(() => {
  process.stderr.write('Live store upgrade audit failed before guarded cleanup could complete.\n');
  process.exitCode = 1;
});
