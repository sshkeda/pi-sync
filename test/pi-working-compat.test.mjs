import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInteractiveMock, streamText } from '../../pi-mock/dist/index.js';

const PI_SYNC = new URL('../index.ts', import.meta.url).pathname;
const PI_WORKING = new URL('../../pi-working/index.ts', import.meta.url).pathname;
const PI_STATUS_LINE = new URL('../../pi-status-line/index.ts', import.meta.url).pathname;

function readEntries(path) {
  return readFileSync(path, 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
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

async function waitForScreenMatch(mock, pattern, timeoutMs, description) {
  const started = Date.now();
  let screen = '';
  while (Date.now() - started < timeoutMs) {
    screen = (await mock.visibleScreen()).join('\n');
    if (pattern.test(screen)) return screen;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.match(screen, pattern, description);
  return screen;
}

function writePiWrapper(root) {
  const piWrapper = join(root, 'pi-wrapper.sh');
  writeFileSync(piWrapper, `#!/usr/bin/env bash\nargs=()\nfor a in "$@"; do [[ "$a" == "--no-session" ]] && continue; args+=("$a"); done\nexec "${process.env.PI_SYNC_TEST_PI_BINARY ?? 'pi'}" "\${args[@]}"\n`);
  chmodSync(piWrapper, 0o755);
  return piWrapper;
}

test('pi-sync does not hide pi-working local Working for row', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-working-compat-'));
  const sessionFile = join(root, 'shared.jsonl');
  const piWrapper = writePiWrapper(root);
  writeFileSync(sessionFile, '', 'utf8');
  const mock = await createInteractiveMock({
    brain: () => streamText(['SYNC_WORKING_CHUNK_1 ', 'SYNC_WORKING_DONE'], 800),
    extensions: [PI_WORKING, PI_SYNC],
    piProvider: 'pi-mock',
    piModel: 'mock',
    startupTimeoutMs: 20_000,
    terminal: { cols: 100, rows: 32 },
    cwd: root,
    env: { PI_LANE_ROOT: join(root, 'lane'), PI_SYNC_POLL_MS: '25', PI_SYNC_HOST_IDLE_MS: '1000' },
    piBinary: piWrapper,
    piArgs: ['--session', sessionFile],
  });

  try {
    mock.clearOutput();
    mock.submit('test pi-working plus pi-sync');
    await mock.waitForOutput('SYNC_WORKING_CHUNK_1', 30_000);
    const screen = (await mock.visibleScreen()).join('\n');
    assert.match(screen, /Working for/);
    await mock.waitForOutput('SYNC_WORKING_DONE', 30_000);
  } finally {
    await mock.close();
    await removeRoot(root);
  }
});

test('pi-sync leaves pi-status-line on persisted assistant leaf with nonzero completed time', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-status-time-'));
  const sessionFile = join(root, 'shared.jsonl');
  const piWrapper = writePiWrapper(root);
  writeFileSync(sessionFile, '', 'utf8');
  const mock = await createInteractiveMock({
    brain: () => streamText(['SYNC_STATUS_TIME_DONE'], 1300),
    extensions: [PI_WORKING, PI_STATUS_LINE, PI_SYNC],
    piProvider: 'pi-mock',
    piModel: 'mock',
    startupTimeoutMs: 20_000,
    terminal: { cols: 100, rows: 32 },
    cwd: root,
    env: { PI_LANE_ROOT: join(root, 'lane'), PI_SYNC_POLL_MS: '25', PI_SYNC_HOST_IDLE_MS: '1000' },
    piBinary: piWrapper,
    piArgs: ['--session', sessionFile],
  });

  try {
    mock.clearOutput();
    mock.submit('test persisted assistant status time');
    await mock.waitForOutput('SYNC_STATUS_TIME_DONE', 30_000);
    await mock.waitForOutput(/Worked for [1-9]\d*s/, 30_000);

    const screen = await waitForScreenMatch(
      mock,
      /~\/1 [^\n]*[1-9]\d*s/,
      5_000,
      'status line should show assistant leaf and completed work time',
    );
    assert.match(screen, /~\/1 [^\n]*[1-9]\d*s/, 'status line should show assistant leaf and completed work time');

    const messages = readEntries(sessionFile).filter((entry) => entry.type === 'message');
    const user = messages.find((entry) => entry.message?.role === 'user' && entry.message?.content?.[0]?.text === 'test persisted assistant status time');
    const assistant = messages.find((entry) => entry.message?.role === 'assistant' && entry.message?.content?.[0]?.text === 'SYNC_STATUS_TIME_DONE');
    assert.equal(assistant?.parentId, user?.id);
  } finally {
    await mock.close();
    await removeRoot(root);
  }
});
