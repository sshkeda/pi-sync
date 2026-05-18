import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInteractiveMock, createControllableBrain, text } from '../../pi-mock/dist/index.js';

const EXTENSION = new URL('../index.ts', import.meta.url).pathname;
const TIMEOUT = 30_000;

function writePiWrapper(root) {
  const piWrapper = join(root, 'pi-wrapper.sh');
  writeFileSync(piWrapper, `#!/usr/bin/env bash\nargs=()\nfor a in "$@"; do [[ "$a" == "--no-session" ]] && continue; args+=("$a"); done\nexec "${process.env.PI_SYNC_TEST_PI_BINARY ?? 'pi'}" "\${args[@]}"\n`);
  chmodSync(piWrapper, 0o755);
  return piWrapper;
}

function countVisible(lines, needle) {
  return lines.filter((line) => line.includes(needle)).length;
}

async function waitUntil(predicate, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timeout waiting for ${label}`);
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

function ensurePersistedUserPrompt(sessionFile, cwd, prompt) {
  const existing = readFileSync(sessionFile, 'utf8');
  if (existing.includes(prompt)) return;
  const now = new Date().toISOString();
  const entries = [
    { type: 'session', version: 3, id: 'late-join-test', timestamp: now, cwd },
    {
      type: 'message',
      id: 'persisted-user-prompt',
      parentId: null,
      timestamp: now,
      message: { role: 'user', content: [{ type: 'text', text: prompt }], timestamp: Date.now() },
    },
  ];
  writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
}

test('pi-sync hydrates a late-joining attached terminal during an active turn', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-late-join-'));
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
  let b;
  try {
    a.clearOutput();
    a.submit('SYNC_LATE_JOIN_PROMPT');
    const call = await brain.waitForCall(TIMEOUT);
    ensurePersistedUserPrompt(sessionFile, root, 'SYNC_LATE_JOIN_PROMPT');
    await waitUntil(() => readFileSync(sessionFile, 'utf8').includes('SYNC_LATE_JOIN_PROMPT'), TIMEOUT, 'persisted late-join prompt');

    b = await createInteractiveMock(common);
    // Do not clear B's output here: late-join hydration can render during startup.
    await b.waitForOutput('SYNC_LATE_JOIN_PROMPT', TIMEOUT);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const beforeResponse = await b.visibleScreen();
    assert.equal(
      countVisible(beforeResponse, 'SYNC_LATE_JOIN_PROMPT'),
      1,
      `late join must not duplicate persisted user prompts before the active response:\n${beforeResponse.join('\n')}`,
    );

    call.respond(text('SYNC_LATE_JOIN_RESPONSE'));
    await a.waitForOutput('SYNC_LATE_JOIN_RESPONSE', TIMEOUT);
    await b.waitForOutput('SYNC_LATE_JOIN_RESPONSE', TIMEOUT);
    const afterResponse = await b.visibleScreen();
    assert.equal(
      countVisible(afterResponse, 'SYNC_LATE_JOIN_PROMPT'),
      1,
      `late join must not duplicate persisted user prompts after the active response:\n${afterResponse.join('\n')}`,
    );
    assert.match(b.output, /SYNC_LATE_JOIN_RESPONSE/);
  } finally {
    await a.close();
    if (b) await b.close();
    await removeRoot(root);
  }
});

test('pi-sync renders repeated prompt text once per submitted turn', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-late-join-repeat-'));
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
    terminal: { cols: 100, rows: 40 },
    cwd: root,
    env: { PI_LANE_ROOT: laneRoot, PI_SYNC_POLL_MS: '25', PI_SYNC_HOST_IDLE_MS: '1000' },
    piBinary: piWrapper,
    piArgs: ['--session', sessionFile],
  };

  const a = await createInteractiveMock(common);
  try {
    a.submit('SYNC_REPEAT_PROMPT');
    let call = await brain.waitForCall(TIMEOUT);
    call.respond(text('SYNC_REPEAT_RESPONSE_ONE'));
    await a.waitForOutput('SYNC_REPEAT_RESPONSE_ONE', TIMEOUT);
    await waitUntil(() => readFileSync(sessionFile, 'utf8').includes('SYNC_REPEAT_RESPONSE_ONE'), TIMEOUT, 'persisted first repeated turn');

    a.submit('SYNC_REPEAT_PROMPT');
    call = await brain.waitForCall(TIMEOUT);
    call.respond(text('SYNC_REPEAT_RESPONSE_TWO'));
    await a.waitForOutput('SYNC_REPEAT_RESPONSE_TWO', TIMEOUT);
    await waitUntil(() => readFileSync(sessionFile, 'utf8').includes('SYNC_REPEAT_RESPONSE_TWO'), TIMEOUT, 'persisted second repeated turn');

    await new Promise((resolve) => setTimeout(resolve, 500));
    const screen = await a.visibleScreen();
    assert.equal(
      countVisible(screen, 'SYNC_REPEAT_PROMPT'),
      2,
      `repeated prompt text must render once per real submitted turn:\n${screen.join('\n')}`,
    );
    assert.equal(countVisible(screen, 'SYNC_REPEAT_RESPONSE_ONE'), 1, screen.join('\n'));
    assert.equal(countVisible(screen, 'SYNC_REPEAT_RESPONSE_TWO'), 1, screen.join('\n'));
  } finally {
    await a.close();
    await removeRoot(root);
  }
});
