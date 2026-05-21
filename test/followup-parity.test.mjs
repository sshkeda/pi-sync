import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInteractiveMock, createControllableBrain, text, bash } from '../../pi-mock/dist/index.js';

const EXTENSION = new URL('../index.ts', import.meta.url).pathname;
const TIMEOUT = 30_000;

function writePiWrapper(root) {
  const piWrapper = join(root, 'pi-wrapper.sh');
  writeFileSync(piWrapper, `#!/usr/bin/env bash\nargs=()\nfor a in "$@"; do [[ "$a" == "--no-session" ]] && continue; args+=("$a"); done\nexec "${process.env.PI_SYNC_TEST_PI_BINARY ?? 'pi'}" "\${args[@]}"\n`);
  chmodSync(piWrapper, 0o755);
  return piWrapper;
}

async function removeRoot(root) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try { rmSync(root, { recursive: true, force: true }); return; }
    catch (error) {
      if (attempt === 4 || !['ENOTEMPTY', 'EBUSY', 'ENOENT'].includes(error?.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

async function waitUntil(predicate, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timeout waiting for ${label}`);
}

function requestTextSummary(request) {
  return (request.messages ?? []).map((message) => {
    const content = message.content;
    const text = Array.isArray(content)
      ? content.map((part) => part?.type === 'text' ? part.text : part?.type).join('|')
      : String(content ?? '');
    return `${message.role}:${text}`;
  });
}

test('pi-sync abort restores queued Alt+Enter follow-up text to the editor like native Pi', { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-followup-abort-'));
  const sessionFile = join(root, 'shared.jsonl');
  const brain = createControllableBrain();
  writeFileSync(sessionFile, '', 'utf8');

  const mock = await createInteractiveMock({
    brain: brain.brain,
    extensions: [EXTENSION],
    piProvider: 'pi-mock',
    piModel: 'mock',
    startupTimeoutMs: 20_000,
    terminal: { cols: 110, rows: 34 },
    cwd: root,
    env: { PI_LANE_ROOT: join(root, 'lane'), PI_SYNC_POLL_MS: '25', PI_SYNC_HOST_IDLE_MS: '5000' },
    piBinary: writePiWrapper(root),
    piArgs: ['--session', sessionFile],
  });

  try {
    mock.submit('SYNC_FOLLOWUP_ABORT_BASE');
    await brain.waitForCall(TIMEOUT);
    await mock.waitForOutput('SYNC_FOLLOWUP_ABORT_BASE', TIMEOUT);

    mock.type('SYNC_FOLLOWUP_ABORT_QUEUED');
    mock.type('\x1b\r');
    await mock.waitForOutput('Follow-up: SYNC_FOLLOWUP_ABORT_QUEUED', TIMEOUT);

    mock.sendKey('escape');
    await mock.waitForOutput(/Operation aborted|aborted/i, TIMEOUT);
    let visible = '';
    await waitUntil(async () => {
      visible = (await mock.visibleScreen()).join('\n');
      return visible.includes('SYNC_FOLLOWUP_ABORT_QUEUED');
    }, 2_000, `queued follow-up restored to editor after abort; last screen:\n${visible}`);
  } finally {
    await mock.close();
    await removeRoot(root);
  }
});

test('pi-sync Alt+Enter follow-up waits until after the active tool turn like native Pi', { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-followup-parity-'));
  const sessionFile = join(root, 'shared.jsonl');
  const brain = createControllableBrain();
  writeFileSync(sessionFile, '', 'utf8');

  const mock = await createInteractiveMock({
    brain: brain.brain,
    extensions: [EXTENSION],
    piProvider: 'pi-mock',
    piModel: 'mock',
    startupTimeoutMs: 20_000,
    terminal: { cols: 110, rows: 34 },
    cwd: root,
    env: { PI_LANE_ROOT: join(root, 'lane'), PI_SYNC_POLL_MS: '25', PI_SYNC_HOST_IDLE_MS: '5000' },
    piBinary: writePiWrapper(root),
    piArgs: ['--session', sessionFile],
  });

  try {
    mock.submit('SYNC_FOLLOWUP_BASE_PROMPT');
    const firstCall = await brain.waitForCall(TIMEOUT);
    await mock.waitForOutput('SYNC_FOLLOWUP_BASE_PROMPT', TIMEOUT);

    mock.type('SYNC_FOLLOWUP_ALT_ENTER_TEXT');
    mock.type('\x1b\r'); // terminal encoding for Alt+Enter in pi-mock/native Pi
    await mock.waitForOutput('Follow-up: SYNC_FOLLOWUP_ALT_ENTER_TEXT', TIMEOUT);

    firstCall.respond(bash('echo tool-step'));
    const toolContinuationCall = await brain.waitForCall(TIMEOUT);
    const toolContinuationSummary = requestTextSummary(toolContinuationCall.request);
    assert.ok(
      !toolContinuationSummary.some((line) => line.includes('SYNC_FOLLOWUP_ALT_ENTER_TEXT')),
      `Alt+Enter follow-up should not be steered into the active tool continuation; native Pi waits until the active turn finishes. Saw:\n${toolContinuationSummary.join('\n')}`,
    );

    toolContinuationCall.respond(text('SYNC_FOLLOWUP_FIRST_TURN_DONE'));
    await mock.waitForOutput('SYNC_FOLLOWUP_FIRST_TURN_DONE', TIMEOUT);

    const followupCall = await brain.waitForCall(TIMEOUT);
    const followupSummary = requestTextSummary(followupCall.request);
    assert.ok(
      followupSummary.some((line) => line.includes('SYNC_FOLLOWUP_ALT_ENTER_TEXT')),
      `queued follow-up should run as the next turn after the active turn finishes. Saw:\n${followupSummary.join('\n')}`,
    );
    followupCall.respond(text('SYNC_FOLLOWUP_SECOND_TURN_DONE'));
    await mock.waitForOutput('SYNC_FOLLOWUP_SECOND_TURN_DONE', TIMEOUT);
  } finally {
    await mock.close();
    await removeRoot(root);
  }
});
