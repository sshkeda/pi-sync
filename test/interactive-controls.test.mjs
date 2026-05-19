import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInteractiveMock, script, text } from '../../pi-mock/dist/index.js';

const EXTENSION = new URL('../index.ts', import.meta.url).pathname;
const TIMEOUT = 30_000;
let testChain = Promise.resolve();

function test(name, options, fn) {
  nodeTest(name, options, async (t) => {
    const previous = testChain;
    let release;
    testChain = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await fn(t);
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 500));
      release();
    }
  });
}

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

async function waitUntil(predicate, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function waitUntilQuiet(predicate, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
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

async function visibleText(mock) {
  return (await mock.visibleScreen()).join('\n');
}

function createPiSyncMockOptions(root, sessionFile, brain) {
  return {
    brain,
    extensions: [EXTENSION],
    piProvider: 'pi-mock',
    piModel: 'mock',
    startupTimeoutMs: 20_000,
    terminal: { cols: 100, rows: 34 },
    cwd: root,
    env: {
      PI_LANE_ROOT: join(root, 'lane'),
      PI_SYNC_POLL_MS: '25',
      PI_SYNC_HOST_IDLE_MS: '1000',
    },
    piBinary: writePiWrapper(root),
    piArgs: ['--session', sessionFile],
  };
}

test('pi-sync preserves idle editor controls around synced prompts', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-controls-'));
  const sessionFile = join(root, 'shared.jsonl');
  writeFileSync(sessionFile, '', 'utf8');
  const requests = [];
  const mock = await createInteractiveMock(createPiSyncMockOptions(root, sessionFile, (request) => {
    requests.push(request);
    const userText = latestUserText(request);
    if (userText === 'actual synced prompt') return text('SYNC_CONTROLS_CLEAR_OK');
    if (userText === 'after model selector cancel') return text('SYNC_CONTROLS_MODEL_CANCEL_OK');
    return text(`UNEXPECTED_CONTROL_PROMPT:${userText}`);
  }));

  try {
    mock.clearOutput();
    mock.type('draft that must be cleared');
    await mock.waitForOutput('draft that must be cleared', TIMEOUT);
    mock.sendKey('ctrl+c');
    mock.sendKey('enter');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.equal(requests.length, 0, 'ctrl+c should clear the editor instead of submitting the draft');

    mock.submit('actual synced prompt');
    await mock.waitForOutput('SYNC_CONTROLS_CLEAR_OK', TIMEOUT);
    assert.equal(latestUserText(requests.at(-1)), 'actual synced prompt');

    mock.clearOutput();
    mock.sendKey('ctrl+l');
    await mock.waitForOutput(/Only showing models|mock \[pi-mock\]/, TIMEOUT);
    mock.sendKey('escape');
    await waitUntil(
      async () => !(await visibleText(mock)).includes('Only showing models'),
      TIMEOUT,
      'model selector dismissed by escape',
    );

    mock.submit('after model selector cancel');
    await mock.waitForOutput('SYNC_CONTROLS_MODEL_CANCEL_OK', TIMEOUT);
    assert.equal(latestUserText(requests.at(-1)), 'after model selector cancel');
  } finally {
    await mock.close();
    await removeRoot(root);
  }
});

test('pi-sync keeps native session tree controls usable', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-tree-controls-'));
  const sessionFile = join(root, 'shared.jsonl');
  writeFileSync(sessionFile, '', 'utf8');
  const mock = await createInteractiveMock(createPiSyncMockOptions(root, sessionFile, script(
    text('TREE_CONTROL_RESPONSE_1'),
    text('TREE_CONTROL_RESPONSE_2'),
  )));

  try {
    mock.submit('TREE_CONTROL_PROMPT_1');
    await mock.waitForOutput('TREE_CONTROL_RESPONSE_1', TIMEOUT);
    mock.submit('TREE_CONTROL_PROMPT_2');
    await mock.waitForOutput('TREE_CONTROL_RESPONSE_2', TIMEOUT);

    mock.clearOutput();
    mock.submit('/tree');
    await mock.waitForOutput('Session Tree', TIMEOUT);
    await mock.waitForOutput('TREE_CONTROL_PROMPT_2', TIMEOUT);

    mock.sendKey('ctrl+u');
    await mock.waitForOutput('user: TREE_CONTROL_PROMPT_2', TIMEOUT);
    await waitUntil(
      async () => !(await visibleText(mock)).includes('assistant: TREE_CONTROL_RESPONSE_2'),
      TIMEOUT,
      'tree user-only filter hides assistant messages',
    );

    mock.sendKey('ctrl+d');
    await mock.waitForOutput('assistant: TREE_CONTROL_RESPONSE_2', TIMEOUT);

    mock.sendKey('up');
    mock.sendKey('down');
    mock.sendKey('left');
    mock.sendKey('right');
    await mock.waitForOutput(/Session Tree[\s\S]*\([0-9]+\/[0-9]+\)/, TIMEOUT);

    mock.sendKey('escape');
    await waitUntil(
      async () => !(await visibleText(mock)).includes('Session Tree'),
      TIMEOUT,
      'tree selector dismissed by escape',
    );
  } finally {
    await mock.close();
    await removeRoot(root);
  }
});

test('pi-sync lets ctrl+d exit an idle interactive session', { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-ctrl-d-'));
  const sessionFile = join(root, 'shared.jsonl');
  writeFileSync(sessionFile, '', 'utf8');
  const mock = await createInteractiveMock(createPiSyncMockOptions(root, sessionFile, script(text('unused'))));

  try {
    mock.sendKey('ctrl+d');
    const exited = await waitUntilQuiet(async () => (await mock.getProcessStats()) === null, TIMEOUT);
    assert.equal(exited, true, 'ctrl+d should exit when the editor is idle and empty');
  } finally {
    await mock.close();
    await removeRoot(root);
  }
});
