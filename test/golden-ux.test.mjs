import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
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

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function removeRoot(path) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 4 || !['ENOTEMPTY', 'EBUSY', 'ENOENT'].includes(error?.code)) throw error;
      await sleep(100);
    }
  }
}

function countVisible(lines, needle) {
  return lines.filter((line) => line.includes(needle)).length;
}

function screenText(lines) {
  return lines.join('\n');
}

function ensurePersistedUserPrompt(sessionFile, cwd, prompt) {
  const existing = readFileSync(sessionFile, 'utf8');
  if (existing.includes(prompt)) return;
  const now = new Date().toISOString();
  const entries = [
    { type: 'session', version: 3, id: 'golden-ux-test', timestamp: now, cwd },
    {
      type: 'message',
      id: 'golden-persisted-user-prompt',
      parentId: null,
      timestamp: now,
      message: { role: 'user', content: [{ type: 'text', text: prompt }], timestamp: Date.now() },
    },
  ];
  writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
}

test('pi-sync golden UX: late join, lane switch, abort, and cardinality stay deterministic', { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-golden-ux-'));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'shared.jsonl');
  const piWrapper = writePiWrapper(root);
  const brain = createControllableBrain();
  writeFileSync(sessionFile, '', 'utf8');
  const canonicalSessionFile = realpathSync(sessionFile);

  const common = {
    brain: brain.brain,
    extensions: [EXTENSION],
    piProvider: 'pi-mock',
    piModel: 'mock',
    startupTimeoutMs: 20_000,
    terminal: { cols: 110, rows: 34 },
    cwd: root,
    env: {
      PI_LANE_ROOT: laneRoot,
      PI_LANE_SESSION_KEY: 'golden-ux-shared-key',
      PI_LANE_SESSION_FILE: canonicalSessionFile,
      PI_SYNC_POLL_MS: '25',
      PI_SYNC_HOST_IDLE_MS: '1000',
      PI_SYNC_INSTANCE_STALE_MS: '5000',
    },
    piBinary: piWrapper,
    piArgs: ['--session', sessionFile],
  };

  const a = await createInteractiveMock(common);
  let b;
  try {
    a.clearOutput();
    a.submit('SYNC_GOLDEN_ACTIVE_PROMPT');
    const call = await brain.waitForCall(TIMEOUT);
    ensurePersistedUserPrompt(sessionFile, root, 'SYNC_GOLDEN_ACTIVE_PROMPT');

    b = await createInteractiveMock(common);
    await b.waitForOutput('SYNC_GOLDEN_ACTIVE_PROMPT', TIMEOUT);
    let screenB = await b.visibleScreen();
    assert.equal(
      countVisible(screenB, 'SYNC_GOLDEN_ACTIVE_PROMPT'),
      1,
      `late join should render the active prompt once:\n${screenText(screenB)}`,
    );

    b.clearOutput();
    b.submit('/lane new');
    await b.waitForOutput(/created ln_[A-Za-z0-9_-]+ -> now ~\/2 ln_[A-Za-z0-9_-]+/, TIMEOUT);
    b.clearOutput();

    a.sendKey('escape');
    await a.waitForOutput(/Operation aborted|aborted/i, TIMEOUT);
    call.respond(text('SYNC_GOLDEN_SHOULD_NOT_RENDER_AFTER_ABORT'));
    await sleep(750);

    const screenA = await a.visibleScreen();
    screenB = await b.visibleScreen();
    assert.equal(countVisible(screenA, 'Operation aborted'), 1, `main lane should render one abort:\n${screenText(screenA)}`);
    assert.doesNotMatch(screenText(screenA), /SYNC_GOLDEN_SHOULD_NOT_RENDER_AFTER_ABORT/);
    assert.doesNotMatch(screenText(screenB), /Operation aborted|SYNC_GOLDEN_SHOULD_NOT_RENDER_AFTER_ABORT/);

    b.submit('SYNC_GOLDEN_SIDE_PROMPT');
    const sideCall = await brain.waitForCall(TIMEOUT);
    sideCall.respond(text('SYNC_GOLDEN_SIDE_RESPONSE'));
    await b.waitForOutput('SYNC_GOLDEN_SIDE_RESPONSE', TIMEOUT);
    await sleep(750);

    const finalA = screenText(await a.visibleScreen());
    const finalB = screenText(await b.visibleScreen());
    assert.doesNotMatch(finalA, /SYNC_GOLDEN_SIDE_PROMPT|SYNC_GOLDEN_SIDE_RESPONSE/);
    assert.match(finalB, /SYNC_GOLDEN_SIDE_PROMPT/);
    assert.match(finalB, /SYNC_GOLDEN_SIDE_RESPONSE/);
  } finally {
    await a.close();
    if (b) await b.close();
    await removeRoot(root);
  }
});
