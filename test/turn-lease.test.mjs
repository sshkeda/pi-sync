import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

function writePiWrapper(root) {
  const piWrapper = join(root, 'pi-wrapper.sh');
  writeFileSync(piWrapper, `#!/usr/bin/env bash\nargs=()\nfor a in "$@"; do [[ "$a" == "--no-session" ]] && continue; args+=("$a"); done\nexec "${process.env.PI_SYNC_TEST_PI_BINARY ?? 'pi'}" "\${args[@]}"\n`);
  chmodSync(piWrapper, 0o755);
  return piWrapper;
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
  const entry = readFileSync(sessionFile, 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find((item) => messageText(item) === textValue);
  assert.ok(entry, `missing session entry with text ${textValue}`);
  return entry;
}

test('pi-sync queues competing same-session input instead of starting a peer model call', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-lease-'));
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
    env: { PI_LANE_ROOT: laneRoot, PI_SYNC_POLL_MS: '25', PI_SYNC_TURN_LEASE_MS: '30000', PI_SYNC_HOST_IDLE_MS: '1000' },
    piBinary: piWrapper,
    piArgs: ['--session', sessionFile],
  };

  const a = await createInteractiveMock(common);
  const b = await createInteractiveMock(common);
  try {
    a.clearOutput();
    b.clearOutput();
    a.submit('SYNC_FIRST_TURN');
    const firstCall = await brain.waitForCall(TIMEOUT);

    b.submit('SYNC_SECOND_TURN_SHOULD_QUEUE');
    const promptQueuePath = join(laneRoot, 'sessions', stableSessionKey(realpathSync(sessionFile)), 'lanes', 'main', 'sync', 'prompt-queue.jsonl');
    await waitUntil(
      () => existsSync(promptQueuePath) && readFileSync(promptQueuePath, 'utf8').includes('SYNC_SECOND_TURN_SHOULD_QUEUE'),
      TIMEOUT,
      'host prompt queue entry',
    );
    assert.equal(brain.pending().length, 0, 'queued follower input should not start a competing peer model call');
    assert.doesNotMatch(b.output, /session is active in another attached terminal/, 'exact mode should not draw follower-only warning chrome');

    firstCall.respond(text('SYNC_FIRST_RESPONSE'));
    await a.waitForOutput('SYNC_FIRST_RESPONSE', TIMEOUT);
    await b.waitForOutput('SYNC_FIRST_RESPONSE', TIMEOUT);

    const secondCall = await brain.waitForCall(TIMEOUT);
    assert.match(
      JSON.stringify(secondCall.request),
      /SYNC_SECOND_TURN_SHOULD_QUEUE/,
      'queued follower input should run after the active prompt completes',
    );
    secondCall.respond(text('SYNC_SECOND_RESPONSE'));
    await a.waitForOutput('SYNC_SECOND_RESPONSE', TIMEOUT);
    await b.waitForOutput('SYNC_SECOND_RESPONSE', TIMEOUT);

    assert.match(a.output, /SYNC_FIRST_RESPONSE/);
    assert.match(b.output, /SYNC_FIRST_RESPONSE/);
    assert.match(a.output, /SYNC_SECOND_RESPONSE/);
    assert.match(b.output, /SYNC_SECOND_RESPONSE/);
    assert.doesNotMatch(`${a.output}\n${b.output}`, /Agent is already processing a prompt|uncaughtException|prompt_error/);
  } finally {
    await a.close();
    await b.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('pi-sync queues competing input after tree navigation on the same sync lane', { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-branch-lease-'));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'shared.jsonl');
  const piWrapper = writePiWrapper(root);
  const helperExt = join(root, 'tree-nav-helper.mjs');
  const brain = createControllableBrain();
  writeFileSync(sessionFile, '', 'utf8');
  writeFileSync(helperExt, `
export default function treeNavHelper(pi) {
  pi.registerCommand("_tree_nav_to_text", {
    description: "Navigate to the first message whose text matches args",
    handler: async (args, ctx) => {
      const wanted = args.trim();
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
    extensions: [PI_LANE_EXT, EXTENSION, helperExt],
    piProvider: 'pi-mock',
    piModel: 'mock',
    startupTimeoutMs: 20_000,
    terminal: { cols: 100, rows: 36 },
    cwd: root,
    env: { PI_LANE_ROOT: laneRoot, PI_SYNC_POLL_MS: '25', PI_SYNC_TURN_LEASE_MS: '30000', PI_SYNC_HOST_IDLE_MS: '1000' },
    piBinary: piWrapper,
    piArgs: ['--session', sessionFile],
  };

  const main = await createInteractiveMock(common);
  const a = await createInteractiveMock(common);
  const b = await createInteractiveMock(common);
  try {
    main.submit('SYNC_BRANCH_QUEUE_BASE_PROMPT');
    let call = await brain.waitForCall(TIMEOUT);
    call.respond(text('SYNC_BRANCH_QUEUE_BASE_ANSWER'));
    await main.waitForOutput('SYNC_BRANCH_QUEUE_BASE_ANSWER', TIMEOUT);
    await a.waitForOutput('SYNC_BRANCH_QUEUE_BASE_ANSWER', TIMEOUT);
    await b.waitForOutput('SYNC_BRANCH_QUEUE_BASE_ANSWER', TIMEOUT);

    main.submit('SYNC_BRANCH_QUEUE_MAIN_PROMPT');
    call = await brain.waitForCall(TIMEOUT);
    call.respond(text('SYNC_BRANCH_QUEUE_MAIN_ANSWER'));
    await main.waitForOutput('SYNC_BRANCH_QUEUE_MAIN_ANSWER', TIMEOUT);
    await a.waitForOutput('SYNC_BRANCH_QUEUE_MAIN_ANSWER', TIMEOUT);

    a.submit('/_tree_nav_to_text SYNC_BRANCH_QUEUE_BASE_ANSWER');
    await a.waitForOutput('leaf_after_nav:', TIMEOUT);
    b.submit('/sync status');
    await b.waitForOutput(/lane=main/, TIMEOUT);

    a.clearOutput();
    b.clearOutput();
    a.submit('SYNC_BRANCH_QUEUE_FIRST_TURN');
    const firstCall = await brain.waitForCall(TIMEOUT);

    b.submit('SYNC_BRANCH_QUEUE_SECOND_TURN_SHOULD_QUEUE');
    const sessionKey = stableSessionKey(realpathSync(sessionFile));
    const promptQueuePath = join(laneRoot, 'sessions', sessionKey, 'lanes', 'main', 'sync', 'prompt-queue.jsonl');
    await waitUntil(
      () => existsSync(promptQueuePath) && readFileSync(promptQueuePath, 'utf8').includes('SYNC_BRANCH_QUEUE_SECOND_TURN_SHOULD_QUEUE'),
      TIMEOUT,
      'main host prompt queue entry after tree navigation',
    );
    assert.equal(brain.pending().length, 0, 'queued input should not start a competing model call');

    firstCall.respond(text('SYNC_BRANCH_QUEUE_FIRST_RESPONSE'));
    await a.waitForOutput('SYNC_BRANCH_QUEUE_FIRST_RESPONSE', TIMEOUT);
    await b.waitForOutput('SYNC_BRANCH_QUEUE_FIRST_RESPONSE', TIMEOUT);

    const secondCall = await brain.waitForCall(TIMEOUT);
    assert.match(
      JSON.stringify(secondCall.request),
      /SYNC_BRANCH_QUEUE_SECOND_TURN_SHOULD_QUEUE/,
      'queued branch input should run after active branch prompt completes',
    );
    secondCall.respond(text('SYNC_BRANCH_QUEUE_SECOND_RESPONSE'));
    await a.waitForOutput('SYNC_BRANCH_QUEUE_SECOND_RESPONSE', TIMEOUT);
    await b.waitForOutput('SYNC_BRANCH_QUEUE_SECOND_RESPONSE', TIMEOUT);

    assert.doesNotMatch(`${a.output}\n${b.output}`, /Agent is already processing a prompt|uncaughtException|prompt_error/);
  } finally {
    await main.close();
    await a.close();
    await b.close();
    rmSync(root, { recursive: true, force: true });
  }
});
