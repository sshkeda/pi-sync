import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInteractiveMock, script, text } from '../../pi-mock/dist/index.js';

const TIMEOUT = 30_000;
const PI_BINARY = process.env.PI_SYNC_TEST_PI_BINARY ?? 'pi';

function readEntries(path) {
  return readFileSync(path, 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function getFreePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function writePiWrapper(root) {
  const piWrapper = join(root, 'pi-wrapper.sh');
  writeFileSync(piWrapper, `#!/usr/bin/env bash
args=()
for a in "$@"; do
  case "$a" in
    --no-session|--no-extensions|--no-skills|--no-prompt-templates) continue ;;
  esac
  args+=("$a")
done
exec "${PI_BINARY}" "\${args[@]}"
`);
  chmodSync(piWrapper, 0o755);
  return piWrapper;
}

function makeInstalledAgentDir(root, port) {
  const source = process.env.PI_SYNC_TEST_SOURCE_AGENT_DIR ?? process.env.HOME + '/.pi/agent';
  const dir = join(root, 'agent');
  mkdirSync(dir, { recursive: true });

  const settings = JSON.parse(readFileSync(join(source, 'settings.json'), 'utf8'));
  settings.defaultProvider = 'pi-mock';
  settings.defaultModel = 'mock';
  settings.enabledModels = Array.from(new Set([...(settings.enabledModels ?? []), 'pi-mock/mock', 'mock']));
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

test('installed pi-sync stack reports native replay before running hosted prompts', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-installed-native-'));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'shared.jsonl');
  const port = await getFreePort();
  const agentDir = makeInstalledAgentDir(root, port);
  const piWrapper = writePiWrapper(root);
  writeFileSync(sessionFile, '', 'utf8');

  const mock = await createInteractiveMock({
    brain: script(text('INSTALLED_NATIVE_SMOKE_RESPONSE')),
    piProvider: 'pi-mock',
    piModel: 'mock',
    port,
    startupTimeoutMs: 30_000,
    terminal: { cols: 100, rows: 40 },
    cwd: root,
    piBinary: piWrapper,
    piArgs: ['--session', sessionFile],
    env: {
      PI_CODING_AGENT_DIR: agentDir,
      PI_LANE_ROOT: laneRoot,
      PI_SYNC_POLL_MS: '25',
      PI_SYNC_HOST_IDLE_MS: '1000',
    },
  });

  try {
    mock.submit('/sync status');
    await mock.waitForOutput('nativeReplay=yes', TIMEOUT);

    mock.clearOutput();
    mock.submit('INSTALLED_NATIVE_SMOKE_PROMPT');
    await mock.waitForOutput('INSTALLED_NATIVE_SMOKE_RESPONSE', TIMEOUT);

    const messages = readEntries(sessionFile).filter((entry) => entry.type === 'message');
    const user = messages.find((entry) => entry.message?.role === 'user' && entry.message?.content?.[0]?.text === 'INSTALLED_NATIVE_SMOKE_PROMPT');
    const assistant = messages.find((entry) => entry.message?.role === 'assistant' && entry.message?.content?.[0]?.text === 'INSTALLED_NATIVE_SMOKE_RESPONSE');

    assert.equal(user?.message?.content?.[0]?.text, 'INSTALLED_NATIVE_SMOKE_PROMPT');
    assert.equal(assistant?.message?.content?.[0]?.text, 'INSTALLED_NATIVE_SMOKE_RESPONSE');
    assert.equal(assistant?.parentId, user?.id);
  } finally {
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  }
});
