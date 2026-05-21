import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInteractiveMock, createControllableBrain, script, text } from '../../pi-mock/dist/index.js';

const EXTENSION = new URL('../index.ts', import.meta.url).pathname;
const STATUS_EXTENSION = new URL('../../pi-status-line/index.ts', import.meta.url).pathname;
const TIMEOUT = 30_000;
let testChain = Promise.resolve();

function test(name, options, fn) {
  nodeTest(name, options, async (t) => {
    const previous = testChain;
    let release;
    testChain = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await fn(t);
    } finally {
      release();
    }
  });
}

function countVisible(lines, needle) {
  return lines.filter((line) => line.includes(needle)).length;
}

function stableSessionKey(sessionFile) {
  return createHash('sha256').update(sessionFile).digest('hex').slice(0, 24);
}

function readSessionEntries(sessionFile) {
  return readFileSync(sessionFile, 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function messageText(entry) {
  const content = entry?.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

function findMessageEntry(sessionFile, text) {
  const entry = readSessionEntries(sessionFile).find((item) => messageText(item) === text);
  assert.ok(entry, `missing session entry with text ${text}`);
  return entry;
}

function findMessageEntries(sessionFile, text) {
  return readSessionEntries(sessionFile).filter((item) => messageText(item) === text);
}

async function waitForMessageEntry(sessionFile, text, timeoutMs = TIMEOUT) {
  let entry;
  try {
    await waitUntil(
      () => {
        entry = readSessionEntries(sessionFile).find((item) => messageText(item) === text);
        return !!entry;
      },
      timeoutMs,
      `session entry with text ${text}`,
    );
  } catch (error) {
    const preview = existsSync(sessionFile) ? readFileSync(sessionFile, 'utf8') : '<missing>';
    throw new Error(`${error.message}\nSession file ${sessionFile}:\n${preview}`);
  }
  return entry;
}

async function waitForMessageEntries(sessionFile, text, count = 1, timeoutMs = TIMEOUT) {
  let entries = [];
  try {
    await waitUntil(
      () => {
        entries = findMessageEntries(sessionFile, text);
        return entries.length >= count;
      },
      timeoutMs,
      `${count} session entries with text ${text}`,
    );
  } catch (error) {
    const preview = existsSync(sessionFile) ? readFileSync(sessionFile, 'utf8') : '<missing>';
    throw new Error(`${error.message}\nSession file ${sessionFile}:\n${preview}`);
  }
  return entries;
}

function assertNoHiddenBranchLanes(laneRoot) {
  const hidden = [];
  function visit(dir) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.name.startsWith('branch-')) hidden.push(path);
      if (entry.isDirectory()) visit(path);
    }
  }
  visit(laneRoot);
  assert.deepEqual(hidden, [], `hidden branch lane paths must not exist:\n${hidden.join('\n')}`);
}

function findLaneStatePath(laneRoot, lane = 'main') {
  const sessionsDir = join(laneRoot, 'sessions');
  if (!existsSync(sessionsDir)) return undefined;
  const candidates = [];
  for (const sessionDir of readdirSync(sessionsDir)) {
    const candidate = join(sessionsDir, sessionDir, 'lanes', `${lane}.json`);
    if (existsSync(candidate)) candidates.push(candidate);
  }
  candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return candidates[0];
}

function readLaneStates(laneRoot) {
  const sessionsDir = join(laneRoot, 'sessions');
  if (!existsSync(sessionsDir)) return [];
  return readdirSync(sessionsDir).flatMap((sessionDir) => {
    const lanesDir = join(laneRoot, 'sessions', sessionDir, 'lanes');
    if (!existsSync(lanesDir)) return [];
    return readdirSync(lanesDir)
      .filter((item) => item.endsWith('.json'))
      .map((item) => JSON.parse(readFileSync(join(lanesDir, item), 'utf8')));
  });
}

function writeLaneFixture(laneRoot, sessionKey, sessionFile, lane) {
  const now = new Date().toISOString();
  mkdirSync(join(laneRoot, 'sessions', sessionKey, 'lanes'), { recursive: true });
  mkdirSync(join(laneRoot, 'flat'), { recursive: true });
  const displayId = lane.displayId ?? 'L1';
  const state = {
    schemaVersion: 1,
    name: lane.name,
    sessionKey,
    baseLeafId: lane.baseLeafId ?? null,
    headEntryId: lane.headEntryId ?? null,
    headEpoch: lane.headEpoch ?? 0,
    createdAt: lane.createdAt ?? now,
    updatedAt: lane.updatedAt ?? now,
    id: lane.id ?? `${sessionKey.slice(0, 8)}-${displayId}`,
    displayId,
    aliasPath: lane.aliasPath ?? join(laneRoot, 'flat', `${sessionKey.slice(0, 8)}-${displayId}.json`),
  };
  writeFileSync(join(laneRoot, 'sessions', sessionKey, 'lanes', `${lane.name}.json`), JSON.stringify(state, null, 2), 'utf8');
}

function writeInstanceFixture(laneRoot, sessionKey, sessionFile, instance) {
  const now = new Date().toISOString();
  mkdirSync(join(laneRoot, 'sessions', sessionKey, 'instances'), { recursive: true });
  writeFileSync(join(laneRoot, 'sessions', sessionKey, 'instances', `${instance.instanceId}.json`), JSON.stringify({
    instanceId: instance.instanceId,
    pid: instance.pid ?? process.pid,
    lane: instance.lane,
    status: instance.status ?? 'idle',
    sessionId: instance.sessionId ?? null,
    sessionKey,
    sessionFile,
    leafId: instance.leafId ?? null,
    startedAt: instance.startedAt ?? now,
    lastSeenAt: instance.lastSeenAt ?? now,
  }, null, 2), 'utf8');
}

function findHostJsons(dir) {
  if (!existsSync(dir)) return [];
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findHostJsons(path));
    else if (entry.isFile() && entry.name === 'host.json' && path.includes('/sync/')) found.push(path);
  }
  return found;
}

function findSessionRuntimeDirs(laneRoot) {
  const sessionsDir = join(laneRoot, 'sessions');
  if (!existsSync(sessionsDir)) return [];
  return readdirSync(sessionsDir)
    .map((name) => join(sessionsDir, name))
    .filter((path) => existsSync(join(path, 'lanes', 'main.json')));
}

async function assertSingleRuntimeDir(laneRoot, label = 'single sync runtime') {
  await waitUntil(() => findSessionRuntimeDirs(laneRoot).length >= 1, TIMEOUT, label);
  const runtimeDirs = findSessionRuntimeDirs(laneRoot);
  assert.equal(
    runtimeDirs.length,
    1,
    `${label} must not split one session file into multiple sync keys:\n${runtimeDirs.join('\n')}`,
  );
  return runtimeDirs[0];
}

async function waitUntil(predicate, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function waitUntilQuiet(predicate, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

async function visibleText(mock) {
  return (await mock.visibleScreen()).join('\n');
}

async function waitForVisibleText(mock, matcher, timeoutMs, label) {
  const start = Date.now();
  let screen = '';
  while (Date.now() - start < timeoutMs) {
    screen = await visibleText(mock);
    if (typeof matcher === 'string' ? screen.includes(matcher) : matcher.test(screen)) return screen;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timeout waiting for ${label}\n${screen}`);
}

function lineContaining(screen, needle) {
  return screen.split('\n').find((line) => line.includes(needle)) ?? '';
}

async function waitForVisibleLine(mock, needle, timeoutMs, label) {
  const start = Date.now();
  let screen = '';
  while (Date.now() - start < timeoutMs) {
    screen = await visibleText(mock);
    const line = lineContaining(screen, needle);
    if (line) return { line, screen };
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timeout waiting for ${label}\n${screen}`);
}

async function removeRoot(root) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 4 || !['ENOTEMPTY', 'EBUSY', 'ENOENT'].includes(error?.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

test('pi-sync publishes live updates from one same-session terminal to another', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-live-'));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'shared.jsonl');
  const piWrapper = join(root, 'pi-wrapper.sh');
  writeFileSync(sessionFile, '', 'utf8');
  writeFileSync(piWrapper, `#!/usr/bin/env bash\nargs=()\nfor a in "$@"; do [[ "$a" == "--no-session" ]] && continue; args+=("$a"); done\nexec "${process.env.PI_SYNC_TEST_PI_BINARY ?? 'pi'}" "\${args[@]}"\n`);
  chmodSync(piWrapper, 0o755);

  const common = {
    brain: script(text('SYNC_TEST_ASSISTANT_RESPONSE')),
    extensions: [EXTENSION],
    piProvider: 'pi-mock',
    piModel: 'mock',
    startupTimeoutMs: 20_000,
    terminal: { cols: 100, rows: 32 },
    cwd: root,
    env: { PI_LANE_ROOT: laneRoot, PI_SYNC_POLL_MS: '50', PI_SYNC_HOST_IDLE_MS: '1000' },
    piBinary: piWrapper,
    piArgs: ['--session', sessionFile],
  };

  const a = await createInteractiveMock(common);
  const b = await createInteractiveMock(common);
  try {
    a.clearOutput();
    b.clearOutput();
    a.submit('SYNC_TEST_USER_PROMPT');
    await a.waitForOutput('SYNC_TEST_ASSISTANT_RESPONSE', TIMEOUT);

    await b.waitForOutput('SYNC_TEST_USER_PROMPT', TIMEOUT);
    await b.waitForOutput('SYNC_TEST_ASSISTANT_RESPONSE', TIMEOUT);
    assert.match(b.output, /SYNC_TEST_ASSISTANT_RESPONSE/);
  } finally {
    await a.close();
    await b.close();
    await removeRoot(root);
  }
});

test('pi-sync attached peer renders an active prompt once before response finishes', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-live-active-prompt-'));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'shared.jsonl');
  const piWrapper = join(root, 'pi-wrapper.sh');
  const brain = createControllableBrain();
  writeFileSync(sessionFile, '', 'utf8');
  writeFileSync(piWrapper, `#!/usr/bin/env bash\nargs=()\nfor a in "$@"; do [[ "$a" == "--no-session" ]] && continue; args+=("$a"); done\nexec "${process.env.PI_SYNC_TEST_PI_BINARY ?? 'pi'}" "\${args[@]}"\n`);
  chmodSync(piWrapper, 0o755);

  const common = {
    brain: brain.brain,
    extensions: [EXTENSION],
    piProvider: 'pi-mock',
    piModel: 'mock',
    startupTimeoutMs: 20_000,
    terminal: { cols: 100, rows: 32 },
    cwd: root,
    env: { PI_LANE_ROOT: laneRoot, PI_SYNC_POLL_MS: '25', PI_SYNC_HOST_IDLE_MS: '1000' },
    piBinary: piWrapper,
    piArgs: ['--session', sessionFile],
  };

  const a = await createInteractiveMock(common);
  const b = await createInteractiveMock(common);
  try {
    a.clearOutput();
    b.clearOutput();
    a.submit('SYNC_ACTIVE_USER_PROMPT');
    const call = await brain.waitForCall(TIMEOUT);
    await b.waitForOutput('SYNC_ACTIVE_USER_PROMPT', TIMEOUT);
    await new Promise((resolve) => setTimeout(resolve, 500));

    const screen = await b.visibleScreen();
    assert.equal(countVisible(screen, 'SYNC_ACTIVE_USER_PROMPT'), 1, screen.join('\n'));

    call.respond(text('SYNC_ACTIVE_ASSISTANT_RESPONSE'));
    await b.waitForOutput('SYNC_ACTIVE_ASSISTANT_RESPONSE', TIMEOUT);
  } finally {
    await a.close();
    await b.close();
    await removeRoot(root);
  }
});

test('pi-sync treats symlink and real session paths as one shared session', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-session-alias-'));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'shared.jsonl');
  const sessionAlias = join(root, 'shared-alias.jsonl');
  const piWrapper = join(root, 'pi-wrapper.sh');
  writeFileSync(sessionFile, '', 'utf8');
  symlinkSync(sessionFile, sessionAlias);
  writeFileSync(piWrapper, `#!/usr/bin/env bash\nargs=()\nfor a in "$@"; do [[ "$a" == "--no-session" ]] && continue; args+=("$a"); done\nexec "${process.env.PI_SYNC_TEST_PI_BINARY ?? 'pi'}" "\${args[@]}"\n`);
  chmodSync(piWrapper, 0o755);

  const common = {
    brain: script(text('SYNC_ALIAS_ASSISTANT_RESPONSE')),
    extensions: [EXTENSION],
    piProvider: 'pi-mock',
    piModel: 'mock',
    startupTimeoutMs: 20_000,
    terminal: { cols: 100, rows: 32 },
    cwd: root,
    env: { PI_LANE_ROOT: laneRoot, PI_SYNC_POLL_MS: '25', PI_SYNC_HOST_IDLE_MS: '1000' },
    piBinary: piWrapper,
  };

  const a = await createInteractiveMock({ ...common, piArgs: ['--session', sessionAlias] });
  const b = await createInteractiveMock({ ...common, piArgs: ['--session', sessionFile] });
  try {
    a.clearOutput();
    b.clearOutput();
    a.submit('SYNC_ALIAS_USER_PROMPT');
    await a.waitForOutput('SYNC_ALIAS_ASSISTANT_RESPONSE', TIMEOUT);

    await b.waitForOutput('SYNC_ALIAS_USER_PROMPT', TIMEOUT);
    await b.waitForOutput('SYNC_ALIAS_ASSISTANT_RESPONSE', TIMEOUT);

    const hostJsons = findHostJsons(laneRoot);
    assert.equal(hostJsons.length, 1, hostJsons.join('\n'));
    const host = JSON.parse(readFileSync(hostJsons[0], 'utf8'));
    assert.equal(realpathSync(host.sessionFile), realpathSync(sessionFile));
  } finally {
    await a.close();
    await b.close();
    await removeRoot(root);
  }
});

test('pi-sync keeps one sync key when Pi session id changes during startup', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-session-id-churn-'));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'shared.jsonl');
  const piWrapper = join(root, 'pi-wrapper.sh');
  const sessionIdChurnExtension = join(root, 'session-id-churn-extension.ts');
  writeFileSync(sessionFile, '', 'utf8');
  writeFileSync(piWrapper, `#!/usr/bin/env bash\nargs=()\nfor a in "$@"; do [[ "$a" == "--no-session" ]] && continue; args+=("$a"); done\nexec "${process.env.PI_SYNC_TEST_PI_BINARY ?? 'pi'}" "\${args[@]}"\n`);
  chmodSync(piWrapper, 0o755);
  writeFileSync(
    sessionIdChurnExtension,
    `export default function(pi) {
  pi.on("session_start", (_event, ctx) => {
    const original = ctx.sessionManager.getSessionId.bind(ctx.sessionManager);
    let calls = 0;
    ctx.sessionManager.getSessionId = () => {
      calls += 1;
      return calls <= 8 ? "transient-startup-session-id" : (original() || "hydrated-session-id");
    };
  });
}
`,
    'utf8',
  );

  const mock = await createInteractiveMock({
    brain: script(text('SYNC_ID_CHURN_RESPONSE')),
    extensions: [sessionIdChurnExtension, EXTENSION],
    piProvider: 'pi-mock',
    piModel: 'mock',
    startupTimeoutMs: 20_000,
    terminal: { cols: 100, rows: 32 },
    cwd: root,
    env: { PI_LANE_ROOT: laneRoot, PI_SYNC_POLL_MS: '25', PI_SYNC_HOST_IDLE_MS: '1000' },
    piBinary: piWrapper,
    piArgs: ['--session', sessionFile],
  });

  try {
    mock.submit('SYNC_ID_CHURN_PROMPT');
    await mock.waitForOutput('SYNC_ID_CHURN_RESPONSE', TIMEOUT);
    await waitUntil(() => findHostJsons(laneRoot).length >= 1, TIMEOUT, 'host json after session id churn');
    await assertSingleRuntimeDir(laneRoot, 'session id churn');
  } finally {
    await mock.close();
    await removeRoot(root);
  }
});

test('pi-sync shares one runtime when same-session peers report different session ids', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-peer-id-mismatch-'));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'shared.jsonl');
  const piWrapper = join(root, 'pi-wrapper.sh');
  const forcedSessionIdExtension = join(root, 'forced-session-id-extension.ts');
  writeFileSync(sessionFile, '', 'utf8');
  writeFileSync(piWrapper, `#!/usr/bin/env bash\nargs=()\nfor a in "$@"; do [[ "$a" == "--no-session" ]] && continue; args+=("$a"); done\nexec "${process.env.PI_SYNC_TEST_PI_BINARY ?? 'pi'}" "\${args[@]}"\n`);
  chmodSync(piWrapper, 0o755);
  writeFileSync(
    forcedSessionIdExtension,
    `export default function(pi) {
  pi.on("session_start", (_event, ctx) => {
    const forced = process.env.PI_SYNC_TEST_FORCED_SESSION_ID;
    if (forced) ctx.sessionManager.getSessionId = () => forced;
  });
}
`,
    'utf8',
  );

  const common = {
    brain: script(text('SYNC_PEER_ID_MISMATCH_RESPONSE')),
    extensions: [forcedSessionIdExtension, EXTENSION],
    piProvider: 'pi-mock',
    piModel: 'mock',
    startupTimeoutMs: 20_000,
    terminal: { cols: 100, rows: 32 },
    cwd: root,
    env: { PI_LANE_ROOT: laneRoot, PI_SYNC_POLL_MS: '25', PI_SYNC_HOST_IDLE_MS: '1000' },
    piBinary: piWrapper,
    piArgs: ['--session', sessionFile],
  };

  const a = await createInteractiveMock({
    ...common,
    env: { ...common.env, PI_SYNC_TEST_FORCED_SESSION_ID: 'peer-a-transient-id' },
  });
  const b = await createInteractiveMock({
    ...common,
    env: { ...common.env, PI_SYNC_TEST_FORCED_SESSION_ID: 'peer-b-hydrated-id' },
  });
  try {
    a.clearOutput();
    b.clearOutput();
    a.submit('SYNC_PEER_ID_MISMATCH_PROMPT');
    await a.waitForOutput('SYNC_PEER_ID_MISMATCH_RESPONSE', TIMEOUT);
    await b.waitForOutput('SYNC_PEER_ID_MISMATCH_PROMPT', TIMEOUT);
    await b.waitForOutput('SYNC_PEER_ID_MISMATCH_RESPONSE', TIMEOUT);
    await assertSingleRuntimeDir(laneRoot, 'peer session id mismatch');
  } finally {
    await a.close();
    await b.close();
    await removeRoot(root);
  }
});

test('pi-sync ignores stale inherited sync keys for a different session file', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-stale-env-key-'));
  const laneRoot = join(root, 'lane');
  const staleSessionFile = join(root, 'stale.jsonl');
  const sessionFile = join(root, 'shared.jsonl');
  const piWrapper = join(root, 'pi-wrapper.sh');
  writeFileSync(staleSessionFile, '', 'utf8');
  writeFileSync(sessionFile, '', 'utf8');
  writeFileSync(piWrapper, `#!/usr/bin/env bash\nargs=()\nfor a in "$@"; do [[ "$a" == "--no-session" ]] && continue; args+=("$a"); done\nexec "${process.env.PI_SYNC_TEST_PI_BINARY ?? 'pi'}" "\${args[@]}"\n`);
  chmodSync(piWrapper, 0o755);

  const common = {
    brain: script(text('SYNC_STALE_ENV_RESPONSE')),
    extensions: [EXTENSION],
    piProvider: 'pi-mock',
    piModel: 'mock',
    startupTimeoutMs: 20_000,
    terminal: { cols: 100, rows: 32 },
    cwd: root,
    env: { PI_LANE_ROOT: laneRoot, PI_SYNC_POLL_MS: '25', PI_SYNC_HOST_IDLE_MS: '1000' },
    piBinary: piWrapper,
    piArgs: ['--session', sessionFile],
  };

  const staleKeyEnv = {
    PI_SYNC_SESSION_KEY: 'stale-inherited-key',
    PI_SYNC_SESSION_FILE: realpathSync(staleSessionFile),
    PI_LANE_SESSION_KEY: 'stale-inherited-key',
    PI_LANE_SESSION_FILE: realpathSync(staleSessionFile),
  };
  const a = await createInteractiveMock({ ...common, env: { ...common.env, ...staleKeyEnv } });
  const b = await createInteractiveMock(common);
  try {
    a.clearOutput();
    b.clearOutput();
    a.submit('SYNC_STALE_ENV_PROMPT');
    await a.waitForOutput('SYNC_STALE_ENV_RESPONSE', TIMEOUT);
    await b.waitForOutput('SYNC_STALE_ENV_PROMPT', TIMEOUT);
    await b.waitForOutput('SYNC_STALE_ENV_RESPONSE', TIMEOUT);
    const runtimeDir = await assertSingleRuntimeDir(laneRoot, 'stale inherited sync key');
    assert.doesNotMatch(runtimeDir, /stale-inherited-key/, runtimeDir);
  } finally {
    await a.close();
    await b.close();
    await removeRoot(root);
  }
});

test('pi-sync shares one runtime across alias paths and different peer session ids', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-alias-id-mismatch-'));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'shared.jsonl');
  const sessionAlias = join(root, 'shared-alias.jsonl');
  const piWrapper = join(root, 'pi-wrapper.sh');
  const forcedSessionIdExtension = join(root, 'forced-session-id-extension.ts');
  writeFileSync(sessionFile, '', 'utf8');
  symlinkSync(sessionFile, sessionAlias);
  writeFileSync(piWrapper, `#!/usr/bin/env bash\nargs=()\nfor a in "$@"; do [[ "$a" == "--no-session" ]] && continue; args+=("$a"); done\nexec "${process.env.PI_SYNC_TEST_PI_BINARY ?? 'pi'}" "\${args[@]}"\n`);
  chmodSync(piWrapper, 0o755);
  writeFileSync(
    forcedSessionIdExtension,
    `export default function(pi) {
  pi.on("session_start", (_event, ctx) => {
    const forced = process.env.PI_SYNC_TEST_FORCED_SESSION_ID;
    if (forced) ctx.sessionManager.getSessionId = () => forced;
  });
}
`,
    'utf8',
  );

  const common = {
    brain: script(text('SYNC_ALIAS_ID_RESPONSE')),
    extensions: [forcedSessionIdExtension, EXTENSION],
    piProvider: 'pi-mock',
    piModel: 'mock',
    startupTimeoutMs: 20_000,
    terminal: { cols: 100, rows: 32 },
    cwd: root,
    env: { PI_LANE_ROOT: laneRoot, PI_SYNC_POLL_MS: '25', PI_SYNC_HOST_IDLE_MS: '1000' },
    piBinary: piWrapper,
  };

  const a = await createInteractiveMock({
    ...common,
    env: { ...common.env, PI_SYNC_TEST_FORCED_SESSION_ID: 'alias-peer-id' },
    piArgs: ['--session', sessionAlias],
  });
  const b = await createInteractiveMock({
    ...common,
    env: { ...common.env, PI_SYNC_TEST_FORCED_SESSION_ID: 'realpath-peer-id' },
    piArgs: ['--session', sessionFile],
  });
  try {
    a.clearOutput();
    b.clearOutput();
    a.submit('SYNC_ALIAS_ID_PROMPT');
    await a.waitForOutput('SYNC_ALIAS_ID_RESPONSE', TIMEOUT);
    await b.waitForOutput('SYNC_ALIAS_ID_PROMPT', TIMEOUT);
    await b.waitForOutput('SYNC_ALIAS_ID_RESPONSE', TIMEOUT);
    await assertSingleRuntimeDir(laneRoot, 'alias path plus session id mismatch');
    const hostJsons = findHostJsons(laneRoot);
    assert.equal(hostJsons.length, 1, hostJsons.join('\n'));
    const host = JSON.parse(readFileSync(hostJsons[0], 'utf8'));
    assert.equal(realpathSync(host.sessionFile), realpathSync(sessionFile));
  } finally {
    await a.close();
    await b.close();
    await removeRoot(root);
  }
});

test('pi-sync switches tree navigation to a separate sync lane without dragging main', { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-tree-branch-'));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'shared.jsonl');
  const piWrapper = join(root, 'pi-wrapper.sh');
  const helperExt = join(root, 'tree-nav-helper.mjs');
  writeFileSync(sessionFile, '', 'utf8');
  writeFileSync(helperExt, `
export default function treeNavHelper(pi) {
  pi.registerCommand("_tree_nav_to_text", {
    description: "Navigate to the first message whose text matches args",
    handler: async (args, ctx) => {
      const wanted = args.trim();
      const file = ctx.sessionManager.getSessionFile();
      if (file) ctx.sessionManager.setSessionFile(file);
      const entry = ctx.sessionManager.getEntries().find((item) => {
        const content = item.message?.content;
        return content === wanted || (Array.isArray(content) && content.some((part) => part.type === "text" && part.text === wanted));
      });
      if (!entry) throw new Error("entry not found: " + wanted);
      await ctx.navigateTree(entry.id);
      ctx.ui.notify("leaf_after_nav:" + ctx.sessionManager.getLeafId(), "info");
    },
  });
}
`, 'utf8');
  writeFileSync(piWrapper, `#!/usr/bin/env bash\nargs=()\nfor a in "$@"; do [[ "$a" == "--no-session" ]] && continue; args+=("$a"); done\nexec "${process.env.PI_SYNC_TEST_PI_BINARY ?? 'pi'}" "\${args[@]}"\n`);
  chmodSync(piWrapper, 0o755);

  const common = {
    brain: script(
      text('SYNC_TREE_BASE_ANSWER'),
      text('SYNC_TREE_SECOND_ANSWER'),
      text('SYNC_TREE_BRANCH_ANSWER'),
    ),
    extensions: [EXTENSION, helperExt],
    piProvider: 'pi-mock',
    piModel: 'mock',
    startupTimeoutMs: 20_000,
    terminal: { cols: 100, rows: 36 },
    cwd: root,
    env: { PI_LANE_ROOT: laneRoot, PI_SYNC_POLL_MS: '25', PI_SYNC_HOST_IDLE_MS: '1000' },
    piBinary: piWrapper,
    piArgs: ['--session', sessionFile],
  };

  const a = await createInteractiveMock(common);
  const b = await createInteractiveMock(common);
  try {
    a.submit('SYNC_TREE_BASE_PROMPT');
    await a.waitForOutput('SYNC_TREE_BASE_ANSWER', TIMEOUT);
    await b.waitForOutput('SYNC_TREE_BASE_ANSWER', TIMEOUT);

    a.submit('SYNC_TREE_SECOND_PROMPT');
    await a.waitForOutput('SYNC_TREE_SECOND_ANSWER', TIMEOUT);
    await b.waitForOutput('SYNC_TREE_SECOND_ANSWER', TIMEOUT);
    await waitForMessageEntry(sessionFile, 'SYNC_TREE_SECOND_ANSWER');

    b.submit('/_tree_nav_to_text SYNC_TREE_BASE_ANSWER');
    await b.waitForOutput('leaf_after_nav:', TIMEOUT);
    b.submit('/sync status');
    await b.waitForOutput(/sync=~\/2 ln_[A-Za-z0-9_-]+/, TIMEOUT);
    a.submit('/sync status');
    await a.waitForOutput(/sync=~\/1 ln_[A-Za-z0-9_-]+/, TIMEOUT);

    a.clearOutput();
    b.clearOutput();
    b.submit('SYNC_TREE_BRANCH_PROMPT');
    await b.waitForOutput('SYNC_TREE_BRANCH_ANSWER', TIMEOUT);
    await new Promise((resolve) => setTimeout(resolve, 1000));

    assert.doesNotMatch(a.output, /SYNC_TREE_BRANCH_PROMPT|SYNC_TREE_BRANCH_ANSWER/, 'main lane terminal must not mirror tree-lane prompt');

    const sessionDirs = readdirSync(join(laneRoot, 'sessions'));
    const lanes = sessionDirs.flatMap((sessionDir) => readdirSync(join(laneRoot, 'sessions', sessionDir, 'lanes')));
    assert.ok(lanes.includes('main.json'), lanes.join('\n'));
    assert.ok(lanes.some((item) => item.startsWith('ln_') && item.endsWith('.json')), lanes.join('\n'));

    const baseAnswer = findMessageEntry(sessionFile, 'SYNC_TREE_BASE_ANSWER');
    const secondAnswer = findMessageEntry(sessionFile, 'SYNC_TREE_SECOND_ANSWER');
    const branchPrompt = findMessageEntry(sessionFile, 'SYNC_TREE_BRANCH_PROMPT');
    assert.equal(branchPrompt.parentId, baseAnswer.id, 'branch prompt should be appended under the selected tree leaf');
    assert.notEqual(branchPrompt.parentId, secondAnswer.id, 'branch prompt must not append to the previous main tail');
    const branchAnswer = findMessageEntry(sessionFile, 'SYNC_TREE_BRANCH_ANSWER');
    const states = readLaneStates(laneRoot);
    const mainLane = states.find((item) => item.name === 'main');
    const treeLane = states.find((item) => item.name !== 'main');
    assert.equal(mainLane?.headEntryId, secondAnswer.id, 'main lane head should stay on the original main tail');
    assert.equal(treeLane?.baseLeafId, baseAnswer.id, 'tree lane should be based at the selected tree leaf');
    assert.equal(treeLane?.headEntryId, branchAnswer.id, 'tree lane head should advance with the branch response');
  } finally {
    await a.close();
    await b.close();
    await removeRoot(root);
  }
});

test('pi-sync keeps a forked tree path on its auto lane until explicit lane switch', { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-alternate-branch-main-'));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'shared.jsonl');
  const piWrapper = join(root, 'pi-wrapper.sh');
  const helperExt = join(root, 'tree-nav-helper.mjs');
  writeFileSync(sessionFile, '', 'utf8');
  writeFileSync(helperExt, `
export default function treeNavHelper(pi) {
  pi.registerCommand("_tree_nav_to_text", {
    description: "Navigate to the first message whose text matches args",
    handler: async (args, ctx) => {
      const wanted = args.trim();
      const file = ctx.sessionManager.getSessionFile();
      if (file) ctx.sessionManager.setSessionFile(file);
      const entry = ctx.sessionManager.getEntries().find((item) => {
        const content = item.message?.content;
        return Array.isArray(content) && content.some((part) => part.type === "text" && part.text === wanted);
      });
      if (!entry) throw new Error("entry not found: " + wanted);
      await ctx.navigateTree(entry.id);
      ctx.ui.notify("leaf_after_nav:" + ctx.sessionManager.getLeafId(), "info");
    },
  });
}
`, 'utf8');
  writeFileSync(piWrapper, `#!/usr/bin/env bash\nargs=()\nfor a in "$@"; do [[ "$a" == "--no-session" ]] && continue; args+=("$a"); done\nexec "${process.env.PI_SYNC_TEST_PI_BINARY ?? 'pi'}" "\${args[@]}"\n`);
  chmodSync(piWrapper, 0o755);

  const brain = createControllableBrain();
  async function respondToPrompt(promptText, responseText) {
    const call = await brain.waitForCall(TIMEOUT);
    assert.match(JSON.stringify(call.request), new RegExp(promptText), `expected provider request for ${promptText}`);
    call.respond(text(responseText));
  }

  const common = {
    brain: brain.brain,
    extensions: [EXTENSION, helperExt],
    piProvider: 'pi-mock',
    piModel: 'mock',
    startupTimeoutMs: 20_000,
    terminal: { cols: 100, rows: 40 },
    cwd: root,
    env: { PI_LANE_ROOT: laneRoot, PI_SYNC_POLL_MS: '25', PI_SYNC_HOST_IDLE_MS: '1000' },
    piBinary: piWrapper,
    piArgs: ['--session', sessionFile],
  };

  const main = await createInteractiveMock(common);
  const branch = await createInteractiveMock(common);
  try {
    main.submit('SYNC_ALT_BASE_PROMPT');
    await respondToPrompt('SYNC_ALT_BASE_PROMPT', 'SYNC_ALT_BASE_ANSWER');
    await main.waitForOutput('SYNC_ALT_BASE_ANSWER', TIMEOUT);
    await branch.waitForOutput('SYNC_ALT_BASE_ANSWER', TIMEOUT);
    await waitForMessageEntry(sessionFile, 'SYNC_ALT_BASE_ANSWER');

    main.submit('SYNC_ALT_MAIN_SECOND_PROMPT');
    await respondToPrompt('SYNC_ALT_MAIN_SECOND_PROMPT', 'SYNC_ALT_MAIN_SECOND_ANSWER');
    await main.waitForOutput('SYNC_ALT_MAIN_SECOND_ANSWER', TIMEOUT);
    await branch.waitForOutput('SYNC_ALT_MAIN_SECOND_ANSWER', TIMEOUT);
    await waitForMessageEntry(sessionFile, 'SYNC_ALT_MAIN_SECOND_ANSWER');

    const navStart = Date.now();
    while (Date.now() - navStart < TIMEOUT) {
      branch.submit('/_tree_nav_to_text SYNC_ALT_BASE_ANSWER');
      if (await waitUntilQuiet(() => branch.output.includes('leaf_after_nav:'), 5_000)) break;
      branch.clearOutput();
    }
    await branch.waitForOutput('leaf_after_nav:', TIMEOUT);
    branch.submit('/sync status');
    await branch.waitForOutput(/sync=~\/2 ln_[A-Za-z0-9_-]+/, TIMEOUT);
    main.submit('/sync status');
    await main.waitForOutput(/sync=~\/1 ln_[A-Za-z0-9_-]+/, TIMEOUT);

    main.clearOutput();
    branch.clearOutput();
    branch.submit('SYNC_ALT_BRANCH_ONE_PROMPT');
    await respondToPrompt('SYNC_ALT_BRANCH_ONE_PROMPT', 'SYNC_ALT_BRANCH_ONE_ANSWER');
    await branch.waitForOutput('SYNC_ALT_BRANCH_ONE_ANSWER', TIMEOUT);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.doesNotMatch(main.output, /SYNC_ALT_BRANCH_ONE_PROMPT|SYNC_ALT_BRANCH_ONE_ANSWER/);
    await waitForMessageEntries(sessionFile, 'SYNC_ALT_BRANCH_ONE_ANSWER');
    await waitUntil(
      () => {
        const treeLane = readLaneStates(laneRoot).find((item) => item.name !== 'main');
        if (!treeLane) return false;
        const branchOneAnswers = findMessageEntries(sessionFile, 'SYNC_ALT_BRANCH_ONE_ANSWER');
        return branchOneAnswers.some((entry) => treeLane.headEntryId === entry.id);
      },
      TIMEOUT,
      'tree lane head after first branch prompt',
    );

    branch.clearOutput();
    branch.submit('SYNC_ALT_BRANCH_TWO_PROMPT');
    await respondToPrompt('SYNC_ALT_BRANCH_TWO_PROMPT', 'SYNC_ALT_BRANCH_TWO_ANSWER');
    await branch.waitForOutput('SYNC_ALT_BRANCH_TWO_ANSWER', TIMEOUT);
    await waitForMessageEntries(sessionFile, 'SYNC_ALT_BRANCH_TWO_ANSWER');
    await waitUntil(
      () => {
        const treeLane = readLaneStates(laneRoot).find((item) => item.name !== 'main');
        if (!treeLane) return false;
        const branchTwoAnswers = findMessageEntries(sessionFile, 'SYNC_ALT_BRANCH_TWO_ANSWER');
        return branchTwoAnswers.some((entry) => treeLane.headEntryId === entry.id);
      },
      TIMEOUT,
      'tree lane head after second branch prompt',
    );

    main.clearOutput();
    main.submit('SYNC_ALT_MAIN_AFTER_BRANCH_PROMPT');
    await respondToPrompt('SYNC_ALT_MAIN_AFTER_BRANCH_PROMPT', 'SYNC_ALT_MAIN_AFTER_BRANCH_ANSWER');
    await main.waitForOutput('SYNC_ALT_MAIN_AFTER_BRANCH_ANSWER', TIMEOUT);
    await waitForMessageEntry(sessionFile, 'SYNC_ALT_MAIN_AFTER_BRANCH_ANSWER');

    const baseAnswer = findMessageEntry(sessionFile, 'SYNC_ALT_BASE_ANSWER');
    const mainSecondAnswer = findMessageEntry(sessionFile, 'SYNC_ALT_MAIN_SECOND_ANSWER');
    const branchOnePrompt = findMessageEntry(sessionFile, 'SYNC_ALT_BRANCH_ONE_PROMPT');
    const branchOneAnswers = findMessageEntries(sessionFile, 'SYNC_ALT_BRANCH_ONE_ANSWER');
    const branchTwoPrompt = findMessageEntry(sessionFile, 'SYNC_ALT_BRANCH_TWO_PROMPT');
    const branchTwoAnswers = findMessageEntries(sessionFile, 'SYNC_ALT_BRANCH_TWO_ANSWER');
    const mainAfterBranchPrompt = findMessageEntry(sessionFile, 'SYNC_ALT_MAIN_AFTER_BRANCH_PROMPT');
    const mainAfterBranchAnswer = findMessageEntry(sessionFile, 'SYNC_ALT_MAIN_AFTER_BRANCH_ANSWER');

    assert.equal(branchOnePrompt.parentId, baseAnswer.id, 'first branch prompt should start from selected tree leaf');
    assert.ok(branchOneAnswers.some((entry) => branchTwoPrompt.parentId === entry.id), 'second branch prompt should continue from previous branch answer');
    assert.equal(mainAfterBranchPrompt.parentId, mainSecondAnswer.id, 'main lane should continue from the original main tail');
    assert.ok(branchTwoAnswers.every((entry) => mainAfterBranchPrompt.parentId !== entry.id), 'main lane must not continue from the tree lane');

    await waitUntil(
      () => {
        const mainLanePath = findLaneStatePath(laneRoot);
        if (!mainLanePath) return false;
        const mainLane = JSON.parse(readFileSync(mainLanePath, 'utf8'));
        return mainLane.headEntryId === mainAfterBranchAnswer.id;
      },
      TIMEOUT,
      'main lane head update',
    );
    const mainLanePath = findLaneStatePath(laneRoot);
    assert.ok(mainLanePath, 'expected main lane state file');
    const mainLane = JSON.parse(readFileSync(mainLanePath, 'utf8'));
    assert.equal(mainLane.headEntryId, mainAfterBranchAnswer.id, 'main lane head should advance along the main path');
    const treeLane = readLaneStates(laneRoot).find((item) => item.name !== 'main');
    assert.ok(treeLane, 'expected auto tree lane state');
    assert.ok(branchTwoAnswers.some((entry) => treeLane.headEntryId === entry.id), 'tree lane head should remain on latest tree branch');
    assertNoHiddenBranchLanes(laneRoot);
  } finally {
    await main.close();
    await branch.close();
    await removeRoot(root);
  }
});

test('pi-sync keeps same-lane session trees on the shared lane head and marks live lane positions', { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-tree-head-marker-'));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'shared.jsonl');
  const piWrapper = join(root, 'pi-wrapper.sh');
  const helperExt = join(root, 'tree-head-helper.mjs');
  writeFileSync(sessionFile, '', 'utf8');
  writeFileSync(helperExt, `
export default function treeHeadHelper(pi) {
  pi.registerCommand("_tree_nav_to_text", {
    description: "Navigate to the first message whose text matches args",
    handler: async (args, ctx) => {
      const wanted = args.trim();
      const file = ctx.sessionManager.getSessionFile();
      if (file) ctx.sessionManager.setSessionFile(file);
      const entry = ctx.sessionManager.getEntries().find((item) => {
        const content = item.message?.content;
        return Array.isArray(content) && content.some((part) => part.type === "text" && part.text === wanted);
      });
      if (!entry) throw new Error("entry not found: " + wanted);
      await ctx.navigateTree(entry.id);
      ctx.ui.notify("leaf_after_nav:" + ctx.sessionManager.getLeafId(), "info");
    },
  });
  pi.registerCommand("_leaf_text", {
    description: "Print the current leaf message text",
    handler: async (_args, ctx) => {
      const leafId = ctx.sessionManager.getLeafId();
      const entry = ctx.sessionManager.getEntries().find((item) => item.id === leafId);
      const content = entry?.message?.content;
      const text = Array.isArray(content)
        ? content.filter((part) => part?.type === "text").map((part) => part.text).join("")
        : "";
      ctx.ui.notify("leaf_text:" + text, "info");
    },
  });
  pi.registerCommand("_tree_markers", {
    description: "Print pi-sync tree marker env",
    handler: async (_args, ctx) => {
      const raw = process.env.PI_SYNC_TREE_MARKERS || "";
      let readable = "";
      try {
        const markers = JSON.parse(raw || "{}");
        readable = Object.entries(markers).map(([id, label]) => {
          const entry = ctx.sessionManager.getEntries().find((item) => item.id === id);
          const content = entry?.message?.content;
          const text = Array.isArray(content)
            ? content.filter((part) => part?.type === "text").map((part) => part.text).join("")
            : "";
          return label + ":" + text;
        }).join("|");
      } catch {}
      ctx.ui.notify("tree_markers:" + (raw || "<empty>") + " readable:" + readable, "info");
    },
  });
}
`, 'utf8');
  writeFileSync(piWrapper, `#!/usr/bin/env bash\nargs=()\nfor a in "$@"; do [[ "$a" == "--no-session" ]] && continue; args+=("$a"); done\nexec "${process.env.PI_SYNC_TEST_PI_BINARY ?? 'pi'}" "\${args[@]}"\n`);
  chmodSync(piWrapper, 0o755);

  const brain = createControllableBrain();
  async function respondToPrompt(promptText, responseText) {
    const call = await brain.waitForCall(TIMEOUT);
    assert.match(JSON.stringify(call.request), new RegExp(promptText), `expected provider request for ${promptText}`);
    call.respond(text(responseText));
  }

  const common = {
    brain: brain.brain,
    extensions: [EXTENSION, helperExt],
    piProvider: 'pi-mock',
    piModel: 'mock',
    startupTimeoutMs: 20_000,
    terminal: { cols: 140, rows: 42 },
    cwd: root,
    env: { PI_LANE_ROOT: laneRoot, PI_SYNC_POLL_MS: '25', PI_SYNC_HOST_IDLE_MS: '1000' },
    piBinary: piWrapper,
    piArgs: ['--session', sessionFile],
  };

  const a = await createInteractiveMock(common);
  const b = await createInteractiveMock(common);
  try {
    a.submit('SYNC_MARKER_BASE_PROMPT');
    await respondToPrompt('SYNC_MARKER_BASE_PROMPT', 'SYNC_MARKER_BASE_ANSWER');
    await a.waitForOutput('SYNC_MARKER_BASE_ANSWER', TIMEOUT);
    await b.waitForOutput('SYNC_MARKER_BASE_ANSWER', TIMEOUT);

    a.submit('SYNC_MARKER_MAIN_PROMPT');
    await respondToPrompt('SYNC_MARKER_MAIN_PROMPT', 'SYNC_MARKER_MAIN_ANSWER');
    await a.waitForOutput('SYNC_MARKER_MAIN_ANSWER', TIMEOUT);
    await b.waitForOutput('SYNC_MARKER_MAIN_ANSWER', TIMEOUT);
    await waitForMessageEntry(sessionFile, 'SYNC_MARKER_MAIN_ANSWER');

    b.submit('/_tree_nav_to_text SYNC_MARKER_BASE_ANSWER');
    await b.waitForOutput('leaf_after_nav:', TIMEOUT);
    b.submit('/lane status');
    await b.waitForOutput(/current ~\/2 ln_[A-Za-z0-9_-]+/, TIMEOUT);

    a.submit('/lane join 2');
    await a.waitForOutput(/joined ln_[A-Za-z0-9_-]+ -> now ~\/1 ln_[A-Za-z0-9_-]+/, TIMEOUT);
    a.clearOutput();
    a.submit('/_leaf_text');
    await a.waitForOutput('leaf_text:SYNC_MARKER_BASE_ANSWER', TIMEOUT);

    a.clearOutput();
    b.clearOutput();
    b.submit('SYNC_MARKER_BRANCH_PROMPT');
    await respondToPrompt('SYNC_MARKER_BRANCH_PROMPT', 'SYNC_MARKER_BRANCH_ANSWER');
    await b.waitForOutput('SYNC_MARKER_BRANCH_ANSWER', TIMEOUT);
    await a.waitForOutput('SYNC_MARKER_BRANCH_ANSWER', TIMEOUT);
    await waitForMessageEntry(sessionFile, 'SYNC_MARKER_BRANCH_ANSWER');

    a.clearOutput();
    a.submit('/_leaf_text');
    await a.waitForOutput('leaf_text:SYNC_MARKER_BRANCH_ANSWER', TIMEOUT);

    b.clearOutput();
    b.submit('/_leaf_text');
    await b.waitForOutput('leaf_text:SYNC_MARKER_BRANCH_ANSWER', TIMEOUT);

    a.clearOutput();
    a.submit('/_tree_markers');
    await a.waitForOutput('tree_markers:', TIMEOUT);
    assert.doesNotMatch(a.output, /tree_markers:<empty>/, a.output);
    assert.match(a.output, /1:SYNC_MARKER_BRANCH_ANSWER/, a.output);
    assert.doesNotMatch(a.output, /2:SYNC_MARKER_BRANCH_ANSWER/, a.output);

    a.clearOutput();
    b.clearOutput();
    a.submit('/tree');
    b.submit('/tree');
    const screenA = await waitForVisibleText(a, /›\s+1[\s\S]*•\s+assistant:\s+SYNC_MARKER_BRANCH_ANSWER/, TIMEOUT, 'terminal A selected tree head marker');
    const screenB = await waitForVisibleText(b, /›\s+1[\s\S]*•\s+assistant:\s+SYNC_MARKER_BRANCH_ANSWER/, TIMEOUT, 'terminal B selected tree head marker');
    assert.doesNotMatch(screenA, /›\s+2[\s\S]*•\s+assistant:\s+SYNC_MARKER_BRANCH_ANSWER/, screenA);
    assert.doesNotMatch(screenB, /›\s+2[\s\S]*•\s+assistant:\s+SYNC_MARKER_BRANCH_ANSWER/, screenB);
  } finally {
    await a.close();
    await b.close();
    await removeRoot(root);
  }
});

test('pi-sync keeps tree lane display ids compact after stale tree aliases', { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-tree-display-id-'));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'shared.jsonl');
  const piWrapper = join(root, 'pi-wrapper.sh');
  const helperExt = join(root, 'tree-nav-helper.mjs');
  writeFileSync(sessionFile, '', 'utf8');
  writeFileSync(helperExt, `
export default function treeNavHelper(pi) {
  pi.registerCommand("_tree_nav_to_text", {
    description: "Navigate to the first message whose text matches args",
    handler: async (args, ctx) => {
      const wanted = args.trim();
      const file = ctx.sessionManager.getSessionFile();
      if (file) ctx.sessionManager.setSessionFile(file);
      const entry = ctx.sessionManager.getEntries().find((item) => {
        const content = item.message?.content;
        return Array.isArray(content) && content.some((part) => part.type === "text" && part.text === wanted);
      });
      if (!entry) throw new Error("entry not found: " + wanted);
      await ctx.navigateTree(entry.id);
      ctx.ui.notify("leaf_after_nav:" + ctx.sessionManager.getLeafId(), "info");
    },
  });
  pi.registerCommand("_tree_markers", {
    description: "Print pi-sync tree marker env",
    handler: async (_args, ctx) => {
      const raw = process.env.PI_SYNC_TREE_MARKERS || "";
      let readable = "";
      try {
        const markers = JSON.parse(raw || "{}");
        readable = Object.entries(markers).map(([id, label]) => {
          const entry = ctx.sessionManager.getEntries().find((item) => item.id === id);
          const content = entry?.message?.content;
          const text = Array.isArray(content)
            ? content.filter((part) => part?.type === "text").map((part) => part.text).join("")
            : "";
          return label + ":" + text;
        }).join("|");
      } catch {}
      ctx.ui.notify("tree_markers:" + (raw || "<empty>") + " readable:" + readable, "info");
    },
  });
}
`, 'utf8');
  writeFileSync(piWrapper, `#!/usr/bin/env bash\nargs=()\nfor a in "$@"; do [[ "$a" == "--no-session" ]] && continue; args+=("$a"); done\nexec "${process.env.PI_SYNC_TEST_PI_BINARY ?? 'pi'}" "\${args[@]}"\n`);
  chmodSync(piWrapper, 0o755);

  const mock = await createInteractiveMock({
    brain: script(
      text('SYNC_DISPLAY_ONE_ANSWER'),
      text('SYNC_DISPLAY_TWO_ANSWER'),
      text('SYNC_DISPLAY_THREE_ANSWER'),
    ),
    extensions: [EXTENSION, helperExt],
    piProvider: 'pi-mock',
    piModel: 'mock',
    startupTimeoutMs: 20_000,
    terminal: { cols: 120, rows: 40 },
    cwd: root,
    env: { PI_LANE_ROOT: laneRoot, PI_SYNC_POLL_MS: '25', PI_SYNC_HOST_IDLE_MS: '1000' },
    piBinary: piWrapper,
    piArgs: ['--session', sessionFile],
  });

  try {
    mock.submit('SYNC_DISPLAY_ONE_PROMPT');
    await mock.waitForOutput('SYNC_DISPLAY_ONE_ANSWER', TIMEOUT);
    mock.submit('SYNC_DISPLAY_TWO_PROMPT');
    await mock.waitForOutput('SYNC_DISPLAY_TWO_ANSWER', TIMEOUT);
    mock.submit('SYNC_DISPLAY_THREE_PROMPT');
    await mock.waitForOutput('SYNC_DISPLAY_THREE_ANSWER', TIMEOUT);
    await waitForMessageEntry(sessionFile, 'SYNC_DISPLAY_THREE_ANSWER');

    mock.clearOutput();
    mock.submit('/_tree_nav_to_text SYNC_DISPLAY_ONE_ANSWER');
    await mock.waitForOutput('leaf_after_nav:', TIMEOUT);
    mock.clearOutput();
    mock.submit('/_tree_markers');
    await mock.waitForOutput(/1:SYNC_DISPLAY_ONE_ANSWER/, TIMEOUT);
    assert.doesNotMatch(mock.output, /1:SYNC_DISPLAY_THREE_ANSWER/, mock.output);
    mock.clearOutput();
    mock.submit('/tree');
    const treeOnLane1 = await waitForVisibleText(mock, 'SYNC_DISPLAY_ONE_ANSWER', TIMEOUT, 'visible tree marker on lone tree lane head');
    assert.match(lineContaining(treeOnLane1, 'assistant: SYNC_DISPLAY_ONE_ANSWER'), /\b1\b/, treeOnLane1);
    assert.doesNotMatch(lineContaining(treeOnLane1, 'assistant: SYNC_DISPLAY_ONE_ANSWER'), /\b2\b/);
    assert.doesNotMatch(lineContaining(treeOnLane1, 'assistant: SYNC_DISPLAY_THREE_ANSWER'), /\b1\b/);
    mock.sendKey('escape');
    await waitUntilQuiet(async () => !(await visibleText(mock)).includes('Session Tree'), TIMEOUT);
    mock.clearOutput();
    mock.submit('/lane identity');
    await mock.waitForOutput(/lane=~\/1 ln_[A-Za-z0-9_-]+/, TIMEOUT);
    assert.doesNotMatch(mock.output, /lane=~\/2/, mock.output);

    mock.clearOutput();
    const mainLane = readLaneStates(laneRoot).find((item) => item.name === 'main');
    assert.ok(mainLane?.id, 'expected canonical id for initial lane');
    mock.submit(`/lane join ${mainLane.id}`);
    await mock.waitForOutput(/joined ln_[A-Za-z0-9_-]+ -> now ~\/1 ln_[A-Za-z0-9_-]+/, TIMEOUT);
    mock.clearOutput();
    mock.submit('/_tree_markers');
    await mock.waitForOutput(/1:SYNC_DISPLAY_THREE_ANSWER/, TIMEOUT);
    assert.doesNotMatch(mock.output, /2:SYNC_DISPLAY_ONE_ANSWER/, mock.output);
    mock.clearOutput();
    mock.submit('/tree');
    const treeBackOnMain = await waitForVisibleText(mock, 'SYNC_DISPLAY_THREE_ANSWER', TIMEOUT, 'visible tree marker after joining main');
    assert.match(lineContaining(treeBackOnMain, 'assistant: SYNC_DISPLAY_THREE_ANSWER'), /\b1\b/, treeBackOnMain);
    assert.doesNotMatch(lineContaining(treeBackOnMain, 'assistant: SYNC_DISPLAY_ONE_ANSWER'), /\b2\b/);
    mock.sendKey('escape');
    await waitUntilQuiet(async () => !(await visibleText(mock)).includes('Session Tree'), TIMEOUT);
    mock.clearOutput();
    mock.submit('/_tree_nav_to_text SYNC_DISPLAY_TWO_ANSWER');
    await mock.waitForOutput('leaf_after_nav:', TIMEOUT);
    mock.clearOutput();
    mock.submit('/lane identity');
    await mock.waitForOutput(/lane=~\/1 ln_[A-Za-z0-9_-]+/, TIMEOUT);
    assert.doesNotMatch(mock.output, /lane=~\/2|lane=~\/3/, mock.output);
  } finally {
    await mock.close();
    await removeRoot(root);
  }
});

test('pi-sync removes visible tree markers for disconnected lanes', { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-tree-marker-disconnect-'));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'shared.jsonl');
  const piWrapper = join(root, 'pi-wrapper.sh');
  const helperExt = join(root, 'tree-nav-helper.mjs');
  writeFileSync(sessionFile, '', 'utf8');
  writeFileSync(helperExt, `
export default function treeNavHelper(pi) {
  pi.registerCommand("_tree_nav_to_text", {
    description: "Navigate to the first message whose text matches args",
    handler: async (args, ctx) => {
      const wanted = args.trim();
      const file = ctx.sessionManager.getSessionFile();
      if (file) ctx.sessionManager.setSessionFile(file);
      const entry = ctx.sessionManager.getEntries().find((item) => {
        const content = item.message?.content;
        return Array.isArray(content) && content.some((part) => part.type === "text" && part.text === wanted);
      });
      if (!entry) throw new Error("entry not found: " + wanted);
      await ctx.navigateTree(entry.id);
      ctx.ui.notify("leaf_after_nav:" + ctx.sessionManager.getLeafId(), "info");
    },
  });
}
`, 'utf8');
  writeFileSync(piWrapper, `#!/usr/bin/env bash\nargs=()\nfor a in "$@"; do [[ "$a" == "--no-session" ]] && continue; args+=("$a"); done\nexec "${process.env.PI_SYNC_TEST_PI_BINARY ?? 'pi'}" "\${args[@]}"\n`);
  chmodSync(piWrapper, 0o755);

  const common = {
    brain: script(
      text('SYNC_DISCONNECT_BASE_ANSWER'),
      text('SYNC_DISCONNECT_MAIN_ANSWER'),
    ),
    extensions: [EXTENSION, helperExt],
    piProvider: 'pi-mock',
    piModel: 'mock',
    startupTimeoutMs: 20_000,
    terminal: { cols: 140, rows: 42 },
    cwd: root,
    env: {
      PI_LANE_ROOT: laneRoot,
      PI_SYNC_POLL_MS: '25',
      PI_SYNC_HOST_IDLE_MS: '1000',
      PI_SYNC_INSTANCE_STALE_MS: '250',
      PI_LANE_HEARTBEAT_MS: '250',
    },
    piBinary: piWrapper,
    piArgs: ['--session', sessionFile],
  };

  const main = await createInteractiveMock(common);
  const branch = await createInteractiveMock(common);
  try {
    main.submit('SYNC_DISCONNECT_BASE_PROMPT');
    await main.waitForOutput('SYNC_DISCONNECT_BASE_ANSWER', TIMEOUT);
    await branch.waitForOutput('SYNC_DISCONNECT_BASE_ANSWER', TIMEOUT);
    main.submit('SYNC_DISCONNECT_MAIN_PROMPT');
    await main.waitForOutput('SYNC_DISCONNECT_MAIN_ANSWER', TIMEOUT);
    await branch.waitForOutput('SYNC_DISCONNECT_MAIN_ANSWER', TIMEOUT);
    await waitForMessageEntry(sessionFile, 'SYNC_DISCONNECT_MAIN_ANSWER');

    branch.submit('/_tree_nav_to_text SYNC_DISCONNECT_BASE_ANSWER');
    await branch.waitForOutput('leaf_after_nav:', TIMEOUT);
    branch.clearOutput();
    branch.submit('/tree');
    const withPeer = await waitForVisibleText(branch, 'SYNC_DISCONNECT_MAIN_ANSWER', TIMEOUT, 'tree marker while main peer is live');
    assert.match(lineContaining(withPeer, 'assistant: SYNC_DISCONNECT_BASE_ANSWER'), /\b2\b/, withPeer);
    assert.match(lineContaining(withPeer, 'assistant: SYNC_DISCONNECT_MAIN_ANSWER'), /\b1\b/, withPeer);
    branch.sendKey('escape');
    await waitUntilQuiet(async () => !(await visibleText(branch)).includes('Session Tree'), TIMEOUT);

    await main.close();
    await new Promise((resolve) => setTimeout(resolve, 800));

    branch.clearOutput();
    branch.submit('/lane identity');
    await branch.waitForOutput(/lane=~\/1 ln_[A-Za-z0-9_-]+/, TIMEOUT);
    assert.doesNotMatch(branch.output, /lane=~\/2/, branch.output);

    branch.clearOutput();
    branch.submit('/tree');
    const withoutPeer = await waitForVisibleText(branch, 'SYNC_DISCONNECT_MAIN_ANSWER', TIMEOUT, 'tree marker after main peer disconnects');
    assert.match(lineContaining(withoutPeer, 'assistant: SYNC_DISCONNECT_BASE_ANSWER'), /\b1\b/, withoutPeer);
    assert.doesNotMatch(lineContaining(withoutPeer, 'assistant: SYNC_DISCONNECT_BASE_ANSWER'), /\b2\b/);
    assert.doesNotMatch(lineContaining(withoutPeer, 'assistant: SYNC_DISCONNECT_MAIN_ANSWER'), /\b1\b/);
  } finally {
    await main.close();
    await branch.close();
    await removeRoot(root);
  }
});

test('pi-sync refreshes an open session tree when a same-lane peer advances', { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-open-tree-refresh-'));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'shared.jsonl');
  const piWrapper = join(root, 'pi-wrapper.sh');
  writeFileSync(sessionFile, '', 'utf8');
  writeFileSync(piWrapper, `#!/usr/bin/env bash\nargs=()\nfor a in "$@"; do [[ "$a" == "--no-session" ]] && continue; args+=("$a"); done\nexec "${process.env.PI_SYNC_TEST_PI_BINARY ?? 'pi'}" "\${args[@]}"\n`);
  chmodSync(piWrapper, 0o755);

  const brain = createControllableBrain();
  async function respondToPrompt(promptText, responseText) {
    const call = await brain.waitForCall(TIMEOUT);
    assert.match(JSON.stringify(call.request), new RegExp(promptText), `expected provider request for ${promptText}`);
    call.respond(text(responseText));
  }

  const common = {
    brain: brain.brain,
    extensions: [EXTENSION],
    piProvider: 'pi-mock',
    piModel: 'mock',
    startupTimeoutMs: 20_000,
    terminal: { cols: 140, rows: 42 },
    cwd: root,
    env: { PI_LANE_ROOT: laneRoot, PI_SYNC_POLL_MS: '25', PI_SYNC_HOST_IDLE_MS: '1000' },
    piBinary: piWrapper,
    piArgs: ['--session', sessionFile],
  };

  const watcher = await createInteractiveMock(common);
  const submitter = await createInteractiveMock(common);
  try {
    submitter.submit('SYNC_OPEN_TREE_BASE_PROMPT');
    await respondToPrompt('SYNC_OPEN_TREE_BASE_PROMPT', 'SYNC_OPEN_TREE_BASE_ANSWER');
    await watcher.waitForOutput('SYNC_OPEN_TREE_BASE_ANSWER', TIMEOUT);
    await waitForMessageEntry(sessionFile, 'SYNC_OPEN_TREE_BASE_ANSWER');

    watcher.clearOutput();
    watcher.submit('/tree');
    await waitForVisibleText(watcher, 'SYNC_OPEN_TREE_BASE_ANSWER', TIMEOUT, 'open tree before peer advances');

    submitter.submit('SYNC_OPEN_TREE_NEXT_PROMPT');
    await respondToPrompt('SYNC_OPEN_TREE_NEXT_PROMPT', 'SYNC_OPEN_TREE_NEXT_ANSWER');
    await submitter.waitForOutput('SYNC_OPEN_TREE_NEXT_ANSWER', TIMEOUT);
    await waitForMessageEntry(sessionFile, 'SYNC_OPEN_TREE_NEXT_ANSWER');

    const refreshedTree = await waitForVisibleLine(watcher, 'assistant: SYNC_OPEN_TREE_NEXT_ANSWER', TIMEOUT, 'open tree refresh after peer advances');
    assert.match(refreshedTree.line, /\b1\b/, refreshedTree.screen);
  } finally {
    await watcher.close();
    await submitter.close();
    await removeRoot(root);
  }
});

test('pi-sync marks the current single-lane assistant row in the session tree', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-current-tree-marker-'));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'shared.jsonl');
  const piWrapper = join(root, 'pi-wrapper.sh');
  writeFileSync(sessionFile, '', 'utf8');
  writeFileSync(piWrapper, `#!/usr/bin/env bash\nargs=()\nfor a in "$@"; do [[ "$a" == "--no-session" ]] && continue; args+=("$a"); done\nexec "${process.env.PI_SYNC_TEST_PI_BINARY ?? 'pi'}" "\${args[@]}"\n`);
  chmodSync(piWrapper, 0o755);

  const mock = await createInteractiveMock({
    brain: script(text('SYNC_CURRENT_TREE_MARKER_ANSWER')),
    extensions: [EXTENSION],
    piProvider: 'pi-mock',
    piModel: 'mock',
    startupTimeoutMs: 20_000,
    terminal: { cols: 120, rows: 34 },
    cwd: root,
    env: { PI_LANE_ROOT: laneRoot, PI_SYNC_POLL_MS: '25', PI_SYNC_HOST_IDLE_MS: '1000' },
    piBinary: piWrapper,
    piArgs: ['--session', sessionFile],
  });

  try {
    mock.submit('SYNC_CURRENT_TREE_MARKER_PROMPT');
    await mock.waitForOutput('SYNC_CURRENT_TREE_MARKER_ANSWER', TIMEOUT);
    await waitForMessageEntry(sessionFile, 'SYNC_CURRENT_TREE_MARKER_ANSWER');

    mock.clearOutput();
    mock.submit('/tree');
    const selectedAssistant = await waitForVisibleLine(mock, 'assistant: SYNC_CURRENT_TREE_MARKER_ANSWER', TIMEOUT, 'current assistant tree marker');
    assert.match(selectedAssistant.line, /\b1\b/, selectedAssistant.screen);
    assert.doesNotMatch(selectedAssistant.line, /\b2\b/, selectedAssistant.screen);
  } finally {
    await mock.close();
    await removeRoot(root);
  }
});

test('pi-sync reconciles a stale loaded lane head to the actual resumed leaf before painting tree markers', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-resume-stale-head-marker-'));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'shared.jsonl');
  const piWrapper = join(root, 'pi-wrapper.sh');
  const helperExt = join(root, 'resume-stale-head-helper.mjs');
  writeFileSync(sessionFile, [
    JSON.stringify({ type: 'session', version: 3, id: 'resume-stale-head-session', timestamp: new Date().toISOString(), cwd: root }),
    JSON.stringify({ type: 'message', id: 'old-user-entry', parentId: null, timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text: 'SYNC_RESUME_OLD_PROMPT' }] } }),
    JSON.stringify({ type: 'message', id: 'old-assistant-entry', parentId: 'old-user-entry', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'SYNC_RESUME_OLD_ANSWER' }], stopReason: 'stop', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } }),
    JSON.stringify({ type: 'message', id: 'new-user-entry', parentId: null, timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text: 'SYNC_RESUME_NEW_PROMPT' }] } }),
    JSON.stringify({ type: 'message', id: 'new-assistant-entry', parentId: 'new-user-entry', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'SYNC_RESUME_NEW_ANSWER' }], stopReason: 'stop', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } }),
    JSON.stringify({ type: 'thinking_level_change', id: 'new-hidden-tail', parentId: 'new-assistant-entry', timestamp: new Date().toISOString(), thinkingLevel: 'off' }),
    '',
  ].join('\n'), 'utf8');
  const canonicalSessionFile = realpathSync(sessionFile);
  const sessionKey = stableSessionKey(canonicalSessionFile);
  writeLaneFixture(laneRoot, sessionKey, canonicalSessionFile, {
    name: 'main',
    id: 'ln_staleh1',
    displayId: 'L1',
    headEntryId: 'old-assistant-entry',
  });
  writeFileSync(helperExt, `
export default function resumeStaleHeadHelper(pi) {
  pi.registerCommand("_tree_markers", {
    description: "Print pi-sync tree marker env",
    handler: async (_args, ctx) => {
      const raw = process.env.PI_SYNC_TREE_MARKERS || "";
      let readable = "";
      try {
        const markers = JSON.parse(raw || "{}");
        readable = Object.entries(markers).map(([id, label]) => {
          const entry = ctx.sessionManager.getEntries().find((item) => item.id === id);
          const content = entry?.message?.content;
          const text = Array.isArray(content)
            ? content.filter((part) => part?.type === "text").map((part) => part.text).join("")
            : "";
          return label + ":" + text;
        }).join("|");
      } catch {}
      ctx.ui.notify("tree_markers:" + (raw || "<empty>") + " readable:" + readable, "info");
    },
  });
}
`, 'utf8');
  writeFileSync(piWrapper, `#!/usr/bin/env bash\nargs=()\nfor a in "$@"; do [[ "$a" == "--no-session" ]] && continue; args+=("$a"); done\nexec "${process.env.PI_SYNC_TEST_PI_BINARY ?? 'pi'}" "\${args[@]}"\n`);
  chmodSync(piWrapper, 0o755);

  const mock = await createInteractiveMock({
    brain: script(text('UNUSED_RESUME_STALE_HEAD_RESPONSE')),
    extensions: [EXTENSION, STATUS_EXTENSION, helperExt],
    piProvider: 'pi-mock',
    piModel: 'mock',
    startupTimeoutMs: 20_000,
    terminal: { cols: 140, rows: 34 },
    cwd: root,
    env: { PI_LANE_ROOT: laneRoot, PI_SYNC_POLL_MS: '25', PI_SYNC_HOST_IDLE_MS: '1000' },
    piBinary: piWrapper,
    piArgs: ['--session', sessionFile],
  });

  try {
    await mock.waitForOutput('SYNC_RESUME_NEW_ANSWER', TIMEOUT);
    await waitForVisibleText(mock, /~\/1\b/, TIMEOUT, 'resumed terminal footer is live lane 1');
    mock.clearOutput();
    mock.submit('/tree');
    const newLine = await waitForVisibleLine(mock, 'assistant: SYNC_RESUME_NEW_ANSWER', TIMEOUT, 'resumed leaf marker follows current assistant');
    assert.match(newLine.line, /\b1\b/, newLine.screen);
    const oldLine = lineContaining(newLine.screen, 'assistant: SYNC_RESUME_OLD_ANSWER');
    assert.doesNotMatch(oldLine, /\b1\b/, newLine.screen);
    mock.sendKey('escape');
    await waitUntilQuiet(async () => !(await visibleText(mock)).includes('Session Tree'), TIMEOUT);
    mock.clearOutput();
    mock.submit('/_tree_markers');
    await mock.waitForOutput(/readable:1:SYNC_RESUME_NEW_ANSWER/, TIMEOUT);
    assert.doesNotMatch(mock.output, /readable:1:SYNC_RESUME_OLD_ANSWER/, mock.output);
  } finally {
    await mock.close();
    await removeRoot(root);
  }
});

test('pi-sync marks a root-position lane on the first root message row', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-root-tree-marker-'));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'shared.jsonl');
  const piWrapper = join(root, 'pi-wrapper.sh');
  const helperExt = join(root, 'tree-root-helper.mjs');
  writeFileSync(sessionFile, [
    JSON.stringify({ type: 'session', version: 3, id: 'root-marker-session', timestamp: new Date().toISOString(), cwd: root }),
    JSON.stringify({ type: 'message', id: 'root-user-entry', parentId: null, timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text: 'SYNC_ROOT_TREE_MARKER_PROMPT' }] } }),
    JSON.stringify({ type: 'message', id: 'root-assistant-entry', parentId: 'root-user-entry', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'SYNC_ROOT_TREE_MARKER_ANSWER' }], stopReason: 'stop', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } }),
    '',
  ].join('\n'), 'utf8');
  writeFileSync(helperExt, `
export default function rootTreeHelper(pi) {
  pi.registerCommand("_tree_nav_to_text", {
    description: "Navigate to the first message whose text matches args",
    handler: async (args, ctx) => {
      const wanted = args.trim();
      const file = ctx.sessionManager.getSessionFile();
      if (file) ctx.sessionManager.setSessionFile(file);
      const entry = ctx.sessionManager.getEntries().find((item) => {
        const content = item.message?.content;
        return Array.isArray(content) && content.some((part) => part.type === "text" && part.text === wanted);
      });
      if (!entry) throw new Error("entry not found: " + wanted);
      await ctx.navigateTree(entry.id);
      ctx.ui.notify("leaf_after_nav:" + (ctx.sessionManager.getLeafId() ?? "<root>"), "info");
    },
  });
}
`, 'utf8');
  writeFileSync(piWrapper, `#!/usr/bin/env bash\nargs=()\nfor a in "$@"; do [[ "$a" == "--no-session" ]] && continue; args+=("$a"); done\nexec "${process.env.PI_SYNC_TEST_PI_BINARY ?? 'pi'}" "\${args[@]}"\n`);
  chmodSync(piWrapper, 0o755);

  const mock = await createInteractiveMock({
    brain: script(text('UNUSED_ROOT_MARKER_RESPONSE')),
    extensions: [EXTENSION, helperExt],
    piProvider: 'pi-mock',
    piModel: 'mock',
    startupTimeoutMs: 20_000,
    terminal: { cols: 120, rows: 34 },
    cwd: root,
    env: { PI_LANE_ROOT: laneRoot, PI_SYNC_POLL_MS: '25', PI_SYNC_HOST_IDLE_MS: '1000' },
    piBinary: piWrapper,
    piArgs: ['--session', sessionFile],
  });

  try {
    await mock.waitForOutput('SYNC_ROOT_TREE_MARKER_ANSWER', TIMEOUT);

    mock.clearOutput();
    mock.submit('/_tree_nav_to_text SYNC_ROOT_TREE_MARKER_PROMPT');
    await waitUntil(
      () => readLaneStates(laneRoot).some((lane) => lane.name !== 'main' && (lane.headEntryId === null || lane.headEntryId === 'root-user-entry')),
      TIMEOUT,
      'root lane state after navigating to first user message',
    );
    mock.clearOutput();
    mock.sendKey('ctrl+c');
    mock.clearOutput();
    mock.submit('/tree');
    const rootUser = await waitForVisibleLine(mock, 'user: SYNC_ROOT_TREE_MARKER_PROMPT', TIMEOUT, 'root lane marker on first root row');
    assert.match(rootUser.line, /\b1\b/, rootUser.screen);
    assert.doesNotMatch(rootUser.line, /\b2\b/, rootUser.screen);
  } finally {
    await mock.close();
    await removeRoot(root);
  }
});

test('pi-sync updates open tree markers as same-row live lanes attach and detach', { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-same-row-markers-'));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'shared.jsonl');
  const piWrapper = join(root, 'pi-wrapper.sh');
  writeFileSync(sessionFile, [
    JSON.stringify({ type: 'session', version: 3, id: 'same-row-marker-session', timestamp: new Date().toISOString(), cwd: root }),
    JSON.stringify({ type: 'message', id: 'same-row-user', parentId: null, timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text: 'SYNC_SAME_ROW_PROMPT' }] } }),
    JSON.stringify({ type: 'message', id: 'same-row-assistant', parentId: 'same-row-user', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'SYNC_SAME_ROW_ANSWER' }], stopReason: 'stop', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } }),
    JSON.stringify({ type: 'thinking_level_change', id: 'same-row-hidden-tail', parentId: 'same-row-assistant', timestamp: new Date().toISOString(), thinkingLevel: 'off' }),
    '',
  ].join('\n'), 'utf8');
  writeFileSync(piWrapper, `#!/usr/bin/env bash\nargs=()\nfor a in "$@"; do [[ "$a" == "--no-session" ]] && continue; args+=("$a"); done\nexec "${process.env.PI_SYNC_TEST_PI_BINARY ?? 'pi'}" "\${args[@]}"\n`);
  chmodSync(piWrapper, 0o755);

  const common = {
    brain: script(text('UNUSED_SAME_ROW_RESPONSE')),
    extensions: [EXTENSION],
    piProvider: 'pi-mock',
    piModel: 'mock',
    startupTimeoutMs: 20_000,
    terminal: { cols: 120, rows: 34 },
    cwd: root,
    env: {
      PI_LANE_ROOT: laneRoot,
      PI_SYNC_POLL_MS: '25',
      PI_SYNC_HOST_IDLE_MS: '1000',
      PI_LANE_HEARTBEAT_MS: '100',
      PI_SYNC_INSTANCE_STALE_MS: '5000',
    },
    piBinary: piWrapper,
    piArgs: ['--session', sessionFile],
  };

  const treeViewer = await createInteractiveMock(common);
  const laneCreator = await createInteractiveMock(common);
  try {
    await treeViewer.waitForOutput('SYNC_SAME_ROW_ANSWER', TIMEOUT);
    await laneCreator.waitForOutput('SYNC_SAME_ROW_ANSWER', TIMEOUT);

    treeViewer.clearOutput();
    treeViewer.submit('/tree');
    const initialLine = await waitForVisibleLine(treeViewer, 'assistant: SYNC_SAME_ROW_ANSWER', TIMEOUT, 'initial same-row marker');
    assert.match(initialLine.line, /\b1\b/, initialLine.screen);
    assert.doesNotMatch(initialLine.line, /\b2\b/, initialLine.screen);

    laneCreator.clearOutput();
    laneCreator.submit('/lane new');
    await laneCreator.waitForOutput(/created ln_[A-Za-z0-9_-]+ -> now ~\/2 ln_[A-Za-z0-9_-]+/, TIMEOUT);

    await waitUntil(async () => {
      const screen = await visibleText(treeViewer);
      const line = lineContaining(screen, 'assistant: SYNC_SAME_ROW_ANSWER');
      return /\b1,2\b/.test(line) && !/\b3\b/.test(line);
    }, TIMEOUT, 'open tree marker updates to 1,2 for two live lanes on one row');

    await laneCreator.close();

    await waitUntil(async () => {
      const screen = await visibleText(treeViewer);
      const line = lineContaining(screen, 'assistant: SYNC_SAME_ROW_ANSWER');
      return /\b1\b/.test(line) && !/\b2\b/.test(line) && !/\b1,2\b/.test(line);
    }, TIMEOUT, 'open tree marker compacts back to 1 after peer lane detaches');
  } finally {
    await treeViewer.close();
    await laneCreator.close();
    await removeRoot(root);
  }
});

test('pi-sync rerenders the footer when live lane labels renumber', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-footer-renumber-'));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'shared.jsonl');
  const piWrapper = join(root, 'pi-wrapper.sh');
  writeFileSync(sessionFile, [
    JSON.stringify({ type: 'session', version: 3, id: 'footer-renumber-session', timestamp: new Date().toISOString(), cwd: root }),
    JSON.stringify({ type: 'message', id: 'footer-user', parentId: null, timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text: 'SYNC_FOOTER_RENUMBER_PROMPT' }] } }),
    JSON.stringify({ type: 'message', id: 'footer-assistant', parentId: 'footer-user', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'SYNC_FOOTER_RENUMBER_ANSWER' }], stopReason: 'stop', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } }),
    '',
  ].join('\n'), 'utf8');
  writeFileSync(piWrapper, `#!/usr/bin/env bash\nargs=()\nfor a in "$@"; do [[ "$a" == "--no-session" ]] && continue; args+=("$a"); done\nexec "${process.env.PI_SYNC_TEST_PI_BINARY ?? 'pi'}" "\${args[@]}"\n`);
  chmodSync(piWrapper, 0o755);

  const common = {
    brain: script(text('UNUSED_FOOTER_RENUMBER_RESPONSE')),
    extensions: [EXTENSION, STATUS_EXTENSION],
    piProvider: 'pi-mock',
    piModel: 'mock',
    startupTimeoutMs: 20_000,
    terminal: { cols: 140, rows: 34 },
    cwd: root,
    env: {
      PI_LANE_ROOT: laneRoot,
      PI_SYNC_POLL_MS: '25',
      PI_SYNC_HOST_IDLE_MS: '1000',
      PI_LANE_HEARTBEAT_MS: '100',
      PI_SYNC_INSTANCE_STALE_MS: '5000',
    },
    piBinary: piWrapper,
    piArgs: ['--session', sessionFile],
  };

  const branch = await createInteractiveMock(common);
  let main;
  try {
    await branch.waitForOutput('SYNC_FOOTER_RENUMBER_ANSWER', TIMEOUT);
    branch.clearOutput();
    branch.submit('/lane new');
    await branch.waitForOutput(/created ln_[A-Za-z0-9_-]+ -> now ~\/1 ln_[A-Za-z0-9_-]+/, TIMEOUT);
    await waitForVisibleText(branch, /~\/1\b/, TIMEOUT, 'branch lane is compacted to ~/1 while it is the only live terminal');

    main = await createInteractiveMock(common);
    await main.waitForOutput('SYNC_FOOTER_RENUMBER_ANSWER', TIMEOUT);

    await waitForVisibleText(branch, /~\/2\b/, TIMEOUT, 'branch footer rerenders to ~/2 when main becomes a live lane');
    branch.clearOutput();
    branch.submit('/tree');
    const currentLine = await waitForVisibleLine(branch, 'assistant: SYNC_FOOTER_RENUMBER_ANSWER', TIMEOUT, 'renumbered current lane tree marker');
    assert.match(currentLine.line, /\b1,2\b|\b2\b/, currentLine.screen);

    await main.close();
    main = undefined;

    await waitForVisibleText(branch, /~\/1\b/, TIMEOUT, 'branch footer rerenders back to ~/1 when the main lane detaches');
    await waitUntil(async () => {
      const screen = await visibleText(branch);
      const line = lineContaining(screen, 'assistant: SYNC_FOOTER_RENUMBER_ANSWER');
      return /\b1\b/.test(line) && !/\b2\b/.test(line) && !/\b1,2\b/.test(line);
    }, TIMEOUT, 'open tree marker and footer compact together after peer detaches');
  } finally {
    await branch.close();
    if (main) await main.close();
    await removeRoot(root);
  }
});

test('pi-sync ignores stale lane files when opening an old session', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-stale-old-session-'));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'shared.jsonl');
  const piWrapper = join(root, 'pi-wrapper.sh');
  writeFileSync(sessionFile, [
    JSON.stringify({ type: 'session', version: 3, id: 'stale-old-session', timestamp: new Date().toISOString(), cwd: root }),
    JSON.stringify({ type: 'message', id: 'old-user', parentId: null, timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text: 'SYNC_OLD_SESSION_PROMPT' }] } }),
    JSON.stringify({ type: 'message', id: 'old-assistant', parentId: 'old-user', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'SYNC_OLD_SESSION_ANSWER' }], stopReason: 'stop', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } }),
    '',
  ].join('\n'), 'utf8');
  const canonicalSessionFile = realpathSync(sessionFile);
  const sessionKey = stableSessionKey(canonicalSessionFile);
  writeLaneFixture(laneRoot, sessionKey, canonicalSessionFile, { name: 'main', displayId: 'L1', headEntryId: 'old-assistant' });
  writeLaneFixture(laneRoot, sessionKey, canonicalSessionFile, { name: 'lane-2', displayId: 'L2', headEntryId: 'old-user' });
  writeLaneFixture(laneRoot, sessionKey, canonicalSessionFile, { name: 'tree-stale', displayId: 'L3', headEntryId: 'old-assistant' });
  writeInstanceFixture(laneRoot, sessionKey, canonicalSessionFile, {
    instanceId: 'stale-side',
    lane: 'lane-2',
    leafId: 'old-user',
    lastSeenAt: '2000-01-01T00:00:00.000Z',
  });
  writeInstanceFixture(laneRoot, sessionKey, canonicalSessionFile, {
    instanceId: 'stale-tree',
    lane: 'tree-stale',
    leafId: 'old-assistant',
    lastSeenAt: '2000-01-01T00:00:00.000Z',
  });
  writeFileSync(piWrapper, `#!/usr/bin/env bash\nargs=()\nfor a in "$@"; do [[ "$a" == "--no-session" ]] && continue; args+=("$a"); done\nexec "${process.env.PI_SYNC_TEST_PI_BINARY ?? 'pi'}" "\${args[@]}"\n`);
  chmodSync(piWrapper, 0o755);

  const mock = await createInteractiveMock({
    brain: script(text('UNUSED_OLD_SESSION_RESPONSE')),
    extensions: [EXTENSION, STATUS_EXTENSION],
    piProvider: 'pi-mock',
    piModel: 'mock',
    startupTimeoutMs: 20_000,
    terminal: { cols: 140, rows: 34 },
    cwd: root,
    env: {
      PI_LANE_ROOT: laneRoot,
      PI_SYNC_POLL_MS: '25',
      PI_SYNC_HOST_IDLE_MS: '1000',
      PI_SYNC_INSTANCE_STALE_MS: '500',
    },
    piBinary: piWrapper,
    piArgs: ['--session', sessionFile],
  });

  try {
    await mock.waitForOutput('SYNC_OLD_SESSION_ANSWER', TIMEOUT);
    await waitForVisibleText(mock, /~\/1\b/, TIMEOUT, 'old session footer ignores stale lane files');
    mock.clearOutput();
    mock.submit('/tree');
    const assistantLine = await waitForVisibleLine(mock, 'assistant: SYNC_OLD_SESSION_ANSWER', TIMEOUT, 'old session current tree marker');
    assert.match(assistantLine.line, /\b1\b/, assistantLine.screen);
    assert.doesNotMatch(assistantLine.line, /\b2\b|\b3\b/, assistantLine.screen);
    assert.doesNotMatch(lineContaining(assistantLine.screen, 'user: SYNC_OLD_SESSION_PROMPT'), /\b2\b|\b3\b/);
  } finally {
    await mock.close();
    await removeRoot(root);
  }
});

test('pi-sync removes markers for a killed terminal after its instance ages out', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-killed-marker-'));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'shared.jsonl');
  const piWrapper = join(root, 'pi-wrapper.sh');
  writeFileSync(sessionFile, [
    JSON.stringify({ type: 'session', version: 3, id: 'killed-marker-session', timestamp: new Date().toISOString(), cwd: root }),
    JSON.stringify({ type: 'message', id: 'killed-user', parentId: null, timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text: 'SYNC_KILLED_MARKER_PROMPT' }] } }),
    JSON.stringify({ type: 'message', id: 'killed-assistant', parentId: 'killed-user', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'SYNC_KILLED_MARKER_ANSWER' }], stopReason: 'stop', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } }),
    '',
  ].join('\n'), 'utf8');
  writeFileSync(piWrapper, `#!/usr/bin/env bash\nargs=()\nfor a in "$@"; do [[ "$a" == "--no-session" ]] && continue; args+=("$a"); done\nexec "${process.env.PI_SYNC_TEST_PI_BINARY ?? 'pi'}" "\${args[@]}"\n`);
  chmodSync(piWrapper, 0o755);

  const common = {
    brain: script(text('UNUSED_KILLED_MARKER_RESPONSE')),
    extensions: [EXTENSION],
    piProvider: 'pi-mock',
    piModel: 'mock',
    startupTimeoutMs: 20_000,
    terminal: { cols: 120, rows: 34 },
    cwd: root,
    env: {
      PI_LANE_ROOT: laneRoot,
      PI_SYNC_POLL_MS: '25',
      PI_SYNC_HOST_IDLE_MS: '1000',
      PI_LANE_HEARTBEAT_MS: '100',
      PI_SYNC_INSTANCE_STALE_MS: '500',
    },
    piBinary: piWrapper,
    piArgs: ['--session', sessionFile],
  };

  const watcher = await createInteractiveMock(common);
  const doomed = await createInteractiveMock(common);
  try {
    await watcher.waitForOutput('SYNC_KILLED_MARKER_ANSWER', TIMEOUT);
    await doomed.waitForOutput('SYNC_KILLED_MARKER_ANSWER', TIMEOUT);

    watcher.clearOutput();
    watcher.submit('/tree');
    await waitForVisibleLine(watcher, 'assistant: SYNC_KILLED_MARKER_ANSWER', TIMEOUT, 'initial killed-marker tree row');

    doomed.clearOutput();
    doomed.submit('/lane new');
    await doomed.waitForOutput(/created ln_[A-Za-z0-9_-]+ -> now ~\/2 ln_[A-Za-z0-9_-]+/, TIMEOUT);
    await waitUntil(async () => {
      const screen = await visibleText(watcher);
      return /\b1,2\b/.test(lineContaining(screen, 'assistant: SYNC_KILLED_MARKER_ANSWER'));
    }, TIMEOUT, 'tree marker includes killed candidate before SIGKILL');

    const stats = doomed.getProcessStats();
    assert.ok(stats?.pid, 'expected doomed pi process pid');
    process.kill(stats.pid, 'SIGKILL');

    await waitUntil(async () => {
      const screen = await visibleText(watcher);
      const line = lineContaining(screen, 'assistant: SYNC_KILLED_MARKER_ANSWER');
      return /\b1\b/.test(line) && !/\b2\b/.test(line) && !/\b1,2\b/.test(line);
    }, TIMEOUT, 'killed terminal marker disappears after stale timeout');
  } finally {
    await watcher.close();
    await doomed.close();
    await removeRoot(root);
  }
});
