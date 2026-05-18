import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway, script, text } from '../../pi-mock/dist/index.js';

const TIMEOUT = 30_000;

async function waitUntil(predicate, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timeout waiting for ${label}`);
}

function readEntries(path) {
  return readFileSync(path, 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function writeAgentDir(root, port) {
  const agentDir = join(root, 'agent');
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({
    defaultProvider: 'wrong-provider',
    defaultModel: 'stale-model',
    enabledModels: ['wrong-provider/stale-model', 'pi-mock/mock'],
  }, null, 2));
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({
    providers: {
      'wrong-provider': {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        api: 'anthropic-messages',
        apiKey: 'mock-key',
        models: [{ id: 'stale-model', name: 'stale' }],
      },
      'pi-mock': {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        api: 'anthropic-messages',
        apiKey: 'mock-key',
        models: [{ id: 'mock', name: 'pi-mock' }],
      },
    },
  }, null, 2));
  return agentDir;
}

function writeStaleSession(sessionFile, cwd) {
  const now = new Date().toISOString();
  const entries = [
    { type: 'session', version: 3, id: 'host-model-authority', timestamp: now, cwd },
    { type: 'model_change', id: 'm0', parentId: null, timestamp: now, provider: 'wrong-provider', modelId: 'stale-model' },
    { type: 'thinking_level_change', id: 't0', parentId: 'm0', timestamp: now, thinkingLevel: 'off' },
    { type: 'message', id: 'u0', parentId: 't0', timestamp: now, message: { role: 'user', content: [{ type: 'text', text: 'old prompt' }], timestamp: Date.now() } },
  ];
  writeFileSync(sessionFile, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
}

function waitForHostEvent(hostEventsPath, type) {
  return waitUntil(() => {
    if (!existsSync(hostEventsPath)) return undefined;
    return readEntries(hostEventsPath).find((entry) => entry.type === type);
  }, TIMEOUT, `host event ${type}`);
}

test('pi-sync host runs prompts with the UI-selected model, not a stale restored provider', { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-host-model-'));
  const gateway = await createGateway({ brain: script(text('MODEL_AUTHORITY_RESPONSE')) });
  const sessionFile = join(root, 'shared.jsonl');
  const laneRoot = join(root, 'lane');
  const agentDir = writeAgentDir(root, gateway.port);
  writeStaleSession(sessionFile, root);

  const host = spawn(process.execPath, [
    new URL('../bin/pi-sync-host.js', import.meta.url).pathname,
    '--session-file', sessionFile,
    '--session-key', 'host-model-authority',
    '--lane', 'main',
  ], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_LANE_ROOT: laneRoot,
      PI_SYNC_HOST_IDLE_MS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  host.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  try {
    const syncDir = join(laneRoot, 'sessions', 'host-model-authority', 'lanes', 'main', 'sync');
    const hostPath = join(syncDir, 'host.json');
    const hostEventsPath = join(syncDir, 'host-events.jsonl');
    const hostInfo = await waitUntil(() => {
      if (!existsSync(hostPath)) return undefined;
      return JSON.parse(readFileSync(hostPath, 'utf8'));
    }, TIMEOUT, 'host info');

    const socket = connect(hostInfo.socketPath);
    socket.setEncoding('utf8');
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    socket.write(JSON.stringify({
      type: 'prompt',
      source: 'pi-sync',
      clientId: 'ui-test',
      lane: 'main',
      text: 'new prompt',
      modelProvider: 'pi-mock',
      modelId: 'mock',
    }) + '\n');

    await waitForHostEvent(hostEventsPath, 'prompt_end');
    socket.end();

    const entries = readEntries(sessionFile);
    const assistant = entries.find((entry) => entry.type === 'message' && entry.message?.role === 'assistant' && entry.message?.content?.[0]?.text === 'MODEL_AUTHORITY_RESPONSE');
    assert.equal(assistant?.message?.provider, 'pi-mock');
    assert.equal(assistant?.message?.model, 'mock');

    const modelSynced = readEntries(hostEventsPath).find((entry) => entry.type === 'model_synced');
    assert.equal(modelSynced?.payload?.previousProvider, 'wrong-provider');
    assert.equal(modelSynced?.payload?.provider, 'pi-mock');
  } finally {
    host.kill('SIGTERM');
    await new Promise((resolve) => host.once('close', resolve));
    await gateway.close();
    rmSync(root, { recursive: true, force: true });
  }

  assert.equal(stderr.includes('Unhandled'), false, stderr);
});

test('pi-sync host registers extension providers before choosing its startup model', { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-host-provider-init-'));
  const gateway = await createGateway({ brain: script(text('unused')) });
  const sessionFile = join(root, 'shared.jsonl');
  const laneRoot = join(root, 'lane');
  const agentDir = join(root, 'agent');
  const extensionPath = join(root, 'preferred-provider.mjs');
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(sessionFile, '', 'utf8');
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({
    defaultProvider: 'preferred-provider',
    defaultModel: 'fast',
    enabledModels: ['wrong-provider/stale-model', 'preferred-provider/fast'],
  }, null, 2));
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({
    providers: {
      'wrong-provider': {
        baseUrl: `http://127.0.0.1:${gateway.port}/v1`,
        api: 'anthropic-messages',
        apiKey: 'mock-key',
        models: [{ id: 'stale-model', name: 'stale' }],
      },
    },
  }, null, 2));
  writeFileSync(extensionPath, `
export default function preferredProvider(pi) {
  pi.registerProvider("preferred-provider", {
    baseUrl: "http://127.0.0.1:${gateway.port}/v1",
    api: "anthropic-messages",
    apiKey: "mock-key",
    models: [{ id: "fast", name: "Preferred Fast" }],
  });
}
`, 'utf8');

  const host = spawn(process.execPath, [
    new URL('../bin/pi-sync-host.js', import.meta.url).pathname,
    '--session-file', sessionFile,
    '--session-key', 'host-provider-init',
    '--lane', 'main',
  ], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_LANE_ROOT: laneRoot,
      PI_SYNC_HOST_EXTENSIONS: extensionPath,
      PI_SYNC_HOST_IDLE_MS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  host.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  try {
    const syncDir = join(laneRoot, 'sessions', 'host-provider-init', 'lanes', 'main', 'sync');
    const hostPath = join(syncDir, 'host.json');
    const hostEventsPath = join(syncDir, 'host-events.jsonl');
    const hostInfo = await waitUntil(() => existsSync(hostPath) && JSON.parse(readFileSync(hostPath, 'utf8')), TIMEOUT, 'host info');
    const socket = connect(hostInfo.socketPath);
    socket.setEncoding('utf8');
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    socket.write(JSON.stringify({
      type: 'prompt',
      source: 'pi-sync',
      clientId: 'ui-test',
      lane: 'main',
      text: 'startup model prompt',
    }) + '\n');
    await waitForHostEvent(hostEventsPath, 'prompt_end');
    socket.end();

    const modelChange = await waitUntil(() => {
      const entries = readEntries(sessionFile);
      return entries.find((entry) => entry.type === 'model_change');
    }, TIMEOUT, 'startup model_change');
    assert.equal(modelChange.provider, 'preferred-provider');
    assert.equal(modelChange.modelId, 'fast');
  } finally {
    host.kill('SIGTERM');
    await new Promise((resolve) => host.once('close', resolve));
    await gateway.close();
    rmSync(root, { recursive: true, force: true });
  }

  assert.equal(stderr.includes('Unhandled'), false, stderr);
});
