import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export function stableSessionKey(sessionFile: string, _sessionId?: string | null): string {
  return createHash("sha256").update(sessionFile).digest("hex").slice(0, 24);
}

export function sanitizeLaneName(value: string | undefined): string {
  const name = (value ?? "").trim() || "main";
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-").slice(0, 64);
  return safe || "main";
}

export function laneRoot(): string {
  return process.env.PI_SYNC_ROOT ?? process.env.PI_LANE_ROOT ?? join(homedir(), ".pi", "lane");
}

export function laneSessionDir(root: string, sessionKey: string): string {
  return join(root, "sessions", sessionKey);
}

export function laneInstancesDir(root: string, sessionKey: string): string {
  return join(laneSessionDir(root, sessionKey), "instances");
}

export function laneLanesDir(root: string, sessionKey: string): string {
  return join(laneSessionDir(root, sessionKey), "lanes");
}
