import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const PISYNC = new URL("../bin/pisync.js", import.meta.url).pathname;
const PIL = new URL("../bin/pil.js", import.meta.url).pathname;

function hostSocketPath(syncDir) {
  const key = createHash("sha256").update(`${syncDir}:${process.env.USER ?? "user"}`).digest("hex").slice(0, 24);
  return join(process.env.TMPDIR || "/tmp", `pi-sync-${key}.sock`);
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function makeFixture({ broken = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), `pi-sync-pisync-cli-${process.pid}-${Date.now()}-`));
  const root = join(dir, "sync-root");
  const key = broken ? "broken-key" : "healthy-key";
  const sessionFile = join(dir, "session.jsonl");
  const sessionDir = join(root, "sessions", key);
  const instancesDir = join(sessionDir, "instances");
  const syncsDir = join(sessionDir, "lanes");
  const syncDir = join(syncsDir, "main", "sync");
  mkdirSync(instancesDir, { recursive: true });
  mkdirSync(syncDir, { recursive: true });
  writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: "session-entry" })}\n${JSON.stringify({ type: "message", id: "head", message: { role: "assistant", content: "ok" } })}\n`);
  writeFileSync(join(instancesDir, "current.json"), JSON.stringify({ instanceId: "current", pid: process.pid, status: broken ? "active" : "idle", lane: "main", sessionKey: key, sessionFile, lastSeenAt: new Date().toISOString() }));
  writeFileSync(join(instancesDir, "stale.json"), JSON.stringify({ instanceId: "stale", pid: 1, status: "disconnected", lane: "main", lastSeenAt: "2000-01-01T00:00:00.000Z" }));
  writeJson(join(syncsDir, "main.json"), { schemaVersion: 1, name: "main", displayId: "L1", headEntryId: broken ? "missing-head" : "head", headEpoch: 3 });
  const socket = hostSocketPath(syncDir);
  if (!broken) {
    writeJson(join(syncDir, "host.json"), { schemaVersion: 1, state: "running", pid: process.pid, sessionKey: key, lane: "main", socketPath: socket, heartbeatAt: new Date().toISOString(), clients: 1, activePromptId: null, pendingPrompts: 0 });
    writeFileSync(socket, "");
  } else {
    mkdirSync(join(syncDir, "host.lock"), { recursive: true });
    writeJson(join(syncDir, "host.lock", "owner.json"), { schemaVersion: 1, state: "starting", pid: 99999999, heartbeatAt: "2000-01-01T00:00:00.000Z" });
  }
  const env = {
    ...process.env,
    PI_SYNC_ROOT: root,
    PI_SYNC_SESSION_KEY: key,
    PI_SYNC_SESSION_ID: "sid",
    PI_SYNC_SESSION_FILE: sessionFile,
    PI_SYNC_INSTANCE_ID: "current",
    PI_SYNC_CHANNEL: "main",
  };
  return { dir, env, socket };
}

test("pisync reports sync identity, instances, liveness, host health, and syncs", () => {
  const fixture = makeFixture();
  try {
    const self = JSON.parse(execFileSync(process.execPath, [PISYNC, "self", "--json"], { env: fixture.env, encoding: "utf8" }));
    assert.equal(self.sessionKey, "healthy-key");
    assert.equal(self.instanceId, "current");
    assert.equal(self.sync, "main");

    const instances = JSON.parse(execFileSync(process.execPath, [PISYNC, "ps", "--json"], { env: fixture.env, encoding: "utf8" }));
    assert.equal(instances.instances.find((item) => item.instanceId === "current").live, true);
    assert.equal(instances.instances.find((item) => item.instanceId === "stale").live, false);

    const syncs = JSON.parse(execFileSync(process.execPath, [PISYNC, "syncs", "--json"], { env: fixture.env, encoding: "utf8" }));
    assert.equal(syncs.syncs[0].name, "main");
    assert.equal(syncs.syncs[0].headEntryId, "head");

    const human = execFileSync(process.execPath, [PISYNC, "status"], { env: fixture.env, encoding: "utf8" });
    assert.match(human, /session\s+sid/);
    assert.match(human, /sync\s+L1 main head=head epoch=3/);
    assert.match(human, /attached\s+1 live, 1 stale/);
    assert.match(human, /host\s+live/);

    const context = execFileSync(process.execPath, [PISYNC, "status", "--context"], { env: fixture.env, encoding: "utf8" });
    assert.match(context, /source="pisync"/);

    const doctor = execFileSync(process.execPath, [PISYNC, "doctor"], { env: fixture.env, encoding: "utf8" });
    assert.match(doctor, /^ok/m);
  } finally {
    if (existsSync(fixture.socket)) rmSync(fixture.socket, { force: true });
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("pisync doctor catches missing sync head and active instance without a host", () => {
  const fixture = makeFixture({ broken: true });
  try {
    let humanError;
    try {
      execFileSync(process.execPath, [PISYNC, "doctor"], { env: fixture.env, encoding: "utf8", stdio: "pipe" });
    } catch (error) {
      humanError = error;
    }
    assert.ok(humanError);
    const output = String(humanError.stdout);
    assert.match(output, /^broken/m);
    assert.match(output, /sync head missing-head does not exist/);
    assert.match(output, /active instance exists but no fresh pi-sync host is running/);

    let jsonError;
    try {
      execFileSync(process.execPath, [PISYNC, "doctor", "--json"], { env: fixture.env, encoding: "utf8", stdio: "pipe" });
    } catch (error) {
      jsonError = error;
    }
    assert.ok(jsonError);
    const parsed = JSON.parse(String(jsonError.stdout));
    assert.equal(parsed.ok, false);
    assert.equal(parsed.problems.length, 2);
    assert.match(parsed.warnings.join("\n"), /stale host lock exists/);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("pil remains a compatibility alias for pisync", () => {
  const fixture = makeFixture();
  try {
    const human = execFileSync(process.execPath, [PIL, "id"], { env: fixture.env, encoding: "utf8" });
    assert.match(human, /sync\s+main main/);
  } finally {
    if (existsSync(fixture.socket)) rmSync(fixture.socket, { force: true });
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});
