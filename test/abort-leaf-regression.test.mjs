import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function readEntries(sessionFile) {
  return readFileSync(sessionFile, 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function entryText(entry) {
  const content = entry?.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

function latestUserText(request) {
  const userMessages = (request.messages ?? []).filter((message) => message.role === 'user');
  const message = userMessages.at(-1);
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

nodeTest('pi-sync abort matches native Pi by leaving the live leaf on the aborted assistant marker', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-abort-leaf-'));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'shared.jsonl');
  const helperExt = join(root, 'leaf-helper.mjs');
  const brain = createControllableBrain();
  writeFileSync(sessionFile, '', 'utf8');
  writeFileSync(helperExt, `
export default function leafHelper(pi) {
  pi.registerCommand("_leaf_text", {
    description: "Print current session leaf id, role, stop reason, and text",
    handler: async (_args, ctx) => {
      const leafId = ctx.sessionManager.getLeafId();
      const entry = ctx.sessionManager.getEntries().find((item) => item.id === leafId);
      const content = entry?.message?.content;
      const text = Array.isArray(content)
        ? content.filter((part) => part?.type === "text").map((part) => part.text).join("")
        : "";
      ctx.ui.notify("leaf_probe:" + JSON.stringify({
        leafId,
        role: entry?.message?.role,
        stopReason: entry?.message?.stopReason,
        text,
      }), "info");
    },
  });
}
`, 'utf8');

  const mock = await createInteractiveMock({
    brain: brain.brain,
    extensions: [EXTENSION, helperExt],
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
    mock.submit('SYNC_ABORT_LEAF_ORIGINAL_PROMPT');
    const abortedCall = await brain.waitForCall(TIMEOUT);
    assert.equal(latestUserText(abortedCall.request), 'SYNC_ABORT_LEAF_ORIGINAL_PROMPT');
    await mock.waitForOutput('SYNC_ABORT_LEAF_ORIGINAL_PROMPT', TIMEOUT);

    mock.sendKey('escape');
    await mock.waitForOutput(/Operation aborted|aborted/i, TIMEOUT);

    // Native Pi leaves the live branch head on the aborted assistant marker.
    // This is intentional parity: /tree shows the aborted marker as the current
    // leaf, while a real new follow-up prompt still becomes the latest user
    // request (covered by abort-followup-context.test.mjs).
    mock.clearOutput();
    mock.submit('/_leaf_text');
    await mock.waitForOutput('leaf_probe:', TIMEOUT);

    const screen = mock.output;
    const match = screen.match(/leaf_probe:(\{[^\n]+\})/);
    assert.ok(match, `missing leaf probe in output:\n${screen}`);
    const probe = JSON.parse(match[1]);

    const entries = readEntries(sessionFile);
    const originalUser = entries.find((entry) => entry?.message?.role === 'user' && entryText(entry) === 'SYNC_ABORT_LEAF_ORIGINAL_PROMPT');
    const abortedAssistant = entries.find((entry) => entry?.message?.role === 'assistant' && entry?.message?.stopReason === 'aborted');
    assert.ok(originalUser, 'original user prompt should be persisted');
    assert.ok(abortedAssistant, 'aborted assistant marker should be persisted');
    assert.equal(abortedAssistant.parentId, originalUser.id, 'aborted assistant marker should be a child of the original user prompt');

    assert.deepEqual(
      { role: probe.role, stopReason: probe.stopReason, text: probe.text },
      { role: 'assistant', stopReason: 'aborted', text: '' },
      `After abort, pi-sync should match native Pi and keep the aborted assistant marker as the live leaf. Actual leaf: ${JSON.stringify(probe)}. Session entries: ${JSON.stringify(entries.map((entry) => ({ id: entry.id, parentId: entry.parentId, role: entry.message?.role, stopReason: entry.message?.stopReason, text: entryText(entry) })), null, 2)}`,
    );
    assert.equal(probe.leafId, abortedAssistant.id, 'live leaf should be the aborted assistant marker, matching native Pi');

    abortedCall.respond(text('SYNC_ABORT_LEAF_SHOULD_NOT_RENDER'));
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.doesNotMatch(mock.output, /SYNC_ABORT_LEAF_SHOULD_NOT_RENDER/);
  } finally {
    await mock.close();
    await removeRoot(root);
  }
});
