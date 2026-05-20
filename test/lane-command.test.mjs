import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInteractiveMock, createControllableBrain, createMock } from '../../pi-mock/dist/index.js';

const EXTENSION = new URL('../index.ts', import.meta.url).pathname;
const TIMEOUT = 30_000;

function writePiWrapper(root) {
  const piWrapper = join(root, 'pi-wrapper.sh');
  writeFileSync(piWrapper, `#!/usr/bin/env bash\nargs=()\nfor a in "$@"; do [[ "$a" == "--no-session" ]] && continue; args+=("$a"); done\nexec "${process.env.PI_SYNC_TEST_PI_BINARY ?? 'pi'}" "\${args[@]}"\n`);
  chmodSync(piWrapper, 0o755);
  return piWrapper;
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

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

test('pi-sync lane commands use live numeric lane ids and complete lane arguments', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-lane-completions-'));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'shared.jsonl');
  const sessionKey = 'completion-session-key';
  const now = new Date().toISOString();
  const previousSyncRoot = process.env.PI_SYNC_ROOT;
  const previousLaneRoot = process.env.PI_LANE_ROOT;
  const previousStale = process.env.PI_SYNC_INSTANCE_STALE_MS;
  const previousSyncKey = process.env.PI_SYNC_SESSION_KEY;
  const previousLaneKey = process.env.PI_LANE_SESSION_KEY;
  process.env.PI_SYNC_ROOT = laneRoot;
  process.env.PI_LANE_ROOT = laneRoot;
  process.env.PI_SYNC_INSTANCE_STALE_MS = '5000';
  process.env.PI_SYNC_SESSION_KEY = sessionKey;
  process.env.PI_LANE_SESSION_KEY = sessionKey;
  writeFileSync(sessionFile, '', 'utf8');
  mkdirSync(join(laneRoot, 'sessions', sessionKey, 'lanes'), { recursive: true });
  mkdirSync(join(laneRoot, 'sessions', sessionKey, 'instances'), { recursive: true });
  writeFileSync(join(laneRoot, 'sessions', sessionKey, 'lanes', 'main.json'), JSON.stringify({
    schemaVersion: 1,
    name: 'main',
    sessionKey,
    baseLeafId: null,
    headEntryId: null,
    headEpoch: 0,
    createdAt: now,
    updatedAt: now,
    id: `${sessionKey.slice(0, 8)}-L1`,
    displayId: 'L1',
    aliasPath: join(laneRoot, 'flat', `${sessionKey.slice(0, 8)}-L1.json`),
  }, null, 2));
  writeFileSync(join(laneRoot, 'sessions', sessionKey, 'lanes', 'lane-2.json'), JSON.stringify({
    schemaVersion: 1,
    name: 'lane-2',
    sessionKey,
    baseLeafId: null,
    headEntryId: null,
    headEpoch: 0,
    createdAt: now,
    updatedAt: now,
    id: `${sessionKey.slice(0, 8)}-L2`,
    displayId: 'L2',
    aliasPath: join(laneRoot, 'flat', `${sessionKey.slice(0, 8)}-L2.json`),
  }, null, 2));
  writeFileSync(join(laneRoot, 'sessions', sessionKey, 'instances', 'main.json'), JSON.stringify({
    instanceId: 'main',
    pid: process.pid,
    lane: 'main',
    status: 'idle',
    sessionId: null,
    sessionKey,
    sessionFile,
    leafId: null,
    startedAt: now,
    lastSeenAt: now,
  }, null, 2));
  writeFileSync(join(laneRoot, 'sessions', sessionKey, 'instances', 'side.json'), JSON.stringify({
    instanceId: 'side',
    pid: process.pid,
    lane: 'lane-2',
    status: 'idle',
    sessionId: null,
    sessionKey,
    sessionFile,
    leafId: null,
    startedAt: now,
    lastSeenAt: now,
  }, null, 2));

  try {
    const mock = await createMock({ extensions: [EXTENSION], sessionFile });

    let completions = await mock.getCompletions('lane', 'j');
    assert.deepEqual(completions.map((item) => item.label), ['join']);
    assert.deepEqual(completions.map((item) => item.value), ['join ']);

    completions = await mock.getCompletions('lane', 'join ');
    assert.ok(completions.some((item) => item.label === '1' && item.value === 'join 1' && item.description === 'main'), JSON.stringify(completions));
    assert.ok(completions.some((item) => item.label === '2' && item.value === 'join 2' && item.description === 'lane-2'), JSON.stringify(completions));
    assert.doesNotMatch(JSON.stringify(completions), /~\/2|L2/);
  } finally {
    if (previousSyncRoot === undefined) delete process.env.PI_SYNC_ROOT;
    else process.env.PI_SYNC_ROOT = previousSyncRoot;
    if (previousLaneRoot === undefined) delete process.env.PI_LANE_ROOT;
    else process.env.PI_LANE_ROOT = previousLaneRoot;
    if (previousStale === undefined) delete process.env.PI_SYNC_INSTANCE_STALE_MS;
    else process.env.PI_SYNC_INSTANCE_STALE_MS = previousStale;
    if (previousSyncKey === undefined) delete process.env.PI_SYNC_SESSION_KEY;
    else process.env.PI_SYNC_SESSION_KEY = previousSyncKey;
    if (previousLaneKey === undefined) delete process.env.PI_LANE_SESSION_KEY;
    else process.env.PI_LANE_SESSION_KEY = previousLaneKey;
    await removeRoot(root);
  }
});

test('pi-sync lane status counts live terminals per lane and numeric join resolves display ids', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-lane-command-'));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'shared.jsonl');
  const piWrapper = writePiWrapper(root);
  const brain = createControllableBrain();
  writeFileSync(sessionFile, '', 'utf8');

  const common = {
    brain: brain.brain,
    extensions: [EXTENSION],
    piProvider: 'pi-mock',
    piModel: 'mock',
    startupTimeoutMs: 20_000,
    terminal: { cols: 120, rows: 32 },
    cwd: root,
    env: { PI_LANE_ROOT: laneRoot, PI_SYNC_POLL_MS: '25', PI_SYNC_HOST_IDLE_MS: '1000', PI_SYNC_INSTANCE_STALE_MS: '5000' },
    piBinary: piWrapper,
    piArgs: ['--session', sessionFile],
  };

  const a = await createInteractiveMock(common);
  const b = await createInteractiveMock(common);
  try {
    a.clearOutput();
    b.clearOutput();

    a.submit('/lane new');
    await a.waitForOutput(/created and joined 2 \(lane-2\)/, TIMEOUT);

    a.clearOutput();
    a.submit('/lane join 1');
    await a.waitForOutput(/joined 1 \(main\)/, TIMEOUT);

    a.clearOutput();
    a.submit('/lane new side');
    await a.waitForOutput(/created and joined 2 \(side\)/, TIMEOUT);

    a.clearOutput();
    a.submit('/lane status');
    await a.waitForOutput(/current 2 \(side\)[\s\S]*connected 1/, TIMEOUT);

    b.clearOutput();
    b.submit('/lane status');
    await b.waitForOutput(/current 1 \(main\)[\s\S]*connected 1/, TIMEOUT);

    b.clearOutput();
    b.submit('/lane join 2');
    await b.waitForOutput(/joined 1 \(side\)/, TIMEOUT);

    b.clearOutput();
    b.submit('/lane status');
    await b.waitForOutput(/current 1 \(side\)[\s\S]*connected 2/, TIMEOUT);

    const screen = (await b.visibleScreen()).join('\n');
    assert.doesNotMatch(screen, /no lane 2/, screen);
  } finally {
    await a.close();
    await b.close();
    await removeRoot(root);
  }
});

test('pi-sync compacts visible lane labels after a peer lane disconnects', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-lane-label-compact-'));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'shared.jsonl');
  const piWrapper = writePiWrapper(root);
  const brain = createControllableBrain();
  writeFileSync(sessionFile, '', 'utf8');

  const common = {
    brain: brain.brain,
    extensions: [EXTENSION],
    piProvider: 'pi-mock',
    piModel: 'mock',
    startupTimeoutMs: 20_000,
    terminal: { cols: 240, rows: 32 },
    cwd: root,
    env: {
      PI_LANE_ROOT: laneRoot,
      PI_SYNC_POLL_MS: '25',
      PI_SYNC_HOST_IDLE_MS: '1000',
      PI_SYNC_INSTANCE_STALE_MS: '500',
      PI_LANE_HEARTBEAT_MS: '100',
    },
    piBinary: piWrapper,
    piArgs: ['--session', sessionFile],
  };

  const a = await createInteractiveMock(common);
  const b = await createInteractiveMock(common);
  const c = await createInteractiveMock(common);
  try {
    a.clearOutput();
    b.clearOutput();
    c.clearOutput();

    b.submit('/lane new alpha');
    await b.waitForOutput(/created and joined 2 \(alpha\)/, TIMEOUT);

    c.submit('/lane new zeta');
    await c.waitForOutput(/created and joined 3 \(zeta\)/, TIMEOUT);

    c.clearOutput();
    c.submit('/lane status');
    await c.waitForOutput(/current 3 \(zeta\)[\s\S]*connected 1/, TIMEOUT);

    await b.close();
    await sleep(800);

    c.clearOutput();
    c.submit('/lane status');
    await c.waitForOutput(/current 2 \(zeta\)/, TIMEOUT);
    const compactedScreen = (await c.visibleScreen()).join('\n');
    assert.match(compactedScreen, /current\s+2[\s\S]*zeta/, compactedScreen);

    a.clearOutput();
    a.submit('/lane status');
    await a.waitForOutput(/current 1 \(main\)/, TIMEOUT);
  } finally {
    await a.close();
    await b.close();
    await c.close();
    await removeRoot(root);
  }
});
