import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { connect } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createControllableBrain, createGateway } from '../../pi-mock/dist/index.js';

const HOST = new URL('../bin/pi-sync-host.js', import.meta.url).pathname;

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`pi-sync-host did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function livePids(pids) {
  const out = execFileSync('ps', ['-axo', 'pid=,stat='], { encoding: 'utf8' });
  const live = new Set(out.trim().split(/\n/).map((line) => {
    const [pid, stat] = line.trim().split(/\s+/);
    return stat?.startsWith('Z') ? undefined : Number(pid);
  }).filter(Boolean));
  return pids.filter((pid) => live.has(pid));
}

async function waitUntil(predicate, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await sleep(25);
  }
  throw new Error(`timeout waiting for ${label}`);
}

function readEvents(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function appendJsonl(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value) + '\n', { flag: 'a' });
}

function writeAgentDir(root, port) {
  const agentDir = join(root, 'agent');
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({
    defaultProvider: 'pi-mock',
    defaultModel: 'mock',
    enabledModels: ['pi-mock/mock'],
  }, null, 2));
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({
    providers: {
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

test('pi-sync-host recovers only still-pending prompts from the durable prompt queue', { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-host-queue-recover-'));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'session.jsonl');
  const sessionKey = 'queue-recover-test';
  writeFileSync(sessionFile, '', 'utf8');
  const brain = createControllableBrain();
  const gateway = await createGateway({ brain: brain.brain });
  const agentDir = writeAgentDir(root, gateway.port);
  const syncDir = join(laneRoot, 'sessions', sessionKey, 'lanes', 'main', 'sync');
  const promptQueuePath = join(syncDir, 'prompt-queue.jsonl');
  const hostEventsPath = join(syncDir, 'host-events.jsonl');
  mkdirSync(syncDir, { recursive: true });

  appendJsonl(promptQueuePath, {
    id: 'completed-prompt',
    at: new Date().toISOString(),
    source: 'pi-sync',
    clientId: 'client-a',
    lane: 'main',
    text: 'SYNC_RECOVER_COMPLETED_SHOULD_NOT_REPLAY',
    modelProvider: 'pi-mock',
    modelId: 'mock',
  });
  appendJsonl(promptQueuePath, {
    id: 'pending-prompt',
    at: new Date().toISOString(),
    source: 'pi-sync',
    clientId: 'client-b',
    lane: 'main',
    text: 'SYNC_RECOVER_PENDING_PROMPT',
    modelProvider: 'pi-mock',
    modelId: 'mock',
  });
  appendJsonl(hostEventsPath, { type: 'prompt_queued', payload: { promptId: 'completed-prompt' } });
  appendJsonl(hostEventsPath, { type: 'prompt_dequeued', payload: { promptId: 'completed-prompt' } });
  appendJsonl(hostEventsPath, { type: 'prompt_end', payload: { promptId: 'completed-prompt' } });
  appendJsonl(hostEventsPath, { type: 'prompt_queued', payload: { promptId: 'pending-prompt' } });

  const child = spawn(process.execPath, [
    HOST,
    '--session-file', sessionFile,
    '--session-key', sessionKey,
    '--lane', 'main',
  ], {
    cwd: root,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_LANE_ROOT: laneRoot,
      PI_SYNC_HOST_IDLE_MS: '300',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  try {
    const call = await brain.waitForCall(10_000);
    const request = JSON.stringify(call.request);
    assert.match(request, /SYNC_RECOVER_PENDING_PROMPT/);
    assert.doesNotMatch(request, /SYNC_RECOVER_COMPLETED_SHOULD_NOT_REPLAY/);
    call.respond({ type: 'text', text: 'SYNC_RECOVER_PENDING_RESPONSE' });

    await waitUntil(
      () => readEvents(hostEventsPath).some((event) => event.type === 'prompt_queue_recovered' && event.payload?.recovered === 1),
      10_000,
      'prompt queue recovery event',
    );
    await waitUntil(
      () => readFileSync(sessionFile, 'utf8').includes('SYNC_RECOVER_PENDING_RESPONSE'),
      10_000,
      'recovered prompt persisted response',
    );
    const result = await waitForExit(child, 10_000);
    assert.deepEqual(result, { code: 0, signal: null });
    assert.equal(stderr, '');
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await gateway.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('pi-sync-host exits after idle timeout when no clients remain', { timeout: 10_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-host-idle-'));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'session.jsonl');
  writeFileSync(sessionFile, '', 'utf8');

  const child = spawn(process.execPath, [
    HOST,
    '--session-file', sessionFile,
    '--session-key', 'idle-test',
    '--lane', 'main',
  ], {
    cwd: root,
    env: {
      ...process.env,
      PI_LANE_ROOT: laneRoot,
      PI_SYNC_HOST_IDLE_MS: '300',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  try {
    const result = await waitForExit(child, 5_000);
    assert.deepEqual(result, { code: 0, signal: null });
    assert.equal(stderr, '');
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    rmSync(root, { recursive: true, force: true });
  }
});

test('pi-sync-host initializes empty short-id session files with the filename id', { timeout: 10_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-host-short-id-'));
  const laneRoot = join(root, 'lane');
  const shortId = 'ShortId12345';
  const sessionFile = join(root, `2026-05-18T04-20-00-000Z_${shortId}.jsonl`);
  writeFileSync(sessionFile, '', 'utf8');

  const child = spawn(process.execPath, [
    HOST,
    '--session-file', sessionFile,
    '--session-key', 'short-id-test',
    '--lane', 'main',
  ], {
    cwd: root,
    env: {
      ...process.env,
      PI_LANE_ROOT: laneRoot,
      PI_SYNC_HOST_IDLE_MS: '300',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForExit(child, 5_000);
    const header = JSON.parse(readFileSync(sessionFile, 'utf8').split(/\r?\n/)[0]);
    assert.equal(header.id, shortId);
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    rmSync(root, { recursive: true, force: true });
  }
});

test('pi-sync-host fresh startup lock prevents duplicate same-session hosts', { timeout: 10_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-host-lock-'));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'session.jsonl');
  const sessionKey = 'lock-test';
  writeFileSync(sessionFile, '', 'utf8');

  const children = Array.from({ length: 12 }, () => spawn(process.execPath, [
    HOST,
    '--session-file', sessionFile,
    '--session-key', sessionKey,
    '--lane', 'main',
  ], {
    cwd: root,
    env: {
      ...process.env,
      PI_LANE_ROOT: laneRoot,
      PI_SYNC_HOST_IDLE_MS: '1000',
      PI_SYNC_HOST_LEASE_MS: '5000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }));

  try {
    await sleep(750);
    assert.ok(livePids(children.map((child) => child.pid)).length <= 1, 'only one host process may survive startup');

    const hostEventsPath = join(laneRoot, 'sessions', sessionKey, 'lanes', 'main', 'sync', 'host-events.jsonl');
    const hostStarts = existsSync(hostEventsPath)
      ? readFileSync(hostEventsPath, 'utf8').split(/\n/).filter((line) => line.includes('"type":"host_start"')).length
      : 0;
    assert.equal(hostStarts, 1, 'only one host should emit host_start for a session/lane');
  } finally {
    for (const child of children) {
      if (child.exitCode === null) child.kill('SIGTERM');
    }
    await Promise.allSettled(children.map((child) => waitForExit(child, 2_000)));
    rmSync(root, { recursive: true, force: true });
  }
});

test('pi-sync-host aborts active work and exits after the last client disconnects', { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-host-last-client-'));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'session.jsonl');
  writeFileSync(sessionFile, '', 'utf8');
  const brain = createControllableBrain();
  const gateway = await createGateway({ brain: brain.brain });
  const agentDir = writeAgentDir(root, gateway.port);

  const child = spawn(process.execPath, [
    HOST,
    '--session-file', sessionFile,
    '--session-key', 'last-client-test',
    '--lane', 'main',
  ], {
    cwd: root,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_LANE_ROOT: laneRoot,
      PI_SYNC_HOST_IDLE_MS: '300',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const syncDir = join(laneRoot, 'sessions', 'last-client-test', 'lanes', 'main', 'sync');
  const hostPath = join(syncDir, 'host.json');
  const hostEventsPath = join(syncDir, 'host-events.jsonl');
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  try {
    const host = await waitUntil(
      () => existsSync(hostPath) && JSON.parse(readFileSync(hostPath, 'utf8')),
      10_000,
      'host info',
    );
    const socket = connect(host.socketPath);
    socket.setEncoding('utf8');
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    socket.write(JSON.stringify({
      type: 'prompt',
      source: 'pi-sync',
      clientId: 'last-client-test',
      lane: 'main',
      text: 'SYNC_LAST_CLIENT_ABORT_PROMPT',
      modelProvider: 'pi-mock',
      modelId: 'mock',
    }) + '\n');
    await brain.waitForCall(10_000);
    await waitUntil(
      () => {
        const current = existsSync(hostPath) && JSON.parse(readFileSync(hostPath, 'utf8'));
        return current?.activePromptId;
      },
      10_000,
      'active host prompt',
    );

    socket.end();
    await waitUntil(
      () => readEvents(hostEventsPath).some((event) => event.type === 'abort_requested' && event.payload?.clientId === null),
      10_000,
      'last-client abort event',
    );
    const result = await waitForExit(child, 10_000);
    assert.deepEqual(result, { code: 0, signal: null });
    assert.equal(stderr, '');
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await gateway.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('pi-sync-host keeps active work alive until the final client disconnects, then clears queued work', { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-host-two-clients-'));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'session.jsonl');
  writeFileSync(sessionFile, '', 'utf8');
  const brain = createControllableBrain();
  const gateway = await createGateway({ brain: brain.brain });
  const agentDir = writeAgentDir(root, gateway.port);

  const child = spawn(process.execPath, [
    HOST,
    '--session-file', sessionFile,
    '--session-key', 'two-client-test',
    '--lane', 'main',
  ], {
    cwd: root,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_LANE_ROOT: laneRoot,
      PI_SYNC_HOST_IDLE_MS: '300',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const syncDir = join(laneRoot, 'sessions', 'two-client-test', 'lanes', 'main', 'sync');
  const hostPath = join(syncDir, 'host.json');
  const hostEventsPath = join(syncDir, 'host-events.jsonl');
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  const openClient = async (clientId) => {
    const host = await waitUntil(
      () => existsSync(hostPath) && JSON.parse(readFileSync(hostPath, 'utf8')),
      10_000,
      'host info',
    );
    const socket = connect(host.socketPath);
    socket.setEncoding('utf8');
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    socket.write(JSON.stringify({ type: 'ping', clientId }) + '\n');
    return socket;
  };

  const sendPrompt = (socket, clientId, textValue) => {
    socket.write(JSON.stringify({
      type: 'prompt',
      source: 'pi-sync',
      clientId,
      lane: 'main',
      text: textValue,
      modelProvider: 'pi-mock',
      modelId: 'mock',
    }) + '\n');
  };

  try {
    const first = await openClient('client-a');
    const second = await openClient('client-b');

    sendPrompt(first, 'client-a', 'SYNC_TWO_CLIENT_ACTIVE_PROMPT');
    await brain.waitForCall(10_000);
    await waitUntil(
      () => {
        const current = existsSync(hostPath) && JSON.parse(readFileSync(hostPath, 'utf8'));
        return current?.activePromptId;
      },
      10_000,
      'active host prompt',
    );

    sendPrompt(second, 'client-b', 'SYNC_TWO_CLIENT_QUEUED_PROMPT');
    await waitUntil(
      () => {
        const current = existsSync(hostPath) && JSON.parse(readFileSync(hostPath, 'utf8'));
        return current?.pendingPrompts === 1;
      },
      10_000,
      'queued host prompt',
    );

    first.end();
    await waitUntil(
      () => readEvents(hostEventsPath).some((event) => event.type === 'client_detach' && event.payload?.clients === 1),
      10_000,
      'first client detach',
    );
    await sleep(500);
    assert.equal(child.exitCode, null, 'host should remain alive while one client is still attached');
    assert.equal(
      readEvents(hostEventsPath).some((event) => event.type === 'abort_requested'),
      false,
      'host should not abort while at least one client remains attached',
    );

    second.end();
    await waitUntil(
      () => readEvents(hostEventsPath).some((event) => event.type === 'abort_requested' && event.payload?.clientId === null && event.payload?.clearedPendingPrompts === 1),
      10_000,
      'last-client abort clearing queued prompt',
    );
    const result = await waitForExit(child, 10_000);
    assert.deepEqual(result, { code: 0, signal: null });
    assert.equal(stderr, '');
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await gateway.close();
    rmSync(root, { recursive: true, force: true });
  }
});
