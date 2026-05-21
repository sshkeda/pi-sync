import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInteractiveMock, createControllableBrain, streamText, text } from '../../pi-mock/dist/index.js';

const EXTENSION = new URL('../index.ts', import.meta.url).pathname;
const PI_WORKING = new URL('../../pi-working/index.ts', import.meta.url).pathname;
const TIMEOUT = 30_000;

function writePiWrapper(root) {
  const piWrapper = join(root, 'pi-wrapper.sh');
  writeFileSync(piWrapper, `#!/usr/bin/env bash\nargs=()\nfor a in "$@"; do [[ "$a" == "--no-session" ]] && continue; args+=("$a"); done\nexec "${process.env.PI_SYNC_TEST_PI_BINARY ?? 'pi'}" "\${args[@]}"\n`);
  chmodSync(piWrapper, 0o755);
  return piWrapper;
}

function countVisible(lines, needle) {
  return lines.filter((line) => line.includes(needle)).length;
}

async function waitUntil(predicate, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timeout waiting for ${label}`);
}

function workingSeconds(lines) {
  const text = lines.join('\n');
  const match = text.match(/Working for (?:(\d+)h )?(?:(\d+)m )?(\d+)s/);
  if (!match) return undefined;
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
}

async function waitForWorkingSeconds(mock, minimum, timeoutMs, label) {
  let screen = [];
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    screen = await mock.visibleScreen();
    const seconds = workingSeconds(screen);
    if (seconds != null && seconds >= minimum) return { seconds, screen };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timeout waiting for ${label}\n${screen.join('\n')}`);
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

function ensurePersistedUserPrompt(sessionFile, cwd, prompt) {
  const existing = readFileSync(sessionFile, 'utf8');
  if (existing.includes(prompt)) return;
  const now = new Date().toISOString();
  const entries = [
    { type: 'session', version: 3, id: 'late-join-test', timestamp: now, cwd },
    {
      type: 'message',
      id: 'persisted-user-prompt',
      parentId: null,
      timestamp: now,
      message: { role: 'user', content: [{ type: 'text', text: prompt }], timestamp: Date.now() },
    },
  ];
  writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
}

function writeCompletedBaseSession(sessionFile, cwd, prompt, answer) {
  const now = new Date().toISOString();
  writeFileSync(sessionFile, [
    JSON.stringify({ type: 'session', version: 3, id: 'active-guard-session', timestamp: now, cwd }),
    JSON.stringify({ type: 'message', id: 'active-guard-base-user', parentId: null, timestamp: now, message: { role: 'user', content: [{ type: 'text', text: prompt }] } }),
    JSON.stringify({ type: 'message', id: 'active-guard-base-assistant', parentId: 'active-guard-base-user', timestamp: now, message: { role: 'assistant', content: [{ type: 'text', text: answer }], stopReason: 'stop', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } }),
    '',
  ].join('\n'), 'utf8');
}

function appendPersistedUserPrompt(sessionFile, prompt, parentId) {
  const now = new Date().toISOString();
  const entry = { type: 'message', id: 'active-guard-user-prompt', parentId, timestamp: now, message: { role: 'user', content: [{ type: 'text', text: prompt }], timestamp: Date.now() } };
  writeFileSync(sessionFile, `${readFileSync(sessionFile, 'utf8').trimEnd()}\n${JSON.stringify(entry)}\n`, 'utf8');
}

function writeMainLaneState(laneRoot, sessionKey, sessionFile, headEntryId) {
  const now = new Date().toISOString();
  const dir = join(laneRoot, 'sessions', sessionKey, 'lanes');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'main.json'), JSON.stringify({
    schemaVersion: 1,
    name: 'main',
    sessionKey,
    baseLeafId: null,
    headEntryId,
    headEpoch: 1,
    createdAt: now,
    updatedAt: now,
    id: 'ln_activeguard',
    displayId: 'L1',
    aliasPath: join(laneRoot, 'flat', 'ln_activeguard.json'),
  }, null, 2));
}

function readMainLaneState(laneRoot, sessionKey) {
  return JSON.parse(readFileSync(join(laneRoot, 'sessions', sessionKey, 'lanes', 'main.json'), 'utf8'));
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

function findMessageEntry(sessionFile, textValue) {
  return readFileSync(sessionFile, 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find((entry) => messageText(entry) === textValue);
}

function readHostInfo(laneRoot, sessionKey) {
  const path = join(laneRoot, 'sessions', sessionKey, 'lanes', 'main', 'sync', 'host.json');
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8'));
}

test('pi-sync hydrates a late-joining attached terminal during an active turn', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-late-join-'));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'shared.jsonl');
  const piWrapper = writePiWrapper(root);
  const brain = createControllableBrain();
  writeFileSync(sessionFile, '', 'utf8');
  const canonicalSessionFile = realpathSync(sessionFile);
  const sessionKey = 'late-join-shared-key';

  const common = {
    brain: brain.brain,
    extensions: [EXTENSION],
    piProvider: 'pi-mock',
    piModel: 'mock',
    startupTimeoutMs: 20_000,
    terminal: { cols: 100, rows: 32 },
    cwd: root,
    env: { PI_LANE_ROOT: laneRoot, PI_LANE_SESSION_KEY: sessionKey, PI_LANE_SESSION_FILE: canonicalSessionFile, PI_SYNC_POLL_MS: '25', PI_SYNC_HOST_IDLE_MS: '1000' },
    piBinary: piWrapper,
    piArgs: ['--session', sessionFile],
  };

  const a = await createInteractiveMock(common);
  let b;
  try {
    a.clearOutput();
    a.submit('SYNC_LATE_JOIN_PROMPT');
    const call = await brain.waitForCall(TIMEOUT);
    ensurePersistedUserPrompt(sessionFile, root, 'SYNC_LATE_JOIN_PROMPT');
    await waitUntil(() => readFileSync(sessionFile, 'utf8').includes('SYNC_LATE_JOIN_PROMPT'), TIMEOUT, 'persisted late-join prompt');

    b = await createInteractiveMock(common);
    // Do not clear B's output here: late-join hydration can render during startup.
    await b.waitForOutput('SYNC_LATE_JOIN_PROMPT', TIMEOUT);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const beforeResponse = await b.visibleScreen();
    assert.equal(
      countVisible(beforeResponse, 'SYNC_LATE_JOIN_PROMPT'),
      1,
      `late join must not duplicate persisted user prompts before the active response:\n${beforeResponse.join('\n')}`,
    );

    call.respond(text('SYNC_LATE_JOIN_RESPONSE'));
    await a.waitForOutput('SYNC_LATE_JOIN_RESPONSE', TIMEOUT);
    await b.waitForOutput('SYNC_LATE_JOIN_RESPONSE', TIMEOUT);
    const afterResponse = await b.visibleScreen();
    assert.equal(
      countVisible(afterResponse, 'SYNC_LATE_JOIN_PROMPT'),
      1,
      `late join must not duplicate persisted user prompts after the active response:\n${afterResponse.join('\n')}`,
    );
    assert.match(b.output, /SYNC_LATE_JOIN_RESPONSE/);
  } finally {
    await a.close();
    if (b) await b.close();
    await removeRoot(root);
  }
});

test('pi-sync late join does not reconcile an active host lane to a persisted user prompt', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-late-join-active-head-guard-'));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'shared.jsonl');
  const piWrapper = writePiWrapper(root);
  const brain = createControllableBrain();
  const sessionKey = 'late-join-active-head-guard-key';
  writeCompletedBaseSession(sessionFile, root, 'SYNC_ACTIVE_GUARD_BASE_PROMPT', 'SYNC_ACTIVE_GUARD_BASE_ANSWER');
  const canonicalSessionFile = realpathSync(sessionFile);
  writeMainLaneState(laneRoot, sessionKey, canonicalSessionFile, 'active-guard-base-assistant');

  const common = {
    brain: brain.brain,
    extensions: [EXTENSION],
    piProvider: 'pi-mock',
    piModel: 'mock',
    startupTimeoutMs: 20_000,
    terminal: { cols: 110, rows: 34 },
    cwd: root,
    env: { PI_LANE_ROOT: laneRoot, PI_LANE_SESSION_KEY: sessionKey, PI_LANE_SESSION_FILE: canonicalSessionFile, PI_SYNC_POLL_MS: '25', PI_SYNC_HOST_IDLE_MS: '1000' },
    piBinary: piWrapper,
    piArgs: ['--session', sessionFile],
  };

  const a = await createInteractiveMock(common);
  let b;
  try {
    await a.waitForOutput('SYNC_ACTIVE_GUARD_BASE_ANSWER', TIMEOUT);
    const baseHeadBeforePrompt = readMainLaneState(laneRoot, sessionKey).headEntryId;
    a.clearOutput();
    a.submit('SYNC_ACTIVE_GUARD_PROMPT');
    const call = await brain.waitForCall(TIMEOUT);
    await waitUntil(() => !!readHostInfo(laneRoot, sessionKey)?.activePromptId, TIMEOUT, 'active host prompt before late join');
    appendPersistedUserPrompt(sessionFile, 'SYNC_ACTIVE_GUARD_PROMPT', 'active-guard-base-assistant');

    b = await createInteractiveMock(common);
    await b.waitForOutput('SYNC_ACTIVE_GUARD_PROMPT', TIMEOUT);
    const activePrompt = findMessageEntry(sessionFile, 'SYNC_ACTIVE_GUARD_PROMPT');
    assert.equal(
      readMainLaneState(laneRoot, sessionKey).headEntryId,
      baseHeadBeforePrompt,
      'late join startup must leave an active host lane head on the previous assistant',
    );
    assert.notEqual(readMainLaneState(laneRoot, sessionKey).headEntryId, activePrompt.id, 'active host lane head must not move to the persisted user prompt');

    call.respond(text('SYNC_ACTIVE_GUARD_RESPONSE'));
    await a.waitForOutput('SYNC_ACTIVE_GUARD_RESPONSE', TIMEOUT);
    await b.waitForOutput('SYNC_ACTIVE_GUARD_RESPONSE', TIMEOUT);
    await waitUntil(
      () => {
        const response = findMessageEntry(sessionFile, 'SYNC_ACTIVE_GUARD_RESPONSE');
        return response && readMainLaneState(laneRoot, sessionKey).headEntryId === response.id;
      },
      TIMEOUT,
      'lane head advances after active host response',
    );
  } finally {
    await a.close();
    if (b) await b.close();
    await removeRoot(root);
  }
});

test('pi-sync late join working timer follows host elapsed time and keeps ticking', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-late-join-working-'));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'shared.jsonl');
  const piWrapper = writePiWrapper(root);
  const brain = createControllableBrain();
  writeFileSync(sessionFile, '', 'utf8');
  const canonicalSessionFile = realpathSync(sessionFile);
  const sessionKey = 'late-join-working-key';

  const common = {
    brain: brain.brain,
    extensions: [EXTENSION, PI_WORKING],
    piProvider: 'pi-mock',
    piModel: 'mock',
    startupTimeoutMs: 20_000,
    terminal: { cols: 100, rows: 34 },
    cwd: root,
    env: { PI_LANE_ROOT: laneRoot, PI_LANE_SESSION_KEY: sessionKey, PI_LANE_SESSION_FILE: canonicalSessionFile, PI_SYNC_POLL_MS: '25', PI_SYNC_HOST_IDLE_MS: '1000' },
    piBinary: piWrapper,
    piArgs: ['--session', sessionFile],
  };

  const a = await createInteractiveMock(common);
  let b;
  try {
    a.clearOutput();
    a.submit('SYNC_LATE_JOIN_WORKING_PROMPT');
    const call = await brain.waitForCall(TIMEOUT);
    ensurePersistedUserPrompt(sessionFile, root, 'SYNC_LATE_JOIN_WORKING_PROMPT');
    call.respond(streamText([
      'SYNC_LATE_JOIN_WORKING_CHUNK_1 ',
      'SYNC_LATE_JOIN_WORKING_CHUNK_2 ',
      'SYNC_LATE_JOIN_WORKING_CHUNK_3 ',
      'SYNC_LATE_JOIN_WORKING_CHUNK_4 ',
      'SYNC_LATE_JOIN_WORKING_DONE',
    ], 1000));
    await a.waitForOutput('SYNC_LATE_JOIN_WORKING_CHUNK_1', TIMEOUT);
    await new Promise((resolve) => setTimeout(resolve, 1600));

    b = await createInteractiveMock(common);
    await b.waitForOutput('SYNC_LATE_JOIN_WORKING_PROMPT', TIMEOUT);
    await b.waitForOutput('SYNC_LATE_JOIN_WORKING_CHUNK_1', TIMEOUT);

    const first = await waitForWorkingSeconds(b, 2, TIMEOUT, 'late join working timer to inherit host elapsed time');
    const second = await waitForWorkingSeconds(b, first.seconds + 1, TIMEOUT, 'late join working timer to keep ticking');
    assert.ok(
      second.seconds > first.seconds,
      `late join working timer must advance\nfirst:\n${first.screen.join('\n')}\nsecond:\n${second.screen.join('\n')}`,
    );
  } finally {
    await a.close();
    if (b) await b.close();
    await removeRoot(root);
  }
});

test('pi-sync renders repeated prompt text once per submitted turn', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-late-join-repeat-'));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'shared.jsonl');
  const piWrapper = writePiWrapper(root);
  const brain = createControllableBrain();
  writeFileSync(sessionFile, '', 'utf8');

  const common = {
    brain: brain.brain,
    extensions: [EXTENSION],
    piProvider: 'pi-mock',
    piModel: 'mock',
    startupTimeoutMs: 20_000,
    terminal: { cols: 100, rows: 40 },
    cwd: root,
    env: { PI_LANE_ROOT: laneRoot, PI_SYNC_POLL_MS: '25', PI_SYNC_HOST_IDLE_MS: '1000' },
    piBinary: piWrapper,
    piArgs: ['--session', sessionFile],
  };

  const a = await createInteractiveMock(common);
  try {
    a.submit('SYNC_REPEAT_PROMPT');
    let call = await brain.waitForCall(TIMEOUT);
    call.respond(text('SYNC_REPEAT_RESPONSE_ONE'));
    await a.waitForOutput('SYNC_REPEAT_RESPONSE_ONE', TIMEOUT);
    await waitUntil(() => readFileSync(sessionFile, 'utf8').includes('SYNC_REPEAT_RESPONSE_ONE'), TIMEOUT, 'persisted first repeated turn');

    a.submit('SYNC_REPEAT_PROMPT');
    call = await brain.waitForCall(TIMEOUT);
    call.respond(text('SYNC_REPEAT_RESPONSE_TWO'));
    await a.waitForOutput('SYNC_REPEAT_RESPONSE_TWO', TIMEOUT);
    await waitUntil(() => readFileSync(sessionFile, 'utf8').includes('SYNC_REPEAT_RESPONSE_TWO'), TIMEOUT, 'persisted second repeated turn');

    await new Promise((resolve) => setTimeout(resolve, 500));
    const screen = await a.visibleScreen();
    assert.equal(
      countVisible(screen, 'SYNC_REPEAT_PROMPT'),
      2,
      `repeated prompt text must render once per real submitted turn:\n${screen.join('\n')}`,
    );
    assert.equal(countVisible(screen, 'SYNC_REPEAT_RESPONSE_ONE'), 1, screen.join('\n'));
    assert.equal(countVisible(screen, 'SYNC_REPEAT_RESPONSE_TWO'), 1, screen.join('\n'));
  } finally {
    await a.close();
    await removeRoot(root);
  }
});
