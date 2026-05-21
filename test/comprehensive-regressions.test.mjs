import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInteractiveMock, createControllableBrain, text } from '../../pi-mock/dist/index.js';

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

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = predicate();
    if (result) return result;
    await sleep(25);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function removeRoot(root) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 4 || !['ENOTEMPTY', 'EBUSY', 'ENOENT'].includes(error?.code)) throw error;
      await sleep(100);
    }
  }
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
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
  return readJsonl(sessionFile).find((entry) => messageText(entry) === textValue);
}

async function waitForMessageEntry(sessionFile, textValue, timeoutMs = TIMEOUT) {
  await waitUntil(() => !!findMessageEntry(sessionFile, textValue), timeoutMs, `session entry ${textValue}`);
}

function countVisible(lines, needle) {
  return lines.filter((line) => line.includes(needle)).length;
}

function screenText(lines) {
  return lines.join('\n');
}

function findFiles(dir, predicate) {
  if (!existsSync(dir)) return [];
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findFiles(path, predicate));
    else if (entry.isFile() && predicate(path)) found.push(path);
  }
  return found;
}

function findHostJsonPath(laneRoot, lane = 'main') {
  const candidates = findFiles(laneRoot, (path) => path.endsWith('/host.json') && path.includes(`/lanes/${lane}/sync/`));
  candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return candidates[0];
}

function readFreshHost(laneRoot, lane = 'main') {
  const path = findHostJsonPath(laneRoot, lane);
  if (!path) return undefined;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function findPromptQueuePath(laneRoot, lane) {
  const candidates = findFiles(laneRoot, (path) => path.endsWith('/prompt-queue.jsonl') && (!lane || path.includes(`/lanes/${lane}/sync/`)));
  candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return candidates[0];
}

function livePid(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForNoLiveHosts(laneRoot, timeoutMs = TIMEOUT) {
  await waitUntil(() => {
    const hosts = findFiles(laneRoot, (path) => path.endsWith('/host.json'))
      .map((path) => {
        try {
          return JSON.parse(readFileSync(path, 'utf8'));
        } catch {
          return undefined;
        }
      })
      .filter(Boolean);
    return hosts.every((host) => !livePid(host.pid));
  }, timeoutMs, 'no live sync hosts');
}

async function createPair(prefix, options = {}) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'shared.jsonl');
  const piWrapper = writePiWrapper(root);
  const brain = createControllableBrain();
  writeFileSync(sessionFile, '', 'utf8');
  const common = {
    brain: brain.brain,
    extensions: options.extensions ?? [EXTENSION],
    piProvider: 'pi-mock',
    piModel: 'mock',
    startupTimeoutMs: 20_000,
    terminal: { cols: 110, rows: 36 },
    cwd: root,
    env: {
      PI_LANE_ROOT: laneRoot,
      PI_SYNC_POLL_MS: '25',
      PI_SYNC_HOST_IDLE_MS: options.hostIdleMs ?? '1000',
      PI_SYNC_INSTANCE_STALE_MS: '5000',
      ...(options.env ?? {}),
    },
    piBinary: piWrapper,
    piArgs: ['--session', sessionFile],
  };
  const a = await createInteractiveMock(common);
  const b = await createInteractiveMock(common);
  return { root, laneRoot, sessionFile, brain, a, b };
}

test('pi-sync recovers after the sync host dies mid-turn without duplicating old UI', { timeout: 120_000 }, async () => {
  const { root, laneRoot, brain, a, b } = await createPair('pi-sync-host-crash-recovery-', { hostIdleMs: '5000' });
  try {
    a.clearOutput();
    b.clearOutput();
    a.submit('SYNC_CRASH_ACTIVE_PROMPT');
    await brain.waitForCall(TIMEOUT);
    await b.waitForOutput('SYNC_CRASH_ACTIVE_PROMPT', TIMEOUT);

    const firstHost = await waitUntil(() => readFreshHost(laneRoot, 'main')?.activePromptId && readFreshHost(laneRoot, 'main'), TIMEOUT, 'active host before crash');
    process.kill(firstHost.pid, 'SIGKILL');
    await waitUntil(() => !livePid(firstHost.pid), TIMEOUT, 'old host process exit');

    b.clearOutput();
    b.submit('SYNC_CRASH_RECOVERY_PROMPT');
    const recoveryCall = await brain.waitForCall(TIMEOUT);
    assert.match(JSON.stringify(recoveryCall.request), /SYNC_CRASH_RECOVERY_PROMPT/);
    recoveryCall.respond(text('SYNC_CRASH_RECOVERY_RESPONSE'));
    await a.waitForOutput('SYNC_CRASH_RECOVERY_RESPONSE', TIMEOUT);
    await b.waitForOutput('SYNC_CRASH_RECOVERY_RESPONSE', TIMEOUT);

    const secondHost = await waitUntil(() => {
      const host = readFreshHost(laneRoot, 'main');
      return host?.pid && host.pid !== firstHost.pid && host;
    }, TIMEOUT, 'replacement host');
    assert.notEqual(secondHost.pid, firstHost.pid);
    assert.equal(countVisible(await b.visibleScreen(), 'SYNC_CRASH_ACTIVE_PROMPT'), 0, 'cleared peer should not redraw crashed active prompt');
    assert.equal(countVisible(await b.visibleScreen(), 'SYNC_CRASH_RECOVERY_RESPONSE'), 1);
  } finally {
    await a.close();
    await b.close();
    await waitForNoLiveHosts(laneRoot);
    await removeRoot(root);
  }
});

test('pi-sync recovers queued peer prompts after a sync host crash', { timeout: 120_000 }, async () => {
  const { root, laneRoot, brain, a, b, sessionFile } = await createPair('pi-sync-host-queued-crash-', {
    hostIdleMs: '5000',
    env: {
      PI_SYNC_HOST_LEASE_MS: '300',
      PI_SYNC_HOST_RECONNECT_MS: '25',
    },
  });
  try {
    a.clearOutput();
    b.clearOutput();
    a.submit('SYNC_CRASH_QUEUE_ACTIVE_PROMPT');
    await brain.waitForCall(TIMEOUT);
    await b.waitForOutput('SYNC_CRASH_QUEUE_ACTIVE_PROMPT', TIMEOUT);

    b.submit('SYNC_CRASH_QUEUE_PEER_PROMPT');
    await waitUntil(() => {
      const path = findPromptQueuePath(laneRoot, 'main');
      return !!path && readFileSync(path, 'utf8').includes('SYNC_CRASH_QUEUE_PEER_PROMPT');
    }, TIMEOUT, 'queued peer prompt before host crash');
    assert.equal(brain.pending().length, 0, 'queued peer prompt should not start before the active prompt completes');

    const firstHost = await waitUntil(() => readFreshHost(laneRoot, 'main')?.activePromptId && readFreshHost(laneRoot, 'main'), TIMEOUT, 'active host before queued crash');
    process.kill(firstHost.pid, 'SIGKILL');
    await waitUntil(() => !livePid(firstHost.pid), TIMEOUT, 'old queued-crash host process exit');

    const queuedCall = await brain.waitForCall(TIMEOUT);
    assert.match(JSON.stringify(queuedCall.request), /SYNC_CRASH_QUEUE_PEER_PROMPT/);
    queuedCall.respond(text('SYNC_CRASH_QUEUE_PEER_RESPONSE'));

    await a.waitForOutput('SYNC_CRASH_QUEUE_PEER_RESPONSE', TIMEOUT);
    await b.waitForOutput('SYNC_CRASH_QUEUE_PEER_RESPONSE', TIMEOUT);

    const replacementHost = await waitUntil(() => {
      const host = readFreshHost(laneRoot, 'main');
      return host?.pid && host.pid !== firstHost.pid && host;
    }, TIMEOUT, 'replacement host after queued crash');
    assert.notEqual(replacementHost.pid, firstHost.pid);

    const queueEventsPath = findFiles(laneRoot, (path) => path.endsWith('/host-events.jsonl') && path.includes('/lanes/main/sync/'))[0];
    assert.match(readFileSync(queueEventsPath, 'utf8'), /prompt_queue_recovered/);
    assert.equal(readFileSync(sessionFile, 'utf8').match(/SYNC_CRASH_QUEUE_PEER_PROMPT/g)?.length, 1);
    assert.equal(readFileSync(sessionFile, 'utf8').match(/SYNC_CRASH_QUEUE_PEER_RESPONSE/g)?.length, 1);

    const screen = await b.visibleScreen();
    assert.equal(countVisible(screen, 'SYNC_CRASH_QUEUE_PEER_PROMPT'), 1, screenText(screen));
    assert.equal(countVisible(screen, 'SYNC_CRASH_QUEUE_PEER_RESPONSE'), 1, screenText(screen));
  } finally {
    await a.close();
    await b.close();
    await waitForNoLiveHosts(laneRoot);
    await removeRoot(root);
  }
});

test('pi-sync keeps active work alive when an attached peer closes, then shuts down after the final terminal closes', { timeout: 120_000 }, async () => {
  const { root, laneRoot, brain, a, b } = await createPair('pi-sync-close-active-', { hostIdleMs: '400' });
  try {
    a.clearOutput();
    b.clearOutput();
    a.submit('SYNC_CLOSE_ACTIVE_PROMPT');
    const call = await brain.waitForCall(TIMEOUT);
    await b.waitForOutput('SYNC_CLOSE_ACTIVE_PROMPT', TIMEOUT);
    const host = await waitUntil(() => {
      const current = readFreshHost(laneRoot, 'main');
      return current?.activePromptId && current.clients >= 2 && current;
    }, TIMEOUT, 'active host with both terminals attached');

    await b.close();
    await sleep(500);
    assert.equal(livePid(host.pid), true, 'host should remain alive while terminal a is attached');

    call.respond(text('SYNC_CLOSE_ACTIVE_RESPONSE'));
    await a.waitForOutput('SYNC_CLOSE_ACTIVE_RESPONSE', TIMEOUT);
    await a.close();
    await waitUntil(() => !livePid(host.pid), TIMEOUT, 'host exits after final terminal closes');
  } finally {
    try { await a.close(); } catch {}
    try { await b.close(); } catch {}
    await waitForNoLiveHosts(laneRoot);
    await removeRoot(root);
  }
});

test('pi-sync tree-navigation prompt stays isolated on its auto lane until peers join it', { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-tree-lane-isolation-'));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'shared.jsonl');
  const piWrapper = writePiWrapper(root);
  const helperExt = join(root, 'tree-nav-helper.mjs');
  const brain = createControllableBrain();
  writeFileSync(sessionFile, '', 'utf8');
  writeFileSync(helperExt, `
export default function treeNavHelper(pi) {
  pi.registerCommand("_tree_nav_to_text", {
    description: "Navigate to message text",
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

  const common = {
    brain: brain.brain,
    extensions: [EXTENSION, helperExt],
    piProvider: 'pi-mock',
    piModel: 'mock',
    startupTimeoutMs: 20_000,
    terminal: { cols: 110, rows: 36 },
    cwd: root,
    env: { PI_LANE_ROOT: laneRoot, PI_SYNC_POLL_MS: '25', PI_SYNC_HOST_IDLE_MS: '1000' },
    piBinary: piWrapper,
    piArgs: ['--session', sessionFile],
  };

  const main = await createInteractiveMock(common);
  const branch = await createInteractiveMock(common);
  try {
    main.submit('SYNC_TREE_BASE_PROMPT');
    let call = await brain.waitForCall(TIMEOUT);
    call.respond(text('SYNC_TREE_BASE_ANSWER'));
    await main.waitForOutput('SYNC_TREE_BASE_ANSWER', TIMEOUT);
    await branch.waitForOutput('SYNC_TREE_BASE_ANSWER', TIMEOUT);
    await waitForMessageEntry(sessionFile, 'SYNC_TREE_BASE_ANSWER');

    main.submit('SYNC_TREE_MAIN_PROMPT');
    call = await brain.waitForCall(TIMEOUT);
    call.respond(text('SYNC_TREE_MAIN_ANSWER'));
    await main.waitForOutput('SYNC_TREE_MAIN_ANSWER', TIMEOUT);
    await branch.waitForOutput('SYNC_TREE_MAIN_ANSWER', TIMEOUT);

    branch.submit('/_tree_nav_to_text SYNC_TREE_BASE_ANSWER');
    await branch.waitForOutput('leaf_after_nav:', TIMEOUT);
    branch.submit('/sync status');
    await branch.waitForOutput(/sync=~\/2 ln_[A-Za-z0-9_-]+/, TIMEOUT);

    main.clearOutput();
    branch.clearOutput();
    branch.submit('SYNC_TREE_BRANCH_PROMPT');
    call = await brain.waitForCall(TIMEOUT);
    call.respond(text('SYNC_TREE_BRANCH_RESPONSE'));
    await branch.waitForOutput('SYNC_TREE_BRANCH_RESPONSE', TIMEOUT);
    await sleep(750);

    assert.doesNotMatch(main.output, /SYNC_TREE_BRANCH_PROMPT|SYNC_TREE_BRANCH_RESPONSE/);
    assert.match(branch.output, /SYNC_TREE_BRANCH_PROMPT/);
    assert.match(branch.output, /SYNC_TREE_BRANCH_RESPONSE/);
  } finally {
    await main.close();
    await branch.close();
    await waitForNoLiveHosts(laneRoot);
    await removeRoot(root);
  }
});

test('pi-sync queues multiple peer prompts in order with no duplicate visible bubbles', { timeout: 120_000 }, async () => {
  const { root, laneRoot, brain, a, b } = await createPair('pi-sync-multi-queue-', { hostIdleMs: '10000' });
  try {
    a.clearOutput();
    b.clearOutput();
    a.submit('SYNC_QUEUE_ACTIVE_PROMPT');
    const firstCall = await brain.waitForCall(TIMEOUT);

    b.submit('SYNC_QUEUE_SECOND_PROMPT');
    b.submit('SYNC_QUEUE_THIRD_PROMPT');
    await waitUntil(() => {
      const path = findPromptQueuePath(laneRoot, 'main');
      if (!path) return false;
      const body = readFileSync(path, 'utf8');
      return body.includes('SYNC_QUEUE_SECOND_PROMPT') && body.includes('SYNC_QUEUE_THIRD_PROMPT');
    }, TIMEOUT, 'two queued prompts');
    assert.equal(brain.pending().length, 0, 'queued peer prompts should not start parallel model calls');

    firstCall.respond(text('SYNC_QUEUE_ACTIVE_RESPONSE'));
    await b.waitForOutput('SYNC_QUEUE_ACTIVE_RESPONSE', TIMEOUT);

    const secondCall = await brain.waitForCall(TIMEOUT);
    assert.match(JSON.stringify(secondCall.request), /SYNC_QUEUE_SECOND_PROMPT/);
    secondCall.respond(text('SYNC_QUEUE_SECOND_RESPONSE'));
    await b.waitForOutput('SYNC_QUEUE_SECOND_RESPONSE', TIMEOUT);

    const thirdCall = await brain.waitForCall(TIMEOUT);
    assert.match(JSON.stringify(thirdCall.request), /SYNC_QUEUE_THIRD_PROMPT/);
    thirdCall.respond(text('SYNC_QUEUE_THIRD_RESPONSE'));
    await b.waitForOutput('SYNC_QUEUE_THIRD_RESPONSE', TIMEOUT);
    await a.waitForOutput('SYNC_QUEUE_THIRD_RESPONSE', TIMEOUT);

    const screen = await b.visibleScreen();
    assert.equal(countVisible(screen, 'SYNC_QUEUE_SECOND_PROMPT'), 1, screenText(screen));
    assert.equal(countVisible(screen, 'SYNC_QUEUE_THIRD_PROMPT'), 1, screenText(screen));
    assert.equal(countVisible(screen, 'SYNC_QUEUE_SECOND_RESPONSE'), 1, screenText(screen));
    assert.equal(countVisible(screen, 'SYNC_QUEUE_THIRD_RESPONSE'), 1, screenText(screen));
  } finally {
    await a.close();
    await b.close();
    await waitForNoLiveHosts(laneRoot);
    await removeRoot(root);
  }
});

test('pi-sync resumed real session does not duplicate transcript and remains syncable', { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-resume-syncable-'));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'shared.jsonl');
  const piWrapper = writePiWrapper(root);
  writeFileSync(sessionFile, '', 'utf8');

  const firstBrain = createControllableBrain();
  const first = await createInteractiveMock({
    brain: firstBrain.brain,
    extensions: [EXTENSION],
    piProvider: 'pi-mock',
    piModel: 'mock',
    startupTimeoutMs: 20_000,
    terminal: { cols: 110, rows: 36 },
    cwd: root,
    env: { PI_LANE_ROOT: laneRoot, PI_SYNC_POLL_MS: '25', PI_SYNC_HOST_IDLE_MS: '1000' },
    piBinary: piWrapper,
    piArgs: ['--session', sessionFile],
  });
  try {
    first.submit('SYNC_RESUME_SYNCABLE_FIRST_PROMPT');
    const call = await firstBrain.waitForCall(TIMEOUT);
    call.respond(text('SYNC_RESUME_SYNCABLE_FIRST_RESPONSE'));
    await first.waitForOutput('SYNC_RESUME_SYNCABLE_FIRST_RESPONSE', TIMEOUT);
  } finally {
    await first.close();
  }
  await waitForNoLiveHosts(laneRoot);

  const brain = createControllableBrain();
  const common = {
    brain: brain.brain,
    extensions: [EXTENSION],
    piProvider: 'pi-mock',
    piModel: 'mock',
    startupTimeoutMs: 20_000,
    terminal: { cols: 110, rows: 36 },
    cwd: root,
    env: { PI_LANE_ROOT: laneRoot, PI_SYNC_POLL_MS: '25', PI_SYNC_HOST_IDLE_MS: '1000' },
    piBinary: piWrapper,
    piArgs: ['--session', sessionFile],
  };
  const a = await createInteractiveMock(common);
  const b = await createInteractiveMock(common);
  try {
    await a.waitForOutput('SYNC_RESUME_SYNCABLE_FIRST_RESPONSE', TIMEOUT);
    await b.waitForOutput('SYNC_RESUME_SYNCABLE_FIRST_RESPONSE', TIMEOUT);
    await sleep(500);
    const screen = await b.visibleScreen();
    assert.equal(countVisible(screen, 'SYNC_RESUME_SYNCABLE_FIRST_PROMPT'), 1, screenText(screen));
    assert.equal(countVisible(screen, 'SYNC_RESUME_SYNCABLE_FIRST_RESPONSE'), 1, screenText(screen));

    a.clearOutput();
    b.clearOutput();
    a.submit('SYNC_RESUME_SYNCABLE_SECOND_PROMPT');
    const secondCall = await brain.waitForCall(TIMEOUT);
    secondCall.respond(text('SYNC_RESUME_SYNCABLE_SECOND_RESPONSE'));
    await a.waitForOutput('SYNC_RESUME_SYNCABLE_SECOND_RESPONSE', TIMEOUT);
    await b.waitForOutput('SYNC_RESUME_SYNCABLE_SECOND_RESPONSE', TIMEOUT);
    assert.equal(readFileSync(sessionFile, 'utf8').match(/SYNC_RESUME_SYNCABLE_FIRST_PROMPT/g)?.length, 1);
    assert.equal(readFileSync(sessionFile, 'utf8').match(/SYNC_RESUME_SYNCABLE_SECOND_PROMPT/g)?.length, 1);
  } finally {
    await a.close();
    await b.close();
    await waitForNoLiveHosts(laneRoot);
    await removeRoot(root);
  }
});
