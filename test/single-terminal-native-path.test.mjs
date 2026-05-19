import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInteractiveMock, script, text } from '../../pi-mock/dist/index.js';

const EXTENSION = new URL('../index.ts', import.meta.url).pathname;
const TIMEOUT = 30_000;

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

function findHostJsons(dir) {
  if (!existsSync(dir)) return [];
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findHostJsons(path));
    else if (entry.isFile() && entry.name === 'host.json' && path.includes('/sync/')) found.push(path);
  }
  return found;
}

function findHostEventsPaths(dir) {
  if (!existsSync(dir)) return [];
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findHostEventsPaths(path));
    else if (entry.isFile() && entry.name === 'host-events.jsonl' && path.includes('/sync/')) found.push(path);
  }
  return found;
}

test('pi-sync routes single-terminal prompts through a warm shared host', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-native-path-'));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'shared.jsonl');
  const piWrapper = writePiWrapper(root);
  writeFileSync(sessionFile, '', 'utf8');

  const mock = await createInteractiveMock({
    brain: script(text('SYNC_NATIVE_RESPONSE')),
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
    await waitUntil(
      () => findHostEventsPaths(laneRoot).some((path) => readFileSync(path, 'utf8').includes('"type":"agent_ready"')),
      TIMEOUT,
      'warm host agent_ready event',
    );
    mock.submit('SYNC_NATIVE_PROMPT');
    await mock.waitForOutput('SYNC_NATIVE_RESPONSE', TIMEOUT);
    assert.equal(existsSync(join(laneRoot, 'sessions')), true);
    assert.equal(findHostJsons(laneRoot).length, 1, 'single-terminal prompt should use one pi-sync-host');
  } finally {
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  }
});
