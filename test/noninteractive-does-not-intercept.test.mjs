import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EXTENSION = new URL('../index.ts', import.meta.url).pathname;

function stableSessionKey(sessionFile) {
  return createHash('sha256').update(sessionFile).digest('hex').slice(0, 24);
}

async function waitUntil(predicate, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timeout waiting for ${label}`);
}

test('pi-sync does not intercept non-UI prompts', { timeout: 60_000 }, async () => {
  const handlers = new Map();
  const pi = {
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
    registerCommand() {},
  };

  const mod = await import(EXTENSION);
  await mod.default(pi);

  const input = handlers.get('input')?.[0];
  assert.equal(typeof input, 'function');

  const result = await input(
    { type: 'input', text: 'noninteractive pi-sync regression prompt', source: 'interactive' },
    {
      hasUI: false,
      ui: {},
      sessionManager: {},
      isIdle: () => true,
    },
  );

  assert.equal(result, undefined);
});

test('pi-sync does not reset a session manager to a non-existent session file', { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-refresh-session-'));
  const missingSessionFile = join(root, 'future-session.jsonl');
  assert.equal(existsSync(missingSessionFile), false);

  const handlers = new Map();
  const pi = {
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
    registerCommand() {},
  };

  try {
    const mod = await import(`${EXTENSION}?refresh=${Date.now()}`);
    await mod.default(pi);

    let setSessionFileCalls = 0;
    const input = handlers.get('input')?.[0];
    assert.equal(typeof input, 'function');

    await input(
      { type: 'input', text: '/sync status', source: 'interactive' },
      {
        hasUI: true,
        ui: { replayAgentEvent() {}, notify() {} },
        sessionManager: {
          getSessionFile: () => missingSessionFile,
          getSessionId: () => 'real-session-id',
          setSessionFile: () => { setSessionFileCalls++; },
        },
        isIdle: () => true,
      },
    );

    assert.equal(setSessionFileCalls, 0, 'must not call setSessionFile on a path Pi has not created yet');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pi-sync has no fallback transcript widget implementation', () => {
  const source = readFileSync(EXTENSION, 'utf8');
  assert.doesNotMatch(source, /setWidget\("pi-sync"/);
  assert.doesNotMatch(source, new RegExp(['remote', 'live', 'view'].join(' ')));
  assert.doesNotMatch(source, new RegExp(['PI_SYNC', 'FALLBACK', 'WIDGET'].join('_')));
});

test('pi-sync fails early in UI sessions when native replay is unavailable', { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-native-replay-required-'));
  const previousEnv = {
    PI_SYNC_EXACT: process.env.PI_SYNC_EXACT,
    PI_SYNC_POLL_MS: process.env.PI_SYNC_POLL_MS,
    PI_LANE_ROOT: process.env.PI_LANE_ROOT,
  };
  process.env.PI_SYNC_EXACT = '0';
  process.env.PI_SYNC_POLL_MS = '10';
  process.env.PI_LANE_ROOT = join(root, 'lane');

  const sessionFile = join(root, 'session.jsonl');
  writeFileSync(sessionFile, '', 'utf8');
  const canonicalSessionFile = realpathSync(sessionFile);

  const handlers = new Map();
  const pi = {
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
    registerCommand() {},
  };

  try {
    const mod = await import(`${EXTENSION}?native-replay-required=${Date.now()}`);
    await mod.default(pi);

    const ctx = {
      hasUI: true,
      ui: {
        setWorkingVisible() {},
        onTerminalInput: () => () => {},
        notify() {},
      },
      sessionManager: {
        getSessionFile: () => canonicalSessionFile,
        getSessionId: () => 'session-id',
        setSessionFile() {},
      },
      isIdle: () => true,
    };

    await assert.rejects(
      () => handlers.get('session_start')?.[0]?.({}, ctx),
      /pi-sync requires Pi native replay support: missing ctx\.ui\.replayAgentEvent/,
    );
  } finally {
    await handlers.get('session_shutdown')?.[0]?.({}, {});
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('pi-sync polling native replay marks remote events for extension guards', { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-polling-replay-env-'));
  const previousEnv = {
    PI_SYNC_EXACT: process.env.PI_SYNC_EXACT,
    PI_SYNC_POLL_MS: process.env.PI_SYNC_POLL_MS,
    PI_LANE_ROOT: process.env.PI_LANE_ROOT,
  };
  delete process.env.PI_SYNC_EXACT;
  process.env.PI_SYNC_POLL_MS = '10';
  process.env.PI_LANE_ROOT = join(root, 'lane');

  const sessionFile = join(root, 'session.jsonl');
  writeFileSync(sessionFile, '', 'utf8');
  const canonicalSessionFile = realpathSync(sessionFile);
  const sessionKey = stableSessionKey(canonicalSessionFile);
  const syncDir = join(process.env.PI_LANE_ROOT, 'sessions', sessionKey, 'lanes', 'main', 'sync');
  mkdirSync(join(syncDir, 'host.lock'), { recursive: true });

  const handlers = new Map();
  const pi = {
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
    registerCommand() {},
  };

  try {
    const mod = await import(`${EXTENSION}?polling-replay-env=${Date.now()}`);
    await mod.default(pi);

    const replayEnvValues = [];
    const ctx = {
      hasUI: true,
      ui: {
        replayAgentEvent: async () => {
          replayEnvValues.push(process.env.PI_SYNC_REPLAYING_REMOTE);
        },
        setWidget() {},
        setWorkingVisible() {},
        onTerminalInput: () => () => {},
        notify() {},
      },
      sessionManager: {
        getSessionFile: () => canonicalSessionFile,
        getSessionId: () => 'session-id',
        setSessionFile() {},
      },
      isIdle: () => true,
    };

    await handlers.get('session_start')?.[0]?.({}, ctx);
    appendFileSync(join(syncDir, 'events.jsonl'), JSON.stringify({
      schemaVersion: 1,
      id: randomUUID(),
      seq: 1,
      at: new Date().toISOString(),
      instanceId: 'peer-instance',
      sessionId: 'session-id',
      sessionKey,
      sessionFile: canonicalSessionFile,
      lane: 'main',
      type: 'agent_end',
      payload: { messages: [] },
    }) + '\n');

    await waitUntil(() => replayEnvValues.length > 0, 5_000, 'remote polling replay');
    assert.deepEqual(replayEnvValues, ['1']);
  } finally {
    await handlers.get('session_shutdown')?.[0]?.({}, {});
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
