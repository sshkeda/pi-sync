import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

async function removeRoot(root) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 4 || !['ENOTEMPTY', 'EBUSY', 'ENOENT'].includes(error?.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

function textFromMessage(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part?.type === 'text' && typeof part.text === 'string') return part.text;
      if (part?.type === 'input_text' && typeof part.text === 'string') return part.text;
      return '';
    })
    .join('');
}

function messagesSummary(request) {
  return (request.messages ?? []).map((message) => ({
    role: message.role,
    text: textFromMessage(message),
    stopReason: message.stopReason,
  }));
}

nodeTest('pi-sync follow-up after abort sends the new user message, not an automatic retry of the aborted prompt', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-abort-followup-'));
  const laneRoot = join(root, 'lane');
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
    env: { PI_LANE_ROOT: laneRoot, PI_SYNC_POLL_MS: '25', PI_SYNC_HOST_IDLE_MS: '1000' },
    piBinary: writePiWrapper(root),
    piArgs: ['--session', sessionFile],
  });

  try {
    mock.clearOutput();
    mock.submit('SYNC_ABORT_CONTEXT_ORIGINAL_PROMPT');
    const abortedCall = await brain.waitForCall(TIMEOUT);
    assert.equal(textFromMessage((abortedCall.request.messages ?? []).filter((m) => m.role === 'user').at(-1)), 'SYNC_ABORT_CONTEXT_ORIGINAL_PROMPT');
    await mock.waitForOutput('SYNC_ABORT_CONTEXT_ORIGINAL_PROMPT', TIMEOUT);

    mock.sendKey('escape');
    await mock.waitForOutput(/Operation aborted|aborted/i, TIMEOUT);

    mock.clearOutput();
    mock.submit('SYNC_ABORT_CONTEXT_FOLLOWUP_PROMPT');
    const followupCall = await brain.waitForCall(TIMEOUT);
    const summary = messagesSummary(followupCall.request);
    const userTexts = summary.filter((message) => message.role === 'user').map((message) => message.text);
    const latestUser = userTexts.at(-1);

    assert.equal(
      latestUser,
      'SYNC_ABORT_CONTEXT_FOLLOWUP_PROMPT',
      `A real new message after abort should be the latest user request. Request summary:\n${JSON.stringify(summary, null, 2)}`,
    );
    assert.ok(
      userTexts.includes('SYNC_ABORT_CONTEXT_ORIGINAL_PROMPT'),
      `Original aborted prompt remains in history, but it is not the latest actionable user request. Request summary:\n${JSON.stringify(summary, null, 2)}`,
    );

    followupCall.respond(text('SYNC_ABORT_CONTEXT_FOLLOWUP_ANSWER'));
    await mock.waitForOutput('SYNC_ABORT_CONTEXT_FOLLOWUP_ANSWER', TIMEOUT);
    abortedCall.respond(text('SYNC_ABORT_CONTEXT_SHOULD_NOT_RENDER'));
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.doesNotMatch(mock.output, /SYNC_ABORT_CONTEXT_SHOULD_NOT_RENDER/);
  } finally {
    await mock.close();
    await removeRoot(root);
  }
});
