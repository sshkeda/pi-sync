import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { createInteractiveMock } from '../../pi-mock/dist/index.js';

const EXTENSION = new URL('../index.ts', import.meta.url).pathname;
const TIMEOUT = 30_000;

function writePiWrapper(root) {
  const piWrapper = join(root, 'pi-wrapper.sh');
  writeFileSync(piWrapper, `#!/usr/bin/env bash\nargs=()\nfor a in "$@"; do [[ "$a" == "--no-session" ]] && continue; args+=("$a"); done\nexec "${process.env.PI_SYNC_TEST_PI_BINARY ?? 'pi'}" "\${args[@]}"\n`);
  chmodSync(piWrapper, 0o755);
  return piWrapper;
}

function stableSessionKey(sessionFile) {
  return createHash('sha256').update(sessionFile).digest('hex').slice(0, 24);
}

function laneSegment(lane = 'main') {
  return lane.replace(/[^a-zA-Z0-9_.=-]+/g, '_').slice(0, 96) || 'main';
}

function syncDir(laneRoot, sessionKey, lane = 'main') {
  return join(laneRoot, 'sessions', sessionKey, 'lanes', laneSegment(lane), 'sync');
}

function hostSocketPath(laneRoot, sessionKey, lane = 'main') {
  const key = createHash('sha256').update(`${syncDir(laneRoot, sessionKey, lane)}:${process.env.USER ?? 'user'}`).digest('hex').slice(0, 24);
  return join(process.env.TMPDIR ?? '/tmp', `pi-sync-${key}.sock`);
}

function countVisible(lines, needle) {
  return lines.filter((line) => line.includes(needle)).length;
}

async function removeRoot(path) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 4 || !['ENOTEMPTY', 'EBUSY', 'ENOENT'].includes(error?.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

async function startFakeHost(socketPath) {
  rmSync(socketPath, { force: true });
  const server = createServer((socket) => {
    socket.setEncoding('utf8');
    socket.on('data', () => {});
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(() => resolve()));
}

function userMessage(textValue) {
  return { role: 'user', content: [{ type: 'text', text: textValue }], timestamp: Date.now() };
}

function assistantMessage(textValue) {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: textValue }],
    api: 'pi-mock',
    provider: 'pi-mock',
    model: 'mock',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

function writeSession(sessionFile, cwd, messages) {
  const now = new Date().toISOString();
  const entries = [{ type: 'session', version: 3, id: 'history-boundary-test', timestamp: now, cwd }];
  let parentId = null;
  for (const [index, message] of messages.entries()) {
    const id = `entry-${index + 1}`;
    entries.push({ type: 'message', id, parentId, timestamp: now, message });
    parentId = id;
  }
  writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
}

function hostEvent(seq, type, payload = {}) {
  return {
    schemaVersion: 1,
    id: randomUUID(),
    seq,
    at: new Date().toISOString(),
    hostInstanceId: 'fake-host',
    sessionFile: payload.sessionFile,
    sessionKey: payload.sessionKey,
    lane: 'main',
    type,
    payload,
  };
}

function agentEvent(seq, agentEvent, basePayload) {
  return hostEvent(seq, 'agent_event', {
    ...basePayload,
    agentEvent,
    promptId: 'active-prompt',
    clientId: 'other-client',
    source: 'pi-sync',
  });
}

function writeFakeActiveHost({ laneRoot, sessionKey, sessionFile, prompt, response, includeAssistantInSession }) {
  const dir = syncDir(laneRoot, sessionKey);
  mkdirSync(dir, { recursive: true });
  const socketPath = hostSocketPath(laneRoot, sessionKey);
  const basePayload = { sessionFile, sessionKey };
  const user = userMessage(prompt);
  const assistant = assistantMessage(response);
  const events = [
    hostEvent(1, 'host_start', basePayload),
    hostEvent(2, 'agent_ready', basePayload),
    hostEvent(3, 'prompt_queued', { ...basePayload, promptId: 'active-prompt', clientId: 'other-client', text: prompt }),
    hostEvent(4, 'prompt_start', { ...basePayload, promptId: 'active-prompt', clientId: 'other-client', text: prompt }),
    agentEvent(5, { type: 'agent_start' }, basePayload),
    agentEvent(6, { type: 'message_start', message: user }, basePayload),
    agentEvent(7, { type: 'message_end', message: user }, basePayload),
    agentEvent(8, { type: 'message_start', message: assistant }, basePayload),
    agentEvent(9, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: response, partial: assistant },
      message: assistant,
    }, basePayload),
  ];
  if (includeAssistantInSession) {
    events.push(agentEvent(10, { type: 'message_end', message: assistant }, basePayload));
    events.push(agentEvent(11, { type: 'agent_end', messages: [user, assistant] }, basePayload));
  }
  writeFileSync(join(dir, 'host-events.jsonl'), `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
  writeFileSync(join(dir, 'host.json'), JSON.stringify({
    schemaVersion: 1,
    state: 'running',
    pid: process.pid,
    instanceId: 'fake-host',
    sessionFile,
    sessionKey,
    lane: 'main',
    socketPath,
    heartbeatAt: new Date().toISOString(),
    activePromptId: 'active-prompt',
    pendingPrompts: 0,
  }, null, 2));
  return socketPath;
}

test('pi-sync does not replay a completed host history over already-rendered persisted messages', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-stale-completed-history-'));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'shared.jsonl');
  const piWrapper = writePiWrapper(root);
  writeSession(sessionFile, root, [
    userMessage('SYNC_STALE_DONE_PROMPT'),
    assistantMessage('SYNC_STALE_DONE_RESPONSE'),
  ]);
  const canonicalSessionFile = realpathSync(sessionFile);
  const sessionKey = stableSessionKey(canonicalSessionFile);
  const socketPath = writeFakeActiveHost({
    laneRoot,
    sessionKey,
    sessionFile: canonicalSessionFile,
    prompt: 'SYNC_STALE_DONE_PROMPT',
    response: 'SYNC_STALE_DONE_RESPONSE',
    includeAssistantInSession: true,
  });
  const server = await startFakeHost(socketPath);
  let mock;

  try {
    mock = await createInteractiveMock({
      brain: () => { throw new Error('provider should not be called'); },
      extensions: [EXTENSION],
      piProvider: 'pi-mock',
      piModel: 'mock',
      startupTimeoutMs: 20_000,
      terminal: { cols: 100, rows: 32 },
      cwd: root,
      env: { PI_LANE_ROOT: laneRoot, PI_LANE_SESSION_KEY: sessionKey, PI_LANE_SESSION_FILE: canonicalSessionFile, PI_SYNC_POLL_MS: '25', PI_SYNC_HOST_IDLE_MS: '5000' },
      piBinary: piWrapper,
      piArgs: ['--session', sessionFile],
    });
    await mock.waitForOutput('SYNC_STALE_DONE_RESPONSE', TIMEOUT);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const screen = await mock.visibleScreen();
    assert.equal(countVisible(screen, 'SYNC_STALE_DONE_PROMPT'), 1, screen.join('\n'));
    assert.equal(countVisible(screen, 'SYNC_STALE_DONE_RESPONSE'), 1, screen.join('\n'));
  } finally {
    await mock?.close();
    await closeServer(server);
    await removeRoot(root);
    rmSync(socketPath, { force: true });
  }
});

test('pi-sync replays only the missing assistant side when the user prompt is already persisted', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-partial-history-'));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'shared.jsonl');
  const piWrapper = writePiWrapper(root);
  writeSession(sessionFile, root, [userMessage('SYNC_PARTIAL_PROMPT')]);
  const canonicalSessionFile = realpathSync(sessionFile);
  const sessionKey = stableSessionKey(canonicalSessionFile);
  const socketPath = writeFakeActiveHost({
    laneRoot,
    sessionKey,
    sessionFile: canonicalSessionFile,
    prompt: 'SYNC_PARTIAL_PROMPT',
    response: 'SYNC_PARTIAL_RESPONSE',
    includeAssistantInSession: false,
  });
  const server = await startFakeHost(socketPath);
  let mock;

  try {
    mock = await createInteractiveMock({
      brain: () => { throw new Error('provider should not be called'); },
      extensions: [EXTENSION],
      piProvider: 'pi-mock',
      piModel: 'mock',
      startupTimeoutMs: 20_000,
      terminal: { cols: 100, rows: 32 },
      cwd: root,
      env: { PI_LANE_ROOT: laneRoot, PI_LANE_SESSION_KEY: sessionKey, PI_LANE_SESSION_FILE: canonicalSessionFile, PI_SYNC_POLL_MS: '25', PI_SYNC_HOST_IDLE_MS: '5000' },
      piBinary: piWrapper,
      piArgs: ['--session', sessionFile],
    });
    await mock.waitForOutput('SYNC_PARTIAL_RESPONSE', TIMEOUT);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const screen = await mock.visibleScreen();
    assert.equal(countVisible(screen, 'SYNC_PARTIAL_PROMPT'), 1, screen.join('\n'));
    assert.equal(countVisible(screen, 'SYNC_PARTIAL_RESPONSE'), 1, screen.join('\n'));
  } finally {
    await mock?.close();
    await closeServer(server);
    await removeRoot(root);
    rmSync(socketPath, { force: true });
  }
});
