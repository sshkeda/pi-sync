import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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
    terminal: { cols: 110, rows: 34 },
    cwd: root,
    env: { PI_LANE_ROOT: laneRoot, PI_SYNC_POLL_MS: '25', PI_SYNC_HOST_IDLE_MS: '1000', PI_SYNC_INSTANCE_STALE_MS: '5000' },
    piBinary: piWrapper,
    piArgs: ['--session', sessionFile],
  };

  const a = await createInteractiveMock(common);
  const b = await createInteractiveMock(common);
  return { root, brain, a, b };
}

test('pi-sync stops replaying an active stream to a terminal after it switches lanes', { timeout: 90_000 }, async () => {
  const { root, brain, a, b } = await createSyncedPair('pi-sync-lane-isolation-active-');
  try {
    a.clearOutput();
    b.clearOutput();
    a.submit('SYNC_LANE_ACTIVE_PROMPT');
    const call = await brain.waitForCall(TIMEOUT);
    await b.waitForOutput('SYNC_LANE_ACTIVE_PROMPT', TIMEOUT);

    b.clearOutput();
    b.submit('/lane new side');
    await b.waitForOutput(/created and joined side/, TIMEOUT);
    b.clearOutput();

    call.respond(text('SYNC_LANE_ACTIVE_RESPONSE_AFTER_SWITCH'));
    await a.waitForOutput('SYNC_LANE_ACTIVE_RESPONSE_AFTER_SWITCH', TIMEOUT);
    await sleep(750);

    assert.doesNotMatch(
      b.output,
      /SYNC_LANE_ACTIVE_RESPONSE_AFTER_SWITCH/,
      'terminal on a different lane must not receive the old lane stream after switching',
    );

    b.submit('/lane status');
    await b.waitForOutput(/current L2 \(side\)[\s\S]*connected 1/, TIMEOUT);
  } finally {
    await a.close();
    await b.close();
    await removeRoot(root);
  }
});

test('pi-sync does not mirror side-lane prompts or responses into the main lane terminal', { timeout: 90_000 }, async () => {
  const { root, brain, a, b } = await createSyncedPair('pi-sync-lane-isolation-side-');
  try {
    a.clearOutput();
    b.clearOutput();
    a.submit('/lane new side');
    await a.waitForOutput(/created and joined side/, TIMEOUT);

    a.clearOutput();
    b.clearOutput();
    a.submit('SYNC_SIDE_LANE_PROMPT');
    const call = await brain.waitForCall(TIMEOUT);
    call.respond(text('SYNC_SIDE_LANE_RESPONSE'));
    await a.waitForOutput('SYNC_SIDE_LANE_RESPONSE', TIMEOUT);
    await sleep(750);

    assert.doesNotMatch(b.output, /SYNC_SIDE_LANE_PROMPT/, 'main lane terminal must not receive side lane prompt');
    assert.doesNotMatch(b.output, /SYNC_SIDE_LANE_RESPONSE/, 'main lane terminal must not receive side lane response');

    b.submit('/lane status');
    await b.waitForOutput(/current L1 \(main\)[\s\S]*connected 1/, TIMEOUT);
  } finally {
    await a.close();
    await b.close();
    await removeRoot(root);
  }
});
