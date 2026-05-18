import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
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

function countVisible(lines, needle) {
  return lines.filter((line) => line.includes(needle)).length;
}

test('pi-sync resume does not replay completed host history over native session render', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-resume-no-replay-'));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'shared.jsonl');
  const piWrapper = writePiWrapper(root);
  writeFileSync(sessionFile, '', 'utf8');

  const first = await createInteractiveMock({
    brain: script(text('SYNC_RESUME_RESPONSE')),
    extensions: [EXTENSION],
    piProvider: 'pi-mock',
    piModel: 'mock',
    startupTimeoutMs: 20_000,
    terminal: { cols: 100, rows: 32 },
    cwd: root,
    env: { PI_LANE_ROOT: laneRoot, PI_SYNC_POLL_MS: '25', PI_SYNC_HOST_IDLE_MS: '5000' },
    piBinary: piWrapper,
    piArgs: ['--session', sessionFile],
  });

  try {
    first.submit('SYNC_RESUME_PROMPT');
    await first.waitForOutput('SYNC_RESUME_RESPONSE', TIMEOUT);
  } finally {
    await first.close();
  }

  const saved = readFileSync(sessionFile, 'utf8');
  assert.equal(saved.match(/SYNC_RESUME_PROMPT/g)?.length, 1, saved);
  assert.equal(saved.match(/SYNC_RESUME_RESPONSE/g)?.length, 1, saved);

  const second = await createInteractiveMock({
    brain: script(text('unused')),
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
    await second.waitForOutput('SYNC_RESUME_RESPONSE', TIMEOUT);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const screen = await second.visibleScreen();
    assert.equal(countVisible(screen, 'SYNC_RESUME_PROMPT'), 1, screen.join('\n'));
    assert.equal(countVisible(screen, 'SYNC_RESUME_RESPONSE'), 1, screen.join('\n'));
  } finally {
    await second.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('pi-sync second attached terminal does not replay completed host history over native session render', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-attach-no-replay-'));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'shared.jsonl');
  const piWrapper = writePiWrapper(root);
  writeFileSync(sessionFile, '', 'utf8');

  const first = await createInteractiveMock({
    brain: script(text('SYNC_ATTACH_RESPONSE')),
    extensions: [EXTENSION],
    piProvider: 'pi-mock',
    piModel: 'mock',
    startupTimeoutMs: 20_000,
    terminal: { cols: 100, rows: 32 },
    cwd: root,
    env: { PI_LANE_ROOT: laneRoot, PI_SYNC_POLL_MS: '25', PI_SYNC_HOST_IDLE_MS: '5000' },
    piBinary: piWrapper,
    piArgs: ['--session', sessionFile],
  });

  let second;
  try {
    first.submit('SYNC_ATTACH_PROMPT');
    await first.waitForOutput('SYNC_ATTACH_RESPONSE', TIMEOUT);
    await new Promise((resolve) => setTimeout(resolve, 250));

    second = await createInteractiveMock({
      brain: script(text('unused')),
      extensions: [EXTENSION],
      piProvider: 'pi-mock',
      piModel: 'mock',
      startupTimeoutMs: 20_000,
      terminal: { cols: 100, rows: 32 },
      cwd: root,
      env: { PI_LANE_ROOT: laneRoot, PI_SYNC_POLL_MS: '25', PI_SYNC_HOST_IDLE_MS: '5000' },
      piBinary: piWrapper,
      piArgs: ['--session', sessionFile],
    });

    await second.waitForOutput('SYNC_ATTACH_RESPONSE', TIMEOUT);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const screen = await second.visibleScreen();
    assert.equal(countVisible(screen, 'SYNC_ATTACH_PROMPT'), 1, screen.join('\n'));
    assert.equal(countVisible(screen, 'SYNC_ATTACH_RESPONSE'), 1, screen.join('\n'));
  } finally {
    await second?.close();
    await first.close();
    rmSync(root, { recursive: true, force: true });
  }
});
