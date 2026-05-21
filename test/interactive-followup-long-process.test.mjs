import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInteractiveMock, createControllableBrain, bash, text } from '../../pi-mock/dist/index.js';

const EXTENSION = new URL('../index.ts', import.meta.url).pathname;
const TIMEOUT = 45_000;

function writePiWrapper(root) {
  const piWrapper = join(root, 'pi-wrapper.sh');
  writeFileSync(piWrapper, `#!/usr/bin/env bash\nargs=()\nfor a in "$@"; do [[ "$a" == "--no-session" ]] && continue; args+=("$a"); done\nexec "${process.env.PI_SYNC_TEST_PI_BINARY ?? 'pi'}" "\${args[@]}"\n`);
  chmodSync(piWrapper, 0o755);
  return piWrapper;
}

async function waitUntil(predicate, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function removeRoot(root) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

function findPromptQueuePath(laneRoot, lane = 'main') {
  const sessionsDir = join(laneRoot, 'sessions');
  if (!existsSync(sessionsDir)) return undefined;
  const candidates = [];
  for (const sessionDir of readdirSync(sessionsDir)) {
    const candidate = join(sessionsDir, sessionDir, 'lanes', lane, 'sync', 'prompt-queue.jsonl');
    if (existsSync(candidate)) candidates.push(candidate);
  }
  candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return candidates[0];
}

test('pi-sync steers an interactive follow-up into the active turn while a long bash tool is still running', { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-long-followup-'));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'shared.jsonl');
  const startedMarker = join(root, 'long-process-started');
  const piWrapper = writePiWrapper(root);
  const brain = createControllableBrain();
  writeFileSync(sessionFile, '', 'utf8');

  const common = {
    brain: brain.brain,
    extensions: [EXTENSION],
    piProvider: 'pi-mock',
    piModel: 'mock',
    startupTimeoutMs: 20_000,
    terminal: { cols: 110, rows: 36 },
    cwd: root,
    env: { PI_LANE_ROOT: laneRoot, PI_SYNC_POLL_MS: '25', PI_SYNC_TURN_LEASE_MS: '30000', PI_SYNC_HOST_IDLE_MS: '10000' },
    piBinary: piWrapper,
    piArgs: ['--session', sessionFile],
  };

  const main = await createInteractiveMock(common);
  const attached = await createInteractiveMock(common);
  try {
    main.clearOutput();
    attached.clearOutput();
    main.submit('SYNC_LONG_PROCESS_PROMPT');

    const firstCall = await brain.waitForCall(TIMEOUT);
    assert.match(JSON.stringify(firstCall.request), /SYNC_LONG_PROCESS_PROMPT/);
    firstCall.respond(bash(`node -e "require('fs').writeFileSync('long-process-started','1'); setTimeout(() => { console.log('SYNC_LONG_PROCESS_DONE'); }, 1500)"`));

    await waitUntil(() => existsSync(startedMarker), TIMEOUT, 'long bash process started');

    main.submit('SYNC_LONG_FOLLOWUP_PROMPT');
    await main.waitForOutput('SYNC_LONG_FOLLOWUP_PROMPT', TIMEOUT);
    await attached.waitForOutput('SYNC_LONG_FOLLOWUP_PROMPT', TIMEOUT);
    assert.equal(brain.pending().length, 0, 'steer must not start a competing model call while the long tool is running');

    await main.waitForOutput('SYNC_LONG_PROCESS_DONE', TIMEOUT);
    await attached.waitForOutput('SYNC_LONG_PROCESS_DONE', TIMEOUT);

    const firstTurnContinuation = await brain.waitForCall(TIMEOUT);
    const firstTurnRequest = JSON.stringify(firstTurnContinuation.request);
    assert.match(firstTurnRequest, /SYNC_LONG_PROCESS_DONE/);
    assert.match(firstTurnRequest, /SYNC_LONG_FOLLOWUP_PROMPT/, 'mid-turn steer must reach the active turn alongside the tool result');
    firstTurnContinuation.respond(text('SYNC_LONG_PROCESS_FINAL'));

    await main.waitForOutput('SYNC_LONG_PROCESS_FINAL', TIMEOUT);
    await attached.waitForOutput('SYNC_LONG_PROCESS_FINAL', TIMEOUT);

    const tail = await Promise.race([
      brain.waitForCall(2_000).then((c) => c).catch(() => null),
    ]);
    assert.equal(tail, null, 'steered follow-up must not also fan out into a separate turn');

    assert.doesNotMatch(`${main.output}\n${attached.output}`, /Agent is already processing a prompt|uncaughtException|prompt_error/);
  } finally {
    await main.close();
    await attached.close();
    await removeRoot(root);
  }
});
