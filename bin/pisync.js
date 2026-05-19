#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SCHEMA_VERSION = 3;
const DEFAULT_SYNC = "main";
const DEFAULT_STALE_MS = 15_000;
const DEFAULT_HOST_LEASE_MS = 5_000;

function stableSessionKey(sessionFile, _sessionId) {
  return createHash("sha256").update(sessionFile).digest("hex").slice(0, 24);
}

function syncRoot() {
  return process.env.PI_SYNC_ROOT || process.env.PI_LANE_ROOT || join(homedir(), ".pi", "lane");
}

function sanitizeSyncName(value) {
  const name = String(value ?? "").trim() || DEFAULT_SYNC;
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-").slice(0, 64);
  return safe || DEFAULT_SYNC;
}

function syncSegment(value) {
  return String(value ?? DEFAULT_SYNC).replace(/[^a-zA-Z0-9_.=-]+/g, "_").slice(0, 96) || DEFAULT_SYNC;
}

function hostSocketPathForSyncDir(dir) {
  const key = createHash("sha256").update(`${dir}:${process.env.USER ?? "user"}`).digest("hex").slice(0, 24);
  return join(process.env.TMPDIR || "/tmp", `pi-sync-${key}.sock`);
}

function identity() {
  const sessionId = process.env.PI_SYNC_SESSION_ID || process.env.PI_LANE_SESSION_ID || "";
  const sessionFile = process.env.PI_SYNC_SESSION_FILE || process.env.PI_LANE_SESSION_FILE || "";
  const sessionKey = process.env.PI_SYNC_SESSION_KEY || process.env.PI_LANE_SESSION_KEY || (sessionFile ? stableSessionKey(sessionFile, sessionId) : "");
  const sync = process.env.PI_SYNC_CHANNEL || process.env.PI_LANE_CURRENT_LANE || DEFAULT_SYNC;
  const syncId = process.env.PI_SYNC_CHANNEL_ID || process.env.PI_LANE_CURRENT_LANE_ID || "";
  const syncFile = process.env.PI_SYNC_CHANNEL_FILE || process.env.PI_LANE_CURRENT_LANE_FILE || "";
  return {
    sessionId,
    sessionKey,
    sessionFile,
    instanceId: process.env.PI_SYNC_INSTANCE_ID || process.env.PI_LANE_INSTANCE_ID || "",
    sync,
    syncId,
    syncFile,
    root: syncRoot(),
    // Compatibility fields for older tools.
    lane: sync,
    laneId: syncId,
    laneFile: syncFile,
  };
}

function sessionDir(id) {
  return join(id.root, "sessions", id.sessionKey);
}

function instancesDir(id) {
  return join(sessionDir(id), "instances");
}

function syncsDir(id) {
  return join(sessionDir(id), "lanes");
}

function syncStateFile(id, syncName = id.sync) {
  return join(syncsDir(id), `${sanitizeSyncName(syncName)}.json`);
}

function syncDir(id, syncName = id.sync) {
  return join(syncsDir(id), syncSegment(syncName), "sync");
}

function paths(id) {
  const dir = id.sessionKey ? syncDir(id) : "";
  return {
    root: id.root,
    sessionDir: id.sessionKey ? sessionDir(id) : "",
    instancesDir: id.sessionKey ? instancesDir(id) : "",
    syncsDir: id.sessionKey ? syncsDir(id) : "",
    currentSyncFile: id.syncFile || (id.sessionKey ? syncStateFile(id) : ""),
    syncDir: dir,
    hostJson: dir ? join(dir, "host.json") : "",
    hostLock: dir ? join(dir, "host.lock") : "",
    hostLockOwner: dir ? join(dir, "host.lock", "owner.json") : "",
    hostSocket: dir ? hostSocketPathForSyncDir(dir) : "",
    promptQueue: dir ? join(dir, "prompt-queue.jsonl") : "",
    hostEvents: dir ? join(dir, "host-events.jsonl") : "",
  };
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json" || arg === "-j") out.json = true;
    else if (arg === "--context") out.context = true;
    else if (arg === "--stale-ms") out.staleMs = Number(argv[++i]);
    else out._.push(arg);
  }
  return out;
}

function instanceLiveness(state, staleMs) {
  const lastSeenAt = state?.lastSeenAt || state?.updatedAt || "";
  const ageMs = lastSeenAt ? Date.now() - Date.parse(lastSeenAt) : undefined;
  const live = Boolean(state && state.status !== "disconnected" && ageMs !== undefined && Number.isFinite(ageMs) && ageMs <= staleMs);
  return {
    live,
    stale: !live,
    lastSeenAt,
    lastSeenAgeMs: ageMs,
    status: state?.status || "unknown",
  };
}

function staleMs(opts) {
  return opts.staleMs || Number(process.env.PI_SYNC_INSTANCE_STALE_MS || process.env.PI_LANE_INSTANCE_STALE_MS || process.env.PBB_INSTANCE_STALE_MS || DEFAULT_STALE_MS);
}

function listInstances(id, opts) {
  const dir = instancesDir(id);
  if (!id.sessionKey || !existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((item) => item.endsWith(".json"))
    .map((item) => readJson(join(dir, item)))
    .filter(Boolean)
    .map((state) => ({ ...state, ...instanceLiveness(state, staleMs(opts)) }))
    .sort((a, b) => String(a.instanceId).localeCompare(String(b.instanceId)));
}

function listSyncs(id) {
  const dir = syncsDir(id);
  if (!id.sessionKey || !existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((item) => item.endsWith(".json"))
    .map((item) => readJson(join(dir, item)))
    .filter(Boolean)
    .sort((a, b) => String(a.displayId || a.name).localeCompare(String(b.displayId || b.name)));
}

function currentSync(syncs, id) {
  return syncs.find((sync) => sync.name === id.sync) || readJson(id.syncFile || syncStateFile(id));
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

function ageMs(iso) {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) ? Date.now() - t : undefined;
}

function hostLiveness(host) {
  const heartbeatAgeMs = ageMs(host?.heartbeatAt);
  const processLive = processAlive(host?.pid);
  const live = Boolean(host?.state === "running" && processLive && heartbeatAgeMs !== undefined && heartbeatAgeMs <= Number(process.env.PI_SYNC_HOST_LEASE_MS || DEFAULT_HOST_LEASE_MS));
  return { live, processLive, heartbeatAgeMs, state: host?.state || "missing" };
}

function fileFresh(path, maxAgeMs) {
  try {
    return Date.now() - statSync(path).mtimeMs <= maxAgeMs;
  } catch {
    return false;
  }
}

function sessionEntryIds(sessionFile) {
  const ids = new Set();
  try {
    for (const line of readFileSync(sessionFile, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (typeof entry?.id === "string") ids.add(entry.id);
      } catch {}
    }
  } catch {}
  return ids;
}

function collectStatus(id, opts) {
  const instances = listInstances(id, opts);
  const syncs = listSyncs(id);
  const current = currentSync(syncs, id);
  const p = paths(id);
  const host = readJson(p.hostJson);
  const hostLockOwner = readJson(p.hostLockOwner);
  const liveInstances = instances.filter((item) => item.live);
  const staleInstances = instances.filter((item) => !item.live);
  return {
    kind: "pisync.status",
    schemaVersion: SCHEMA_VERSION,
    identity: id,
    paths: p,
    currentSync: current,
    currentLane: current,
    syncs,
    lanes: syncs,
    instances,
    host: host ? { ...host, ...hostLiveness(host) } : undefined,
    hostLockOwner: hostLockOwner ? { ...hostLockOwner, ...hostLiveness(hostLockOwner) } : undefined,
    summary: {
      syncCount: syncs.length,
      laneCount: syncs.length,
      instanceCount: instances.length,
      liveInstanceCount: liveInstances.length,
      staleInstanceCount: staleInstances.length,
    },
  };
}

function doctor(id, opts) {
  const status = collectStatus(id, opts);
  const problems = [];
  const warnings = [];
  const p = status.paths;
  const hostLive = Boolean(status.host?.live);
  const liveWorkers = status.instances.filter((item) => item.live && ["active", "waiting"].includes(item.status));
  if (!id.sessionKey) problems.push("PI_SYNC_SESSION_KEY is missing and no session file was available to derive it.");
  if (!id.sessionFile) warnings.push("PI_SYNC_SESSION_FILE is missing.");
  if (!id.instanceId) warnings.push("PI_SYNC_INSTANCE_ID is missing.");
  if (id.sessionKey && !existsSync(p.sessionDir)) problems.push(`session directory is missing: ${p.sessionDir}`);
  if (id.sessionKey && !existsSync(p.instancesDir)) warnings.push(`instances directory is missing: ${p.instancesDir}`);
  if (id.sessionKey && !existsSync(p.syncsDir)) warnings.push(`sync state directory is missing: ${p.syncsDir}`);
  if (id.instanceId && !status.instances.some((item) => item.instanceId === id.instanceId)) warnings.push(`current instance file was not found for ${id.instanceId}.`);
  if (id.sessionKey && !status.currentSync) warnings.push(`current sync state was not found for ${id.sync}.`);
  if (status.currentSync?.headEntryId) {
    const ids = sessionEntryIds(id.sessionFile);
    if (!id.sessionFile || ids.size === 0) problems.push(`sync head ${status.currentSync.headEntryId} cannot be checked because the session file is missing or empty.`);
    else if (!ids.has(status.currentSync.headEntryId)) problems.push(`sync head ${status.currentSync.headEntryId} does not exist in ${id.sessionFile}.`);
  }
  if (liveWorkers.length > 0 && !hostLive) problems.push(`live ${liveWorkers.map((item) => item.status).join("/")} instance exists but no fresh pi-sync host is running.`);
  if (hostLive && p.hostSocket && !existsSync(p.hostSocket)) problems.push(`fresh host is running but its socket is missing: ${p.hostSocket}`);
  if (!hostLive && p.hostSocket && existsSync(p.hostSocket)) warnings.push(`host socket exists without a fresh host: ${p.hostSocket}`);
  if (p.hostLock && existsSync(p.hostLock) && ((status.hostLockOwner && !status.hostLockOwner.live) || (!status.hostLockOwner && !fileFresh(p.hostLock, Number(process.env.PI_SYNC_HOST_LEASE_MS || DEFAULT_HOST_LEASE_MS))))) {
    warnings.push(`stale host lock exists: ${p.hostLock}`);
  }
  if (hostLive && status.summary.liveInstanceCount === 0 && !status.host.activePromptId && !status.host.pendingPrompts) warnings.push("host is running with no live attached instances or active work.");
  return { ...status, kind: "pisync.doctor", ok: problems.length === 0, problems, warnings };
}

function attr(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r/g, "&#13;")
    .replace(/\n/g, "&#10;");
}

function escapeBody(value) {
  return String(value ?? "").replace(/<\/pi_context>/gi, "<\\/pi_context>");
}

function context(kind, attrs, body) {
  const renderedAttrs = Object.entries({ source: "pisync", kind, schema_version: SCHEMA_VERSION, ...attrs })
    .filter(([, value]) => value !== undefined && value !== null && value !== false)
    .map(([key, value]) => `${key}="${attr(value)}"`)
    .join(" ");
  return `<pi_context ${renderedAttrs}>\n${escapeBody(body)}\n</pi_context>`;
}

function renderContext(value) {
  const id = value.identity || value;
  return context(value.kind, { session_id: id.sessionId, session_key: id.sessionKey, instance_id: id.instanceId, sync: id.sync }, JSON.stringify(value, null, 2));
}

function line(label, value) {
  return `${label.padEnd(10)} ${value}`;
}

function syncDisplay(sync, id) {
  if (!sync) return `${id.syncId || id.sync || DEFAULT_SYNC} (missing state)`;
  const name = sync.name || id.sync || DEFAULT_SYNC;
  const displayId = sync.displayId || id.syncId || name;
  const head = sync.headEntryId || "<empty>";
  const epoch = sync.headEpoch ?? 0;
  return `${displayId} ${name} head=${head} epoch=${epoch}`;
}

function renderStatus(value) {
  const id = value.identity;
  const live = value.summary.liveInstanceCount;
  const stale = value.summary.staleInstanceCount;
  const host = value.host?.live ? "live" : "not live";
  return [
    line("session", id.sessionId || "<none>"),
    line("file", id.sessionFile || "<none>"),
    line("sync", syncDisplay(value.currentSync, id)),
    line("self", id.instanceId || "<none>"),
    line("attached", `${live} live, ${stale} stale`),
    line("host", host),
    line("root", value.paths.sessionDir || value.paths.root),
  ].join("\n");
}

function renderIdentity(id) {
  return [
    line("session", id.sessionId || "<none>"),
    line("key", id.sessionKey || "<none>"),
    line("file", id.sessionFile || "<none>"),
    line("instance", id.instanceId || "<none>"),
    line("sync", `${id.syncId || id.sync || DEFAULT_SYNC} ${id.sync || DEFAULT_SYNC}`),
    line("root", id.root),
  ].join("\n");
}

function renderInstances(value) {
  if (value.instances.length === 0) return "No instances.";
  return value.instances
    .map((item) => {
      const marker = item.instanceId === value.identity.instanceId ? "*" : " ";
      const state = item.live ? "live" : "stale";
      return `${marker} ${String(item.instanceId || "<unknown>").padEnd(12)} ${state.padEnd(5)} ${String(item.status || "unknown").padEnd(12)} sync=${item.lane || ""} last=${item.lastSeenAt || "unknown"}`;
    })
    .join("\n");
}

function renderSyncs(value) {
  if (value.syncs.length === 0) return "No syncs.";
  return value.syncs
    .map((sync) => {
      const marker = sync.name === value.identity.sync ? "*" : " ";
      return `${marker} ${syncDisplay(sync, value.identity)}`;
    })
    .join("\n");
}

function renderPaths(value) {
  return Object.entries(value.paths)
    .map(([key, value]) => line(key, value || "<none>"))
    .join("\n");
}

function renderDoctor(value) {
  const lines = [value.ok ? "ok" : "broken"];
  if (value.problems.length > 0) lines.push("", "problems:", ...value.problems.map((item) => `- ${item}`));
  if (value.warnings.length > 0) lines.push("", "warnings:", ...value.warnings.map((item) => `- ${item}`));
  if (value.problems.length === 0 && value.warnings.length === 0) lines.push("No pi-sync runtime issues found.");
  return lines.join("\n");
}

function emit(value, opts, renderer) {
  if (opts.json) console.log(JSON.stringify(value, null, 2));
  else if (opts.context) console.log(renderContext(value));
  else console.log(renderer(value));
}

function usage() {
  console.log(`pisync - inspect pi-sync runtime

Usage:
  pisync                 Show current session/sync status
  pisync id              Show current identity
  pisync ps              Show attached Pi instances
  pisync syncs           Show sync heads
  pisync paths           Show runtime paths
  pisync doctor          Check for broken sync state

Options:
  --json, -j             Print JSON
  --context              Print pi_context XML for agents
  --stale-ms <ms>        Override instance liveness window

Compatibility aliases:
  pi-sync                same CLI when installed from package bin
  pil                    deprecated alias
  pisync lanes           same as pisync syncs
  pisync instances       same as pisync ps
  pisync status          same as pisync`);
}

const opts = parseArgs(process.argv.slice(2));
const command = opts._[0] || "status";
const id = identity();

if (["help", "--help", "-h"].includes(command)) {
  usage();
  process.exit(0);
}

if (command === "id" || command === "self" || command === "whoami") {
  emit({ kind: "pisync.identity", schemaVersion: SCHEMA_VERSION, ...id }, opts, renderIdentity);
} else if (command === "ps" || command === "instances") {
  const value = collectStatus(id, opts);
  value.kind = "pisync.instances";
  emit(value, opts, renderInstances);
} else if (command === "syncs" || command === "lanes" || command === "ls") {
  const value = collectStatus(id, opts);
  value.kind = "pisync.syncs";
  emit(value, opts, renderSyncs);
} else if (command === "paths" || command === "path") {
  const value = collectStatus(id, opts);
  value.kind = "pisync.paths";
  emit(value, opts, renderPaths);
} else if (command === "doctor") {
  const value = doctor(id, opts);
  emit(value, opts, renderDoctor);
  if (!value.ok) process.exit(1);
} else if (command === "status") {
  emit(collectStatus(id, opts), opts, renderStatus);
} else {
  console.error(`Unknown pisync command: ${command}`);
  console.error("Run `pisync help` for usage.");
  process.exit(2);
}
