import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInteractiveMock, createControllableBrain, toolCall, text } from "../../pi-mock/dist/index.js";

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

function writeBackgroundExtension(root, helperFile, body) {
  const helperPath = join(root, helperFile);
  writeFileSync(helperPath, body, "utf8");
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
  "pi-background-tool promotes a slow interactive tool to background and pi-pending shows the row",
  { timeout: 60_000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-background-tool-"));
    const sessionFile = join(root, "session.jsonl");
    const piWrapper = writePiWrapper(root);
    const helperExt = writeBackgroundExtension(
      root,
      "test-helper-bg-slow.mjs",
      `
import { Type } from "@sinclair/typebox";

let pendingRegistry;
let backgroundRunner;
const importsReady = Promise.all([
  import(${JSON.stringify(PI_PENDING_PATH)}),
  import(${JSON.stringify(PI_BACKGROUND_TOOL_PATH)}),
]).then(([pendingMod, bgMod]) => {
  pendingRegistry = pendingMod.createPiPending({ namespace: "bg-tool-slow", showId: false });
  return { bgMod };
});

export default function piBackgroundToolSlow(pi) {
  pi.on("session_start", async (_event, ctx) => {
    await importsReady;
    if (pendingRegistry && ctx.hasUI && ctx.ui) pendingRegistry.attach(ctx.ui);
  });
  pi.on("session_shutdown", async () => {
    if (pendingRegistry) pendingRegistry.detach();
  });
  pi.registerTool({
    name: "bg_tool_demo",
    description: "Slow tool exercising pi-background-tool + pi-pending.",
    parameters: Type.Object({}),
    async execute(toolCallId, _params, signal, _onUpdate, ctx) {
      const { bgMod } = await importsReady;
      if (!backgroundRunner) {
        backgroundRunner = bgMod.createBackgroundToolRunner({
          pending: pendingRegistry,
          sendMessage: pi.sendMessage.bind(pi),
          background: { mode: "threshold", afterMs: 200 },
        });
      }
      return backgroundRunner.run({
        id: toolCallId,
        text: "BG_TOOL_PENDING_ROW",
        ctx,
        signal,
        async run({ signal: runSignal }) {
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => resolve(), 2_000);
            runSignal.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new Error("aborted"));
            }, { once: true });
          });
          return "BG_TOOL_DONE_VALUE";
        },
        renderResult(value) {
          return { content: [{ type: "text", text: "inline:" + value }] };
        },
        renderBackgrounded() {
          return { content: [{ type: "text", text: "bg_tool_demo backgrounded" }] };
        },
        renderBackgroundResult(value) {
          return '<pi_context source="bg-tool-slow" kind="result" id="' + toolCallId + '">\\n' + value + '\\n</pi_context>';
        },
      });
    },
  });
}
`,
    );
    writeFileSync(sessionFile, "", "utf8");

    const brain = createControllableBrain();
    const mock = await createInteractiveMock({
      brain: brain.brain,
      extensions: [helperExt],
      piProvider: "pi-mock",
      piModel: "mock",
      startupTimeoutMs: 20_000,
      terminal: { cols: 110, rows: 32 },
      cwd: root,
      piBinary: piWrapper,
      piArgs: ["--session", sessionFile],
    });

    try {
      mock.clearOutput();
      mock.submit("trigger bg tool");
      const firstCall = await brain.waitForCall(TIMEOUT);
      firstCall.respond(toolCall("bg_tool_demo", {}));

      await mock.waitForOutput("BG_TOOL_PENDING_ROW", TIMEOUT);
      await mock.waitForOutput("bg_tool_demo backgrounded", TIMEOUT);

      const backgroundResultCall = await waitForCallContaining(brain, "BG_TOOL_DONE_VALUE", TIMEOUT);
      backgroundResultCall.respond(text("saw bg-tool background context"));
      await mock.waitForOutput("saw bg-tool background context", TIMEOUT);

      const start = Date.now();
      let screen = "";
      while (Date.now() - start < TIMEOUT) {
        screen = (await mock.visibleScreen()).join("\n");
        if (!screen.includes("BG_TOOL_PENDING_ROW")) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(
        !screen.includes("BG_TOOL_PENDING_ROW"),
        "pi-pending row should clear after background result is delivered:\n" + screen,
      );
      assert.ok(
        !screen.includes("inline:BG_TOOL_DONE_VALUE"),
        "fast-path renderer must not be used when work is backgrounded:\n" + screen,
      );
    } finally {
      await mock.close();
      await removeRoot(root);
    }
  },
);

test(
  "pi-background-tool waits inline (no pi-pending row) for a tool that finishes before the threshold",
  { timeout: 60_000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-background-tool-fast-"));
    const sessionFile = join(root, "session.jsonl");
    const piWrapper = writePiWrapper(root);
    const helperExt = writeBackgroundExtension(
      root,
      "test-helper-bg-fast.mjs",
      `
import { Type } from "@sinclair/typebox";

let pendingRegistry;
let backgroundRunner;
const importsReady = Promise.all([
  import(${JSON.stringify(PI_PENDING_PATH)}),
  import(${JSON.stringify(PI_BACKGROUND_TOOL_PATH)}),
]).then(([pendingMod, bgMod]) => {
  pendingRegistry = pendingMod.createPiPending({ namespace: "bg-tool-fast", showId: false });
  return { bgMod };
});

export default function piBackgroundToolFast(pi) {
  pi.on("session_start", async (_event, ctx) => {
    await importsReady;
    if (pendingRegistry && ctx.hasUI && ctx.ui) pendingRegistry.attach(ctx.ui);
  });
  pi.on("session_shutdown", async () => {
    if (pendingRegistry) pendingRegistry.detach();
  });
  pi.registerTool({
    name: "bg_tool_fast",
    description: "Resolves before the background threshold.",
    parameters: Type.Object({}),
    async execute(toolCallId, _params, signal, _onUpdate, ctx) {
      const { bgMod } = await importsReady;
      if (!backgroundRunner) {
        backgroundRunner = bgMod.createBackgroundToolRunner({
          pending: pendingRegistry,
          sendMessage: pi.sendMessage.bind(pi),
          background: { mode: "threshold", afterMs: 5_000 },
        });
      }
      return backgroundRunner.run({
        id: toolCallId,
        text: "FAST_ROW_MARKER",
        ctx,
        signal,
        async run() { return "FAST_DONE"; },
        renderResult(value) {
          return { content: [{ type: "text", text: "fast-inline:" + value }] };
        },
        renderBackgrounded() {
          return { content: [{ type: "text", text: "fast tool backgrounded" }] };
        },
        renderBackgroundResult(value) {
          return '<pi_context source="bg-tool-fast" kind="result" id="' + toolCallId + '">\\n' + value + '\\n</pi_context>';
        },
      });
    },
  });
}
`,
    );
    writeFileSync(sessionFile, "", "utf8");

    const brain = createControllableBrain();
    const mock = await createInteractiveMock({
      brain: brain.brain,
      extensions: [helperExt],
      piProvider: "pi-mock",
      piModel: "mock",
      startupTimeoutMs: 20_000,
      terminal: { cols: 110, rows: 32 },
      cwd: root,
      piBinary: piWrapper,
      piArgs: ["--session", sessionFile],
    });

    try {
      mock.clearOutput();
      mock.submit("trigger fast bg tool");
      const firstCall = await brain.waitForCall(TIMEOUT);
      firstCall.respond(toolCall("bg_tool_fast", {}));

      const followup = await brain.waitForCall(TIMEOUT);
      const raw = JSON.stringify(followup.request);
      assert.ok(
        raw.includes("fast-inline:FAST_DONE"),
        "fast-path renderResult should appear in the next provider request: " + raw.slice(0, 300),
      );
      assert.ok(
        !raw.includes("fast tool backgrounded"),
        "renderBackgrounded must not run when the tool resolved before threshold: " + raw.slice(0, 300),
      );
      followup.respond(text("done"));
      await mock.waitForOutput("done", TIMEOUT);

      const screen = (await mock.visibleScreen()).join("\n");
      assert.ok(
        !screen.includes("FAST_ROW_MARKER"),
        "pi-pending row should never appear for a fast tool below threshold:\n" + screen,
      );
    } finally {
      await mock.close();
      await removeRoot(root);
    }
  },
);
