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
import { createInteractiveMock, createControllableBrain, toolCall, text } from "../../pi-mock/dist/index.js";

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
  const helperPath = join(root, "test-helper-pi-pending-lane-switch.mjs");
  writeFileSync(
    helperPath,
    `
import { Type } from "@sinclair/typebox";

let pendingRegistry;
let pendingPromise = import(${JSON.stringify(PI_PENDING_PATH)}).then((mod) => {
  pendingRegistry = mod.createPiPending({ namespace: "lane-switch", showId: false });
});

export default function laneSwitchMirrorTest(pi) {
  pi.on("session_start", async (_event, ctx) => {
    await pendingPromise;
    if (pendingRegistry && ctx.hasUI && ctx.ui) pendingRegistry.attach(ctx.ui);
  });
  pi.on("session_shutdown", async () => {
    if (pendingRegistry) pendingRegistry.detach();
  });
  pi.registerTool({
    name: "lane_switch_long_op",
    label: "Lane Switch Mirror",
    description: "Long-running tool that updates a pending row.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      await pendingPromise;
      pendingRegistry?.start({ id: "LSOP", text: "LANE_SWITCH_ROW_MARKER" });
      try {
        await new Promise((resolve) => setTimeout(resolve, 6_000));
      } finally {
        pendingRegistry?.finish("LSOP");
      }
      return { content: [{ type: "text", text: "lane-switch op done" }] };
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

function listPendingDirs(laneRoot) {
  const sessionsDir = join(laneRoot, "sessions");
  if (!existsSync(sessionsDir)) return [];
  const out = [];
  for (const key of readdirSync(sessionsDir)) {
    const lanesDir = join(sessionsDir, key, "lanes");
    if (!existsSync(lanesDir)) continue;
    for (const entry of readdirSync(lanesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = join(lanesDir, entry.name, "sync", "pending");
      if (existsSync(candidate)) {
        out.push({ lane: entry.name, files: readdirSync(candidate).filter((n) => n.endsWith(".json")) });
      }
    }
  }
  return out;
}

test(
  "pi-pending mirror row from main-lane host stops rendering on a peer that switched to a new lane",
  { timeout: 120_000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-pending-lane-switch-"));
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
      terminal: { cols: 110, rows: 34 },
      cwd: root,
      env: {
        PI_LANE_ROOT: laneRoot,
        PI_SYNC_POLL_MS: "25",
        PI_SYNC_HOST_IDLE_MS: "10000",
      },
      piBinary: piWrapper,
      piArgs: ["--session", sessionFile],
    };

    const submitter = await createInteractiveMock(common);
    const observer = await createInteractiveMock(common);

    try {
      submitter.clearOutput();
      observer.clearOutput();
      submitter.submit("trigger lane-switch tool");
      const call = await brain.waitForCall(TIMEOUT);
      call.respond(toolCall("lane_switch_long_op", {}));

      await observer.waitForOutput("LANE_SWITCH_ROW_MARKER", TIMEOUT);
      await submitter.waitForOutput("LANE_SWITCH_ROW_MARKER", TIMEOUT);

      observer.clearOutput();
      observer.submit("/lane new");
      await observer.waitForOutput(/created ln_[A-Za-z0-9_-]+ -> now ~\/2/, TIMEOUT);

      await new Promise((resolve) => setTimeout(resolve, 2_000));

      const observerScreen = (await observer.visibleScreen()).join("\n");
      const submitterScreen = (await submitter.visibleScreen()).join("\n");
      const pendingDirs = listPendingDirs(laneRoot);

      console.log("pendingDirs after lane switch:", JSON.stringify(pendingDirs));
      console.log("observer screen has LANE_SWITCH_ROW_MARKER:", observerScreen.includes("LANE_SWITCH_ROW_MARKER"));
      console.log(
        "submitter (still on main) screen has LANE_SWITCH_ROW_MARKER:",
        submitterScreen.includes("LANE_SWITCH_ROW_MARKER"),
      );

      assert.equal(
        observerScreen.includes("LANE_SWITCH_ROW_MARKER"),
        false,
        `observer switched to new lane should not show main lane's pending row:\n${observerScreen}`,
      );
      assert.equal(
        submitterScreen.includes("LANE_SWITCH_ROW_MARKER"),
        true,
        `submitter still on main lane should still see the pending row:\n${submitterScreen}`,
      );

      const second = await brain.waitForCall(TIMEOUT);
      second.respond(text("post lane switch reply"));
    } finally {
      await submitter.close();
      await observer.close();
      await removeRoot(root);
    }
  },
);
