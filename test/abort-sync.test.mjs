import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { createInteractiveMock, createControllableBrain, bash, streamText, text } from '../../pi-mock/dist/index.js';

const EXTENSION = new URL('../index.ts', import.meta.url).pathname;
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
      await new Promise((resolve) => setTimeout(resolve, 1000));
      release();
    }
  });
}

function writePiWrapper(root) {
  const piWrapper = join(root, 'pi-wrapper.sh');
  writeFileSync(piWrapper, `#!/usr/bin/env bash\nargs=()\nfor a in "$@"; do [[ "$a" == "--no-session" ]] && continue; args+=("$a"); done\nexec "${process.env.PI_SYNC_TEST_PI_BINARY ?? 'pi'}" "\${args[@]}"\n`);
  chmodSync(piWrapper, 0o755);
  return piWrapper;
}

function stableSessionKey(sessionFile) {
  return createHash('sha256').update(sessionFile).digest('hex').slice(0, 24);
}

function syncDir(laneRoot, sessionKey, lane = 'main') {
  return join(laneRoot, 'sessions', sessionKey, 'lanes', lane, 'sync');
}

function hostSocketPath(laneRoot, sessionKey, lane = 'main') {
  const key = createHash('sha256').update(`${syncDir(laneRoot, sessionKey, lane)}:${process.env.USER ?? 'user'}`).digest('hex').slice(0, 24);
  return join(process.env.TMPDIR ?? '/tmp', `pi-sync-${key}.sock`);
}

function findHostEventsPath(laneRoot, lane) {
  const sessionsDir = join(laneRoot, 'sessions');
  if (!existsSync(sessionsDir)) return undefined;
  for (const sessionKey of readdirSync(sessionsDir)) {
    const lanesDir = join(sessionsDir, sessionKey, 'lanes');
    if (!existsSync(lanesDir)) continue;
    const lanes = lane ? [lane] : readdirSync(lanesDir).filter((item) => !item.endsWith('.json'));
    for (const laneName of lanes) {
      const candidate = join(lanesDir, laneName, 'sync', 'host-events.jsonl');
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function hostEventsContain(laneRoot, needle) {
  const sessionsDir = join(laneRoot, 'sessions');
  if (!existsSync(sessionsDir)) return false;
  for (const sessionKey of readdirSync(sessionsDir)) {
    const lanesDir = join(sessionsDir, sessionKey, 'lanes');
    if (!existsSync(lanesDir)) continue;
    for (const laneName of readdirSync(lanesDir).filter((item) => !item.endsWith('.json'))) {
      const candidate = join(lanesDir, laneName, 'sync', 'host-events.jsonl');
      if (existsSync(candidate) && readFileSync(candidate, 'utf8').includes(needle)) return true;
    }
  }
  return false;
}

function findHostJsonPath(laneRoot) {
  const sessionsDir = join(laneRoot, 'sessions');
  if (!existsSync(sessionsDir)) return undefined;
  for (const sessionKey of readdirSync(sessionsDir)) {
    const lanesDir = join(sessionsDir, sessionKey, 'lanes');
    if (!existsSync(lanesDir)) continue;
    for (const laneName of readdirSync(lanesDir).filter((item) => !item.endsWith('.json'))) {
      const candidate = join(lanesDir, laneName, 'sync', 'host.json');
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

async function startAbortCaptureServer(socketPath) {
  rmSync(socketPath, { force: true });
  let resolveAbort;
  const abortFrame = new Promise((resolve) => { resolveAbort = resolve; });
  const server = createServer((socket) => {
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === 'abort') resolveAbort(parsed);
        } catch {}
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return { server, abortFrame };
}

async function startFrameCaptureServer(socketPath) {
  rmSync(socketPath, { force: true });
  const frames = [];
  const server = createServer((socket) => {
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          frames.push(JSON.parse(line));
        } catch {}
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return { server, frames };
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(() => resolve()));
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

function findMessageEntry(sessionFile, textValue) {
  const entry = readSessionEntries(sessionFile).find((item) => messageText(item) === textValue);
  assert.ok(entry, `missing session entry with text ${textValue}`);
  return entry;
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
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

function countVisible(lines, needle) {
  return lines.filter((line) => line.includes(needle)).length;
}

function normalizeVisibleScreen(lines) {
  return lines.map((line) => line.replace(/\s+$/g, ''));
}

async function waitForSameVisibleScreen(a, b, timeoutMs, label) {
  const start = Date.now();
  let lastA = [];
  let lastB = [];
  while (Date.now() - start < timeoutMs) {
    lastA = normalizeVisibleScreen(await a.visibleScreen());
    lastB = normalizeVisibleScreen(await b.visibleScreen());
    if (JSON.stringify(lastA) === JSON.stringify(lastB)) return { a: lastA, b: lastB };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.deepEqual(lastB, lastA, `${label}\n--- terminal a ---\n${lastA.join('\n')}\n--- terminal b ---\n${lastB.join('\n')}`);
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

test('pi-sync forwards Escape abort from an attached terminal to the active host turn', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-abort-'));
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
    a.submit('SYNC_ABORT_PROMPT');
    const call = await brain.waitForCall(TIMEOUT);
    await b.waitForOutput('SYNC_ABORT_PROMPT', TIMEOUT);

    b.sendKey('escape');

    await waitUntil(
      () => {
        const hostEventsPath = findHostEventsPath(laneRoot);
        return !!hostEventsPath && readFileSync(hostEventsPath, 'utf8').includes('"type":"abort_requested"');
      },
      TIMEOUT,
      'host abort_requested event',
    );

    await a.waitForOutput(/Operation aborted|aborted/i, TIMEOUT);
    await b.waitForOutput(/Operation aborted|aborted/i, TIMEOUT);

    call.respond(text('SYNC_ABORT_SHOULD_NOT_RENDER'));
    await new Promise((resolve) => setTimeout(resolve, 750));
    assert.doesNotMatch(a.output, /SYNC_ABORT_SHOULD_NOT_RENDER/);
    assert.doesNotMatch(b.output, /SYNC_ABORT_SHOULD_NOT_RENDER/);

    const screenA = await a.visibleScreen();
    const screenB = await b.visibleScreen();
    assert.equal(countVisible(screenA, 'Operation aborted'), 1, screenA.join('\n'));
    assert.equal(countVisible(screenB, 'Operation aborted'), 1, screenB.join('\n'));
    await waitForSameVisibleScreen(a, b, 2_000, 'attached terminals should settle to the same abort UI');
  } finally {
    await a.close();
    await b.close();
    await removeRoot(root);
  }
});

test('pi-sync does not steal Escape when no host turn is active', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-idle-escape-'));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'shared.jsonl');
  const piWrapper = writePiWrapper(root);
  const escapeProbeExt = join(root, 'escape-probe.mjs');
  writeFileSync(sessionFile, '', 'utf8');
  writeFileSync(escapeProbeExt, `
export default function escapeProbe(pi) {
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    ctx.ui.onTerminalInput((data) => {
      if (data !== "\\x1b") return undefined;
      ctx.ui.notify("escape_passthrough_idle", "info");
      return undefined;
    });
  });
}
`, 'utf8');

  const mock = await createInteractiveMock({
    brain: createControllableBrain().brain,
    extensions: [EXTENSION, escapeProbeExt],
    piProvider: 'pi-mock',
    piModel: 'mock',
    startupTimeoutMs: 20_000,
    terminal: { cols: 100, rows: 32 },
    cwd: root,
    env: { PI_LANE_ROOT: laneRoot, PI_SYNC_POLL_MS: '25', PI_SYNC_HOST_IDLE_MS: '10000' },
    piBinary: piWrapper,
    piArgs: ['--session', sessionFile],
  });

  try {
    await waitUntil(
      () => {
        const hostJsonPath = findHostJsonPath(laneRoot);
        if (!hostJsonPath) return false;
        const host = JSON.parse(readFileSync(hostJsonPath, 'utf8'));
        return host.state === 'running' && existsSync(host.socketPath);
      },
      TIMEOUT,
      'host socket attached while idle',
    );
    mock.clearOutput();
    mock.sendKey('escape');
    await mock.waitForOutput('escape_passthrough_idle', TIMEOUT);
    assert.doesNotMatch(mock.output, /Operation aborted|abort_requested|pi-sync: host not ready/i);
  } finally {
    await mock.close();
    await removeRoot(root);
  }
});

test('pi-sync cancels an unsent cold-host prompt on immediate Escape', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-cold-abort-'));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'shared.jsonl');
  const piWrapper = writePiWrapper(root);
  writeFileSync(sessionFile, '', 'utf8');
  const canonicalSessionFile = realpathSync(sessionFile);
  const sessionKey = stableSessionKey(canonicalSessionFile);
  const dir = syncDir(laneRoot, sessionKey);
  const socketPath = hostSocketPath(laneRoot, sessionKey);
  mkdirSync(join(dir, 'host.lock'), { recursive: true });
  writeFileSync(join(dir, 'host.json'), JSON.stringify({
    schemaVersion: 1,
    state: 'running',
    pid: process.pid,
    instanceId: 'fake-cold-host',
    sessionFile: canonicalSessionFile,
    sessionKey,
    lane: 'main',
    socketPath,
    heartbeatAt: new Date().toISOString(),
    activePromptId: null,
    pendingPrompts: 0,
  }, null, 2));

  const brain = createControllableBrain();
  const mock = await createInteractiveMock({
    brain: brain.brain,
    extensions: [EXTENSION],
    piProvider: 'pi-mock',
    piModel: 'mock',
    startupTimeoutMs: 20_000,
    terminal: { cols: 100, rows: 32 },
    cwd: root,
    env: { PI_LANE_ROOT: laneRoot, PI_LANE_SESSION_KEY: sessionKey, PI_LANE_SESSION_FILE: canonicalSessionFile, PI_SYNC_POLL_MS: '25', PI_SYNC_HOST_IDLE_MS: '5000', PI_SYNC_HOST_RECONNECT_MS: '25' },
    piBinary: piWrapper,
    piArgs: ['--session', sessionFile],
  });
  let server;
  try {
    mock.submit('SYNC_COLD_ABORT_SHOULD_NOT_SEND');
    await mock.waitForOutput('SYNC_COLD_ABORT_SHOULD_NOT_SEND', TIMEOUT);
    mock.sendKey('escape');

    const capture = await startFrameCaptureServer(socketPath);
    server = capture.server;
    await new Promise((resolve) => setTimeout(resolve, 750));
    assert.deepEqual(capture.frames, [], `immediate abort should not send queued prompt frames:\n${JSON.stringify(capture.frames, null, 2)}`);
    assert.equal(brain.pending().length, 0, 'provider should not receive a cancelled cold-host prompt');
  } finally {
    await mock.close();
    if (server) await closeServer(server);
    rmSync(socketPath, { force: true });
    await removeRoot(root);
  }
});

test('pi-sync forwards Escape abort from the submitting terminal to the active host turn', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-own-abort-'));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'shared.jsonl');
  const piWrapper = writePiWrapper(root);
  const brain = createControllableBrain();
  writeFileSync(sessionFile, '', 'utf8');

  const mock = await createInteractiveMock({
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
  });

  try {
    mock.clearOutput();
    mock.submit('SYNC_OWN_ABORT_PROMPT');
    const call = await brain.waitForCall(TIMEOUT);
    await mock.waitForOutput('SYNC_OWN_ABORT_PROMPT', TIMEOUT);

    mock.sendKey('escape');

    await waitUntil(
      () => {
        const hostEventsPath = findHostEventsPath(laneRoot);
        return !!hostEventsPath && readFileSync(hostEventsPath, 'utf8').includes('"type":"abort_requested"');
      },
      TIMEOUT,
      'own-terminal host abort_requested event',
    );

    await mock.waitForOutput(/Operation aborted|aborted/i, TIMEOUT);

    call.respond(text('SYNC_OWN_ABORT_SHOULD_NOT_RENDER'));
    await new Promise((resolve) => setTimeout(resolve, 750));
    assert.doesNotMatch(mock.output, /SYNC_OWN_ABORT_SHOULD_NOT_RENDER/);
  } finally {
    await mock.close();
    await removeRoot(root);
  }
});

test('pi-sync aborts an active long-running bash tool from an attached terminal', { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-bash-abort-'));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'shared.jsonl');
  const startedMarker = join(root, 'bash-tool-started');
  const doneMarker = join(root, 'bash-tool-done');
  const piWrapper = writePiWrapper(root);
  const brain = createControllableBrain();
  writeFileSync(sessionFile, '', 'utf8');

  const common = {
    brain: brain.brain,
    extensions: [EXTENSION],
    piProvider: 'pi-mock',
    piModel: 'mock',
    startupTimeoutMs: 20_000,
    terminal: { cols: 100, rows: 36 },
    cwd: root,
    env: { PI_LANE_ROOT: laneRoot, PI_SYNC_POLL_MS: '25', PI_SYNC_HOST_IDLE_MS: '1000' },
    piBinary: piWrapper,
    piArgs: ['--session', sessionFile],
  };

  const submitter = await createInteractiveMock(common);
  const peer = await createInteractiveMock(common);
  try {
    submitter.clearOutput();
    peer.clearOutput();
    submitter.submit('SYNC_BASH_ABORT_PROMPT');
    const call = await brain.waitForCall(TIMEOUT);
    assert.match(JSON.stringify(call.request), /SYNC_BASH_ABORT_PROMPT/);
    call.respond(bash(`node -e "const fs = require('fs'); fs.writeFileSync('bash-tool-started', '1'); setTimeout(() => { fs.writeFileSync('bash-tool-done', '1'); console.log('SYNC_BASH_ABORT_SHOULD_NOT_RENDER'); }, 2500)"`));

    await waitUntil(() => existsSync(startedMarker), TIMEOUT, 'long bash tool started');
    await peer.waitForOutput('SYNC_BASH_ABORT_PROMPT', TIMEOUT);

    peer.sendKey('escape');

    await waitUntil(
      () => hostEventsContain(laneRoot, '"type":"abort_requested"'),
      TIMEOUT,
      'bash tool host abort_requested event',
    );

    await submitter.waitForOutput(/Operation aborted|aborted/i, TIMEOUT);
    await peer.waitForOutput(/Operation aborted|aborted/i, TIMEOUT);

    await new Promise((resolve) => setTimeout(resolve, 3200));
    assert.equal(existsSync(doneMarker), false, 'aborted bash tool should not reach its completion marker');
    assert.equal(brain.pending().length, 0, 'aborted bash tool should not trigger a tool-result continuation');
  } finally {
    await submitter.close();
    await peer.close();
    await removeRoot(root);
  }
});

test('pi-sync aborts an actively streaming chat response', { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-stream-abort-'));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'shared.jsonl');
  const piWrapper = writePiWrapper(root);
  const brain = createControllableBrain();
  writeFileSync(sessionFile, '', 'utf8');

  const mock = await createInteractiveMock({
    brain: brain.brain,
    extensions: [EXTENSION],
    piProvider: 'pi-mock',
    piModel: 'mock',
    startupTimeoutMs: 20_000,
    terminal: { cols: 100, rows: 34 },
    cwd: root,
    env: { PI_LANE_ROOT: laneRoot, PI_SYNC_POLL_MS: '25', PI_SYNC_HOST_IDLE_MS: '1000' },
    piBinary: piWrapper,
    piArgs: ['--session', sessionFile],
  });

  try {
    mock.clearOutput();
    mock.submit('SYNC_STREAM_ABORT_PROMPT');
    const call = await brain.waitForCall(TIMEOUT);
    call.respond(streamText([
      'SYNC_STREAM_CHUNK_1 ',
      'SYNC_STREAM_CHUNK_2 ',
      'SYNC_STREAM_ABORT_SHOULD_NOT_RENDER',
    ], 750));

    await mock.waitForOutput('SYNC_STREAM_CHUNK_1', TIMEOUT);
    mock.sendKey('escape');

    await waitUntil(
      () => hostEventsContain(laneRoot, '"type":"abort_requested"'),
      TIMEOUT,
      'streaming chat host abort_requested event',
    );
    await mock.waitForOutput(/Operation aborted|aborted/i, TIMEOUT);

    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.doesNotMatch(mock.output, /SYNC_STREAM_ABORT_SHOULD_NOT_RENDER/);
  } finally {
    await mock.close();
    await removeRoot(root);
  }
});

test('pi-sync queues Escape abort while the active host socket is reconnecting', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-abort-reconnect-'));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'shared.jsonl');
  const piWrapper = writePiWrapper(root);
  writeFileSync(sessionFile, '', 'utf8');
  const canonicalSessionFile = realpathSync(sessionFile);
  const sessionKey = stableSessionKey(canonicalSessionFile);
  const dir = syncDir(laneRoot, sessionKey);
  const socketPath = hostSocketPath(laneRoot, sessionKey);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, 'host.lock'), { recursive: true });
  writeFileSync(join(dir, 'host.json'), JSON.stringify({
    schemaVersion: 1,
    state: 'running',
    pid: process.pid,
    instanceId: 'fake-active-host',
    sessionFile: canonicalSessionFile,
    sessionKey,
    lane: 'main',
    socketPath,
    heartbeatAt: new Date().toISOString(),
    activePromptId: 'active-prompt',
    pendingPrompts: 0,
  }, null, 2));

  const mock = await createInteractiveMock({
    brain: () => { throw new Error('provider should not be called'); },
    extensions: [EXTENSION],
    piProvider: 'pi-mock',
    piModel: 'mock',
    startupTimeoutMs: 20_000,
    terminal: { cols: 100, rows: 32 },
    cwd: root,
    env: { PI_LANE_ROOT: laneRoot, PI_LANE_SESSION_KEY: sessionKey, PI_LANE_SESSION_FILE: canonicalSessionFile, PI_SYNC_POLL_MS: '25', PI_SYNC_HOST_IDLE_MS: '5000', PI_SYNC_HOST_RECONNECT_MS: '25' },
    piBinary: piWrapper,
    piArgs: ['--session', sessionFile],
  });
  let server;
  try {
    mock.sendKey('escape');
    const capture = await startAbortCaptureServer(socketPath);
    server = capture.server;
    const frame = await Promise.race([
      capture.abortFrame,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout waiting for queued abort frame')), TIMEOUT)),
    ]);
    assert.equal(frame.type, 'abort');
    assert.equal(frame.source, 'pi-sync');
  } finally {
    await mock.close();
    if (server) await closeServer(server);
    rmSync(socketPath, { force: true });
    await removeRoot(root);
  }
});

test('pi-sync treats enhanced terminal Escape sequences as abort keys', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-enhanced-escape-'));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'shared.jsonl');
  const piWrapper = writePiWrapper(root);
  writeFileSync(sessionFile, '', 'utf8');
  const canonicalSessionFile = realpathSync(sessionFile);
  const sessionKey = stableSessionKey(canonicalSessionFile);
  const dir = syncDir(laneRoot, sessionKey);
  const socketPath = hostSocketPath(laneRoot, sessionKey);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, 'host.lock'), { recursive: true });
  writeFileSync(join(dir, 'host.json'), JSON.stringify({
    schemaVersion: 1,
    state: 'running',
    pid: process.pid,
    instanceId: 'fake-enhanced-escape-host',
    sessionFile: canonicalSessionFile,
    sessionKey,
    lane: 'main',
    socketPath,
    heartbeatAt: new Date().toISOString(),
    activePromptId: 'active-prompt',
    pendingPrompts: 0,
  }, null, 2));

  const capture = await startAbortCaptureServer(socketPath);
  const mock = await createInteractiveMock({
    brain: () => { throw new Error('provider should not be called'); },
    extensions: [EXTENSION],
    piProvider: 'pi-mock',
    piModel: 'mock',
    startupTimeoutMs: 20_000,
    terminal: { cols: 100, rows: 32 },
    cwd: root,
    env: { PI_LANE_ROOT: laneRoot, PI_LANE_SESSION_KEY: sessionKey, PI_LANE_SESSION_FILE: canonicalSessionFile, PI_SYNC_POLL_MS: '25', PI_SYNC_HOST_IDLE_MS: '5000', PI_SYNC_HOST_RECONNECT_MS: '25' },
    piBinary: piWrapper,
    piArgs: ['--session', sessionFile],
  });

  try {
    mock.type('\x1b[27u');
    const frame = await Promise.race([
      capture.abortFrame,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout waiting for enhanced escape abort frame')), TIMEOUT)),
    ]);
    assert.equal(frame.type, 'abort');
    assert.equal(frame.source, 'pi-sync');
  } finally {
    await mock.close();
    await closeServer(capture.server);
    rmSync(socketPath, { force: true });
    await removeRoot(root);
  }
});

test('pi-sync forwards Escape abort after peers join the same tree sync lane', { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-branch-abort-'));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'shared.jsonl');
  const piWrapper = writePiWrapper(root);
  const helperExt = join(root, 'tree-nav-helper.mjs');
  const navPath = join(root, 'tree-nav.json');
  const brain = createControllableBrain();
  writeFileSync(sessionFile, '', 'utf8');
  writeFileSync(helperExt, `
import { writeFileSync } from "node:fs";
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
      writeFileSync(${JSON.stringify(navPath)}, JSON.stringify({ leafId: ctx.sessionManager.getLeafId(), wanted }) + "\\n");
      ctx.ui.notify("leaf_after_nav:" + ctx.sessionManager.getLeafId(), "info");
    },
  });
}
`, 'utf8');

  const common = {
    brain: brain.brain,
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

  const main = await createInteractiveMock(common);
  const branch = await createInteractiveMock(common);
  const aborter = await createInteractiveMock(common);
  try {
    main.submit('SYNC_BRANCH_ABORT_BASE_PROMPT');
    let call = await brain.waitForCall(TIMEOUT);
    call.respond(text('SYNC_BRANCH_ABORT_BASE_ANSWER'));
    await main.waitForOutput('SYNC_BRANCH_ABORT_BASE_ANSWER', TIMEOUT);
    await branch.waitForOutput('SYNC_BRANCH_ABORT_BASE_ANSWER', TIMEOUT);
    await aborter.waitForOutput('SYNC_BRANCH_ABORT_BASE_ANSWER', TIMEOUT);

    main.submit('SYNC_BRANCH_ABORT_MAIN_PROMPT');
    call = await brain.waitForCall(TIMEOUT);
    call.respond(text('SYNC_BRANCH_ABORT_MAIN_ANSWER'));
    await main.waitForOutput('SYNC_BRANCH_ABORT_MAIN_ANSWER', TIMEOUT);
    await branch.waitForOutput('SYNC_BRANCH_ABORT_MAIN_ANSWER', TIMEOUT);

    const navStart = Date.now();
    while (Date.now() - navStart < TIMEOUT) {
      branch.submit('/_tree_nav_to_text SYNC_BRANCH_ABORT_BASE_ANSWER');
      if (await waitUntilQuiet(
        () => existsSync(navPath) && readFileSync(navPath, 'utf8').includes('SYNC_BRANCH_ABORT_BASE_ANSWER'),
        5_000,
      )) break;
      branch.clearOutput();
    }
    assert.ok(
      existsSync(navPath) && readFileSync(navPath, 'utf8').includes('SYNC_BRANCH_ABORT_BASE_ANSWER'),
      `tree navigation helper did not complete; branch output:\n${branch.output}`,
    );
    await waitUntil(
      () => existsSync(navPath) && readFileSync(navPath, 'utf8').includes('SYNC_BRANCH_ABORT_BASE_ANSWER'),
      TIMEOUT,
      'tree navigation helper completion',
    );
    aborter.submit('/_tree_nav_to_text SYNC_BRANCH_ABORT_BASE_ANSWER');
    await aborter.waitForOutput('leaf_after_nav:', TIMEOUT);

    branch.clearOutput();
    aborter.clearOutput();
    branch.submit('SYNC_BRANCH_ABORT_PROMPT');
    call = await brain.waitForCall(TIMEOUT);
    await aborter.waitForOutput('SYNC_BRANCH_ABORT_PROMPT', TIMEOUT);
    await waitUntil(
      () => {
        return hostEventsContain(laneRoot, '"type":"prompt_start"');
      },
      TIMEOUT,
      'branch host prompt_start event',
    );

    aborter.sendKey('escape');

    await waitUntil(
      () => {
        return hostEventsContain(laneRoot, '"type":"abort_requested"');
      },
      TIMEOUT,
      'branch host abort_requested event',
    );

    await branch.waitForOutput(/Operation aborted|aborted/i, TIMEOUT);
    await aborter.waitForOutput(/Operation aborted|aborted/i, TIMEOUT);

    call.respond(text('SYNC_BRANCH_ABORT_SHOULD_NOT_RENDER'));
    await new Promise((resolve) => setTimeout(resolve, 750));
    assert.doesNotMatch(branch.output, /SYNC_BRANCH_ABORT_SHOULD_NOT_RENDER/);
    assert.doesNotMatch(aborter.output, /SYNC_BRANCH_ABORT_SHOULD_NOT_RENDER/);
  } finally {
    await main.close();
    await branch.close();
    await aborter.close();
    await removeRoot(root);
  }
});
