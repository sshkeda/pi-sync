import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { createInteractiveMock, createControllableBrain, text } from '../../pi-mock/dist/index.js';

const EXTENSION = new URL('../index.ts', import.meta.url).pathname;
const PI_LANE_EXT = new URL('../../pi-lane/src/extension.ts', import.meta.url).pathname;
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

    const hostEventsPath = join(laneRoot, 'sessions', stableSessionKey(realpathSync(sessionFile)), 'lanes', 'main', 'sync', 'host-events.jsonl');
    await waitUntil(
      () => existsSync(hostEventsPath) && readFileSync(hostEventsPath, 'utf8').includes('"type":"abort_requested"'),
      TIMEOUT,
      'host abort_requested event',
    );

    await a.waitForOutput(/Operation aborted|aborted/i, TIMEOUT);
    await b.waitForOutput(/Operation aborted|aborted/i, TIMEOUT);

    call.respond(text('SYNC_ABORT_SHOULD_NOT_RENDER'));
    await new Promise((resolve) => setTimeout(resolve, 750));
    assert.doesNotMatch(a.output, /SYNC_ABORT_SHOULD_NOT_RENDER/);
    assert.doesNotMatch(b.output, /SYNC_ABORT_SHOULD_NOT_RENDER/);
  } finally {
    await a.close();
    await b.close();
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

    const hostEventsPath = join(laneRoot, 'sessions', stableSessionKey(realpathSync(sessionFile)), 'lanes', 'main', 'sync', 'host-events.jsonl');
    await waitUntil(
      () => existsSync(hostEventsPath) && readFileSync(hostEventsPath, 'utf8').includes('"type":"abort_requested"'),
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
    env: { PI_LANE_ROOT: laneRoot, PI_SYNC_POLL_MS: '25', PI_SYNC_HOST_IDLE_MS: '5000', PI_SYNC_HOST_RECONNECT_MS: '25' },
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

test('pi-sync forwards Escape abort after tree navigation on the same sync lane', { timeout: 120_000 }, async () => {
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
    extensions: [PI_LANE_EXT, EXTENSION, helperExt],
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
    await waitUntil(
      () => existsSync(navPath) && readFileSync(navPath, 'utf8').includes('SYNC_BRANCH_ABORT_BASE_ANSWER'),
      TIMEOUT,
      'tree navigation helper completion',
    );

    branch.clearOutput();
    aborter.clearOutput();
    branch.submit('SYNC_BRANCH_ABORT_PROMPT');
    call = await brain.waitForCall(TIMEOUT);
    await aborter.waitForOutput('SYNC_BRANCH_ABORT_PROMPT', TIMEOUT);

    aborter.sendKey('escape');

    const hostEventsPath = join(laneRoot, 'sessions', stableSessionKey(realpathSync(sessionFile)), 'lanes', 'main', 'sync', 'host-events.jsonl');
    await waitUntil(
      () => existsSync(hostEventsPath) && readFileSync(hostEventsPath, 'utf8').includes('"type":"abort_requested"'),
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
