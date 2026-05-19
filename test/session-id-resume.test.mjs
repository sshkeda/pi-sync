import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, realpathSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInteractiveMock, script, text } from '../../pi-mock/dist/index.js';

const EXTENSION = new URL('../index.ts', import.meta.url).pathname;
const TIMEOUT = 30_000;
const PI_BINARY = process.env.PI_SYNC_TEST_PI_BINARY ?? 'pi';

function writePiWrapper(root) {
  const piWrapper = join(root, 'pi-wrapper.sh');
  writeFileSync(piWrapper, `#!/usr/bin/env bash\nargs=()\nfor a in "$@"; do [[ "$a" == "--no-session" ]] && continue; args+=("$a"); done\nexec "${PI_BINARY}" "\${args[@]}"\n`);
  chmodSync(piWrapper, 0o755);
  return piWrapper;
}

function findJsonlFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findJsonlFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(path);
  }
  return found;
}

function findFiles(dir, predicate) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findFiles(path, predicate));
    else if (entry.isFile() && predicate(path)) found.push(path);
  }
  return found;
}

test('pi-sync keeps the displayed session id backed by a real session file', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-session-id-'));
  const sessionDir = join(root, 'sessions');
  const laneRoot = join(root, 'lane');
  const piWrapper = writePiWrapper(root);

  const mock = await createInteractiveMock({
    brain: script(text('SYNC_SESSION_ID_RESPONSE')),
    extensions: [EXTENSION],
    piProvider: 'pi-mock',
    piModel: 'mock',
    startupTimeoutMs: 20_000,
    terminal: { cols: 100, rows: 32 },
    cwd: root,
    piBinary: piWrapper,
    env: {
      PI_CODING_AGENT_SESSION_DIR: sessionDir,
      PI_LANE_ROOT: laneRoot,
      PI_SYNC_POLL_MS: '25',
      PI_SYNC_HOST_IDLE_MS: '1000',
    },
  });

  try {
    mock.submit('SYNC_SESSION_ID_PROMPT');
    await mock.waitForOutput('SYNC_SESSION_ID_RESPONSE', TIMEOUT);

    const hostJsons = findFiles(laneRoot, (file) => file.endsWith('/host.json'));
    assert.equal(hostJsons.length, 1, `expected one host.json, got ${hostJsons.join(', ')}`);
    const host = JSON.parse(readFileSync(hostJsons[0], 'utf8'));
    assert.equal(existsSync(host.sessionFile), true, `host sessionFile should exist: ${host.sessionFile}`);

    const header = readFileSync(host.sessionFile, 'utf8').split(/\r?\n/, 1)[0];
    assert.match(header, /"type":"session"/);
    assert.equal(typeof JSON.parse(header).id, 'string');
    assert.notEqual(JSON.parse(header).id.length, 0);
    assert.ok(findJsonlFiles(sessionDir).map((file) => realpathSync(file)).includes(host.sessionFile), `${host.sessionFile} should be in session dir`);
  } finally {
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  }
});
