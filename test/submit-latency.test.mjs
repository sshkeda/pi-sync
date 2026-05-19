import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInteractiveMock, createControllableBrain, text } from '../../pi-mock/dist/index.js';

const TIMEOUT = 30_000;
const PI_BINARY = process.env.PI_SYNC_TEST_PI_BINARY ?? 'pi';

async function waitUntil(predicate, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timeout waiting for ${label}`);
}

function findHostEventsPaths(dir) {
  if (!existsSync(dir)) return [];
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findHostEventsPaths(path));
    else if (entry.isFile() && entry.name === 'host-events.jsonl' && path.includes('/sync/')) found.push(path);
  }
  return found;
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

test('pi-sync warm installed-stack submit reaches provider without reconnect delay', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-submit-latency-'));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'shared.jsonl');
  const port = 19461;
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
    await waitUntil(
      () => findHostEventsPaths(laneRoot).some((path) => readFileSync(path, 'utf8').includes('"type":"agent_ready"')),
      TIMEOUT,
      'warm host agent_ready event',
    );

    mock.clearOutput();
    const submittedAt = Date.now();
    mock.submit('SYNC_LATENCY_PROMPT');
    const call = await brain.waitForCall(TIMEOUT);
    const submitToProviderMs = Date.now() - submittedAt;
    call.respond(text('SYNC_LATENCY_RESPONSE'));
    await mock.waitForOutput('SYNC_LATENCY_RESPONSE', TIMEOUT);

    assert.ok(
      submitToProviderMs < 200,
      `warm installed-stack submit should reach provider quickly; got ${submitToProviderMs}ms`,
    );
  } finally {
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  }
});
