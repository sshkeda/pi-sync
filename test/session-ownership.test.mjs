import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createControllableBrain, createInteractiveMock, text } from '../../pi-mock/dist/index.js';

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

function readEntries(path) {
  const raw = readFileSync(path, 'utf8').trim();
  if (!raw) return [];
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function messageText(entry) {
  const content = entry?.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
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

async function respondToPrompt(brain, promptText, responseText) {
  const call = await brain.waitForCall(TIMEOUT);
  assert.match(JSON.stringify(call.request), new RegExp(promptText), `expected provider request for ${promptText}`);
  call.respond(text(responseText));
}

test('pi-sync UI clients cannot clobber the host-owned session file and local commands do not mutate it', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-session-owner-'));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'shared.jsonl');
  const piWrapper = writePiWrapper(root);
  const helperExt = join(root, 'test-helper-extension-tree-nav.mjs');
  const brain = createControllableBrain();
  writeFileSync(sessionFile, '', 'utf8');
  writeFileSync(helperExt, `
export default function treeNavHelper(pi) {
  pi.registerCommand("_tree_nav_to_text", {
    description: "Navigate to the first message whose text matches args",
    handler: async (args, ctx) => {
      const wanted = args.trim();
      const file = ctx.sessionManager.getSessionFile();
      if (file) ctx.sessionManager.setSessionFile(file);
      const entry = ctx.sessionManager.getEntries().find((item) => {
        const content = item.message?.content;
        return Array.isArray(content) && content.some((part) => part.type === "text" && part.text === wanted);
      });
      if (!entry) throw new Error("entry not found: " + wanted);
      await ctx.navigateTree(entry.id);
      ctx.ui.notify("leaf_after_nav:" + ctx.sessionManager.getLeafId(), "info");
    },
  });
}
`, 'utf8');

  const common = {
    brain: brain.brain,
    extensions: [EXTENSION, helperExt],
    piProvider: 'pi-mock',
    piModel: 'mock',
    startupTimeoutMs: 20_000,
    terminal: { cols: 120, rows: 36 },
    cwd: root,
    env: { PI_LANE_ROOT: laneRoot, PI_SYNC_POLL_MS: '25', PI_SYNC_HOST_IDLE_MS: '1000' },
    piBinary: piWrapper,
    piArgs: ['--session', sessionFile],
  };

  const a = await createInteractiveMock(common);
  const b = await createInteractiveMock(common);
  try {
    a.clearOutput();
    b.clearOutput();

    a.submit('SYNC_OWNER_FIRST_PROMPT');
    await respondToPrompt(brain, 'SYNC_OWNER_FIRST_PROMPT', 'SYNC_OWNER_FIRST_ANSWER');
    await a.waitForOutput('SYNC_OWNER_FIRST_ANSWER', TIMEOUT);
    await b.waitForOutput('SYNC_OWNER_FIRST_ANSWER', TIMEOUT);

    a.submit('SYNC_OWNER_SECOND_PROMPT');
    await respondToPrompt(brain, 'SYNC_OWNER_SECOND_PROMPT', 'SYNC_OWNER_SECOND_ANSWER');
    await a.waitForOutput('SYNC_OWNER_SECOND_ANSWER', TIMEOUT);
    await b.waitForOutput('SYNC_OWNER_SECOND_ANSWER', TIMEOUT);

    const entries = readEntries(sessionFile);
    assert.equal(entries.filter((entry) => entry.type === 'session').length, 1, 'session file must keep exactly one header');
    assert.equal(entries[0]?.type, 'session', 'session header must remain first');

    const messages = entries.filter((entry) => entry.type === 'message').map(messageText);
    assert.deepEqual(messages, [
      'SYNC_OWNER_FIRST_PROMPT',
      'SYNC_OWNER_FIRST_ANSWER',
      'SYNC_OWNER_SECOND_PROMPT',
      'SYNC_OWNER_SECOND_ANSWER',
    ]);

    const beforeLocalCommand = readFileSync(sessionFile, 'utf8');
    b.clearOutput();

    b.submit('/_tree_nav_to_text SYNC_OWNER_FIRST_ANSWER');
    await b.waitForOutput('leaf_after_nav:', TIMEOUT);

    b.submit('/lane new audit-side');
    await b.waitForOutput(/created and joined audit-side/, TIMEOUT);

    b.submit('/lane join 1');
    await b.waitForOutput(/joined L1 \(main\)/, TIMEOUT);

    b.submit('/lane status');
    await b.waitForOutput(/pi-sync lane: current L1 \(main\)/, TIMEOUT);

    b.submit('/sync status');
    await b.waitForOutput(/pi-sync: instance=/, TIMEOUT);

    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(
      readFileSync(sessionFile, 'utf8'),
      beforeLocalCommand,
      'attached-terminal tree navigation, lane commands, and sync status must not rewrite the host-owned session file',
    );
  } finally {
    await a.close();
    await b.close();
    await removeRoot(root);
  }
});

test('pi-sync keeps unavailable-host queued prompts invisible to local persistence and custom UI', { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-host-unavailable-'));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'shared.jsonl');
  const piWrapper = writePiWrapper(root);
  writeFileSync(sessionFile, '', 'utf8');

  const canonicalSessionFile = realpathSync(sessionFile);
  const sessionKey = stableSessionKey(canonicalSessionFile);
  const ownerPath = join(laneRoot, 'sessions', sessionKey, 'lanes', 'main', 'sync', 'host.lock', 'owner.json');
  mkdirSync(dirname(ownerPath), { recursive: true });
  writeFileSync(ownerPath, JSON.stringify({
    schemaVersion: 1,
    state: 'starting',
    pid: process.pid,
    heartbeatAt: new Date().toISOString(),
  }) + '\n');

  const mock = await createInteractiveMock({
    brain: createControllableBrain().brain,
    extensions: [EXTENSION],
    piProvider: 'pi-mock',
    piModel: 'mock',
    startupTimeoutMs: 20_000,
    terminal: { cols: 120, rows: 32 },
    cwd: root,
    env: {
      PI_LANE_ROOT: laneRoot,
      PI_SYNC_POLL_MS: '25',
      PI_SYNC_HOST_RECONNECT_MS: '25',
      PI_SYNC_HOST_LEASE_MS: '5000',
      PI_SYNC_HOST_IDLE_MS: '1000',
    },
    piBinary: piWrapper,
    piArgs: ['--session', sessionFile],
  });

  try {
    mock.clearOutput();
    mock.submit('SYNC_UNAVAILABLE_PROMPT');
    await new Promise((resolve) => setTimeout(resolve, 500));

    const entries = readEntries(sessionFile);
    assert.equal(
      entries.filter((entry) => messageText(entry) === 'SYNC_UNAVAILABLE_PROMPT').length,
      0,
      'queued host prompt must not be persisted by the attached UI process',
    );
    assert.doesNotMatch(mock.output, /pi-sync: waiting for sync host|prompt is queued/);
  } finally {
    await mock.close();
    await removeRoot(root);
  }
});
