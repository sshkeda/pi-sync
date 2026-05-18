import { spawn } from "node:child_process";
import { connect, type Socket } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

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

function nowIso(): string {
  return new Date().toISOString();
}

function stableSessionKey(sessionFile: string): string {
  return createHash("sha256").update(sessionFile).digest("hex").slice(0, 24);
}

function laneRoot(): string {
  return process.env.PI_LANE_ROOT ?? join(homedir(), ".pi", "lane");
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

function currentLane(): string {
  return process.env.PI_LANE_CURRENT_LANE || "main";
}

function laneSegment(lane: string = currentLane()): string {
  return lane.replace(/[^a-zA-Z0-9_.=-]+/g, "_").slice(0, 96) || "main";
}

function laneStateSegment(lane: string = currentLane()): string {
  return lane.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-").slice(0, 64) || "main";
}

function laneStatePath(sessionKey: string, lane: string = currentLane()): string {
  return join(laneRoot(), "sessions", sessionKey, "lanes", `${laneStateSegment(lane)}.json`);
}

function syncDir(sessionKey: string, lane: string = currentLane()): string {
  return join(laneRoot(), "sessions", sessionKey, "lanes", laneSegment(lane), "sync");
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
  const key = createHash("sha256").update(`${syncDir(sessionKey, lane)}:${process.env.USER ?? "user"}`).digest("hex").slice(0, 24);
  return join(process.env.TMPDIR ?? "/tmp", `pi-sync-${key}.sock`);
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
  const t = Date.parse(info.heartbeatAt);
  return Number.isFinite(t) && Date.now() - t <= Number(process.env.PI_SYNC_HOST_LEASE_MS ?? 5_000);
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
  let observedHostActiveWork = false;
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
  const optimisticOwnUserTextCounts = new Map<string, number>();
  const mirroredPromptTextCounts = new Map<string, number>();
  const hostRenderedPromptTextCounts = new Map<string, number>();
  let replayingRemoteAgentEvents = 0;
  let replayHistoryPersistedMessageTextCounts: Map<string, number> | undefined;
  let replayHistoryPersistedMessageKeys: Set<string> | undefined;
  let pendingHostAbort = false;
  let selectedTreeCursorEntryId: string | null | undefined;

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

  function ensureHost(ctx: ExtensionContext): void {
    if (!ensureActivePaths(ctx) || !activeSessionKey || !activeSessionFile) return;
    const lane = activeLane ?? currentLane();
    const existing = readHostInfo(activeSessionKey, lane);
    if (isHostFresh(existing) && existsSync(hostSocketPath(activeSessionKey, lane))) return;
    if (isFreshPath(hostLockDirPath(activeSessionKey, lane), Number(process.env.PI_SYNC_HOST_LEASE_MS ?? 5_000))) return;
    if (lastHostSpawnSessionKey === activeSessionKey && lastHostSpawnLane === lane && Date.now() - lastHostSpawnAt <= Number(process.env.PI_SYNC_HOST_LEASE_MS ?? 5_000)) return;
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
      env: { ...process.env, PI_LANE_ROOT: laneRoot(), PI_LANE_CURRENT_LANE: lane, PI_SYNC_HOST_PROCESS: "1", PI_SYNC_HOST_EXTENSIONS: cliExtensionArgsForHost() },
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

  function replayHostEvent(event: any, ctx: ExtensionContext): void {
    if (!event) return;
    if (typeof event.id === "string" && !rememberHostEvent(event.id)) return;
    if (event.type === "prompt_queued" || event.type === "prompt_start" || event.type === "abort_requested") {
      observedHostActiveWork = true;
    } else if (event.type === "prompt_end" || event.type === "prompt_error") {
      observedHostActiveWork = false;
    }
    if (event.type === "session_flushed" || event.type === "lane_head_updated" || event.type === "prompt_end" || event.type === "prompt_error") {
      refreshSessionFile(ctx);
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
      return;
    }
    if (event.type !== "agent_event") return;
    const replayEvent = event.payload?.agentEvent;
    if (replayEvent?.type === "turn_start" || replayEvent?.type === "turn_end") return;
    if (replayEvent?.type === "queue_update") return;
    if (replayEvent?.type === "agent_start") observedHostActiveWork = true;
    if (replayEvent?.type === "agent_end") observedHostActiveWork = false;
    if (isPersistedReplayMessageEvent(replayEvent)) return;
    if (isPersistedReplayAgentEnd(replayEvent)) return;
    if (isAlreadyEchoedUserPrompt(event, replayEvent)) return;
    if (replayEvent?.type === "agent_start" && EXACT_MODE) ctx.ui.setWorkingVisible(false);
    if (replayEvent) {
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
    replayHostEvent(message.event, ctx);
  }


  function connectHost(ctx: ExtensionContext): void {
    if (shuttingDown) return;
    if (!ensureActivePaths(ctx) || !activeSessionKey) return;
    if (hostSocket && !hostSocket.destroyed) return;
    ensureHost(ctx);
    const socketPath = hostSocketPath(activeSessionKey, activeLane ?? currentLane());
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
      while (pendingHostPrompts.length > 0 && !socket.destroyed) {
        const prompt = pendingHostPrompts.shift();
        if (prompt) socket.write(JSON.stringify({ type: "prompt", ...prompt, source: "pi-sync", clientId: instanceId }) + "\n");
      }
      if (pendingHostAbort && !socket.destroyed) {
        pendingHostAbort = false;
        socket.write(JSON.stringify({ type: "abort", source: "pi-sync", clientId: instanceId }) + "\n");
        publish(ctx, "abort_requested", { source: "escape" });
      }
    });
    socket.on("data", (chunk) => {
      hostSocketBuffer += chunk;
      let idx;
      while ((idx = hostSocketBuffer.indexOf("\n")) >= 0) {
        const line = hostSocketBuffer.slice(0, idx).trim();
        hostSocketBuffer = hostSocketBuffer.slice(idx + 1);
        if (!line) continue;
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
    observedHostActiveWork = true;
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
    if (observedHostActiveWork || pendingHostPrompts.length > 0) return true;
    if (!activeSessionKey) return false;
    const host = readHostInfo(activeSessionKey, activeLane ?? currentLane());
    return !!(isHostFresh(host) && (host.activePromptId || (host.pendingPrompts ?? 0) > 0));
  }

  function sendHostAbort(ctx: ExtensionContext): boolean {
    connectHost(ctx);
    if (!hostSocket || hostSocket.destroyed) {
      pendingHostAbort = true;
      scheduleHostReconnect(ctx);
      return true;
    }
    pendingHostAbort = false;
    hostSocket.write(JSON.stringify({ type: "abort", source: "pi-sync", clientId: instanceId }) + "\n");
    publish(ctx, "abort_requested", { source: "escape" });
    return true;
  }

  function startTerminalInputSync(ctx: ExtensionContext): void {
    terminalInputUnsubscribe?.();
    terminalInputUnsubscribe = ctx.ui.onTerminalInput((data) => {
      if (data !== "\x1b") return undefined;
      ensureActivePaths(ctx);
      connectHost(ctx);
      if (!hostHasActiveWork()) return undefined;
      sendHostAbort(ctx);
      return { consume: true };
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
    const nextKey = stableSessionKey(file);
    const nextLane = currentLane();
    const changed = activeSessionKey !== undefined && (activeSessionKey !== nextKey || activeLane !== nextLane);
    if (changed) {
      releaseTurnFor(ownedTurnSessionKey, ownedTurnLane);
      readOffset = 0;
      clearSeenEvents();
      pendingHostPrompts.length = 0;
      observedHostActiveWork = false;
      try { hostSocket?.end(); } catch {}
      hostSocket = undefined;
    }
    activeSessionFile = file;
    activeSessionId = sessionId(ctx);
    activeSessionKey = nextKey;
    activeLane = nextLane;
    activeEventPath = eventLogPath(activeSessionKey, activeLane);
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
      if (!EXACT_MODE) ctx.ui.notify(`pi-sync: queued input from attached terminal`, "info");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`pi-sync: failed to queue remote input: ${message}`, "warning");
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
      ctx.ui.notify(`pi-sync: remote replay failed: ${message}`, "warning");
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
        `pi-sync: instance=${instanceId} sessionId=${sessionId(ctx) ?? "<none>"} sessionKey=${activeSessionKey} lane=${activeLane ?? currentLane()} nativeReplay=${hasNativeReplay ? "yes" : "no"} localOwnsTurn=${localOwnsTurn ? "yes" : "no"} activeOwner=${freshOwner?.instanceId ?? "<none>"} host=${freshHost ? `${freshHost.pid}/${freshHost.instanceId.slice(0, 8)}` : "<none>"} readOffset=${readOffset} events=${activeEventPath}`,
        "info",
      );
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    nativeReplay(ctx);
    if (EXACT_MODE) ctx.ui.setWorkingVisible(false);
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
      ensureHost(ctx);
      connectHost(ctx);
      renderOptimisticUserMessage(ctx, event.text, "own");
      publish(ctx, "prompt_echo", { text: event.text });
      if (!sendHostPrompt(ctx, event.text)) {
        ctx.ui.notify("pi-sync: host not ready; prompt not sent", "warning");
      }
      return { action: "handled" };
    }
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
    scheduleQueuedInputDrain(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    shuttingDown = true;
    publish(ctx, "detach", { sessionId: activeSessionId, sessionFile: activeSessionFile, sessionKey: activeSessionKey });
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
