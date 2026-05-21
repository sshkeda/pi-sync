import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type PiPendingPlacement = "aboveEditor" | "belowEditor";
export type PiPendingDetails = Record<string, unknown>;

export interface PiPendingFormatInput {
  id: string;
  namespace: string;
  label?: string;
  text: string;
  details?: PiPendingDetails;
  startedAt: number;
}

export type PiPendingFormatter = (item: PiPendingFormatInput) => string;
export type PiPendingShowId = boolean | "auto";

export interface PiPendingStartInput {
  id: string;
  label?: string;
  text: string;
  startedAt?: number;
  details?: PiPendingDetails;
}

export interface PiPendingUpdateInput {
  label?: string;
  text?: string;
  details?: PiPendingDetails;
}

export interface PiPendingOptions {
  namespace: string;
  /** @deprecated pi-pending always renders to the shared "pi-pending" widget. */
  widgetId?: string;
  placement?: PiPendingPlacement;
  format?: PiPendingFormatter;
  showId?: PiPendingShowId;
  minElapsedColumnWidth?: number;
  minIdColumnWidth?: number;
}

export interface PiPendingRegistry {
  attach(ui: ExtensionUIContext): void;
  detach(ui?: ExtensionUIContext): void;
  start(item: PiPendingStartInput): void;
  update(id: string, patch: PiPendingUpdateInput): void;
  finish(id: string): void;
  clear(): void;
  list(): PiPendingFormatInput[];
}

interface InternalPendingItem extends PiPendingFormatInput {
  key: string;
  sequence: number;
  format: PiPendingFormatter;
  showId: PiPendingShowId;
  minElapsedColumnWidth: number;
  minIdColumnWidth: number;
}

interface PiPendingGlobalState {
  ui: ExtensionUIContext | undefined;
  widgetId: string;
  placement: PiPendingPlacement;
  items: Map<string, InternalPendingItem>;
  mirroredItems: Map<string, InternalPendingItem>;
  nextSequence: number;
  widgetInstalled: boolean;
  syncPollTimer: ReturnType<typeof setInterval> | undefined;
  lastSyncSnapshot: string;
}

const DEFAULT_WIDGET_ID = "pi-pending";
const DEFAULT_MIN_ELAPSED_COLUMN_WIDTH = "4m 16s".length;

declare global {
  var __piPendingGlobalState__v1: PiPendingGlobalState | undefined;
}

function globalState(): PiPendingGlobalState {
  if (!globalThis.__piPendingGlobalState__v1) {
    globalThis.__piPendingGlobalState__v1 = {
      widgetId: DEFAULT_WIDGET_ID,
      placement: "aboveEditor",
      items: new Map(),
      mirroredItems: new Map(),
      nextSequence: 1,
      ui: undefined,
      widgetInstalled: false,
      syncPollTimer: undefined,
      lastSyncSnapshot: "",
    };
  }
  return globalThis.__piPendingGlobalState__v1;
}

function namespaceKey(namespace: string, id: string): string {
  return `${namespace}:${id}`;
}

function normalizeVisibleText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function padToWidth(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

export function formatElapsedDuration(startedAt: number, now = Date.now()): string {
  const totalSeconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function formatElapsedSeconds(startedAt: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  return seconds < 1000 ? String(seconds).padStart(3, "0") : String(seconds);
}

function defaultFormat(item: PiPendingFormatInput): string {
  return item.label ? `${item.label}: ${item.text}` : item.text;
}

function shouldShowId(item: InternalPendingItem): boolean {
  return item.showId === true || (item.showId === "auto" && item.label === undefined);
}

function sortedItems(state: PiPendingGlobalState): InternalPendingItem[] {
  const localKeys = new Set(state.items.keys());
  return [
    ...state.items.values(),
    ...[...state.mirroredItems.values()].filter((item) => !localKeys.has(item.key)),
  ].sort((a, b) => a.sequence - b.sequence || a.key.localeCompare(b.key));
}

function laneSegment(lane: string): string {
  return lane.replace(/[^a-zA-Z0-9_.=-]+/g, "_").slice(0, 96) || "main";
}

function syncPendingDir(): string | undefined {
  const sessionKey = process.env.PI_SYNC_SESSION_KEY ?? process.env.PI_LANE_SESSION_KEY;
  if (!sessionKey) return undefined;
  const root = process.env.PI_SYNC_ROOT ?? process.env.PI_LANE_ROOT ?? join(homedir(), ".pi", "lane");
  const lane = process.env.PI_SYNC_CHANNEL ?? process.env.PI_LANE_CURRENT_LANE ?? "main";
  return join(root, "sessions", sessionKey, "lanes", laneSegment(lane), "sync", "pending");
}

function mirrorPathFor(key: string): string | undefined {
  const dir = syncPendingDir();
  if (!dir) return undefined;
  return join(dir, `${Buffer.from(key).toString("base64url")}.json`);
}

function writeAtomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`, "utf8");
  renameSync(tmp, path);
}

function writeMirroredItem(item: InternalPendingItem): void {
  const path = mirrorPathFor(item.key);
  if (!path) return;
  try {
    writeAtomicJson(path, {
      schemaVersion: 1,
      key: item.key,
      id: item.id,
      namespace: item.namespace,
      label: item.label,
      text: item.text,
      body: normalizeVisibleText(item.format(item)),
      details: item.details,
      startedAt: item.startedAt,
      sequence: item.sequence,
      showId: item.showId,
      minElapsedColumnWidth: item.minElapsedColumnWidth,
      minIdColumnWidth: item.minIdColumnWidth,
      updatedAt: Date.now(),
      pid: process.pid,
    });
  } catch {}
}

function removeMirroredItem(key: string): void {
  const path = mirrorPathFor(key);
  if (!path) return;
  try {
    rmSync(path, { force: true });
  } catch {}
}

function toDetails(value: unknown): PiPendingDetails | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: PiPendingDetails = {};
  for (const [k, v] of Object.entries(value)) out[k] = v;
  return out;
}

function isWriterPidAlive(pid: unknown): boolean {
  if (!Number.isInteger(pid) || typeof pid !== "number" || pid <= 0) return true;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "ESRCH") return false;
    return true;
  }
}

function readMirroredItems(state: PiPendingGlobalState): boolean {
  const dir = syncPendingDir();
  if (!dir || !existsSync(dir)) {
    if (state.mirroredItems.size === 0 && state.lastSyncSnapshot === "") return false;
    state.mirroredItems.clear();
    state.lastSyncSnapshot = "";
    return true;
  }
  const next = new Map<string, InternalPendingItem>();
  const snapshotParts: string[] = [];
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const path = join(dir, name);
      try {
        const raw = readFileSync(path, "utf8");
        const parsed: Record<string, unknown> = JSON.parse(raw);
        if (
          parsed.schemaVersion !== 1 ||
          typeof parsed.key !== "string" ||
          typeof parsed.id !== "string" ||
          typeof parsed.namespace !== "string"
        )
          continue;
        if (!isWriterPidAlive(parsed.pid)) {
          try {
            rmSync(path, { force: true });
          } catch {}
          continue;
        }
        const body = typeof parsed.body === "string" ? parsed.body : typeof parsed.text === "string" ? parsed.text : "";
        const details = toDetails(parsed.details);
        const item: InternalPendingItem = {
          key: parsed.key,
          id: parsed.id,
          namespace: parsed.namespace,
          text: typeof parsed.text === "string" ? parsed.text : body,
          startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : Date.now(),
          sequence: typeof parsed.sequence === "number" ? parsed.sequence : Number.MAX_SAFE_INTEGER,
          format: () => body,
          showId: parsed.showId === false ? false : parsed.showId === "auto" ? "auto" : true,
          minElapsedColumnWidth:
            typeof parsed.minElapsedColumnWidth === "number"
              ? parsed.minElapsedColumnWidth
              : DEFAULT_MIN_ELAPSED_COLUMN_WIDTH,
          minIdColumnWidth: typeof parsed.minIdColumnWidth === "number" ? parsed.minIdColumnWidth : 0,
          ...(typeof parsed.label === "string" ? { label: parsed.label } : {}),
          ...(details !== undefined ? { details } : {}),
        };
        next.set(item.key, item);
        snapshotParts.push(`${item.key}:${parsed.updatedAt ?? ""}:${body}`);
      } catch {}
    }
  } catch {}
  const snapshot = snapshotParts.sort().join("|");
  if (snapshot === state.lastSyncSnapshot) return false;
  state.mirroredItems = next;
  state.lastSyncSnapshot = snapshot;
  return true;
}

function startSyncPolling(state: PiPendingGlobalState): void {
  if (state.syncPollTimer) return;
  state.syncPollTimer = setInterval(() => {
    if (!state.ui) return;
    if (readMirroredItems(state)) reconcileWidget(state);
  }, 500);
  state.syncPollTimer.unref?.();
}

function createPendingWidget(state: PiPendingGlobalState, tui: TUI, theme: Theme): Component & { dispose(): void } {
  const interval = setInterval(() => tui.requestRender(), 1000);
  return {
    render(width: number): string[] {
      if (width <= 0) return [];
      const rows = sortedItems(state).map((item) => ({
        item,
        body: normalizeVisibleText(item.format(item)),
        elapsed: formatElapsedDuration(item.startedAt),
        id: shouldShowId(item) ? item.id : undefined,
      }));
      const elapsedWidth = rows.reduce(
        (max, row) => Math.max(max, row.item.minElapsedColumnWidth, visibleWidth(row.elapsed)),
        0,
      );
      const idWidth = rows.reduce(
        (max, row) => Math.max(max, row.item.minIdColumnWidth, visibleWidth(row.id ?? "")),
        0,
      );
      return rows.map((row) => {
        const elapsed = padToWidth(row.elapsed, elapsedWidth);
        const prefix = row.id ? `${elapsed} ${padToWidth(row.id, idWidth)} ` : `${elapsed} `;
        const line = padToWidth(truncateToWidth(`${prefix}${row.body}`, width, "..."), width);
        return theme.bg("toolPendingBg", theme.fg("toolTitle", line));
      });
    },
    invalidate() {},
    dispose() {
      clearInterval(interval);
    },
  };
}

function reconcileWidget(state: PiPendingGlobalState): void {
  if (!state.ui) return;
  if (sortedItems(state).length === 0) {
    if (state.widgetInstalled) {
      state.ui.setWidget(state.widgetId, undefined);
      state.widgetInstalled = false;
    }
    return;
  }
  if (state.widgetInstalled) return;
  state.ui.setWidget(state.widgetId, (tui, theme) => createPendingWidget(state, tui, theme), {
    placement: state.placement,
  });
  state.widgetInstalled = true;
}

export function createPiPending(options: PiPendingOptions): PiPendingRegistry {
  const namespace = normalizeVisibleText(options.namespace);
  if (!namespace) throw new Error("pi-pending namespace is required");
  const format = options.format ?? defaultFormat;
  const showId = options.showId ?? true;
  const minElapsedColumnWidth = options.minElapsedColumnWidth ?? DEFAULT_MIN_ELAPSED_COLUMN_WIDTH;
  const minIdColumnWidth = options.minIdColumnWidth ?? 0;
  const state = globalState();
  state.widgetId = DEFAULT_WIDGET_ID;
  state.placement = options.placement ?? state.placement ?? "aboveEditor";

  return {
    attach(ui: ExtensionUIContext): void {
      state.ui = ui;
      readMirroredItems(state);
      startSyncPolling(state);
      reconcileWidget(state);
    },
    detach(ui?: ExtensionUIContext): void {
      if (ui && state.ui !== ui) return;
      if (state.ui && state.widgetInstalled) state.ui.setWidget(state.widgetId, undefined);
      state.ui = undefined;
      state.widgetInstalled = false;
      if (state.syncPollTimer) clearInterval(state.syncPollTimer);
      state.syncPollTimer = undefined;
    },
    start(item: PiPendingStartInput): void {
      const id = normalizeVisibleText(item.id);
      if (!id) throw new Error("pi-pending item id is required");
      const key = namespaceKey(namespace, id);
      const existing = state.items.get(key);
      const nextItem: InternalPendingItem = {
        key,
        id,
        namespace,
        text: item.text,
        startedAt: item.startedAt ?? existing?.startedAt ?? Date.now(),
        sequence: existing?.sequence ?? state.nextSequence++,
        format,
        showId,
        minElapsedColumnWidth,
        minIdColumnWidth,
        ...(item.label !== undefined ? { label: item.label } : {}),
        ...(item.details !== undefined ? { details: item.details } : {}),
      };
      state.items.set(key, nextItem);
      writeMirroredItem(nextItem);
      reconcileWidget(state);
    },
    update(id: string, patch: PiPendingUpdateInput): void {
      const key = namespaceKey(namespace, id);
      const item = state.items.get(key);
      if (!item) return;
      const nextItem: InternalPendingItem = {
        ...item,
        ...(patch.label !== undefined ? { label: patch.label } : {}),
        ...(patch.text !== undefined ? { text: patch.text } : {}),
        ...(patch.details !== undefined ? { details: patch.details } : {}),
      };
      state.items.set(key, nextItem);
      writeMirroredItem(nextItem);
      reconcileWidget(state);
    },
    finish(id: string): void {
      const key = namespaceKey(namespace, id);
      if (state.items.delete(key)) removeMirroredItem(key);
      reconcileWidget(state);
    },
    clear(): void {
      for (const key of [...state.items.keys()]) {
        if (key.startsWith(`${namespace}:`)) {
          state.items.delete(key);
          removeMirroredItem(key);
        }
      }
      reconcileWidget(state);
    },
    list(): PiPendingFormatInput[] {
      return sortedItems(state)
        .filter((item) => item.namespace === namespace)
        .map(({ id, label, text, details, startedAt }) => ({
          id,
          text,
          startedAt,
          ...(label !== undefined ? { label } : {}),
          ...(details !== undefined ? { details } : {}),
          namespace,
        }));
    },
  };
}
