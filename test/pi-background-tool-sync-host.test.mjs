import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInteractiveMock, createControllableBrain, toolCall, text } from "../../pi-mock/dist/index.js";

const EXTENSION = new URL("../index.ts", import.meta.url).pathname;
const PI_PENDING_PATH = new URL("../third_party/pi-pending/index.ts", import.meta.url).pathname;
const PI_BACKGROUND_TOOL_PATH = new URL(
  "../third_party/pi-background-tool/index.ts",
  import.meta.url,
).pathname;
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

function writeBackgroundToolExtension(root) {
  const helperPath = join(root, "test-helper-bg-tool-sync.mjs");
  writeFileSync(
    helperPath,
    `
import { Type } from "@sinclair/typebox";

let pendingRegistry;
let backgroundRunner;
const importsReady = Promise.all([
  import(${JSON.stringify(PI_PENDING_PATH)}),
  import(${JSON.stringify(PI_BACKGROUND_TOOL_PATH)}),
])
  .then(([pendingMod, bgMod]) => {
    pendingRegistry = pendingMod.createPiPending({ namespace: "bg-tool-sync", showId: false });
    return { pendingMod, bgMod };
  });

export default function piBgToolSyncHostExtension(pi) {
  pi.on("session_start", async (_event, ctx) => {
    await importsReady;
    if (pendingRegistry && ctx.hasUI && ctx.ui) pendingRegistry.attach(ctx.ui);
  });
  pi.on("session_shutdown", async () => {
    if (pendingRegistry) pendingRegistry.detach();
  });
  pi.registerTool({
    name: "bg_tool_sync_demo",
    label: "BG Tool Sync Demo",
    description: "Long-running tool that pi-background-tool must auto-background under a pi-sync host.",
    parameters: Type.Object({}),
    async execute(toolCallId, _params, signal, _onUpdate, ctx) {
      const { bgMod } = await importsReady;
      if (!backgroundRunner) {
        backgroundRunner = bgMod.createBackgroundToolRunner({
          pending: pendingRegistry,
          sendMessage: async (...args) => pi.sendMessage(...args),
          waitForInjection: bgMod.createProviderRequestInjectionWatcher(pi),
          background: { mode: "threshold", afterMs: 250 },
        });
      }
      return backgroundRunner.run({
        id: toolCallId,
        label: "demo",
        text: "BG_SYNC_PENDING_ROW",
        ctx,
        signal,
        async run({ signal: runSignal }) {
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => resolve(), 2_500);
            runSignal.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new Error("aborted"));
            }, { once: true });
          });
          return "BG_SYNC_RESULT_VALUE";
        },
        renderResult(value) {
          return { content: [{ type: "text", text: "inline:" + value }] };
        },
        renderBackgrounded() {
          return { content: [{ type: "text", text: "bg_tool_sync_demo backgrounded" }] };
        },
        renderBackgroundResult(value) {
          return '<pi_context source="bg-tool-sync" kind="result" id="' + toolCallId + '">\\n' + value + '\\n</pi_context>';
        },
      });
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

async function waitForCallContaining(brain, needle, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const remaining = Math.max(100, timeoutMs - (Date.now() - start));
    const call = await brain.waitForCall(remaining);
    if (JSON.stringify(call.request).includes(needle)) return call;
    call.respond(text("ack"));
  }
  throw new Error("no provider request contained: " + needle);
}

test(
  "pi-background-tool backgrounds a slow tool under a pi-sync host (no local UI), mirroring the pending row to attached terminals",
  { timeout: 90_000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-bg-tool-sync-host-"));
    const laneRoot = join(root, "lane");
    const sessionFile = join(root, "shared.jsonl");
    const piWrapper = writePiWrapper(root);
    const helperExt = writeBackgroundToolExtension(root);
    writeFileSync(sessionFile, "", "utf8");

    const brain = createControllableBrain();
    const common = {
      brain: brain.brain,
      extensions: [EXTENSION, helperExt],
      piProvider: "pi-mock",
      piModel: "mock",
      startupTimeoutMs: 20_000,
      terminal: { cols: 110, rows: 32 },
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
      submitter.submit("trigger bg sync tool");
      const firstCall = await brain.waitForCall(TIMEOUT);
      firstCall.respond(toolCall("bg_tool_sync_demo", {}));

      await submitter.waitForOutput("BG_SYNC_PENDING_ROW", TIMEOUT);
      await observer.waitForOutput("BG_SYNC_PENDING_ROW", TIMEOUT);
      await submitter.waitForOutput("bg_tool_sync_demo backgrounded", TIMEOUT);

      const backgroundCall = await waitForCallContaining(brain, "BG_SYNC_RESULT_VALUE", TIMEOUT);
      backgroundCall.respond(text("ack bg result"));
      await submitter.waitForOutput("ack bg result", TIMEOUT);

      const start = Date.now();
      let observerScreen = "";
      while (Date.now() - start < TIMEOUT) {
        observerScreen = (await observer.visibleScreen()).join("\n");
        if (!observerScreen.includes("BG_SYNC_PENDING_ROW")) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(
        !observerScreen.includes("BG_SYNC_PENDING_ROW"),
        "pi-pending row should clear from observer after background result delivered:\n" + observerScreen,
      );
    } finally {
      await submitter.close();
      await observer.close();
      await removeRoot(root);
    }
  },
);
