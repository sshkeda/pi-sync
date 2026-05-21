import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInteractiveMock, createControllableBrain, toolCall } from "../../pi-mock/dist/index.js";

const EXTENSION = new URL("../index.ts", import.meta.url).pathname;
const PI_PENDING_PATH = new URL("../third_party/pi-pending/index.ts", import.meta.url).pathname;
const TIMEOUT = 30_000;

function writePiWrapper(root) {
  const piWrapper = join(root, "pi-wrapper.sh");
  writeFileSync(
    piWrapper,
    `#!/usr/bin/env bash\nargs=()\nfor a in "$@"; do [[ "$a" == "--no-session" ]] && continue; args+=("$a"); done\nexec "${
      process.env.PI_SYNC_TEST_PI_BINARY ?? "pi"
    }" "\${args[@]}"\n`,
  );
  chmodSync(piWrapper, 0o755);
  return piWrapper;
}

function writeMirrorHelperExtension(root) {
  const helperPath = join(root, "test-helper-pi-pending-stale.mjs");
  writeFileSync(
    helperPath,
    `
import { Type } from "@sinclair/typebox";

let pendingRegistry;
let pendingPromise = import(${JSON.stringify(PI_PENDING_PATH)}).then((mod) => {
  pendingRegistry = mod.createPiPending({ namespace: "stale-test", showId: false });
});

export default function staleMirrorTest(pi) {
  pi.on("session_start", async (_event, ctx) => {
    await pendingPromise;
    if (pendingRegistry && ctx.hasUI && ctx.ui) pendingRegistry.attach(ctx.ui);
  });
  pi.on("session_shutdown", async () => {
    if (pendingRegistry) pendingRegistry.detach();
  });
  pi.registerTool({
    name: "stale_long_op",
    label: "Stale Mirror",
    description: "Starts a pending row and never finishes (host will be killed).",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      await pendingPromise;
      pendingRegistry?.start({ id: "STALE1", text: "STALE_ROW_MARKER" });
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      pendingRegistry?.finish("STALE1");
      return { content: [{ type: "text", text: "done" }] };
    },
  });
}
`,
    "utf8",
  );
  return helperPath;
}

async function removeRoot(root) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 4 || !["ENOTEMPTY", "EBUSY", "ENOENT"].includes(error?.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

async function waitUntil(predicate, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timeout waiting for ${label}`);
}

function findMirrorDir(laneRoot) {
  const sessionsDir = join(laneRoot, "sessions");
  if (!existsSync(sessionsDir)) return undefined;
  for (const key of readdirSync(sessionsDir)) {
    const candidate = join(sessionsDir, key, "lanes", "main", "sync", "pending");
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function readHostInfo(laneRoot) {
  const sessionsDir = join(laneRoot, "sessions");
  if (!existsSync(sessionsDir)) return undefined;
  for (const key of readdirSync(sessionsDir)) {
    const path = join(sessionsDir, key, "lanes", "main", "sync", "host.json");
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, "utf8"));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

test(
  "pi-pending mirror row persists across host crash, never cleared (orphan bug)",
  { timeout: 90_000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-pending-stale-"));
    const laneRoot = join(root, "lane");
    const sessionFile = join(root, "shared.jsonl");
    const piWrapper = writePiWrapper(root);
    const helperExt = writeMirrorHelperExtension(root);
    writeFileSync(sessionFile, "", "utf8");

    const brain = createControllableBrain();
    const common = {
      brain: brain.brain,
      extensions: [EXTENSION, helperExt],
      piProvider: "pi-mock",
      piModel: "mock",
      startupTimeoutMs: 20_000,
      terminal: { cols: 100, rows: 32 },
      cwd: root,
      env: {
        PI_LANE_ROOT: laneRoot,
        PI_SYNC_POLL_MS: "25",
        PI_SYNC_HOST_IDLE_MS: "5000",
      },
      piBinary: piWrapper,
      piArgs: ["--session", sessionFile],
    };

    const submitter = await createInteractiveMock(common);
    const observer = await createInteractiveMock(common);

    try {
      submitter.clearOutput();
      observer.clearOutput();
      submitter.submit("trigger stale tool");
      const call = await brain.waitForCall(TIMEOUT);
      call.respond(toolCall("stale_long_op", {}));

      await observer.waitForOutput("STALE_ROW_MARKER", TIMEOUT);
      await submitter.waitForOutput("STALE_ROW_MARKER", TIMEOUT);

      await waitUntil(() => {
        const dir = findMirrorDir(laneRoot);
        if (!dir) return false;
        return readdirSync(dir).filter((n) => n.endsWith(".json")).length > 0;
      }, TIMEOUT, "mirror file written");

      const host = readHostInfo(laneRoot);
      assert.ok(host?.pid, `expected host pid in host.json: ${JSON.stringify(host)}`);
      process.kill(host.pid, "SIGKILL");

      await waitUntil(() => {
        try {
          process.kill(host.pid, 0);
          return false;
        } catch {
          return true;
        }
      }, TIMEOUT, "host process dead");

      await new Promise((resolve) => setTimeout(resolve, 2_000));

      const dir = findMirrorDir(laneRoot);
      const remaining = dir ? readdirSync(dir).filter((n) => n.endsWith(".json")) : [];
      const observerScreen = (await observer.visibleScreen()).join("\n");
      const stillVisible = observerScreen.includes("STALE_ROW_MARKER");

      console.log("mirror files after host kill:", remaining.length, remaining);
      console.log("STALE_ROW_MARKER still on observer screen:", stillVisible);

      assert.equal(
        remaining.length,
        0,
        `BUG: pi-pending mirror leaks ${remaining.length} orphan file(s) after host SIGKILL — attached terminals will show a phantom pending row forever:\n${remaining.join("\n")}`,
      );
      assert.equal(
        stillVisible,
        false,
        `BUG: observer still shows STALE_ROW_MARKER after host died:\n${observerScreen}`,
      );
    } finally {
      await submitter.close();
      await observer.close();
      await removeRoot(root);
    }
  },
);
