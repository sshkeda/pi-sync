#!/usr/bin/env node
import { createServer } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg.startsWith('--')) args.set(arg.slice(2), process.argv[++i] ?? '');
}

const requestedSessionFile = args.get('session-file');
if (!requestedSessionFile) {
  console.error('usage: pi-sync-host --session-file <path> [--lane main] [--session-key key]');
  process.exit(2);
}

function canonicalSessionFile(path) {
  try {
    if (existsSync(path)) return realpathSync(path);
    return join(realpathSync(dirname(path)), basename(path));
  } catch {
    return path;
  }
}

const instanceId = randomUUID();
const lane = args.get('lane') || process.env.PI_LANE_CURRENT_LANE || 'main';
const sessionFile = canonicalSessionFile(requestedSessionFile);
const sessionKey = args.get('session-key') || createHash('sha256').update(sessionFile).digest('hex').slice(0, 24);
const laneRoot = process.env.PI_LANE_ROOT || join(homedir(), '.pi', 'lane');
const sessionRoot = join(laneRoot, 'sessions', sessionKey, 'lanes', lane.replace(/[^a-zA-Z0-9_.=-]+/g, '_').slice(0, 96) || 'main', 'sync');
const hostPath = join(sessionRoot, 'host.json');
const socketKey = createHash('sha256').update(`${sessionRoot}:${process.env.USER ?? 'user'}`).digest('hex').slice(0, 24);
const socketPath = join(process.env.TMPDIR || '/tmp', `pi-sync-${socketKey}.sock`);
const hostEventsPath = join(sessionRoot, 'host-events.jsonl');
const promptQueuePath = join(sessionRoot, 'prompt-queue.jsonl');
const HOST_EXTENSION_EXCLUDE_RE = /(^|[/\\])(pi-sync|pi-working|pi-aura|pi-status-line|pi-lane|pi-agent-observe)([/\\]|$)/;
const sourceAgentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');

mkdirSync(sessionRoot, { recursive: true });
const hostLockDir = join(sessionRoot, 'host.lock');
const hostLockOwnerPath = join(hostLockDir, 'owner.json');
const HOST_LEASE_MS = Number(process.env.PI_SYNC_HOST_LEASE_MS || 5000);
function readExistingHost() {
  try { return JSON.parse(readFileSync(hostPath, 'utf8')); } catch { return undefined; }
}
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function existingHostFresh(info) {
  const t = Date.parse(info?.heartbeatAt ?? '');
  return info?.state === 'running' && processAlive(info?.pid) && Number.isFinite(t) && Date.now() - t <= HOST_LEASE_MS;
}
function readLockOwner() {
  try { return JSON.parse(readFileSync(hostLockOwnerPath, 'utf8')); } catch { return undefined; }
}
function lockOwnerFresh(owner = readLockOwner()) {
  const t = Date.parse(owner?.heartbeatAt ?? owner?.startedAt ?? '');
  return ['starting', 'running'].includes(owner?.state) && processAlive(owner?.pid) && Number.isFinite(t) && Date.now() - t <= HOST_LEASE_MS;
}
function lockDirFresh() {
  if (lockOwnerFresh()) return true;
  try {
    const t = lstatSync(hostLockDir).mtimeMs;
    return Number.isFinite(t) && Date.now() - t <= HOST_LEASE_MS;
  } catch {
    return false;
  }
}
function writeHostLockOwner(state = 'running') {
  writeJson(hostLockOwnerPath, {
    schemaVersion: 1,
    state,
    pid: process.pid,
    instanceId,
    sessionFile,
    sessionKey,
    lane,
    socketPath,
    heartbeatAt: nowIso(),
  });
}
try {
  mkdirSync(hostLockDir, { recursive: false });
  writeHostLockOwner('starting');
} catch {
  const existing = readExistingHost();
  if (existingHostFresh(existing)) process.exit(0);
  if (lockDirFresh()) process.exit(0);
  try { rmSync(hostLockDir, { recursive: true, force: true }); } catch {}
  try {
    mkdirSync(hostLockDir, { recursive: false });
    writeHostLockOwner('starting');
  } catch {
    process.exit(0);
  }
}
try { rmSync(socketPath, { force: true }); } catch {}

const clients = new Set();
let seq = 0;
let activePrompt = null;
let agentSession = null;
let hostSessionManager = null;
let agentReady = false;
let agentInitializing = false;
let piCore = null;
const pendingPrompts = [];
const abortingPromptIds = new Set();
const HOST_IDLE_MS = Number(process.env.PI_SYNC_HOST_IDLE_MS || 120_000);
let idleTimer = null;

function nowIso() { return new Date().toISOString(); }

function writeHostInfo(state = 'running') {
  writeHostLockOwner(state);
  const info = {
    schemaVersion: 1,
    state,
    pid: process.pid,
    instanceId,
    sessionFile,
    sessionKey,
    lane,
    socketPath,
    hostEventsPath,
    promptQueuePath,
    startedAt,
    heartbeatAt: nowIso(),
    clients: clients.size,
    activePromptId: activePrompt?.id ?? null,
    pendingPrompts: pendingPrompts.length,
    idleTimeoutMs: HOST_IDLE_MS,
  };
  writeFileSync(hostPath, JSON.stringify(info, null, 2) + '\n');
}

function cancelIdleShutdown() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
}

function scheduleIdleShutdown() {
  cancelIdleShutdown();
  if (HOST_IDLE_MS <= 0) return;
  if (clients.size > 0 || activePrompt || pendingPrompts.length > 0 || agentInitializing) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (clients.size === 0 && !activePrompt && pendingPrompts.length === 0 && !agentInitializing) {
      shutdown('idle_timeout');
    }
  }, HOST_IDLE_MS);
  idleTimer.unref?.();
}

function appendJsonl(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(value) + '\n');
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  renameSync(tmp, path);
}

function sessionFileHasEntry(entryId) {
  if (!entryId) return true;
  try {
    return readFileSync(sessionFile, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .some((line) => {
        try { return JSON.parse(line)?.id === entryId; } catch { return false; }
      });
  } catch {
    return false;
  }
}

function flushHostSessionFile(reason) {
  const rewriteFile = hostSessionManager?._rewriteFile;
  if (typeof rewriteFile !== 'function') return false;
  try {
    rewriteFile.call(hostSessionManager);
    hostEvent('session_flushed', {
      reason,
      leafEntryId: hostSessionManager?.getLeafId?.() ?? null,
      entries: hostSessionManager?.getEntries?.().length ?? null,
    });
    return true;
  } catch (error) {
    hostEvent('session_flush_error', {
      reason,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return false;
  }
}

function ensureHostLeafPersisted(reason) {
  const leafEntryId = hostSessionManager?.getLeafId?.() ?? null;
  if (!leafEntryId || sessionFileHasEntry(leafEntryId)) return true;
  flushHostSessionFile(reason);
  const persisted = sessionFileHasEntry(leafEntryId);
  if (!persisted) hostEvent('session_flush_missing_leaf', { reason, leafEntryId });
  return persisted;
}

function sanitizeLaneName(value) {
  const name = String(value ?? '').trim() || 'main';
  return name.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-').slice(0, 64) || 'main';
}

function laneStatePath(laneName = lane) {
  return join(laneRoot, 'sessions', sessionKey, 'lanes', `${sanitizeLaneName(laneName)}.json`);
}

function readLaneState(laneName = lane) {
  const state = readJson(laneStatePath(laneName));
  if (!state || state.schemaVersion !== 1) return undefined;
  return state;
}

function promptLaneName(prompt) {
  return sanitizeLaneName(prompt?.lane || lane);
}

function effectivePromptLaneHead(prompt) {
  const state = readLaneState(promptLaneName(prompt));
  if (prompt && Object.prototype.hasOwnProperty.call(prompt, 'laneHeadEntryId') && prompt.laneHeadEntryId !== undefined) {
    const promptEpoch = typeof prompt.laneHeadEpoch === 'number' ? prompt.laneHeadEpoch : Number.NaN;
    const stateEpoch = typeof state?.headEpoch === 'number' ? state.headEpoch : Number.NaN;
    if (Number.isFinite(promptEpoch) && Number.isFinite(stateEpoch) && stateEpoch > promptEpoch) {
      return { headEntryId: typeof state.headEntryId === 'string' ? state.headEntryId : null, headEpoch: stateEpoch, source: 'lane_state_newer' };
    }
    return { headEntryId: typeof prompt.laneHeadEntryId === 'string' ? prompt.laneHeadEntryId : null, headEpoch: Number.isFinite(promptEpoch) ? promptEpoch : undefined, source: 'prompt' };
  }
  return { headEntryId: typeof state?.headEntryId === 'string' ? state.headEntryId : null, headEpoch: typeof state?.headEpoch === 'number' ? state.headEpoch : undefined, source: 'lane_state' };
}

function promptLaneHead(prompt) {
  return effectivePromptLaneHead(prompt).headEntryId;
}

function moveHostToLaneHead(prompt) {
  const effective = effectivePromptLaneHead(prompt);
  const target = effective.headEntryId;
  prompt.effectiveLaneHeadEntryId = target;
  prompt.effectiveLaneHeadEpoch = effective.headEpoch;
  prompt.effectiveLaneHeadSource = effective.source;
  if (target) hostSessionManager?.branch?.(target);
  else hostSessionManager?.resetLeaf?.();
  return target;
}

function updateLaneHeadAfterPrompt(prompt) {
  if (!prompt || prompt.laneHeadUpdated) return;
  const laneName = promptLaneName(prompt);
  const state = readLaneState(laneName);
  if (!state) {
    hostEvent('lane_head_update_skipped', { promptId: prompt.id, lane: laneName, reason: 'missing_lane_state' });
    return;
  }
  const expectedHeadEntryId = Object.prototype.hasOwnProperty.call(prompt, 'effectiveLaneHeadEntryId')
    ? prompt.effectiveLaneHeadEntryId
    : promptLaneHead(prompt);
  if ((state.headEntryId ?? null) !== expectedHeadEntryId) {
    if (!prompt.allowLaneHeadFork) {
      hostEvent('lane_head_update_conflict', {
        promptId: prompt.id,
        lane: laneName,
        expectedHeadEntryId,
        actualHeadEntryId: state.headEntryId ?? null,
      });
      return;
    }
    hostEvent('lane_head_fork', {
      promptId: prompt.id,
      lane: laneName,
      previousHeadEntryId: state.headEntryId ?? null,
      forkHeadEntryId: expectedHeadEntryId,
    });
  }
  const newHeadEntryId = hostSessionManager?.getLeafId?.() ?? null;
  const leafEntry = newHeadEntryId
    ? hostSessionManager?.getEntries?.().find((entry) => entry?.id === newHeadEntryId)
    : null;
  if (leafEntry && leafEntry.type === 'message' && leafEntry.message?.role === 'user') {
    return;
  }
  if (!ensureHostLeafPersisted('before_lane_head_update')) return;
  writeJson(laneStatePath(laneName), {
    ...state,
    headEntryId: newHeadEntryId,
    headEpoch: Math.max(Number(state.headEpoch ?? 0) + 1, Number(prompt.effectiveLaneHeadEpoch ?? prompt.laneHeadEpoch ?? 0) + 1),
    updatedAt: nowIso(),
    updatedBy: instanceId,
  });
  prompt.laneHeadUpdated = true;
  hostEvent('lane_head_updated', { promptId: prompt.id, lane: laneName, expectedHeadEntryId, newHeadEntryId });
}

function sessionIdFromPath(path) {
  const name = path.split(/[/\\]/).pop() || '';
  const match = name.match(/_([^_]+)\.jsonl$/);
  return match?.[1] || randomUUID();
}

function ensureSessionFileInitialized(path) {
  try {
    if (existsSync(path) && readFileSync(path, 'utf8').trim().length > 0) return;
  } catch {}
  mkdirSync(dirname(path), { recursive: true });
  const header = {
    type: 'session',
    version: 3,
    id: sessionIdFromPath(path),
    timestamp: nowIso(),
    cwd: process.cwd(),
  };
  writeFileSync(path, JSON.stringify(header) + '\n', 'utf8');
}

function hostEvent(type, payload = {}) {
  const event = { schemaVersion: 1, id: randomUUID(), seq: ++seq, at: nowIso(), hostInstanceId: instanceId, sessionFile, sessionKey, lane, type, payload };
  const line = JSON.stringify({ type: 'event', event }) + '\n';
  for (const client of clients) client.write(line);
  appendJsonl(hostEventsPath, event);
  return event;
}

function packageSource(entry) {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object' && typeof entry.source === 'string') return entry.source;
  return '';
}

function shouldLoadInHost(entry) {
  const source = packageSource(entry);
  return !HOST_EXTENSION_EXCLUDE_RE.test(source);
}

function prepareHostAgentDir(agentDir) {
  if (!agentDir) return undefined;
  const hostAgentDir = join(sessionRoot, 'host-agent');
  mkdirSync(hostAgentDir, { recursive: true });
  try {
    const settings = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'));
    if (Array.isArray(settings.packages)) settings.packages = settings.packages.filter(shouldLoadInHost);
    if (Array.isArray(settings.extensions)) settings.extensions = settings.extensions.filter(shouldLoadInHost);
    writeFileSync(join(hostAgentDir, 'settings.json'), JSON.stringify(settings, null, 2) + '\n');
  } catch {}
  for (const name of ['models.json', 'auth.json']) {
    const source = join(agentDir, name);
    const target = join(hostAgentDir, name);
    try {
      rmSync(target, { force: true });
      if (existsSync(source)) symlinkSync(source, target);
    } catch {
      try { if (existsSync(source)) copyFileSync(source, target); } catch {}
    }
  }
  for (const name of ['skills', 'prompts', 'themes']) {
    const source = join(agentDir, name);
    const target = join(hostAgentDir, name);
    try {
      rmSync(target, { recursive: true, force: true });
      if (existsSync(source)) symlinkSync(source, target);
    } catch {}
  }
  return hostAgentDir;
}

function installExtraHostExtensions(agentDir) {
  const extras = (process.env.PI_SYNC_HOST_EXTENSIONS || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
    .filter((ext) => !ext.includes('/pi-mock/') && !ext.includes('test-helper-extension') && shouldLoadInHost(ext));
  if (!agentDir || extras.length === 0) return;
  const extDir = join(agentDir, 'extensions');
  try {
    if (existsSync(extDir) && lstatSync(extDir).isSymbolicLink()) return;
  } catch {}
  mkdirSync(extDir, { recursive: true });
  extras.forEach((ext, index) => {
    const target = join(extDir, `pi-sync-host-extra-${index}.js`);
    try { rmSync(target, { force: true }); } catch {}
    try { symlinkSync(ext, target); } catch {}
  });
}

async function loadPiCore() {
  if (!piCore) piCore = await import('@earendil-works/pi-coding-agent');
  return piCore;
}

async function initAgent() {
  if (agentReady || agentInitializing) return;
  agentInitializing = true;
  try {
    const { createAgentSessionFromServices, createAgentSessionServices, SessionManager } = await loadPiCore();
    ensureSessionFileInitialized(sessionFile);
    hostSessionManager = SessionManager.open(sessionFile);
    const hostAgentDir = prepareHostAgentDir(sourceAgentDir);
    installExtraHostExtensions(hostAgentDir);
    const services = await createAgentSessionServices({
      cwd: hostSessionManager.getCwd(),
      agentDir: hostAgentDir ?? sourceAgentDir,
    });
    const created = await createAgentSessionFromServices({
      services,
      sessionManager: hostSessionManager,
      sessionStartEvent: { type: 'session_start', reason: 'startup' },
    });
    agentSession = created.session;
    agentSession.subscribe((agentEvent) => {
      if (agentEvent?.type === 'message_end') flushHostSessionFile('message_end');
      hostEvent('agent_event', {
        agentEvent,
        promptId: activePrompt?.id ?? null,
        clientId: activePrompt?.clientId ?? null,
        source: activePrompt?.source ?? null,
      });
    });
    agentReady = true;
    hostEvent('agent_ready', { sessionId: agentSession.sessionId, sessionFile: agentSession.sessionFile });
  } catch (error) {
    hostEvent('agent_init_error', { message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
    throw error;
  } finally {
    agentInitializing = false;
    writeHostInfo();
    scheduleIdleShutdown();
  }
}

function promptModelRef(prompt) {
  if (!prompt?.modelProvider || !prompt?.modelId) return null;
  return { provider: prompt.modelProvider, modelId: prompt.modelId };
}

async function ensurePromptModel(prompt) {
  const ref = promptModelRef(prompt);
  if (!ref || !agentSession) return;
  const current = agentSession.model;
  if (current?.provider === ref.provider && current?.id === ref.modelId) return;
  const model = agentSession.modelRegistry?.find?.(ref.provider, ref.modelId);
  if (!model) {
    throw new Error(`pi-sync host cannot find requested model ${ref.provider}/${ref.modelId}`);
  }
  await agentSession.setModel(model);
  hostEvent('model_synced', {
    promptId: prompt.id,
    provider: model.provider,
    modelId: model.id,
    previousProvider: current?.provider ?? null,
    previousModelId: current?.id ?? null,
  });
}

function enqueuePrompt(payload) {
  cancelIdleShutdown();
  const prompt = { id: randomUUID(), at: nowIso(), ...payload };
  pendingPrompts.push(prompt);
  appendJsonl(promptQueuePath, prompt);
  hostEvent('prompt_queued', { promptId: prompt.id, source: prompt.source ?? null, clientId: prompt.clientId ?? null, lane: promptLaneName(prompt), laneHeadEntryId: promptLaneHead(prompt), modelProvider: prompt.modelProvider ?? null, modelId: prompt.modelId ?? null, text: prompt.text ?? '' });
  writeHostInfo();
  void pumpQueue();
}

async function abortActive(payload = {}) {
  cancelIdleShutdown();
  const activePromptId = activePrompt?.id ?? null;
  const clearedPendingPrompts = pendingPrompts.splice(0).length;
  if (activePromptId) abortingPromptIds.add(activePromptId);
  hostEvent('abort_requested', {
    clientId: payload.clientId ?? null,
    activePromptId,
    clearedPendingPrompts,
  });
  writeHostInfo();
  if (!agentSession || !activePromptId) {
    scheduleIdleShutdown();
    return;
  }
  try {
    await agentSession.abort();
  } catch (error) {
    hostEvent('abort_error', {
      promptId: activePromptId,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  } finally {
    writeHostInfo();
    scheduleIdleShutdown();
  }
}

async function pumpQueue() {
  if (activePrompt || pendingPrompts.length === 0) return;
  await initAgent();
  if (!agentSession) return;
  const prompt = pendingPrompts.shift();
  activePrompt = prompt;
  const laneHeadEntryId = moveHostToLaneHead(prompt);
  try {
    await ensurePromptModel(prompt);
    hostEvent('prompt_start', { promptId: prompt.id, lane: promptLaneName(prompt), laneHeadEntryId, laneHeadSource: prompt.effectiveLaneHeadSource ?? null, modelProvider: agentSession.model?.provider ?? null, modelId: agentSession.model?.id ?? null, text: prompt.text ?? '' });
    writeHostInfo();
    await agentSession.prompt(prompt.text ?? '', { source: 'extension' });
    flushHostSessionFile('prompt_complete');
    updateLaneHeadAfterPrompt(prompt);
    hostEvent('prompt_end', { promptId: prompt.id });
  } catch (error) {
    if (!abortingPromptIds.has(prompt.id)) {
      hostEvent('prompt_error', { promptId: prompt.id, message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
    }
  } finally {
    abortingPromptIds.delete(prompt.id);
    activePrompt = null;
    writeHostInfo();
    scheduleIdleShutdown();
    void pumpQueue();
  }
}

const startedAt = nowIso();
const server = createServer((socket) => {
  cancelIdleShutdown();
  clients.add(socket);
  writeHostInfo();
  socket.setEncoding('utf8');
  socket.setNoDelay?.(true);
  socket.write(JSON.stringify({ type: 'hello', host: { instanceId, pid: process.pid, sessionFile, sessionKey, lane } }) + '\n');
  hostEvent('client_attach', { clients: clients.size });

  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { socket.write(JSON.stringify({ type: 'error', error: 'invalid_json' }) + '\n'); continue; }
      if (msg.type === 'ping') socket.write(JSON.stringify({ type: 'pong', at: nowIso() }) + '\n');
      else if (msg.type === 'prompt') enqueuePrompt({ text: String(msg.text ?? ''), source: msg.source, clientId: msg.clientId, lane: msg.lane, modelProvider: msg.modelProvider, modelId: msg.modelId, laneHeadEntryId: msg.laneHeadEntryId, laneHeadEpoch: msg.laneHeadEpoch, allowLaneHeadFork: msg.allowLaneHeadFork === true });
      else if (msg.type === 'abort') void abortActive({ source: msg.source, clientId: msg.clientId });
      else if (msg.type === 'status') socket.write(JSON.stringify({ type: 'status', hostPath, socketPath, clients: clients.size, activePrompt, pendingPrompts: pendingPrompts.length }) + '\n');
      else if (msg.type === 'shutdown') shutdown('client_shutdown');
      else socket.write(JSON.stringify({ type: 'error', error: 'unknown_type', received: msg.type }) + '\n');
    }
  });
  socket.on('close', () => {
    clients.delete(socket);
    writeHostInfo();
    hostEvent('client_detach', { clients: clients.size });
    scheduleIdleShutdown();
  });
});

function shutdown(reason) {
  cancelIdleShutdown();
  hostEvent('host_shutdown', { reason });
  writeHostInfo('stopped');
  try { agentSession?.dispose?.(); } catch {}
  try { server.close(); } catch {}
  try { rmSync(socketPath, { force: true }); } catch {}
  try { rmSync(hostLockDir, { recursive: true, force: true }); } catch {}
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('sigterm'));
process.on('SIGINT', () => shutdown('sigint'));
process.on('uncaughtException', (error) => {
  hostEvent('host_error', { message: error.message, stack: error.stack });
  shutdown('uncaught_exception');
});

server.listen(socketPath, () => {
  writeHostInfo();
  hostEvent('host_start', { pid: process.pid, socketPath });
  void initAgent().catch((error) => {
    hostEvent('agent_init_error', { message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
    shutdown('agent_init_error');
  });
  scheduleIdleShutdown();
});

const heartbeat = setInterval(() => writeHostInfo(), Number(process.env.PI_SYNC_HOST_HEARTBEAT_MS || 1000));
heartbeat.unref?.();
