import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, realpathSync, readFileSync, readdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createInteractiveMock, createControllableBrain, script, text } from '../../pi-mock/dist/index.js';

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

async function waitUntil(predicate, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timeout waiting for ${label}`);
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
    rmSync(root, { recursive: true, force: true });
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
    rmSync(root, { recursive: true, force: true });
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

    const canonicalKey = stableSessionKey(realpathSync(sessionFile));
    const aliasKey = stableSessionKey(sessionAlias);
    assert.ok(existsSync(join(laneRoot, 'sessions', canonicalKey, 'lanes', 'main', 'sync', 'host.json')));
    assert.equal(existsSync(join(laneRoot, 'sessions', aliasKey, 'lanes', 'main', 'sync', 'host.json')), false);
  } finally {
    await a.close();
    await b.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('pi-sync keeps tree navigation on the current sync lane and mirrors the forked path', { timeout: 120_000 }, async () => {
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
      text('SYNC_TREE_BASE_ANSWER'),
      text('SYNC_TREE_SECOND_ANSWER'),
      text('SYNC_TREE_BRANCH_ANSWER'),
    ),
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

  const a = await createInteractiveMock(common);
  const b = await createInteractiveMock(common);
  try {
    a.submit('SYNC_TREE_BASE_PROMPT');
    await a.waitForOutput('SYNC_TREE_BASE_ANSWER', TIMEOUT);
    await b.waitForOutput('SYNC_TREE_BASE_ANSWER', TIMEOUT);

    a.submit('SYNC_TREE_SECOND_PROMPT');
    await a.waitForOutput('SYNC_TREE_SECOND_ANSWER', TIMEOUT);
    await b.waitForOutput('SYNC_TREE_SECOND_ANSWER', TIMEOUT);

    b.submit('/_tree_nav_to_text SYNC_TREE_BASE_ANSWER');
    await b.waitForOutput('leaf_after_nav:', TIMEOUT);

    a.clearOutput();
    b.clearOutput();
    b.submit('SYNC_TREE_BRANCH_PROMPT');
    await b.waitForOutput('SYNC_TREE_BRANCH_ANSWER', TIMEOUT);
    await new Promise((resolve) => setTimeout(resolve, 1000));

    await a.waitForOutput('SYNC_TREE_BRANCH_PROMPT', TIMEOUT);
    await a.waitForOutput('SYNC_TREE_BRANCH_ANSWER', TIMEOUT);

    const sessionDirs = readdirSync(join(laneRoot, 'sessions'));
    const lanes = sessionDirs.flatMap((sessionDir) => readdirSync(join(laneRoot, 'sessions', sessionDir, 'lanes')));
    assert.ok(lanes.includes('main.json'), lanes.join('\n'));
    assertNoHiddenBranchLanes(laneRoot);

    const baseAnswer = findMessageEntry(sessionFile, 'SYNC_TREE_BASE_ANSWER');
    const secondAnswer = findMessageEntry(sessionFile, 'SYNC_TREE_SECOND_ANSWER');
    const branchPrompt = findMessageEntry(sessionFile, 'SYNC_TREE_BRANCH_PROMPT');
    assert.equal(branchPrompt.parentId, baseAnswer.id, 'branch prompt should be appended under the selected tree leaf');
    assert.notEqual(branchPrompt.parentId, secondAnswer.id, 'branch prompt must not append to the previous main tail');
    const branchAnswer = findMessageEntry(sessionFile, 'SYNC_TREE_BRANCH_ANSWER');
    const mainLanePath = join(laneRoot, 'sessions', stableSessionKey(realpathSync(sessionFile)), 'lanes', 'main.json');
    await waitUntil(
      () => JSON.parse(readFileSync(mainLanePath, 'utf8')).headEntryId === branchAnswer.id,
      TIMEOUT,
      'main lane head update',
    );
  } finally {
    await a.close();
    await b.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('pi-sync keeps a forked tree path on main until an explicit lane switch', { timeout: 120_000 }, async () => {
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
      text('SYNC_ALT_BASE_ANSWER'),
      text('SYNC_ALT_MAIN_SECOND_ANSWER'),
      text('SYNC_ALT_BRANCH_ONE_ANSWER'),
      text('SYNC_ALT_BRANCH_TWO_ANSWER'),
      text('SYNC_ALT_MAIN_AFTER_BRANCH_ANSWER'),
    ),
    extensions: [PI_LANE_EXT, EXTENSION, helperExt],
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
    await main.waitForOutput('SYNC_ALT_BASE_ANSWER', TIMEOUT);
    await branch.waitForOutput('SYNC_ALT_BASE_ANSWER', TIMEOUT);

    main.submit('SYNC_ALT_MAIN_SECOND_PROMPT');
    await main.waitForOutput('SYNC_ALT_MAIN_SECOND_ANSWER', TIMEOUT);
    await branch.waitForOutput('SYNC_ALT_MAIN_SECOND_ANSWER', TIMEOUT);

    branch.submit('/_tree_nav_to_text SYNC_ALT_BASE_ANSWER');
    await branch.waitForOutput('leaf_after_nav:', TIMEOUT);

    main.clearOutput();
    branch.clearOutput();
    branch.submit('SYNC_ALT_BRANCH_ONE_PROMPT');
    await branch.waitForOutput('SYNC_ALT_BRANCH_ONE_ANSWER', TIMEOUT);
    await main.waitForOutput('SYNC_ALT_BRANCH_ONE_PROMPT', TIMEOUT);
    await main.waitForOutput('SYNC_ALT_BRANCH_ONE_ANSWER', TIMEOUT);
    const sessionKey = stableSessionKey(realpathSync(sessionFile));
    const laneDir = join(laneRoot, 'sessions', sessionKey, 'lanes');
    const mainLanePath = join(laneDir, 'main.json');
    await waitUntil(
      () => {
        const branchOneAnswers = findMessageEntries(sessionFile, 'SYNC_ALT_BRANCH_ONE_ANSWER');
        const mainLane = JSON.parse(readFileSync(mainLanePath, 'utf8'));
        return branchOneAnswers.some((entry) => mainLane.headEntryId === entry.id);
      },
      TIMEOUT,
      'main lane head after first branch prompt',
    );

    branch.clearOutput();
    branch.submit('SYNC_ALT_BRANCH_TWO_PROMPT');
    await branch.waitForOutput('SYNC_ALT_BRANCH_TWO_ANSWER', TIMEOUT);
    await waitUntil(
      () => {
        const branchTwoAnswers = findMessageEntries(sessionFile, 'SYNC_ALT_BRANCH_TWO_ANSWER');
        const mainLane = JSON.parse(readFileSync(mainLanePath, 'utf8'));
        return branchTwoAnswers.some((entry) => mainLane.headEntryId === entry.id);
      },
      TIMEOUT,
      'main lane head after second branch prompt',
    );

    main.submit('SYNC_ALT_MAIN_AFTER_BRANCH_PROMPT');
    await main.waitForOutput('SYNC_ALT_MAIN_AFTER_BRANCH_ANSWER', TIMEOUT);

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
    assert.ok(branchTwoAnswers.some((entry) => mainAfterBranchPrompt.parentId === entry.id), 'same sync lane should continue from the latest forked main head');
    assert.notEqual(mainAfterBranchPrompt.parentId, mainSecondAnswer.id, 'tree navigation should not create a hidden branch sync lane');

    await waitUntil(
      () => {
        const mainLane = JSON.parse(readFileSync(mainLanePath, 'utf8'));
        return mainLane.headEntryId === mainAfterBranchAnswer.id;
      },
      TIMEOUT,
      'main lane head update',
    );
    const mainLane = JSON.parse(readFileSync(mainLanePath, 'utf8'));
    assert.equal(mainLane.headEntryId, mainAfterBranchAnswer.id, 'main lane head should advance along the active forked tree path');
    assertNoHiddenBranchLanes(laneRoot);
  } finally {
    await main.close();
    await branch.close();
    rmSync(root, { recursive: true, force: true });
  }
});
