import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createInteractiveMock, createControllableBrain, text } from '../../pi-mock/dist/index.js';

const EXTENSION = new URL('../index.ts', import.meta.url).pathname;
const TIMEOUT = 30_000;

function writePiWrapper(root) {
  const piWrapper = join(root, 'pi-wrapper.sh');
  writeFileSync(piWrapper, `#!/usr/bin/env bash\nargs=()\nfor a in "$@"; do [[ "$a" == "--no-session" ]] && continue; args+=("$a"); done\nexec "${process.env.PI_SYNC_TEST_PI_BINARY ?? 'pi'}" "\${args[@]}"\n`);
  chmodSync(piWrapper, 0o755);
  return piWrapper;
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

function countVisible(lines, needle) {
  return lines.filter((line) => line.includes(needle)).length;
}

test('pi-sync renders one prompt/response once and does not duplicate after host reconnect', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-no-duplicate-'));
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
    mock.submit('SYNC_DUP_PROMPT');
    const call = await brain.waitForCall(TIMEOUT);
    call.respond(text('SYNC_DUP_RESPONSE'));
    await mock.waitForOutput('SYNC_DUP_RESPONSE', TIMEOUT);
    await new Promise((resolve) => setTimeout(resolve, 200));

    let screen = await mock.visibleScreen();
    assert.equal(countVisible(screen, 'SYNC_DUP_PROMPT'), 1, screen.join('\n'));
    assert.equal(countVisible(screen, 'SYNC_DUP_RESPONSE'), 1, screen.join('\n'));

    const hostInfoPath = join(laneRoot, 'sessions', stableSessionKey(realpathSync(sessionFile)), 'lanes', 'main', 'sync', 'host.json');
    await waitUntil(() => existsSync(hostInfoPath), TIMEOUT, 'host info');
    const host = JSON.parse(readFileSync(hostInfoPath, 'utf8'));
    process.kill(host.pid, 'SIGTERM');
    await waitUntil(() => !existsSync(hostInfoPath) || JSON.parse(readFileSync(hostInfoPath, 'utf8')).pid !== host.pid || JSON.parse(readFileSync(hostInfoPath, 'utf8')).state !== 'running', TIMEOUT, 'old host stopped');
    await new Promise((resolve) => setTimeout(resolve, 750));

    screen = await mock.visibleScreen();
    assert.equal(countVisible(screen, 'SYNC_DUP_PROMPT'), 1, screen.join('\n'));
    assert.equal(countVisible(screen, 'SYNC_DUP_RESPONSE'), 1, screen.join('\n'));
  } finally {
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  }
});
