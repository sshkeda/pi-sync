import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInteractiveMock, script, text } from '../../pi-mock/dist/index.js';

const EXTENSION = new URL('../index.ts', import.meta.url).pathname;
const TIMEOUT = 30_000;

function writePiWrapper(root) {
  const piWrapper = join(root, 'pi-wrapper.sh');
  writeFileSync(piWrapper, `#!/usr/bin/env bash\nargs=()\nfor a in "$@"; do [[ "$a" == "--no-session" ]] && continue; args+=("$a"); done\nexec "${process.env.PI_SYNC_TEST_PI_BINARY ?? 'pi'}" "\${args[@]}"\n`);
  chmodSync(piWrapper, 0o755);
  return piWrapper;
}

function readEntries(path) {
  return readFileSync(path, 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test('pi-sync persists a complete short-id session tree after hosted prompt', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-session-persist-'));
  const laneRoot = join(root, 'lane');
  const shortId = 'ShortId12345';
  const sessionFile = join(root, `2026-05-18T04-20-00-000Z_${shortId}.jsonl`);
  const piWrapper = writePiWrapper(root);
  writeFileSync(sessionFile, '', 'utf8');

  const mock = await createInteractiveMock({
    brain: script(text('SYNC_PERSIST_ASSISTANT_RESPONSE')),
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
    mock.submit('SYNC_PERSIST_USER_PROMPT');
    await mock.waitForOutput('SYNC_PERSIST_ASSISTANT_RESPONSE', TIMEOUT);
    await new Promise((resolve) => setTimeout(resolve, 500));

    const entries = readEntries(sessionFile);
    const messages = entries.filter((entry) => entry.type === 'message');
    const user = messages.find((entry) => entry.message?.role === 'user');
    const assistant = messages.find((entry) => entry.message?.role === 'assistant');

    assert.equal(user?.message?.content?.[0]?.text, 'SYNC_PERSIST_USER_PROMPT');
    assert.equal(assistant?.message?.content?.[0]?.text, 'SYNC_PERSIST_ASSISTANT_RESPONSE');
    assert.equal(assistant?.parentId, user?.id);
  } finally {
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  }
});
