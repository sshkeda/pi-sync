import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createInteractiveMock, streamText } from '../../pi-mock/dist/index.js';

const TIMEOUT = 30_000;
const PI_BINARY = process.env.PI_SYNC_TEST_PI_BINARY ?? 'pi';
const PI_SYNC = new URL('../index.ts', import.meta.url).pathname;
const PI_WORKING = new URL('../../pi-working/index.ts', import.meta.url).pathname;
const HOST_SCRIPT = new URL('../bin/pi-sync-host.js', import.meta.url).pathname;

function stableSessionKey(sessionFile) {
  return createHash('sha256').update(sessionFile).digest('hex').slice(0, 24);
}

function writePiWrapper(root) {
  const piWrapper = join(root, 'pi-wrapper.sh');
  writeFileSync(piWrapper, `#!/usr/bin/env bash\nargs=()\nfor a in "$@"; do\n  case "$a" in\n    --no-session|--no-extensions|--no-skills|--no-prompt-templates) continue ;;\n  esac\n  args+=("$a")\ndone\nexec "${PI_BINARY}" "\${args[@]}"\n`);
  chmodSync(piWrapper, 0o755);
  return piWrapper;
}

function makeAgentDir(root, port, dir = join(root, 'agent')) {
  const source = process.env.PI_SYNC_TEST_SOURCE_AGENT_DIR ?? process.env.HOME + '/.pi/agent';
  mkdirSync(dir, { recursive: true });

  const settings = {
    packages: [PI_WORKING, PI_SYNC],
    defaultProvider: 'pi-mock',
    defaultModel: 'mock',
    theme: 'scanner',
  };
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

  for (const entry of ['skills', 'themes', 'prompts']) {
    const p = join(source, entry);
    if (existsSync(p)) symlinkSync(p, join(dir, entry), 'dir');
  }
  return dir;
}

async function waitUntil(predicate, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

test('pi-sync host filters UI-only extensions from headless installed config', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-host-ui-filter-'));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'shared.jsonl');
  const port = 19463;
  const piWrapper = writePiWrapper(root);
  const agentDir = makeAgentDir(root, port);
  writeFileSync(sessionFile, '', 'utf8');

  const mock = await createInteractiveMock({
    brain: () => streamText(['SYNC_HOST_FILTER_RESPONSE'], 20),
    piProvider: 'pi-mock',
    piModel: 'mock',
    port,
    startupTimeoutMs: 30_000,
    terminal: { cols: 100, rows: 32 },
    cwd: root,
    env: {
      PI_CODING_AGENT_DIR: agentDir,
      PI_LANE_ROOT: laneRoot,
      PI_SYNC_POLL_MS: '25',
      PI_SYNC_HOST_IDLE_MS: '1000',
    },
    piBinary: piWrapper,
    piArgs: ['--session', sessionFile],
  });

  try {
    mock.clearOutput();
    mock.submit('SYNC_HOST_FILTER_PROMPT');
    await mock.waitForOutput('SYNC_HOST_FILTER_RESPONSE', TIMEOUT);
    await new Promise((resolve) => setTimeout(resolve, 250));

    const sessionKey = stableSessionKey(realpathSync(sessionFile));
    const hostEventsPath = join(laneRoot, 'sessions', sessionKey, 'lanes', 'main', 'sync', 'host-events.jsonl');
    const events = readFileSync(hostEventsPath, 'utf8');
    assert.doesNotMatch(events, /"type":"host_error"/, events);
    assert.doesNotMatch(events, /Theme not initialized/, events);
    assert.doesNotMatch(events, /"type":"host_shutdown".*"uncaught_exception"/, events);

    const hostAgentSettingsPath = join(laneRoot, 'sessions', sessionKey, 'lanes', 'main', 'sync', 'host-agent', 'settings.json');
    const hostSettings = JSON.parse(readFileSync(hostAgentSettingsPath, 'utf8'));
    assert.deepEqual(hostSettings.packages, [], 'headless host should not load pi-working or pi-sync from installed packages');
  } finally {
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('pi-sync host filters UI-only extensions from home agent config without PI_CODING_AGENT_DIR', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-host-home-filter-'));
  const home = join(root, 'home');
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'shared.jsonl');
  const port = 19464;
  makeAgentDir(root, port, join(home, '.pi', 'agent'));
  writeFileSync(sessionFile, '', 'utf8');
  const sessionKey = stableSessionKey(sessionFile);
  const syncRoot = join(laneRoot, 'sessions', sessionKey, 'lanes', 'main', 'sync');
  const hostEventsPath = join(syncRoot, 'host-events.jsonl');
  const hostAgentSettingsPath = join(syncRoot, 'host-agent', 'settings.json');

  const child = spawn(process.execPath, [
    HOST_SCRIPT,
    '--session-file', sessionFile,
    '--session-key', sessionKey,
    '--lane', 'main',
  ], {
    cwd: root,
    stdio: 'ignore',
    env: {
      ...process.env,
      HOME: home,
      PI_CODING_AGENT_DIR: '',
      PI_LANE_ROOT: laneRoot,
      PI_LANE_CURRENT_LANE: 'main',
      PI_SYNC_HOST_IDLE_MS: '10000',
    },
  });

  try {
    await waitUntil(() => existsSync(hostAgentSettingsPath), TIMEOUT, 'host-agent settings');
    await waitUntil(() => existsSync(hostEventsPath) && readFileSync(hostEventsPath, 'utf8').includes('"type":"agent_ready"'), TIMEOUT, 'agent ready');

    const events = readFileSync(hostEventsPath, 'utf8');
    assert.doesNotMatch(events, /"type":"host_error"/, events);
    assert.doesNotMatch(events, /Theme not initialized/, events);
    assert.doesNotMatch(events, /"type":"host_shutdown".*"uncaught_exception"/, events);

    const hostSettings = JSON.parse(readFileSync(hostAgentSettingsPath, 'utf8'));
    assert.deepEqual(hostSettings.packages, [], 'headless host should filter home ~/.pi/agent packages too');
  } finally {
    await stopChild(child);
    rmSync(root, { recursive: true, force: true });
  }
});
