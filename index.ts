import { execFileSync, spawn } from "node:child_process";
import { connect, type Socket } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type AutocompleteItem } from "@earendil-works/pi-tui";
import {
  DEFAULT_LANE,
  type InstanceState,
  type LaneState,
  appendDebug,
  ensureLane,
  hostSocketPathForSyncDir,
  instancePath,
  laneInstancesDir,
  laneLanesDir,
  laneRoot,
  laneSegment,
  laneSessionDir,
  laneStatePath,
  nowIso,
  readLane,
  readJsonFile,
  sanitizeLaneName,
  syncDir,
  updateLaneState,
  writeJsonFile,
  debugLogPath,
} from "./src/lane-state.ts";

type SessionManagerLike = {
  getSessionFile?: () => string | undefined;
  getSessionId?: () => string | undefined;
  getLeafId?: () => string | null | undefined;
  branch?: (entryId: string) => void;
  resetLeaf?: () => void;
  setSessionFile?: (path: string) => void;
};

type SyncEvent = {
  schemaVersion: 1;
  id: string;
  seq: number;
  at: string;
  instanceId: string;
  sessionId: string | null;
  sessionKey: string;
  sessionFile: string;
  lane: string;
  type: string;
  payload: unknown;
};

type HostInfo = {
  schemaVersion: 1;
  state: string;
  pid: number;
  instanceId: string;
  sessionFile: string;
  sessionKey: string;
  lane: string;
  socketPath: string;
  heartbeatAt: string;
  clients?: number;
  activePromptId?: string | null;
  pendingPrompts?: number;
};

type HostPrompt = {
  text: string;
  lane: string;
  modelProvider?: string;
  modelId?: string;
  laneHeadEntryId?: string | null;
  laneHeadEpoch?: number;
  allowLaneHeadFork?: boolean;
};

type TurnOwner = {
  schemaVersion: 1;
  instanceId: string;
  sessionId: string | null;
  sessionKey: string;
  sessionFile: string;
  lane: string;
  acquiredAt: string;
  heartbeatAt: string;
  turnStartOffset: number;
  reason: string;
};

const POLL_MS = Number(process.env.PI_SYNC_POLL_MS ?? 100);
const LEASE_MS = Number(process.env.PI_SYNC_TURN_LEASE_MS ?? 5 * 60_000);
const LEASE_HEARTBEAT_MS = Math.max(250, Number(process.env.PI_SYNC_TURN_HEARTBEAT_MS ?? 2_000));
const MAX_PAYLOAD_CHARS = Number(process.env.PI_SYNC_MAX_PAYLOAD_CHARS ?? 20_000);
const EXACT_MODE = process.env.PI_SYNC_EXACT !== "0";
const MAX_SEEN_EVENT_IDS = Number(process.env.PI_SYNC_MAX_SEEN_EVENT_IDS ?? 5_000);
const HOST_RECONNECT_MS = Math.max(10, Number(process.env.PI_SYNC_HOST_RECONNECT_MS ?? 25));
const COLD_PROMPT_GRACE_MS = Math.max(0, Number(process.env.PI_SYNC_COLD_PROMPT_GRACE_MS ?? 40));

function isEscapeInput(data: string): boolean {
  return data === "\x1b" || matchesKey(data, Key.escape) || matchesKey(data, Key.esc);
}

function stableSessionKey(sessionFile: string): string {
  return createHash("sha256").update(sessionFile).digest("hex").slice(0, 24);
}

function sameSessionFile(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return left === right;
  }
}

function activeSessionKeyFor(_ctx: ExtensionContext, file: string, _previousFile?: string, _previousKey?: string): string {
  const envLaneSessionKey = process.env.PI_SYNC_SESSION_KEY ?? process.env.PI_LANE_SESSION_KEY;
  const laneSessionFile = process.env.PI_SYNC_SESSION_FILE ?? process.env.PI_LANE_SESSION_FILE;
  if (envLaneSessionKey && (!laneSessionFile || sameSessionFile(laneSessionFile, file))) return envLaneSessionKey;
  return stableSessionKey(file);
}

function sessionManager(ctx: ExtensionContext): SessionManagerLike | undefined {
  return ctx.sessionManager as SessionManagerLike | undefined;
}

function sessionFile(ctx: ExtensionContext): string | undefined {
  const file = sessionManager(ctx)?.getSessionFile?.();
  if (!file) return undefined;
  try {
    if (existsSync(file)) return realpathSync(file);
    return join(realpathSync(dirname(file)), basename(file));
  } catch {
    return file;
  }
}

function sessionId(ctx: ExtensionContext): string | null {
  return sessionManager(ctx)?.getSessionId?.() ?? null;
}

function nativeReplay(ctx: ExtensionContext): (event: unknown, options?: unknown) => unknown {
  const replayAgentEvent = (ctx.ui as any)?.replayAgentEvent;
  if (typeof replayAgentEvent !== "function") {
    throw new Error("pi-sync requires Pi native replay support: missing ctx.ui.replayAgentEvent. Apply/fix the pi-sync core Pi patch before loading pi-sync.");
  }
  return replayAgentEvent.bind(ctx.ui);
}

function refreshSessionFile(ctx: ExtensionContext): void {
  const file = sessionFile(ctx);
  const sm = sessionManager(ctx);
  if (!file || !existsSync(file) || typeof sm?.setSessionFile !== "function") return;
  try {
    sm.setSessionFile(file);
    (ctx.ui as any)?.requestRender?.();
  } catch {
    // Best-effort. Native replay still keeps the UI live even if the session
    // manager implementation changes and cannot be refreshed here.
  }
}

function disableLocalSessionPersistence(ctx: ExtensionContext): void {
  const sm = sessionManager(ctx) as (SessionManagerLike & { persist?: boolean }) | undefined;
  if (sm && "persist" in sm) sm.persist = false;
}

let moduleCurrentLane = DEFAULT_LANE;

function currentLane(): string {
  return moduleCurrentLane || DEFAULT_LANE;
}

function eventLogPath(sessionKey: string, lane: string = currentLane()): string {
  return join(syncDir(sessionKey, lane), "events.jsonl");
}

function turnLockDir(sessionKey: string, lane: string = currentLane()): string {
  return join(syncDir(sessionKey, lane), "turn.lock");
}

function turnOwnerPath(sessionKey: string, lane: string = currentLane()): string {
  return join(turnLockDir(sessionKey, lane), "owner.json");
}

function hostInfoPath(sessionKey: string, lane: string = currentLane()): string {
  return join(syncDir(sessionKey, lane), "host.json");
}

function hostLockDirPath(sessionKey: string, lane: string = currentLane()): string {
  return join(syncDir(sessionKey, lane), "host.lock");
}

function hostSocketPath(sessionKey: string, lane: string = currentLane()): string {
  return hostSocketPathForSyncDir(syncDir(sessionKey, lane));
}

function hostEventsPath(sessionKey: string, lane: string = currentLane()): string {
  return join(syncDir(sessionKey, lane), "host-events.jsonl");
}

function hostScriptPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "bin", "pi-sync-host.js");
}

function fileSize(path: string): number {
  try {
    return existsSync(path) ? statSync(path).size : 0;
  } catch {
    return 0;
  }
}

function persistedLeafId(path: string | undefined): string | null | undefined {
  if (!path || !existsSync(path)) return undefined;
  try {
    const lines = readFileSync(path, "utf8").trim().split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const entry = JSON.parse(lines[i]) as { type?: string; id?: unknown };
      if (entry.type !== "session" && typeof entry.id === "string") return entry.id;
    }
    return null;
  } catch {
    return undefined;
  }
}

function persistedEntryExists(path: string | undefined, entryId: string): boolean {
  if (!path || !existsSync(path)) return false;
  try {
    const lines = readFileSync(path, "utf8").trim().split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      const entry = JSON.parse(line) as { id?: unknown };
      if (entry.id === entryId) return true;
    }
  } catch {
    return false;
  }
  return false;
}

function persistedMessageEntryIds(path: string | undefined): Set<string> {
  const ids = new Set<string>();
  if (!path || !existsSync(path)) return ids;
  try {
    const lines = readFileSync(path, "utf8").trim().split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      const entry = JSON.parse(line) as { type?: string; id?: unknown };
      if (entry.type === "message" && typeof entry.id === "string") ids.add(entry.id);
    }
  } catch {
    ids.clear();
  }
  return ids;
}

function persistedRootMarkerEntryId(path: string | undefined): string | undefined {
  if (!path || !existsSync(path)) return undefined;
  try {
    const lines = readFileSync(path, "utf8").trim().split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      const entry = JSON.parse(line) as { type?: string; id?: unknown; parentId?: unknown };
      if (entry.type === "message" && typeof entry.id === "string" && entry.parentId == null) return entry.id;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function extractMessageText(message: any): string | undefined {
  if (!message) return undefined;
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return undefined;
  const parts: string[] = [];
  for (const part of message.content) {
    if (part?.type === "text" && typeof part.text === "string") parts.push(part.text);
  }
  return parts.join("");
}

function messageReplayKey(message: any): string | undefined {
  const role = typeof message?.role === "string" ? message.role : undefined;
  const text = extractMessageText(message);
  if (!role || text === undefined) return undefined;
  return `${role}\0${text}`;
}

function persistedMessageTextCounts(path: string | undefined): Map<string, number> {
  const counts = new Map<string, number>();
  if (!path || !existsSync(path)) return counts;
  try {
    const lines = readFileSync(path, "utf8").trim().split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      const entry = JSON.parse(line) as { type?: string; message?: unknown };
      if (entry.type !== "message") continue;
      const key = messageReplayKey(entry.message);
      if (key !== undefined) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  } catch {
    counts.clear();
  }
  return counts;
}

function truncateJson(value: unknown): unknown {
  try {
    const raw = JSON.stringify(value);
    if (raw.length <= MAX_PAYLOAD_CHARS) return value;
    return { truncated: true, preview: raw.slice(0, MAX_PAYLOAD_CHARS) };
  } catch {
    return { unserializable: true, text: String(value).slice(0, MAX_PAYLOAD_CHARS) };
  }
}

function appendEvent(path: string, event: SyncEvent): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
}

function readNewEvents(path: string, offset: number): { events: SyncEvent[]; offset: number } {
  if (!existsSync(path)) return { events: [], offset };
  const size = statSync(path).size;
  if (size < offset) offset = 0;
  if (size === offset) return { events: [], offset };
  const fdText = readFileSync(path).toString("utf8", offset);
  const events: SyncEvent[] = [];
  for (const line of fdText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as SyncEvent;
      if (parsed?.schemaVersion === 1 && typeof parsed.id === "string") events.push(parsed);
    } catch {
      // Ignore partial/corrupt lines; next full read will catch future events.
    }
  }
  return { events, offset: size };
}

function toReplayEvent(event: SyncEvent): unknown | undefined {
  const payload = event.payload as Record<string, any> | undefined;
  if (!payload || typeof payload !== "object") return undefined;
  if (
    event.type === "agent_start" ||
    event.type === "agent_end" ||
    event.type === "message_start" ||
    event.type === "message_update" ||
    event.type === "message_end" ||
    event.type === "tool_execution_start" ||
    event.type === "tool_execution_update" ||
    event.type === "tool_execution_end"
  ) {
    return { ...payload, type: event.type };
  }
  return undefined;
}

function readTurnOwner(sessionKey: string, lane: string = currentLane()): TurnOwner | undefined {
  const path = turnOwnerPath(sessionKey, lane);
  if (!existsSync(path)) return undefined;
  try {
    const owner = JSON.parse(readFileSync(path, "utf8")) as TurnOwner;
    if (owner?.schemaVersion !== 1 || typeof owner.instanceId !== "string") return undefined;
    return owner;
  } catch {
    return undefined;
  }
}

function isOwnerFresh(owner: TurnOwner | undefined): owner is TurnOwner {
  if (!owner) return false;
  const t = Date.parse(owner.heartbeatAt || owner.acquiredAt);
  return Number.isFinite(t) && Date.now() - t <= LEASE_MS;
}

function readHostInfo(sessionKey: string, lane: string = currentLane()): HostInfo | undefined {
  const path = hostInfoPath(sessionKey, lane);
  if (!existsSync(path)) return undefined;
  try {
    const info = JSON.parse(readFileSync(path, "utf8")) as HostInfo;
    if (info?.schemaVersion !== 1 || typeof info.pid !== "number") return undefined;
    return info;
  } catch {
    return undefined;
  }
}

function processAlive(pid: number | undefined): boolean {
  if (!Number.isInteger(pid) || (pid as number) <= 0) return false;
  try {
    process.kill(pid as number, 0);
    const stat = execFileSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (stat.startsWith("Z")) return false;
    return true;
  } catch {
    return false;
  }
}

function readLaneState(sessionKey: string, lane: string = currentLane()): { headEntryId?: string | null; headEpoch?: number } | undefined {
  const path = laneStatePath(sessionKey, lane);
  if (!existsSync(path)) return undefined;
  try {
    const state = JSON.parse(readFileSync(path, "utf8")) as { schemaVersion?: number; headEntryId?: unknown; headEpoch?: unknown };
    if (state?.schemaVersion !== 1) return undefined;
    return {
      headEntryId: typeof state.headEntryId === "string" ? state.headEntryId : null,
      headEpoch: typeof state.headEpoch === "number" ? state.headEpoch : undefined,
    };
  } catch {
    return undefined;
  }
}

function isHostFresh(info: HostInfo | undefined): info is HostInfo {
  if (!info || info.state !== "running") return false;
  if (!processAlive(info.pid)) return false;
  const t = Date.parse(info.heartbeatAt);
  return Number.isFinite(t) && Date.now() - t <= Number(process.env.PI_SYNC_HOST_LEASE_MS ?? 5_000);
}

function isHostLockFresh(sessionKey: string, lane: string): boolean {
  const lockDir = hostLockDirPath(sessionKey, lane);
  const ownerPath = join(lockDir, "owner.json");
  try {
    const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as { state?: string; pid?: number; heartbeatAt?: string; startedAt?: string };
    const t = Date.parse(owner.heartbeatAt ?? owner.startedAt ?? "");
    if (["starting", "running"].includes(owner.state ?? "") && Number.isFinite(t) && Date.now() - t <= Number(process.env.PI_SYNC_HOST_LEASE_MS ?? 5_000)) {
      return processAlive(owner.pid);
    }
    if (Number.isInteger(owner.pid) && !processAlive(owner.pid)) return false;
  } catch {
    // Fall back to the lock directory age for very old/corrupt lock owners.
  }
  return isFreshPath(lockDir, Number(process.env.PI_SYNC_HOST_LEASE_MS ?? 5_000));
}

function isFreshPath(path: string, maxAgeMs: number): boolean {
  try {
    const t = statSync(path).mtimeMs;
    return Number.isFinite(t) && Date.now() - t <= maxAgeMs;
  } catch {
    return false;
  }
}

export default function piSync(pi: ExtensionAPI) {
  if (process.env.PI_SYNC_HOST_PROCESS === "1") return;
  process.env.PI_SYNC_HANDLES_INTERACTIVE_INPUT = "1";

  const instanceId = randomUUID();
  let activeSessionFile: string | undefined;
  let activeSessionId: string | null = null;
  let activeSessionKey: string | undefined;
  let activeLane: string | undefined;
  let activeEventPath: string | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let hostSocket: Socket | undefined;
  let hostSocketBuffer = "";
  let hostReconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let terminalInputUnsubscribe: (() => void) | undefined;
  let shuttingDown = false;
  let lastHostSpawnSessionKey: string | undefined;
  let lastHostSpawnLane: string | undefined;
  let lastHostSpawnAt = 0;
  const pendingHostPrompts: HostPrompt[] = [];
  let hostAbortGraceStartedAt = 0;
  let hostAbortGraceUntil = 0;
  let remoteTurnMaybeUnflushed = false;
  let remoteWorkingStartedAtMs: number | undefined;
  let remoteWorkingTimer: ReturnType<typeof setInterval> | undefined;
  let readOffset = 0;
  let localOwnsTurn = false;
  let ownedTurnSessionKey: string | undefined;
  let ownedTurnLane: string | undefined;
  let publishSeq = 0;
  let isProcessingRemote = false;
  let processRemoteAgain = false;
  let queuedDrainTimer: ReturnType<typeof setTimeout> | undefined;
  const pendingQueuedInputs: Array<{ text: string; images?: any[] }> = [];
  const seenEventIds: string[] = [];
  const seenHostEventIds: string[] = [];
  const abortedHostPromptIds = new Set<string>();
  const hostPromptIdsWithStreamingMessage = new Set<string>();
  const renderedAbortPromptIds = new Set<string>();
  let suppressAbortedHostMessageEndUntil = 0;
  const optimisticOwnUserTextCounts = new Map<string, number>();
  const mirroredPromptTextCounts = new Map<string, number>();
  const hostRenderedPromptTextCounts = new Map<string, number>();
  let replayingRemoteAgentEvents = 0;
  let replayHistoryPersistedMessageTextCounts: Map<string, number> | undefined;
  let replayHistoryPersistedMessageKeys: Set<string> | undefined;
  let pendingHostAbort = false;
  let selectedTreeCursorEntryId: string | null | undefined;
  let laneHeartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let currentStatus: InstanceState["status"] = "idle";
  let currentSessionFile: string | undefined;
  let currentSessionKey: string | undefined;
  let currentSessionId: string | null | undefined;
  const startedAt = nowIso();
  const initialSyncRootEnv = process.env.PI_SYNC_ROOT;
  const initialLaneRootEnv = process.env.PI_LANE_ROOT;

  function isReplayingRemoteAgentEvent(): boolean {
    return replayingRemoteAgentEvents > 0;
  }

  function cliExtensionArgsForHost(): string {
    const extras: string[] = [];
    for (let i = 0; i < process.argv.length; i++) {
      const arg = process.argv[i];
      if ((arg === "-e" || arg === "--extension") && process.argv[i + 1]) {
        const ext = process.argv[++i];
        if (
          !ext.includes("/pi-sync/index.ts") &&
          !ext.endsWith("/pi-sync") &&
          !ext.includes("/pi-mock/") &&
          !ext.includes("test-helper-extension")
        ) extras.push(ext);
      }
    }
    return extras.join(",");
  }

  function formatRemoteWorkingDuration(ms: number): string {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
  }

  function hostEventTimeMs(event: any): number {
    const at = typeof event?.at === "string" ? Date.parse(event.at) : NaN;
    return Number.isFinite(at) ? at : Date.now();
  }

  function applyRemoteWorking(ctx: ExtensionContext): void {
    if (!EXACT_MODE || remoteWorkingStartedAtMs == null) return;
    try {
      const message = ctx.ui.theme?.fg
        ? ctx.ui.theme.fg("dim", `Working for ${formatRemoteWorkingDuration(Date.now() - remoteWorkingStartedAtMs)}`)
        : `Working for ${formatRemoteWorkingDuration(Date.now() - remoteWorkingStartedAtMs)}`;
      ctx.ui.setWorkingMessage(message);
      ctx.ui.setWorkingVisible(true);
    } catch {
      stopRemoteWorking();
    }
  }

  function startRemoteWorking(ctx: ExtensionContext, startedAtMs: number): void {
    if (!EXACT_MODE) return;
    if (remoteWorkingStartedAtMs == null || startedAtMs < remoteWorkingStartedAtMs) {
      remoteWorkingStartedAtMs = startedAtMs;
    }
    applyRemoteWorking(ctx);
    if (!remoteWorkingTimer) {
      remoteWorkingTimer = setInterval(() => applyRemoteWorking(ctx), 250);
      remoteWorkingTimer.unref?.();
    }
  }

  function stopRemoteWorking(): void {
    if (remoteWorkingTimer) clearInterval(remoteWorkingTimer);
    remoteWorkingTimer = undefined;
    remoteWorkingStartedAtMs = undefined;
  }

  function exportLaneIdentity(ctx: ExtensionContext, file: string): LaneState | undefined {
    const key = activeSessionKeyFor(ctx, file, activeSessionFile, activeSessionKey);
    const id = sessionId(ctx);
    currentSessionId = id;
    currentSessionFile = file;
    currentSessionKey = key;
    process.env.PI_SYNC_INSTANCE_ID = instanceId;
    process.env.PI_LANE_INSTANCE_ID = instanceId;
    if (id) {
      process.env.PI_SYNC_SESSION_ID = id;
      process.env.PI_LANE_SESSION_ID = id;
    } else {
      delete process.env.PI_SYNC_SESSION_ID;
      delete process.env.PI_LANE_SESSION_ID;
    }
    process.env.PI_SYNC_SESSION_KEY = key;
    process.env.PI_SYNC_SESSION_FILE = file;
    process.env.PI_SYNC_CHANNEL = currentLane();
    process.env.PI_SYNC_ROOT = laneRoot();
    process.env.PI_LANE_SESSION_KEY = key;
    process.env.PI_LANE_SESSION_FILE = file;
    process.env.PI_LANE_CURRENT_LANE = currentLane();
    process.env.PI_LANE_ROOT = laneRoot();
    const lane = ensureLane(key, file, currentLane(), sessionManager(ctx)?.getLeafId?.() ?? persistedLeafId(file) ?? null);
    const displayId = activeLaneDisplayId(key, currentLane());
    process.env.PI_SYNC_CHANNEL_ID = displayId;
    process.env.PI_SYNC_CHANNEL_FILE_ID = lane.id ?? "";
    process.env.PI_LANE_CURRENT_LANE_ID = displayId;
    process.env.PI_LANE_CURRENT_LANE_FILE_ID = lane.id ?? "";
    if (lane.aliasPath) {
      process.env.PI_SYNC_CHANNEL_FILE = lane.aliasPath;
      process.env.PI_LANE_CURRENT_LANE_FILE = lane.aliasPath;
    } else {
      delete process.env.PI_SYNC_CHANNEL_FILE;
      delete process.env.PI_LANE_CURRENT_LANE_FILE;
    }
    updateTreeMarkers(key, file);
    return lane;
  }

  function clearLaneIdentity(): void {
    delete process.env.PI_SYNC_INSTANCE_ID;
    delete process.env.PI_SYNC_SESSION_ID;
    delete process.env.PI_SYNC_SESSION_KEY;
    delete process.env.PI_SYNC_SESSION_FILE;
    delete process.env.PI_SYNC_CHANNEL;
    delete process.env.PI_SYNC_CHANNEL_ID;
    delete process.env.PI_SYNC_CHANNEL_FILE_ID;
    delete process.env.PI_SYNC_CHANNEL_FILE;
    delete process.env.PI_LANE_INSTANCE_ID;
    delete process.env.PI_LANE_SESSION_ID;
    delete process.env.PI_LANE_SESSION_KEY;
    delete process.env.PI_LANE_SESSION_FILE;
    delete process.env.PI_LANE_CURRENT_LANE;
    delete process.env.PI_LANE_CURRENT_LANE_ID;
    delete process.env.PI_LANE_CURRENT_LANE_FILE_ID;
    delete process.env.PI_LANE_CURRENT_LANE_FILE;
    delete process.env.PI_SYNC_TREE_MARKERS;
    if (initialSyncRootEnv === undefined) delete process.env.PI_SYNC_ROOT;
    else process.env.PI_SYNC_ROOT = initialSyncRootEnv;
    if (initialLaneRootEnv === undefined) delete process.env.PI_LANE_ROOT;
    else process.env.PI_LANE_ROOT = initialLaneRootEnv;
  }

  function updateTreeMarkers(sessionKey: string | undefined = currentSessionKey ?? activeSessionKey, file: string | undefined = currentSessionFile ?? activeSessionFile): void {
    if (!sessionKey || !file) {
      delete process.env.PI_SYNC_TREE_MARKERS;
      return;
    }
    const messageIds = persistedMessageEntryIds(file);
    const activeLaneNames = new Set<string>();
    for (const instance of liveLaneInstances(sessionKey)) {
      activeLaneNames.add(sanitizeLaneName(instance.lane));
    }
    if (currentSessionKey === sessionKey || activeSessionKey === sessionKey) {
      activeLaneNames.add(sanitizeLaneName(currentLane()));
    }
    const markers: Record<string, string[]> = {};
    for (const lane of readLaneStates(sessionKey)) {
      if (!activeLaneNames.has(sanitizeLaneName(lane.name))) continue;
      const headEntryId = lane.headEntryId ?? null;
      const markerEntryId = headEntryId && messageIds.has(headEntryId)
        ? headEntryId
        : headEntryId === null
          ? persistedRootMarkerEntryId(file)
          : undefined;
      if (!markerEntryId) continue;
      const id = liveLaneId(sessionKey, lane.name);
      markers[markerEntryId] = [...(markers[markerEntryId] ?? []), id];
    }
    const compactMarkers: Record<string, string> = {};
    for (const [entryId, ids] of Object.entries(markers)) {
      compactMarkers[entryId] = [...new Set(ids)]
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        .join(",");
    }
    if (Object.keys(compactMarkers).length > 0) {
      process.env.PI_SYNC_TREE_MARKERS = JSON.stringify(compactMarkers);
    } else {
      delete process.env.PI_SYNC_TREE_MARKERS;
    }
  }

  function syncSessionLeafToLaneHead(ctx: ExtensionContext, sessionKey: string | undefined = activeSessionKey, laneName: string = activeLane ?? currentLane()): void {
    if (!sessionKey || !activeSessionFile) return;
    const lane = readLane(sessionKey, laneName);
    if (!lane) return;
    const targetHead = lane.headEntryId ?? null;
    const sm = sessionManager(ctx);
    if (!sm) return;
    const currentLeaf = sm.getLeafId?.() ?? null;
    if (currentLeaf === targetHead) {
      selectedTreeCursorEntryId = targetHead;
      updateTreeMarkers(sessionKey, activeSessionFile);
      return;
    }
    try {
      sm.setSessionFile?.(activeSessionFile);
      if (targetHead === null) {
        sm.resetLeaf?.();
      } else if (persistedEntryExists(activeSessionFile, targetHead)) {
        sm.branch?.(targetHead);
      } else {
        return;
      }
      selectedTreeCursorEntryId = targetHead;
      updateTreeMarkers(sessionKey, activeSessionFile);
      (ctx.ui as any)?.requestRender?.();
    } catch {
      // Best-effort reconciliation. The next session refresh or tree
      // navigation will retry with the latest persisted lane state.
    }
  }

  function writeLaneInstance(ctx: ExtensionContext, file: string, status = currentStatus): void {
    currentStatus = status;
    const lane = exportLaneIdentity(ctx, file);
    if (!lane || !currentSessionKey) return;
    const state: InstanceState = {
      instanceId,
      pid: process.pid,
      lane: currentLane(),
      status,
      sessionId: currentSessionId ?? null,
      sessionKey: currentSessionKey,
      sessionFile: file,
      leafId: sessionManager(ctx)?.getLeafId?.() ?? null,
      startedAt,
      lastSeenAt: nowIso(),
    };
    writeJsonFile(instancePath(currentSessionKey, instanceId), state);
    updateTreeMarkers(currentSessionKey, file);
  }

  function readLaneInstances(sessionKey: string): InstanceState[] {
    try {
      mkdirSync(laneInstancesDir(sessionKey), { recursive: true });
      return readdirSync(laneInstancesDir(sessionKey))
        .filter((item) => item.endsWith(".json"))
        .map((item) => readJsonFile<InstanceState>(join(laneInstancesDir(sessionKey), item)))
        .filter((item): item is InstanceState => !!item);
    } catch {
      return [];
    }
  }

  function isLiveLaneInstance(state: InstanceState): boolean {
    if (state.status === "disconnected") return false;
    const staleMs = Number(process.env.PI_SYNC_INSTANCE_STALE_MS ?? process.env.PI_LANE_INSTANCE_STALE_MS ?? 15_000);
    const lastSeenAt = Date.parse(state.lastSeenAt);
    return Number.isFinite(lastSeenAt) && Date.now() - lastSeenAt <= staleMs;
  }

  function activeLaneDisplayId(sessionKey: string, lane: string): string {
    const name = sanitizeLaneName(lane);
    const names = laneNamesForLiveDisplay(sessionKey, name);
    return `L${Math.max(0, names.indexOf(name)) + 1}`;
  }

  function readLaneStates(sessionKey: string): LaneState[] {
    try {
      mkdirSync(laneLanesDir(sessionKey), { recursive: true });
      return readdirSync(laneLanesDir(sessionKey))
        .filter((item) => item.endsWith(".json"))
        .map((item) => readJsonFile<LaneState>(join(laneLanesDir(sessionKey), item)))
        .filter((item): item is LaneState => !!item);
    } catch {
      return [];
    }
  }

  function normalizeLaneSelector(value: string | undefined): string {
    const raw = String(value ?? "").trim();
    if (!raw) return DEFAULT_LANE;
    const marker = /^~\/(\d+)$/.exec(raw);
    if (marker) return `L${marker[1]}`;
    if (/^\d+$/.test(raw)) return `L${raw}`;
    return raw;
  }

  function laneNamesForLiveDisplay(sessionKey: string, includeLane?: string): string[] {
    const names = new Set<string>();
    const instances = readLaneInstances(sessionKey);
    for (const instance of instances) {
      if (isLiveLaneInstance(instance)) names.add(sanitizeLaneName(instance.lane));
    }
    if (includeLane) names.add(sanitizeLaneName(includeLane));
    if (names.size === 0) names.add(DEFAULT_LANE);
    return [...names].sort((a, b) => {
      if (a === DEFAULT_LANE) return -1;
      if (b === DEFAULT_LANE) return 1;
      return a.localeCompare(b);
    });
  }

  function resolveLiveLaneDisplayName(sessionKey: string, selector: string | undefined): string | undefined {
    const normalized = normalizeLaneSelector(selector);
    const match = /^L(\d+)$/i.exec(normalized);
    if (!match) return undefined;
    const index = Number(match[1]) - 1;
    const names = laneNamesForLiveDisplay(sessionKey);
    return index >= 0 ? names[index] : undefined;
  }

  function resolveLaneName(sessionKey: string, selector: string | undefined): string | undefined {
    const liveName = resolveLiveLaneDisplayName(sessionKey, selector);
    if (liveName) return liveName;
    const normalized = normalizeLaneSelector(selector);
    const sanitized = sanitizeLaneName(normalized);
    const lanes = readLaneStates(sessionKey);
    const byName = lanes.find((lane) => sanitizeLaneName(lane.name) === sanitized);
    if (byName) return byName.name;
    const upper = normalized.toUpperCase();
    const byDisplay = lanes.find((lane) => (lane.displayId ?? "").toUpperCase() === upper);
    if (byDisplay) return byDisplay.name;
    if (upper === "L1" || sanitized === DEFAULT_LANE) return DEFAULT_LANE;
    return undefined;
  }

  function liveLaneInstances(sessionKey: string, lane?: string): InstanceState[] {
    return readLaneInstances(sessionKey)
      .filter((item) => isLiveLaneInstance(item))
      .filter((item) => lane === undefined || sanitizeLaneName(item.lane) === sanitizeLaneName(lane));
  }

  function nextDefaultLaneName(sessionKey: string): string {
    const used = new Set(readLaneStates(sessionKey).map((lane) => sanitizeLaneName(lane.name)));
    for (let index = 2; index < 10_000; index++) {
      const name = `lane-${index}`;
      if (!used.has(name)) return name;
    }
    return `lane-${Date.now().toString(36)}`;
  }

  function laneIdFromDisplayId(displayId: string): string {
    const match = /^L(\d+)$/i.exec(displayId);
    return match ? match[1] : displayId;
  }

  function liveLaneId(sessionKey: string, lane: string): string {
    return laneIdFromDisplayId(activeLaneDisplayId(sessionKey, lane));
  }

  function displayLane(sessionKey: string, lane: LaneState): string {
    const id = liveLaneId(sessionKey, lane.name);
    return id === lane.name ? id : `${id} (${lane.name})`;
  }

  const laneSubcommands: AutocompleteItem[] = [
    { value: "status", label: "status", description: "Show current lane state" },
    { value: "new ", label: "new", description: "Create and join a lane" },
    { value: "join ", label: "join", description: "Join an existing lane" },
    { value: "list", label: "list", description: "List lanes and live instances" },
    { value: "instances", label: "instances", description: "List live terminal instances" },
    { value: "identity", label: "identity", description: "Show exported sync identity" },
    { value: "debug", label: "debug", description: "Show the pi-sync debug log path" },
  ];

  function filterCompletions(items: AutocompleteItem[], prefix: string): AutocompleteItem[] {
    const normalized = prefix.trim().toLowerCase();
    if (!normalized) return items;
    return items.filter((item) => item.label.toLowerCase().startsWith(normalized) || item.value.toLowerCase().startsWith(normalized));
  }

  function laneArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
    const raw = String(argumentPrefix ?? "");
    const trimmed = raw.trimStart();
    const endsWithSpace = /\s$/.test(trimmed);
    const parts = trimmed.split(/\s+/).filter(Boolean);
    if (parts.length === 0 || (!endsWithSpace && parts.length === 1)) {
      return filterCompletions(laneSubcommands, parts[0] ?? "");
    }

    const command = parts[0];
    if (command !== "join") return null;

    const key = currentSessionKey ?? activeSessionKey ?? process.env.PI_SYNC_SESSION_KEY ?? process.env.PI_LANE_SESSION_KEY;
    const lanes = key ? laneNamesForLiveDisplay(key).map((name) => readLane(key, name)).filter((lane): lane is LaneState => !!lane) : [];
    const selectorPrefix = endsWithSpace ? "" : parts[1] ?? "";
    const items = lanes
      .map((lane) => {
        const id = key ? liveLaneId(key, lane.name) : lane.name;
        return {
          value: `join ${id}`,
          label: id,
          description: lane.name,
        };
      });
    return filterCompletions(items, selectorPrefix);
  }

  function notifyLane(ctx: ExtensionContext, message: string): void {
    ctx.ui?.notify?.(message, "info");
  }

  function initializeLaneSession(ctx: ExtensionContext): void {
    const initialFile = sessionFile(ctx);
    if (initialFile) sessionManager(ctx)?.setSessionFile?.(initialFile);
    const file = sessionFile(ctx) ?? initialFile;
    if (!file) {
      clearLaneIdentity();
      return;
    }
    moduleCurrentLane = DEFAULT_LANE;
    const key = activeSessionKeyFor(ctx, file, activeSessionFile, activeSessionKey);
    mkdirSync(laneLanesDir(key), { recursive: true });
    mkdirSync(laneInstancesDir(key), { recursive: true });
    ensureLane(key, file, DEFAULT_LANE, persistedLeafId(file) ?? null);
    writeLaneInstance(ctx, file, "idle");
    if (laneHeartbeatTimer) clearInterval(laneHeartbeatTimer);
    laneHeartbeatTimer = setInterval(() => writeLaneInstance(ctx, file), Math.max(250, Number(process.env.PI_LANE_HEARTBEAT_MS ?? 2_000)));
    laneHeartbeatTimer.unref?.();
  }

  function treeLaneNameForHead(headEntryId: string | null): string {
    if (!headEntryId) return "tree-root";
    return `tree-${createHash("sha256").update(headEntryId).digest("hex").slice(0, 12)}`;
  }

  function existingTreeLaneForHead(sessionKey: string, headEntryId: string | null): string | undefined {
    try {
      mkdirSync(laneLanesDir(sessionKey), { recursive: true });
      for (const item of readdirSync(laneLanesDir(sessionKey))) {
        if (!item.endsWith(".json")) continue;
        const lane = readJsonFile<LaneState>(join(laneLanesDir(sessionKey), item));
        if (!lane || lane.name === DEFAULT_LANE) continue;
        if ((lane.baseLeafId ?? null) === headEntryId || (lane.headEntryId ?? null) === headEntryId) return lane.name;
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  function laneNameForTreeSelection(sessionKey: string, file: string, headEntryId: string | null): string {
    const main = ensureLane(sessionKey, file, DEFAULT_LANE, persistedLeafId(file) ?? null);
    if ((main.headEntryId ?? null) === headEntryId) return DEFAULT_LANE;
    return existingTreeLaneForHead(sessionKey, headEntryId) ?? treeLaneNameForHead(headEntryId);
  }

  function switchLaneForTreeSelection(ctx: ExtensionContext, file: string, newHeadEntryId: string | null, oldLeafId?: string | null): void {
    const key = activeSessionKeyFor(ctx, file, activeSessionFile, activeSessionKey);
    const lane = laneNameForTreeSelection(key, file, newHeadEntryId);
    moduleCurrentLane = lane;
    const current = ensureLane(key, file, lane, newHeadEntryId);
    if ((current.headEntryId ?? null) !== newHeadEntryId || (current.baseLeafId ?? null) !== newHeadEntryId) {
      updateLaneState(key, file, lane, {
        baseLeafId: current.baseLeafId ?? newHeadEntryId,
        headEntryId: newHeadEntryId,
        headEpoch: (current.headEntryId ?? null) === newHeadEntryId ? current.headEpoch : current.headEpoch + 1,
        updatedBy: instanceId,
      });
    }
    appendDebug(key, "tree_navigation_lane_switch", {
      lane,
      oldLeafId: oldLeafId ?? null,
      newHeadEntryId,
      instanceId,
    });
    writeLaneInstance(ctx, file, "idle");
    updateTreeMarkers(key, file);
  }

  function ensureHost(ctx: ExtensionContext): void {
    if (!ensureActivePaths(ctx) || !activeSessionKey || !activeSessionFile) return;
    const lane = activeLane ?? currentLane();
    const existing = readHostInfo(activeSessionKey, lane);
    if (isHostFresh(existing) && existsSync(hostSocketPath(activeSessionKey, lane))) return;
    const existingDead = !!existing?.pid && !isHostFresh(existing);
    if (existingDead) {
      try { rmSync(hostSocketPath(activeSessionKey, lane), { force: true }); } catch {}
      try { rmSync(hostLockDirPath(activeSessionKey, lane), { recursive: true, force: true }); } catch {}
    }
    if (isHostLockFresh(activeSessionKey, lane)) return;
    if (!existingDead && lastHostSpawnSessionKey === activeSessionKey && lastHostSpawnLane === lane && Date.now() - lastHostSpawnAt <= Number(process.env.PI_SYNC_HOST_LEASE_MS ?? 5_000)) return;
    lastHostSpawnSessionKey = activeSessionKey;
    lastHostSpawnLane = lane;
    lastHostSpawnAt = Date.now();
    const child = spawn(process.execPath, [
      hostScriptPath(),
      "--session-file", activeSessionFile,
      "--session-key", activeSessionKey,
      "--lane", lane,
    ], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, PI_SYNC_ROOT: laneRoot(), PI_LANE_ROOT: laneRoot(), PI_SYNC_CHANNEL: lane, PI_LANE_CURRENT_LANE: lane, PI_SYNC_HOST_PROCESS: "1", PI_SYNC_HOST_EXTENSIONS: cliExtensionArgsForHost() },
    });
    child.unref();
  }

  function scheduleHostReconnect(ctx: ExtensionContext): void {
    if (shuttingDown) return;
    if (hostReconnectTimer) return;
    hostReconnectTimer = setTimeout(() => {
      hostReconnectTimer = undefined;
      connectHost(ctx);
    }, HOST_RECONNECT_MS);
    hostReconnectTimer.unref?.();
  }

  function abortedAssistantMessage(ctx: ExtensionContext): any {
    return {
      role: "assistant",
      content: [],
      api: (ctx.model as any)?.api ?? "pi-sync",
      provider: (ctx.model as any)?.provider ?? "pi-sync",
      model: (ctx.model as any)?.id ?? (ctx.model as any)?.model ?? "unknown",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "aborted",
      errorMessage: "Operation aborted",
      timestamp: Date.now(),
    };
  }

  function renderHostAbortRequested(ctx: ExtensionContext, rawPayload: unknown): void {
    const payload = rawPayload && typeof rawPayload === "object" ? rawPayload as Record<string, any> : {};
    const activePromptId = typeof payload.activePromptId === "string" ? payload.activePromptId : undefined;
    const clearedPendingPrompts =
      typeof payload.clearedPendingPrompts === "number"
        ? payload.clearedPendingPrompts
        : payload.clearedLocalPendingPrompts
          ? 1
          : 0;
    if (activePromptId) abortedHostPromptIds.add(activePromptId);
    if (!activePromptId && clearedPendingPrompts <= 0) return;

    if (EXACT_MODE) ctx.ui.setWorkingVisible(false);
    if (activePromptId && renderedAbortPromptIds.has(activePromptId)) return;
    if (activePromptId) renderedAbortPromptIds.add(activePromptId);
    suppressAbortedHostMessageEndUntil = Date.now() + 5_000;

    const replayAgentEvent = nativeReplay(ctx);
    const message = abortedAssistantMessage(ctx);
    const hasStreamingMessage = hostPromptIdsWithStreamingMessage.has(activePromptId ?? "");
    const events = hasStreamingMessage
      ? [{ type: "message_end", message }]
      : [
        { type: "message_start", message: { ...message, stopReason: undefined, errorMessage: undefined } },
        { type: "message_end", message },
      ];
    replayingRemoteAgentEvents++;
    const previousReplayEnv = process.env.PI_SYNC_REPLAYING_REMOTE;
    process.env.PI_SYNC_REPLAYING_REMOTE = "1";
    void (async () => {
      for (const replayEvent of events) {
        await Promise.resolve(replayAgentEvent(replayEvent, { emitExtensions: true }));
      }
    })()
      .catch(() => undefined)
      .finally(() => {
        replayingRemoteAgentEvents = Math.max(0, replayingRemoteAgentEvents - 1);
        if (previousReplayEnv === undefined) delete process.env.PI_SYNC_REPLAYING_REMOTE;
        else process.env.PI_SYNC_REPLAYING_REMOTE = previousReplayEnv;
      });
  }

  function replayHostEvent(event: any, ctx: ExtensionContext): void {
    if (!event) return;
    if (typeof event.id === "string" && !rememberHostEvent(event.id)) return;
    if (event.type === "prompt_queued" || event.type === "prompt_start") {
      if (event.type === "prompt_queued" || event.type === "prompt_start") remoteTurnMaybeUnflushed = true;
      if (event.type === "prompt_start") startRemoteWorking(ctx, hostEventTimeMs(event));
    } else if (event.type === "prompt_end" || event.type === "prompt_error") {
      hostAbortGraceStartedAt = 0;
      hostAbortGraceUntil = 0;
      suppressAbortedHostMessageEndUntil = 0;
      stopRemoteWorking();
    }
    if (event.type === "session_flushed" || event.type === "lane_head_updated" || event.type === "prompt_end" || event.type === "prompt_error") {
      refreshSessionFile(ctx);
      if (event.type === "lane_head_updated" || event.type === "session_flushed" || event.type === "prompt_end") {
        syncSessionLeafToLaneHead(ctx);
      }
      remoteTurnMaybeUnflushed = false;
      return;
    }
    if (event.type === "prompt_queued") {
      const text = typeof event.payload?.text === "string" ? event.payload.text : "";
      if (
        text &&
        event.payload?.clientId !== instanceId &&
        !hasReplayHistoryPersistedUserText(text) &&
        !hostRenderedPromptTextCounts.has(text) &&
        !mirroredPromptTextCounts.has(text)
      ) {
        renderOptimisticUserMessage(ctx, text, "peer");
      }
      return;
    }
    if (event.type === "abort_requested") {
      renderHostAbortRequested(ctx, event.payload);
      return;
    }
    if (event.type !== "agent_event") return;
    const replayEvent = event.payload?.agentEvent;
    const promptId = typeof event.payload?.promptId === "string" ? event.payload.promptId : undefined;
    if (Date.now() < suppressAbortedHostMessageEndUntil && replayEvent?.message?.role === "assistant") {
      return;
    }
    if (promptId && abortedHostPromptIds.has(promptId)) {
      if (replayEvent?.type === "agent_end") {
        hostPromptIdsWithStreamingMessage.delete(promptId);
        renderedAbortPromptIds.delete(promptId);
        abortedHostPromptIds.delete(promptId);
        const replayAgentEvent = nativeReplay(ctx);
        void Promise.resolve(replayAgentEvent(replayEvent, { emitExtensions: true })).catch(() => undefined);
      }
      return;
    }
    if (replayEvent?.type === "turn_start" || replayEvent?.type === "turn_end") return;
    if (replayEvent?.type === "queue_update") return;
    if (replayEvent?.type === "agent_end") {
      hostAbortGraceStartedAt = 0;
      hostAbortGraceUntil = 0;
    }
    if (replayEvent?.type === "message_end" || replayEvent?.type === "agent_end") remoteTurnMaybeUnflushed = true;
    if (isPersistedReplayMessageEvent(replayEvent)) return;
    if (isPersistedReplayAgentEnd(replayEvent)) return;
    if (isAlreadyEchoedUserPrompt(event, replayEvent)) return;
    if (replayEvent?.type === "agent_start") startRemoteWorking(ctx, hostEventTimeMs(event));
    if (replayEvent) {
      if (promptId && replayEvent.type === "message_start" && replayEvent.message?.role === "assistant") {
        hostPromptIdsWithStreamingMessage.add(promptId);
      }
      const replayAgentEvent = nativeReplay(ctx);
      replayingRemoteAgentEvents++;
      const previousReplayEnv = process.env.PI_SYNC_REPLAYING_REMOTE;
      process.env.PI_SYNC_REPLAYING_REMOTE = "1";
      void Promise.resolve(replayAgentEvent(replayEvent, { emitExtensions: true }))
        .finally(() => {
          replayingRemoteAgentEvents = Math.max(0, replayingRemoteAgentEvents - 1);
          if (previousReplayEnv === undefined) delete process.env.PI_SYNC_REPLAYING_REMOTE;
          else process.env.PI_SYNC_REPLAYING_REMOTE = previousReplayEnv;
          if (replayEvent.type === "message_end" || replayEvent.type === "agent_end") refreshSessionFile(ctx);
        });
      if (replayEvent.type === "message_start") {
        const text = messageText(replayEvent.message);
        if (text !== undefined) addHostRenderedPromptText(text);
      }
      if (promptId && (replayEvent.type === "message_end" || replayEvent.type === "agent_end")) {
        hostPromptIdsWithStreamingMessage.delete(promptId);
        renderedAbortPromptIds.delete(promptId);
      }
    }
  }

  function replayHostHistory(ctx: ExtensionContext): void {
    if (!activeSessionKey) return;
    const lane = activeLane ?? currentLane();
    const host = readHostInfo(activeSessionKey, lane);
    if (!host?.activePromptId && !host?.pendingPrompts) return;
    const path = hostEventsPath(activeSessionKey, lane);
    if (!existsSync(path)) return;
    const previousPersistedMessageCounts = replayHistoryPersistedMessageTextCounts;
    const previousPersistedMessageKeys = replayHistoryPersistedMessageKeys;
    replayHistoryPersistedMessageTextCounts = persistedMessageTextCounts(activeSessionFile);
    replayHistoryPersistedMessageKeys = new Set(replayHistoryPersistedMessageTextCounts.keys());
    try {
      for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
        if (!line.trim()) continue;
        try { replayHostEvent(JSON.parse(line), ctx); } catch {}
      }
    } finally {
      replayHistoryPersistedMessageTextCounts = previousPersistedMessageCounts;
      replayHistoryPersistedMessageKeys = previousPersistedMessageKeys;
    }
  }

  function handleHostMessage(message: any, ctx: ExtensionContext): void {
    if (message?.type !== "event") return;
    if (message.event?.sessionKey !== activeSessionKey || message.event?.lane !== activeLane) return;
    replayHostEvent(message.event, ctx);
  }


  function connectHost(ctx: ExtensionContext): void {
    if (shuttingDown) return;
    if (!ensureActivePaths(ctx) || !activeSessionKey) return;
    if (hostSocket && !hostSocket.destroyed) {
      const host = readHostInfo(activeSessionKey, activeLane ?? currentLane());
      if (isHostFresh(host)) return;
      try { hostSocket.destroy(); } catch {}
      hostSocket = undefined;
      hostSocketBuffer = "";
    }
    ensureHost(ctx);
    const socketPath = hostSocketPath(activeSessionKey, activeLane ?? currentLane());
    const host = readHostInfo(activeSessionKey, activeLane ?? currentLane());
    if (!isHostFresh(host)) {
      scheduleHostReconnect(ctx);
      return;
    }
    if (!existsSync(socketPath)) {
      scheduleHostReconnect(ctx);
      return;
    }
    const socket = connect(socketPath);
    hostSocket = socket;
    hostSocketBuffer = "";
    socket.setEncoding("utf8");
    socket.setNoDelay?.(true);
    socket.on("connect", () => {
      replayHostHistory(ctx);
      if (pendingHostAbort && !socket.destroyed) {
        pendingHostAbort = false;
        pendingHostPrompts.length = 0;
        socket.write(JSON.stringify({ type: "abort", source: "pi-sync", clientId: instanceId }) + "\n");
        publish(ctx, "abort_requested", { source: "escape" });
        return;
      }
      const flushPrompts = () => {
        if (pendingHostAbort && !socket.destroyed) {
          pendingHostAbort = false;
          pendingHostPrompts.length = 0;
          socket.write(JSON.stringify({ type: "abort", source: "pi-sync", clientId: instanceId }) + "\n");
          publish(ctx, "abort_requested", { source: "escape" });
          return;
        }
        while (pendingHostPrompts.length > 0 && !socket.destroyed) {
          const prompt = pendingHostPrompts.shift();
          if (prompt) socket.write(JSON.stringify({ type: "prompt", ...prompt, source: "pi-sync", clientId: instanceId }) + "\n");
        }
      };
      if (COLD_PROMPT_GRACE_MS > 0 && pendingHostPrompts.length > 0) {
        setTimeout(flushPrompts, COLD_PROMPT_GRACE_MS).unref?.();
      } else {
        flushPrompts();
      }
    });
    socket.on("data", (chunk) => {
      hostSocketBuffer += chunk;
      let idx;
      while ((idx = hostSocketBuffer.indexOf("\n")) >= 0) {
        const line = hostSocketBuffer.slice(0, idx).trim();
        hostSocketBuffer = hostSocketBuffer.slice(idx + 1);
        if (!line) continue;
        if (hostSocket !== socket) continue;
        try {
          handleHostMessage(JSON.parse(line), ctx);
        } catch {
          // Ignore malformed host frames; reconnect handles process restarts.
        }
      }
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      if (hostSocket === socket) hostSocket = undefined;
      scheduleHostReconnect(ctx);
    });
  }

  function sendHostPrompt(ctx: ExtensionContext, text: string): boolean {
    connectHost(ctx);
    hostAbortGraceStartedAt = Date.now();
    hostAbortGraceUntil = hostAbortGraceStartedAt + 1000;
    const lane = activeLane ?? currentLane();
    const laneState = activeSessionKey ? readLaneState(activeSessionKey, lane) : undefined;
    const prompt: HostPrompt = {
      text,
      lane,
      modelProvider: ctx.model?.provider,
      modelId: ctx.model?.id,
    };
    if (selectedTreeCursorEntryId !== undefined) {
      const cursorHeadEntryId = selectedTreeCursorEntryId;
      const validCursorHeadEntryId =
        cursorHeadEntryId === null || (typeof cursorHeadEntryId === "string" && persistedEntryExists(activeSessionFile, cursorHeadEntryId))
          ? cursorHeadEntryId
          : undefined;
      if (validCursorHeadEntryId !== undefined) {
        prompt.laneHeadEntryId = validCursorHeadEntryId;
        prompt.laneHeadEpoch = laneState?.headEpoch;
        prompt.allowLaneHeadFork = validCursorHeadEntryId !== (laneState?.headEntryId ?? null);
      }
    }
    if (!hostSocket || hostSocket.destroyed) {
      pendingHostPrompts.push(prompt);
      scheduleHostReconnect(ctx);
      selectedTreeCursorEntryId = undefined;
      return true;
    }
    hostSocket.write(JSON.stringify({ type: "prompt", ...prompt, source: "pi-sync", clientId: instanceId }) + "\n");
    selectedTreeCursorEntryId = undefined;
    return true;
  }

  function hostHasActiveWork(): boolean {
    if (pendingHostPrompts.length > 0) return true;
    if (!activeSessionKey) return false;
    const host = readHostInfo(activeSessionKey, activeLane ?? currentLane());
    const now = Date.now();
    if (!isHostFresh(host)) return now < hostAbortGraceUntil;
    if (host.activePromptId || (host.pendingPrompts ?? 0) > 0) return true;
    if (host.state === "running" && (host.clients ?? 0) > 0) return true;
    const heartbeatAt = typeof host.heartbeatAt === "string" ? Date.parse(host.heartbeatAt) : NaN;
    if (now < hostAbortGraceUntil && (!Number.isFinite(heartbeatAt) || heartbeatAt < hostAbortGraceStartedAt)) return true;
    hostAbortGraceStartedAt = 0;
    hostAbortGraceUntil = 0;
    return false;
  }

  function abortLocalSession(ctx: ExtensionContext): void {
    try {
      void Promise.resolve(ctx.abort()).catch(() => undefined);
    } catch {
      // The host abort is authoritative; local abort only keeps the terminal session in sync.
    }
  }

  function sendHostAbort(ctx: ExtensionContext): boolean {
    if (pendingHostPrompts.length > 0) {
      const clearedLocalPendingPrompts = pendingHostPrompts.length;
      pendingHostPrompts.length = 0;
      hostAbortGraceStartedAt = 0;
      hostAbortGraceUntil = 0;
      pendingHostAbort = false;
      if (EXACT_MODE) ctx.ui.setWorkingVisible(false);
      renderHostAbortRequested(ctx, { clearedPendingPrompts: clearedLocalPendingPrompts });
      publish(ctx, "abort_requested", { source: "escape", clearedLocalPendingPrompts: true });
      return true;
    }
    connectHost(ctx);
    const host = activeSessionKey ? readHostInfo(activeSessionKey, activeLane ?? currentLane()) : undefined;
    if (!hostSocket || hostSocket.destroyed) {
      pendingHostPrompts.length = 0;
      pendingHostAbort = true;
      scheduleHostReconnect(ctx);
      renderHostAbortRequested(ctx, { activePromptId: host?.activePromptId ?? undefined, clearedPendingPrompts: host?.pendingPrompts ?? 0 });
      return true;
    }
    pendingHostAbort = false;
    hostSocket.write(JSON.stringify({ type: "abort", source: "pi-sync", clientId: instanceId }) + "\n");
    renderHostAbortRequested(ctx, { activePromptId: host?.activePromptId ?? undefined, clearedPendingPrompts: host?.pendingPrompts ?? 0 });
    publish(ctx, "abort_requested", { source: "escape" });
    return true;
  }

  function startTerminalInputSync(ctx: ExtensionContext): void {
    terminalInputUnsubscribe?.();
    terminalInputUnsubscribe = ctx.ui.onTerminalInput((data) => {
      if (!isEscapeInput(data)) return undefined;
      ensureActivePaths(ctx);
      connectHost(ctx);
      if (!hostHasActiveWork()) return undefined;
      sendHostAbort(ctx);
      return undefined;
    });
  }

  function addOptimisticOwnUserText(text: string): void {
    optimisticOwnUserTextCounts.set(text, (optimisticOwnUserTextCounts.get(text) ?? 0) + 1);
  }

  function consumeOptimisticOwnUserText(text: string): void {
    const count = optimisticOwnUserTextCounts.get(text) ?? 0;
    if (count <= 1) optimisticOwnUserTextCounts.delete(text);
    else optimisticOwnUserTextCounts.set(text, count - 1);
  }

  function addMirroredPromptText(text: string): void {
    mirroredPromptTextCounts.set(text, (mirroredPromptTextCounts.get(text) ?? 0) + 1);
  }

  function consumeMirroredPromptText(text: string): void {
    const count = mirroredPromptTextCounts.get(text) ?? 0;
    if (count <= 1) mirroredPromptTextCounts.delete(text);
    else mirroredPromptTextCounts.set(text, count - 1);
  }

  function addHostRenderedPromptText(text: string): void {
    hostRenderedPromptTextCounts.set(text, (hostRenderedPromptTextCounts.get(text) ?? 0) + 1);
  }

  function consumeHostRenderedPromptText(text: string): boolean {
    const count = hostRenderedPromptTextCounts.get(text) ?? 0;
    if (count <= 0) return false;
    if (count === 1) hostRenderedPromptTextCounts.delete(text);
    else hostRenderedPromptTextCounts.set(text, count - 1);
    return true;
  }

  function messageText(message: any): string | undefined {
    return extractMessageText(message);
  }

  async function waitForRemoteFlushBeforeLocalCommand(ctx: ExtensionContext): Promise<void> {
    const startedAtMs = Date.now();
    while (remoteTurnMaybeUnflushed && Date.now() - startedAtMs < 2_000) {
      connectHost(ctx);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    refreshSessionFile(ctx);
  }

  function consumeReplayHistoryPersistedMessage(message: any): boolean {
    const key = messageReplayKey(message);
    if (key === undefined) return false;
    const count = replayHistoryPersistedMessageTextCounts?.get(key) ?? 0;
    if (count <= 0) return false;
    if (count === 1) replayHistoryPersistedMessageTextCounts?.delete(key);
    else replayHistoryPersistedMessageTextCounts?.set(key, count - 1);
    return true;
  }

  function hasReplayHistoryPersistedMessage(message: any): boolean {
    const key = messageReplayKey(message);
    return key !== undefined && (replayHistoryPersistedMessageTextCounts?.get(key) ?? 0) > 0;
  }

  function hasReplayHistoryPersistedUserText(text: string): boolean {
    return (replayHistoryPersistedMessageTextCounts?.get(`user\0${text}`) ?? 0) > 0;
  }

  function isPersistedReplayMessageEvent(replayEvent: any): boolean {
    if (!replayHistoryPersistedMessageTextCounts) return false;
    if (replayEvent?.type !== "message_start" && replayEvent?.type !== "message_update" && replayEvent?.type !== "message_end") return false;
    const message = replayEvent.message ?? replayEvent.assistantMessageEvent?.message ?? replayEvent.assistantMessageEvent?.partial;
    if (!hasReplayHistoryPersistedMessage(message)) return false;
    if (replayEvent.type === "message_end") consumeReplayHistoryPersistedMessage(message);
    return true;
  }

  function isPersistedReplayAgentEnd(replayEvent: any): boolean {
    if (!replayHistoryPersistedMessageKeys || replayEvent?.type !== "agent_end") return false;
    const messages = Array.isArray(replayEvent.messages) ? replayEvent.messages : [];
    if (messages.length === 0) return false;
    return messages.every((message: any) => {
      const key = messageReplayKey(message);
      return key !== undefined && replayHistoryPersistedMessageKeys?.has(key);
    });
  }

  function isAlreadyEchoedUserPrompt(hostEvent: any, replayEvent: any): boolean {
    if (replayEvent?.type !== "message_start" && replayEvent?.type !== "message_end") return false;
    if (replayEvent.message?.role !== "user") return false;
    const text = messageText(replayEvent.message);
    if (text === undefined) return false;
    const ownEcho = hostEvent?.payload?.clientId === instanceId && optimisticOwnUserTextCounts.has(text);
    const peerEcho = hostEvent?.payload?.clientId !== instanceId && mirroredPromptTextCounts.has(text);
    if (!ownEcho && !peerEcho) return false;
    if (replayEvent.type === "message_end" && ownEcho) consumeOptimisticOwnUserText(text);
    if (replayEvent.type === "message_end" && peerEcho) {
      consumeMirroredPromptText(text);
      addHostRenderedPromptText(text);
    }
    return true;
  }

  function renderOptimisticUserMessage(ctx: ExtensionContext, text: string, source: "own" | "peer"): void {
    const replayAgentEvent = nativeReplay(ctx);
    if (source === "own") addOptimisticOwnUserText(text);
    else addMirroredPromptText(text);
    const message = { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
    replayingRemoteAgentEvents++;
    void Promise.resolve(replayAgentEvent({ type: "message_start", message }))
      .then(() => replayAgentEvent({ type: "message_end", message }))
      .catch(() => {
        if (source === "own") consumeOptimisticOwnUserText(text);
        else consumeMirroredPromptText(text);
      })
      .finally(() => { replayingRemoteAgentEvents = Math.max(0, replayingRemoteAgentEvents - 1); });
  }

  const seenEventSet = new Set<string>();

  function rememberEvent(id: string): boolean {
    if (seenEventSet.has(id)) return false;
    seenEventSet.add(id);
    seenEventIds.push(id);
    while (seenEventIds.length > MAX_SEEN_EVENT_IDS) {
      const old = seenEventIds.shift();
      if (old) seenEventSet.delete(old);
    }
    return true;
  }

  function clearSeenEvents(): void {
    seenEventIds.length = 0;
    seenEventSet.clear();
    seenHostEventIds.length = 0;
    seenHostEventSet.clear();
    optimisticOwnUserTextCounts.clear();
    mirroredPromptTextCounts.clear();
    hostRenderedPromptTextCounts.clear();
  }

  const seenHostEventSet = new Set<string>();

  function rememberHostEvent(id: string): boolean {
    if (seenHostEventSet.has(id)) return false;
    seenHostEventSet.add(id);
    seenHostEventIds.push(id);
    while (seenHostEventIds.length > MAX_SEEN_EVENT_IDS) {
      const old = seenHostEventIds.shift();
      if (old) seenHostEventSet.delete(old);
    }
    return true;
  }

  function releaseTurnFor(sessionKey: string | undefined = ownedTurnSessionKey, lane: string | undefined = ownedTurnLane): void {
    if (!sessionKey || !localOwnsTurn) return;
    const targetLane = lane ?? activeLane ?? currentLane();
    try {
      const owner = readTurnOwner(sessionKey, targetLane);
      if (!owner || owner.instanceId === instanceId) rmSync(turnLockDir(sessionKey, targetLane), { recursive: true, force: true });
    } catch {
      // Best effort cleanup; stale-lock recovery handles process death.
    }
    if (ownedTurnSessionKey === sessionKey && ownedTurnLane === lane) {
      ownedTurnSessionKey = undefined;
      ownedTurnLane = undefined;
    }
    localOwnsTurn = false;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }

  function ensureActivePaths(ctx: ExtensionContext): boolean {
    const file = sessionFile(ctx) ?? activeSessionFile;
    if (!file) return false;
    const nextKey = activeSessionKeyFor(ctx, file, activeSessionFile, activeSessionKey);
    const nextLane = currentLane();
    const changed = activeSessionKey !== undefined && (activeSessionKey !== nextKey || activeLane !== nextLane);
    if (changed) {
      releaseTurnFor(ownedTurnSessionKey, ownedTurnLane);
      readOffset = 0;
      clearSeenEvents();
      pendingHostPrompts.length = 0;
      hostAbortGraceStartedAt = 0;
      hostAbortGraceUntil = 0;
      try { hostSocket?.end(); } catch {}
      hostSocket = undefined;
    }
    activeSessionFile = file;
    activeSessionId = sessionId(ctx);
    activeSessionKey = nextKey;
    activeLane = nextLane;
    activeEventPath = eventLogPath(activeSessionKey, activeLane);
    ensureLane(activeSessionKey, file, activeLane, persistedLeafId(file) ?? sessionManager(ctx)?.getLeafId?.() ?? null);
    exportLaneIdentity(ctx, file);
    updateTreeMarkers(activeSessionKey, file);
    mkdirSync(syncDir(activeSessionKey, activeLane), { recursive: true });
    if (!existsSync(activeEventPath)) writeFileSync(activeEventPath, "", "utf8");
    return true;
  }

  function writeOwnerFor(sessionKey: string, owner: TurnOwner, lane: string = owner.lane): void {
    const path = turnOwnerPath(sessionKey, lane);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${instanceId}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(owner, null, 2)}\n`, "utf8");
    renameSync(tmp, path);
  }

  function releaseTurn(): void {
    releaseTurnFor(ownedTurnSessionKey);
  }

  function heartbeatTurn(): void {
    const key = ownedTurnSessionKey;
    const lane = ownedTurnLane ?? activeLane ?? currentLane();
    if (!key || !localOwnsTurn) return;
    const owner = readTurnOwner(key, lane);
    if (owner?.instanceId !== instanceId) {
      localOwnsTurn = false;
      ownedTurnSessionKey = undefined;
      ownedTurnLane = undefined;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
      return;
    }
    writeOwnerFor(key, { ...owner, heartbeatAt: nowIso() }, lane);
  }

  function startHeartbeat(): void {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(heartbeatTurn, LEASE_HEARTBEAT_MS);
    heartbeatTimer.unref?.();
  }

  function acquireTurn(ctx: ExtensionContext, reason: string): { ok: true } | { ok: false; owner?: TurnOwner } {
    if (!ensureActivePaths(ctx) || !activeSessionKey || !activeEventPath || !activeSessionFile) return { ok: true };
    const lane = activeLane ?? currentLane();
    const lockDir = turnLockDir(activeSessionKey, lane);
    const existing = readTurnOwner(activeSessionKey, lane);
    if (isOwnerFresh(existing)) {
      if (existing.instanceId === instanceId) {
        localOwnsTurn = true;
        ownedTurnSessionKey = activeSessionKey;
        ownedTurnLane = lane;
        startHeartbeat();
        return { ok: true };
      }
      return { ok: false, owner: existing };
    }
    if (existing && !isOwnerFresh(existing)) {
      try {
        rmSync(lockDir, { recursive: true, force: true });
      } catch {
        // If another process raced us, mkdir below will fail and we will re-read.
      }
    }
    try {
      mkdirSync(lockDir, { recursive: false });
    } catch {
      const owner = readTurnOwner(activeSessionKey, lane);
      if (isOwnerFresh(owner)) {
        if (owner.instanceId === instanceId) {
          localOwnsTurn = true;
          ownedTurnSessionKey = activeSessionKey;
          ownedTurnLane = lane;
          startHeartbeat();
          return { ok: true };
        }
        return { ok: false, owner };
      }
      try {
        rmSync(lockDir, { recursive: true, force: true });
        mkdirSync(lockDir, { recursive: false });
      } catch {
        const racedOwner = readTurnOwner(activeSessionKey, lane);
        if (isOwnerFresh(racedOwner)) {
          if (racedOwner.instanceId === instanceId) {
            localOwnsTurn = true;
            ownedTurnSessionKey = activeSessionKey;
            ownedTurnLane = lane;
            startHeartbeat();
            return { ok: true };
          }
          return { ok: false, owner: racedOwner };
        }
        return { ok: false, owner: racedOwner };
      }
    }
    const owner: TurnOwner = {
      schemaVersion: 1,
      instanceId,
      sessionId: sessionId(ctx),
      sessionKey: activeSessionKey,
      sessionFile: activeSessionFile,
      lane,
      acquiredAt: nowIso(),
      heartbeatAt: nowIso(),
      turnStartOffset: fileSize(activeEventPath),
      reason,
    };
    writeOwnerFor(activeSessionKey, owner, lane);
    localOwnsTurn = true;
    ownedTurnSessionKey = activeSessionKey;
    ownedTurnLane = lane;
    startHeartbeat();
    return { ok: true };
  }

  function publish(ctx: ExtensionContext, type: string, payload: unknown): void {
    if (!ensureActivePaths(ctx) || !activeEventPath || !activeSessionKey || !activeSessionFile) return;
    const event: SyncEvent = {
      schemaVersion: 1,
      id: randomUUID(),
      seq: ++publishSeq,
      at: nowIso(),
      instanceId,
      sessionId: sessionId(ctx),
      sessionKey: activeSessionKey,
      sessionFile: activeSessionFile,
      lane: activeLane ?? currentLane(),
      type,
      payload: truncateJson(payload),
    };
    rememberEvent(event.id);
    appendEvent(activeEventPath, event);
  }

  async function handleControlEvent(event: SyncEvent, ctx: ExtensionContext): Promise<boolean> {
    if (event.type !== "queued_input") return false;
    if (!localOwnsTurn || ownedTurnSessionKey !== event.sessionKey || (ownedTurnLane ?? activeLane ?? currentLane()) !== event.lane) return true;
    const payload = event.payload as Record<string, any> | undefined;
    const text = typeof payload?.text === "string" ? payload.text : "";
    if (!text.trim()) return true;
    const images = Array.isArray(payload?.images) ? payload.images : undefined;
    try {
      pendingQueuedInputs.push({ text, images });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (activeSessionKey) appendDebug(activeSessionKey, "queued_input_error", { message });
    }
    return true;
  }

  async function processRemoteEvents(ctx: ExtensionContext): Promise<void> {
    if (isProcessingRemote) {
      processRemoteAgain = true;
      return;
    }
    isProcessingRemote = true;
    try {
      do {
        processRemoteAgain = false;
        if (!activeEventPath) return;
        const result = readNewEvents(activeEventPath, readOffset);
        readOffset = result.offset;
        for (const event of result.events) {
          if (!rememberEvent(event.id)) continue;
          if (event.instanceId === instanceId) continue;
          if (event.type === "abort_requested") {
            renderHostAbortRequested(ctx, event.payload);
            continue;
          }
          if (event.type === "prompt_echo") {
            const payload = event.payload as Record<string, any> | undefined;
            const text = typeof payload?.text === "string" ? payload.text : "";
            if (text && !consumeHostRenderedPromptText(text) && !mirroredPromptTextCounts.has(text)) {
              renderOptimisticUserMessage(ctx, text, "peer");
            }
            continue;
          }
          if (await handleControlEvent(event, ctx)) continue;
          const replayEvent = toReplayEvent(event);
          if (replayEvent) {
            const replayAgentEvent = nativeReplay(ctx);
            replayingRemoteAgentEvents++;
            const previousReplayEnv = process.env.PI_SYNC_REPLAYING_REMOTE;
            process.env.PI_SYNC_REPLAYING_REMOTE = "1";
            try {
              await replayAgentEvent(replayEvent);
            } finally {
              replayingRemoteAgentEvents = Math.max(0, replayingRemoteAgentEvents - 1);
              if (previousReplayEnv === undefined) delete process.env.PI_SYNC_REPLAYING_REMOTE;
              else process.env.PI_SYNC_REPLAYING_REMOTE = previousReplayEnv;
            }
            if (event.type === "message_end" || event.type === "agent_end") refreshSessionFile(ctx);
            continue;
          }
        }
      } while (processRemoteAgain);
    } finally {
      isProcessingRemote = false;
    }
  }

  function scheduleProcessRemoteEvents(ctx: ExtensionContext): void {
    void processRemoteEvents(ctx).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (activeSessionKey) appendDebug(activeSessionKey, "remote_replay_failed", { message });
    });
  }

  function refreshActiveLaneFromEnv(ctx: ExtensionContext): void {
    const previousSessionKey = activeSessionKey;
    const previousLane = activeLane;
    if (!ensureActivePaths(ctx) || !activeSessionKey || !activeEventPath) return;
    const changed = previousSessionKey !== undefined && (previousSessionKey !== activeSessionKey || previousLane !== activeLane);
    if (!changed) return;
    const owner = readTurnOwner(activeSessionKey, activeLane ?? currentLane());
    readOffset = isOwnerFresh(owner) ? Math.max(0, owner.turnStartOffset) : fileSize(activeEventPath);
    ensureHost(ctx);
    connectHost(ctx);
    publish(ctx, "attach", { sessionId: activeSessionId, sessionFile: activeSessionFile, sessionKey: activeSessionKey, lane: activeLane });
  }

  function startPolling(ctx: ExtensionContext): void {
    if (!ensureActivePaths(ctx) || !activeSessionKey || !activeEventPath) return;

    const owner = readTurnOwner(activeSessionKey, activeLane ?? currentLane());
    readOffset = isOwnerFresh(owner) ? Math.max(0, owner.turnStartOffset) : fileSize(activeEventPath);

    if (pollTimer) clearInterval(pollTimer);
    scheduleProcessRemoteEvents(ctx);
    pollTimer = setInterval(() => {
      refreshActiveLaneFromEnv(ctx);
      scheduleProcessRemoteEvents(ctx);
    }, POLL_MS);
    pollTimer.unref?.();
  }

  function refreshAfterCommand(ctx: ExtensionContext): void {
    const refresh = () => {
      if (shuttingDown || !ctx.hasUI) return;
      ensureActivePaths(ctx);
      startPolling(ctx);
      ensureHost(ctx);
      connectHost(ctx);
      publish(ctx, "attach", { sessionId: activeSessionId, sessionFile: activeSessionFile, sessionKey: activeSessionKey, lane: activeLane });
    };
    for (const delay of [0, 25, 100]) setTimeout(refresh, delay).unref?.();
  }

  pi.registerCommand("lane", {
    description: "Show, join, or create Pi sync lanes. Usage: /lane [status|new|join|list|identity|debug]",
    getArgumentCompletions: laneArgumentCompletions,
    handler: async (args: string, ctx: ExtensionContext) => {
      const file = sessionFile(ctx);
      if (!file) {
        notifyLane(ctx, "pi-sync lane: no persisted session file");
        return;
      }
      const key = activeSessionKeyFor(ctx, file, activeSessionFile, activeSessionKey);
      const [rawCommand, rawName] = args.trim().split(/\s+/, 2);
      const command = rawCommand || "status";

      if (command === "new") {
        const name = sanitizeLaneName(rawName || nextDefaultLaneName(key));
        const leaf = sessionManager(ctx)?.getLeafId?.() ?? null;
        moduleCurrentLane = name;
        const lane = ensureLane(key, file, name, leaf);
        writeLaneInstance(ctx, file, "idle");
        refreshAfterCommand(ctx);
        notifyLane(ctx, `pi-sync lane: created and joined ${displayLane(key, lane)}`);
        return;
      }

      if (command === "join") {
        const resolvedName = resolveLaneName(key, rawName || DEFAULT_LANE);
        const name = resolvedName ? sanitizeLaneName(resolvedName) : sanitizeLaneName(rawName || DEFAULT_LANE);
        const existingLane = resolvedName ? readLane(key, name) : undefined;
        if (!existingLane) {
          notifyLane(ctx, `pi-sync lane: no lane ${rawName || name}; use /lane list or /lane new ${name}`);
          return;
        }
        sessionManager(ctx)?.setSessionFile?.(file);
        moduleCurrentLane = name;
        if (existingLane.headEntryId) sessionManager(ctx)?.branch?.(existingLane.headEntryId);
        else sessionManager(ctx)?.resetLeaf?.();
        writeLaneInstance(ctx, file, "idle");
        refreshAfterCommand(ctx);
        notifyLane(ctx, `pi-sync lane: joined ${displayLane(key, existingLane)}`);
        return;
      }

      if (command === "list") {
        const names = readLaneStates(key)
          .sort((a, b) => liveLaneId(key, a.name).localeCompare(liveLaneId(key, b.name), undefined, { numeric: true }))
          .map((item) => `${liveLaneId(key, item.name)}(${item.name})`);
        const instances = liveLaneInstances(key)
          .map((item) => {
            const lane = readLane(key, item.lane);
            return `${lane ? liveLaneId(key, lane.name) : item.lane}:${item.status}:${item.pid}`;
          })
          .join(", ");
        const current = ensureLane(key, file, currentLane(), sessionManager(ctx)?.getLeafId?.() ?? null);
        notifyLane(ctx, `pi-sync lane: lanes ${names.join(", ") || "1(main)"}; current ${liveLaneId(key, current.name)}; instances ${instances || "none"}`);
        return;
      }

      if (command === "instances") {
        const instances = liveLaneInstances(key)
          .map((item) => `${item.instanceId.slice(0, 8)} ${item.lane} ${item.status} pid=${item.pid} seen=${item.lastSeenAt}`)
          .join("; ");
        notifyLane(ctx, `pi-sync lane: instances ${instances || "none"}`);
        return;
      }

      if (command === "identity" || command === "self") {
        exportLaneIdentity(ctx, file);
        notifyLane(ctx, `pi-sync lane: identity sessionId=${currentSessionId ?? "<none>"} sessionKey=${currentSessionKey} sessionFile=${currentSessionFile} instanceId=${instanceId} currentLane=${currentLane()} laneId=${process.env.PI_LANE_CURRENT_LANE_ID ?? "<none>"} laneFile=${process.env.PI_LANE_CURRENT_LANE_FILE ?? "<none>"} root=${laneRoot()} pid=${process.pid}`);
        return;
      }

      if (command === "debug") {
        notifyLane(ctx, `pi-sync lane: debug log ${debugLogPath(key)}`);
        return;
      }

      if (command !== "status") {
        notifyLane(ctx, `pi-sync lane: unknown command ${command}; try status, new, join, list, instances, identity, or debug`);
        return;
      }

      const lane = ensureLane(key, file, currentLane(), sessionManager(ctx)?.getLeafId?.() ?? null);
      const instances = liveLaneInstances(key, currentLane());
      const host = readHostInfo(key, currentLane());
      const freshHost = isHostFresh(host) ? host : undefined;
      const hostSummary = freshHost
        ? `host pid=${freshHost.pid} clients=${freshHost.clients ?? 0} active=${freshHost.activePromptId ?? "<none>"} pending=${freshHost.pendingPrompts ?? 0}`
        : "host=<none>";
      notifyLane(ctx, `pi-sync lane: current ${displayLane(key, lane)}; file ${lane.aliasPath ?? "<none>"}; head ${lane.headEntryId ?? "<empty>"}; connected ${instances.length}; ${hostSummary}`);
    },
  });

  pi.registerCommand("sync", {
    description: "Pi same-session live sync status. Usage: /sync [status|release|tail]",
    handler: async (args: string, ctx: ExtensionContext) => {
      ensureActivePaths(ctx);
      if (!activeSessionFile || !activeSessionKey || !activeEventPath) {
        ctx.ui.notify("pi-sync: no persisted session file", "warning");
        return;
      }
      const subcommand = args.trim().split(/\s+/)[0] || "status";
      if (subcommand === "release") {
        releaseTurn();
        ctx.ui.notify("pi-sync: released local turn lease", "info");
        return;
      }
      if (subcommand === "tail") {
        const lines = existsSync(activeEventPath)
          ? readFileSync(activeEventPath, "utf8").trim().split(/\r?\n/).filter(Boolean).slice(-8)
          : [];
        ctx.ui.notify(`pi-sync tail:\n${lines.join("\n") || "<empty>"}`, "info");
        return;
      }
      const owner = readTurnOwner(activeSessionKey, activeLane ?? currentLane());
      const freshOwner = isOwnerFresh(owner) ? owner : undefined;
      const host = readHostInfo(activeSessionKey, activeLane ?? currentLane());
      const freshHost = isHostFresh(host) ? host : undefined;
      const hasNativeReplay = typeof (ctx.ui as any).replayAgentEvent === "function";
      ctx.ui.notify(
        `pi-sync: instance=${instanceId} sessionId=${sessionId(ctx) ?? "<none>"} sessionKey=${activeSessionKey} sync=${activeLane ?? currentLane()} nativeReplay=${hasNativeReplay ? "yes" : "no"} localOwnsTurn=${localOwnsTurn ? "yes" : "no"} activeOwner=${freshOwner?.instanceId ?? "<none>"} host=${freshHost ? `${freshHost.pid}/${freshHost.instanceId.slice(0, 8)}` : "<none>"} readOffset=${readOffset} events=${activeEventPath}`,
        "info",
      );
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    nativeReplay(ctx);
    disableLocalSessionPersistence(ctx);
    if (EXACT_MODE) ctx.ui.setWorkingVisible(false);
    initializeLaneSession(ctx);
    startTerminalInputSync(ctx);
    startPolling(ctx);
    ensureHost(ctx);
    connectHost(ctx);
    publish(ctx, "attach", { sessionId: activeSessionId, sessionFile: activeSessionFile, sessionKey: activeSessionKey });
  });

  pi.on("session_tree", async (event, ctx) => {
    if (!ctx.hasUI) return;
    nativeReplay(ctx);
    selectedTreeCursorEntryId = (event as any).newLeafId ?? sessionManager(ctx)?.getLeafId?.() ?? null;
    const file = sessionFile(ctx);
    if (file) switchLaneForTreeSelection(ctx, file, selectedTreeCursorEntryId ?? null, (event as any).oldLeafId ?? null);
    ensureActivePaths(ctx);
    startPolling(ctx);
    ensureHost(ctx);
    connectHost(ctx);
    publish(ctx, "attach", { sessionId: activeSessionId, sessionFile: activeSessionFile, sessionKey: activeSessionKey, lane: activeLane });
  });

  pi.on("input", async (event, ctx) => {
    if (!ctx.hasUI || event.source !== "interactive") return undefined;
    nativeReplay(ctx);
    const selectedHeadEntryId = selectedTreeCursorEntryId;
    const currentSessionFile = sessionFile(ctx);
    const persistedHeadEntryId = persistedLeafId(currentSessionFile);
    refreshSessionFile(ctx);
    if (selectedHeadEntryId !== undefined && selectedHeadEntryId !== persistedHeadEntryId) {
      if (selectedHeadEntryId === null) {
        sessionManager(ctx)?.resetLeaf?.();
      } else if (persistedEntryExists(sessionFile(ctx) ?? currentSessionFile, selectedHeadEntryId)) {
        sessionManager(ctx)?.branch?.(selectedHeadEntryId);
      }
    }
    if (!event.text.trimStart().startsWith("/")) {
      if (!ensureActivePaths(ctx)) return undefined;
      if (activeSessionFile) writeLaneInstance(ctx, activeSessionFile, "active");
      ensureHost(ctx);
      connectHost(ctx);
      renderOptimisticUserMessage(ctx, event.text, "own");
      publish(ctx, "prompt_echo", { text: event.text });
      sendHostPrompt(ctx, event.text);
      return { action: "handled" };
    }
    await waitForRemoteFlushBeforeLocalCommand(ctx);
    refreshAfterCommand(ctx);
    return undefined;
  });

  pi.on("message_start", async (event, ctx) => { if (!isReplayingRemoteAgentEvent()) publish(ctx, "message_start", event); });
  pi.on("message_update", async (event, ctx) => { if (!isReplayingRemoteAgentEvent()) publish(ctx, "message_update", event); });
  pi.on("message_end", async (event, ctx) => {
    if (isReplayingRemoteAgentEvent()) return;
    publish(ctx, "message_end", event);
    refreshSessionFile(ctx);
  });
  pi.on("tool_call", async (event, ctx) => { if (!isReplayingRemoteAgentEvent()) publish(ctx, "tool_call", event); });
  pi.on("tool_result", async (event, ctx) => { if (!isReplayingRemoteAgentEvent()) publish(ctx, "tool_result", event); });
  pi.on("tool_execution_start", async (event, ctx) => { if (!isReplayingRemoteAgentEvent()) publish(ctx, "tool_execution_start", event); });
  pi.on("tool_execution_update", async (event, ctx) => { if (!isReplayingRemoteAgentEvent()) publish(ctx, "tool_execution_update", event); });
  pi.on("tool_execution_end", async (event, ctx) => { if (!isReplayingRemoteAgentEvent()) publish(ctx, "tool_execution_end", event); });
  pi.on("agent_start", async (event, ctx) => {
    if (isReplayingRemoteAgentEvent()) return;
    acquireTurn(ctx, "agent_start");
    publish(ctx, "agent_start", event);
  });
  function drainQueuedInputs(): void {
    if (pendingQueuedInputs.length === 0) return;
    const queued = pendingQueuedInputs.splice(0);
    const text = queued.map((item) => item.text).filter(Boolean).join("\n\n");
    const images = queued.flatMap((item) => item.images ?? []);
    if (!text.trim()) return;
    const content = images.length > 0 ? ([{ type: "text", text }, ...images] as any) : text;
    try {
      pi.sendUserMessage(content);
    } catch {
      // Pi may still be unwinding agent_end listeners. Put the input back and
      // let the idle-drain scheduler try again; do not render local error chrome.
      pendingQueuedInputs.unshift(...queued);
      throw new Error("not-idle");
    }
  }

  function scheduleQueuedInputDrain(ctx: ExtensionContext): void {
    if (queuedDrainTimer) return;
    queuedDrainTimer = setTimeout(() => {
      queuedDrainTimer = undefined;
      if (pendingQueuedInputs.length === 0) return;
      if (!ctx.isIdle()) {
        scheduleQueuedInputDrain(ctx);
        return;
      }
      try {
        drainQueuedInputs();
      } catch {
        scheduleQueuedInputDrain(ctx);
      }
    }, 50);
    queuedDrainTimer.unref?.();
  }

  pi.on("agent_end", async (event, ctx) => {
    if (isReplayingRemoteAgentEvent()) return;
    publish(ctx, "agent_end", event);
    refreshSessionFile(ctx);
    releaseTurn();
    const file = activeSessionFile ?? sessionFile(ctx);
    if (file) writeLaneInstance(ctx, file, "idle");
    scheduleQueuedInputDrain(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stopRemoteWorking();
    shuttingDown = true;
    publish(ctx, "detach", { sessionId: activeSessionId, sessionFile: activeSessionFile, sessionKey: activeSessionKey });
    if (laneHeartbeatTimer) clearInterval(laneHeartbeatTimer);
    laneHeartbeatTimer = undefined;
    if (currentSessionKey) {
      writeJsonFile(instancePath(currentSessionKey, instanceId), {
        instanceId,
        pid: process.pid,
        lane: currentLane(),
        sessionId: currentSessionId ?? null,
        sessionKey: currentSessionKey,
        sessionFile: currentSessionFile,
        leafId: null,
        startedAt,
        status: "disconnected",
        lastSeenAt: nowIso(),
      });
    }
    clearLaneIdentity();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = undefined;
    if (hostReconnectTimer) clearTimeout(hostReconnectTimer);
    hostReconnectTimer = undefined;
    if (queuedDrainTimer) clearTimeout(queuedDrainTimer);
    queuedDrainTimer = undefined;
    terminalInputUnsubscribe?.();
    terminalInputUnsubscribe = undefined;
    try { hostSocket?.end(); } catch {}
    hostSocket = undefined;
    releaseTurn();
  });
}
