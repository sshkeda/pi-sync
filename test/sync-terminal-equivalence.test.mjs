import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInteractiveMock, createControllableBrain, streamText, text } from '../../pi-mock/dist/index.js';

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

function assertVisibleCardinality(lines, expectations, label) {
  for (const [needle, expected] of expectations) {
    assert.equal(countVisible(lines, needle), expected, `${label}: expected ${expected} visible ${needle}\n${lines.join('\n')}`);
  }
}

async function createSyncedPair(rootPrefix) {
  const root = mkdtempSync(join(tmpdir(), rootPrefix));
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
  return { root, brain, a, b };
}

test('pi-sync keeps attached terminals equivalent for a completed text turn', { timeout: 90_000 }, async () => {
  const { root, brain, a, b } = await createSyncedPair('pi-sync-equivalence-text-');
  try {
    a.clearOutput();
    b.clearOutput();
    a.submit('SYNC_EQ_TEXT_PROMPT');
    const call = await brain.waitForCall(TIMEOUT);
    await b.waitForOutput('SYNC_EQ_TEXT_PROMPT', TIMEOUT);
    call.respond(text('SYNC_EQ_TEXT_RESPONSE'));

    await a.waitForOutput('SYNC_EQ_TEXT_RESPONSE', TIMEOUT);
    await b.waitForOutput('SYNC_EQ_TEXT_RESPONSE', TIMEOUT);

    await waitForSameVisibleScreen(a, b, 2_000, 'completed text turn should settle to identical terminal UI');
    const screenA = await a.visibleScreen();
    const screenB = await b.visibleScreen();
    assertVisibleCardinality(screenA, [['SYNC_EQ_TEXT_PROMPT', 1], ['SYNC_EQ_TEXT_RESPONSE', 1]], 'terminal a');
    assertVisibleCardinality(screenB, [['SYNC_EQ_TEXT_PROMPT', 1], ['SYNC_EQ_TEXT_RESPONSE', 1]], 'terminal b');
  } finally {
    await a.close();
    await b.close();
    await removeRoot(root);
  }
});

test('pi-sync keeps attached terminals equivalent for a streaming text turn', { timeout: 90_000 }, async () => {
  const { root, brain, a, b } = await createSyncedPair('pi-sync-equivalence-stream-');
  try {
    a.clearOutput();
    b.clearOutput();
    a.submit('SYNC_EQ_STREAM_PROMPT');
    const call = await brain.waitForCall(TIMEOUT);
    await b.waitForOutput('SYNC_EQ_STREAM_PROMPT', TIMEOUT);
    call.respond(streamText(['SYNC_EQ_STREAM_', 'RESPONSE'], 100));

    await a.waitForOutput('SYNC_EQ_STREAM_RESPONSE', TIMEOUT);
    await b.waitForOutput('SYNC_EQ_STREAM_RESPONSE', TIMEOUT);

    await waitForSameVisibleScreen(a, b, 2_000, 'streaming text turn should settle to identical terminal UI');
    const screenA = await a.visibleScreen();
    const screenB = await b.visibleScreen();
    assertVisibleCardinality(screenA, [['SYNC_EQ_STREAM_PROMPT', 1], ['SYNC_EQ_STREAM_RESPONSE', 1]], 'terminal a');
    assertVisibleCardinality(screenB, [['SYNC_EQ_STREAM_PROMPT', 1], ['SYNC_EQ_STREAM_RESPONSE', 1]], 'terminal b');
  } finally {
    await a.close();
    await b.close();
    await removeRoot(root);
  }
});
