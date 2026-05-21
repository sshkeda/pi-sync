import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type LaneState = {
  schemaVersion: 1;
  name: string;
  sessionKey: string;
  baseLeafId: string | null;
  headEntryId: string | null;
  headEpoch: number;
  createdAt: string;
  updatedAt: string;
  id?: string;
  displayId?: string;
  aliasPath?: string;
  updatedBy?: string;
};

export type LaneAliasState = {
  schemaVersion: 1;
  id: string;
  displayId: string;
  laneName: string;
  name: string;
  sessionKey: string;
  sessionFile: string;
  canonicalPath: string;
  createdAt: string;
  updatedAt: string;
};

export type InstanceState = {
  instanceId: string;
  pid: number;
  lane: string;
  status: "idle" | "waiting" | "active" | "disconnected";
  sessionId: string | null;
  sessionKey: string;
  sessionFile: string;
  leafId: string | null;
  startedAt: string;
  lastSeenAt: string;
};

export const DEFAULT_LANE = "main";
const CANONICAL_LANE_ID_RE = /^ln_[A-Za-z0-9_-]{6,}$/;

export function nowIso(): string {
  return new Date().toISOString();
}

export function isCanonicalLaneId(value: string | undefined): boolean {
  return typeof value === "string" && CANONICAL_LANE_ID_RE.test(value);
}

export function newLaneId(): string {
  return `ln_${randomBytes(6).toString("base64url")}`;
}

export function laneRoot(): string {
  return process.env.PI_SYNC_ROOT ?? process.env.PI_LANE_ROOT ?? join(homedir(), ".pi", "lane");
}

export function sanitizeLaneName(value: string | undefined): string {
  const name = (value ?? "").trim() || DEFAULT_LANE;
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-").slice(0, 64);
  return safe || DEFAULT_LANE;
}

export function laneSegment(lane: string = DEFAULT_LANE): string {
  return lane.replace(/[^a-zA-Z0-9_.=-]+/g, "_").slice(0, 96) || DEFAULT_LANE;
}

export function laneStateSegment(lane: string = DEFAULT_LANE): string {
  return lane.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-").slice(0, 64) || DEFAULT_LANE;
}

export function laneSessionDir(sessionKey: string): string {
  return join(laneRoot(), "sessions", sessionKey);
}

export function laneLanesDir(sessionKey: string): string {
  return join(laneSessionDir(sessionKey), "lanes");
}

export function laneInstancesDir(sessionKey: string): string {
  return join(laneSessionDir(sessionKey), "instances");
}

export function lanePath(sessionKey: string, lane: string): string {
  return join(laneLanesDir(sessionKey), `${sanitizeLaneName(lane)}.json`);
}

export function laneStatePath(sessionKey: string, lane: string = DEFAULT_LANE): string {
  return join(laneRoot(), "sessions", sessionKey, "lanes", `${laneStateSegment(lane)}.json`);
}

export function syncDir(sessionKey: string, lane: string = DEFAULT_LANE): string {
  return join(laneRoot(), "sessions", sessionKey, "lanes", laneSegment(lane), "sync");
}

export function instancePath(sessionKey: string, instanceId: string): string {
  return join(laneInstancesDir(sessionKey), `${instanceId}.json`);
}

export function debugLogPath(sessionKey: string): string {
  return join(laneSessionDir(sessionKey), "debug.jsonl");
}

export function aliasRootDir(): string {
  if (process.env.PI_SYNC_ALIAS_ROOT) return process.env.PI_SYNC_ALIAS_ROOT;
  if (process.env.PI_LANE_ALIAS_ROOT) return process.env.PI_LANE_ALIAS_ROOT;
  if (process.env.PI_SYNC_ROOT) return join(process.env.PI_SYNC_ROOT, "flat");
  if (process.env.PI_LANE_ROOT) return join(process.env.PI_LANE_ROOT, "flat");
  return join(homedir(), ".pi-sync");
}

export function laneAliasPath(id: string): string {
  return join(aliasRootDir(), `${id}.json`);
}

export function readJsonFile<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

export function appendDebug(sessionKey: string, event: string, data: Record<string, unknown> = {}): void {
  mkdirSync(laneSessionDir(sessionKey), { recursive: true });
  writeFileSync(debugLogPath(sessionKey), `${JSON.stringify({ at: nowIso(), event, ...data })}\n`, { flag: "a" });
}

export function readLaneAliasStates(sessionKey: string): LaneAliasState[] {
  try {
    mkdirSync(aliasRootDir(), { recursive: true });
    return readdirSync(aliasRootDir())
      .filter((item) => item.endsWith(".json"))
      .map((item) => readJsonFile<LaneAliasState>(join(aliasRootDir(), item)))
      .filter((item): item is LaneAliasState => item?.schemaVersion === 1 && item.sessionKey === sessionKey && typeof item.displayId === "string");
  } catch {
    return [];
  }
}

export function laneDisplayId(sessionKey: string, lane: string): string {
  const name = sanitizeLaneName(lane);
  if (name === DEFAULT_LANE) return "L1";
  const aliases = readLaneAliasStates(sessionKey);
  const existing = aliases.find((item) => item.laneName === name || item.name === name);
  if (existing?.displayId) return existing.displayId;
  const max = aliases
    .map((item) => /^L(\d+)$/.exec(item.displayId)?.[1])
    .filter((item): item is string => !!item)
    .reduce((largest, item) => Math.max(largest, Number(item)), 1);
  return `L${max + 1}`;
}

export function laneAliasId(sessionKey: string, lane: string, displayId = laneDisplayId(sessionKey, lane)): string {
  return `${sessionKey.slice(0, 8)}-${displayId}`;
}

export function writeLaneAlias(sessionKey: string, file: string, state: LaneState): LaneAliasState {
  const displayId = state.displayId ?? laneDisplayId(sessionKey, state.name);
  const id: string = isCanonicalLaneId(state.id) ? state.id! : newLaneId();
  const path = laneAliasPath(id);
  const existing = readJsonFile<LaneAliasState>(path);
  const alias: LaneAliasState = {
    schemaVersion: 1,
    id,
    displayId,
    laneName: state.name,
    name: state.name,
    sessionKey: state.sessionKey,
    sessionFile: file,
    canonicalPath: lanePath(sessionKey, state.name),
    createdAt: existing?.createdAt ?? state.createdAt,
    updatedAt: nowIso(),
  };
  writeJsonFile(path, alias);
  return alias;
}

export function readLane(sessionKey: string, lane: string): LaneState | undefined {
  return readJsonFile<LaneState>(lanePath(sessionKey, lane));
}

export function ensureLane(sessionKey: string, file: string, lane: string, baseLeafId: string | null | undefined): LaneState {
  const name = sanitizeLaneName(lane);
  const path = lanePath(sessionKey, name);
  const existing = readJsonFile<LaneState>(path);
  if (existing) {
    if (isCanonicalLaneId(existing.id) && existing.displayId && existing.aliasPath) return existing;
    const alias = writeLaneAlias(sessionKey, file, existing);
    const hydrated = { ...existing, id: alias.id, displayId: alias.displayId, aliasPath: laneAliasPath(alias.id) };
    writeJsonFile(path, hydrated);
    return hydrated;
  }

  const displayId = laneDisplayId(sessionKey, name);
  const id = newLaneId();
  const created: LaneState = {
    schemaVersion: 1,
    name,
    sessionKey,
    baseLeafId: baseLeafId ?? null,
    headEntryId: baseLeafId ?? null,
    headEpoch: 0,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    id,
    displayId,
    aliasPath: laneAliasPath(id),
  };
  writeLaneAlias(sessionKey, file, created);
  writeJsonFile(path, created);
  return created;
}

export function updateLaneState(sessionKey: string, file: string, lane: string, patch: Partial<LaneState>): LaneState {
  const current = ensureLane(sessionKey, file, lane, undefined);
  const next = { ...current, ...patch, schemaVersion: 1 as const, name: sanitizeLaneName(lane), updatedAt: nowIso() };
  const alias = writeLaneAlias(sessionKey, file, next);
  next.id = alias.id;
  next.displayId = alias.displayId;
  next.aliasPath = laneAliasPath(alias.id);
  writeJsonFile(lanePath(sessionKey, lane), next);
  return next;
}

export function hostSocketPathForSyncDir(dir: string): string {
  const key = createHash("sha256").update(`${dir}:${process.env.USER ?? "user"}`).digest("hex").slice(0, 24);
  return join(process.env.TMPDIR ?? "/tmp", `pi-sync-${key}.sock`);
}
