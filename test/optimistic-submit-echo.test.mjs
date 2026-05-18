import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInteractiveMock, createControllableBrain, text } from '../../pi-mock/dist/index.js';

const TIMEOUT = 30_000;
const PI_BINARY = process.env.PI_SYNC_TEST_PI_BINARY ?? 'pi';

async function waitUntil(predicate, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return Date.now() - start;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timeout waiting for ${label}`);
}

function countVisible(lines, needle) {
  return lines.filter((line) => line.includes(needle)).length;
}

function writePiWrapper(root) {
  const piWrapper = join(root, 'pi-wrapper.sh');
  writeFileSync(piWrapper, `#!/usr/bin/env bash\nargs=()\nfor a in "$@"; do\n  case "$a" in\n    --no-session|--no-extensions|--no-skills|--no-prompt-templates) continue ;;\n  esac\n  args+=("$a")\ndone\nexec "${PI_BINARY}" "\${args[@]}"\n`);
  chmodSync(piWrapper, 0o755);
  return piWrapper;
}

function makeRegularAgentDir(root, port) {
  const source = process.env.PI_SYNC_TEST_SOURCE_AGENT_DIR ?? process.env.HOME + '/.pi/agent';
  const dir = join(root, 'agent');
  mkdirSync(dir, { recursive: true });

  const settings = JSON.parse(readFileSync(join(source, 'settings.json'), 'utf8'));
  settings.defaultProvider = 'pi-mock';
  settings.defaultModel = 'mock';
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings, null, 2));

  let models = { providers: {} };
  try { models = JSON.parse(readFileSync(join(source, 'models.json'), 'utf8')); } catch {}
  models.providers ??= {};
  models.providers['pi-mock'] = {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    api: 'anthropic-messages',
    apiKey: 'mock-key',
    models: [{ id: 'mock', name: 'pi-mock' }],
  };
  writeFileSync(join(dir, 'models.json'), JSON.stringify(models, null, 2));

  for (const entry of ['extensions', 'skills', 'themes', 'prompts']) {
    const p = join(source, entry);
    if (existsSync(p)) symlinkSync(p, join(dir, entry), 'dir');
  }
  return dir;
}

test('pi-sync echoes submitted prompt locally before waiting on cold host replay', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-optimistic-echo-'));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'shared.jsonl');
  const port = 19462;
  const piWrapper = writePiWrapper(root);
  const agentDir = makeRegularAgentDir(root, port);
  const brain = createControllableBrain();
  writeFileSync(sessionFile, '', 'utf8');

  const mock = await createInteractiveMock({
    brain: brain.brain,
    piProvider: 'pi-mock',
    piModel: 'mock',
    port,
    startupTimeoutMs: 30_000,
    terminal: { cols: 100, rows: 32 },
    cwd: root,
    env: { PI_CODING_AGENT_DIR: agentDir, PI_LANE_ROOT: laneRoot, PI_SYNC_POLL_MS: '25', PI_SYNC_HOST_IDLE_MS: '1000' },
    piBinary: piWrapper,
    piArgs: ['--session', sessionFile],
  });

  try {
    mock.clearOutput();
    const submittedAt = Date.now();
    mock.submit('SYNC_OPTIMISTIC_PROMPT');
    const promptVisibleMs = await waitUntil(async () => {
      const screen = await mock.visibleScreen();
      return screen.some((line) => line.includes('SYNC_OPTIMISTIC_PROMPT'));
    }, 150, 'local optimistic prompt echo');

    assert.ok(
      promptVisibleMs < 150,
      `submitted prompt should paint immediately; got ${Date.now() - submittedAt}ms`,
    );

    const call = await brain.waitForCall(TIMEOUT);
    call.respond(text('SYNC_OPTIMISTIC_RESPONSE'));
    await mock.waitForOutput('SYNC_OPTIMISTIC_RESPONSE', TIMEOUT);
    await new Promise((resolve) => setTimeout(resolve, 200));

    const screen = await mock.visibleScreen();
    assert.equal(countVisible(screen, 'SYNC_OPTIMISTIC_PROMPT'), 1, screen.join('\n'));
    assert.equal(countVisible(screen, 'SYNC_OPTIMISTIC_RESPONSE'), 1, screen.join('\n'));
  } finally {
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  }
});
