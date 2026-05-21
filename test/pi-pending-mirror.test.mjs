import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
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
  const helperPath = join(root, "test-helper-pi-pending-mirror.mjs");
  writeFileSync(
    helperPath,
    `
import { Type } from "@sinclair/typebox";

let pendingRegistry;
let pendingPromise = import(${JSON.stringify(PI_PENDING_PATH)})
  .then((mod) => {
    pendingRegistry = mod.createPiPending({ namespace: "mirror-test", showId: false });
  })
  .catch((error) => {
    console.error("pi-pending import failed", error);
  });

export default function piPendingMirrorTestExtension(pi) {
  pi.on("session_start", async (_event, ctx) => {
    await pendingPromise;
    if (pendingRegistry && ctx.hasUI && ctx.ui) pendingRegistry.attach(ctx.ui);
  });
  pi.on("session_shutdown", async () => {
    if (pendingRegistry) pendingRegistry.detach();
  });
  pi.registerTool({
    name: "mirror_test_long_op",
    label: "Mirror Test",
    description: "Test tool that uses pi-pending mirror.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      await pendingPromise;
      pendingRegistry?.start({ id: "OP1", text: "MIRROR_PENDING_ROW" });
      try {
        await new Promise((resolve) => setTimeout(resolve, 4_000));
      } finally {
        pendingRegistry?.finish("OP1");
      }
      return { content: [{ type: "text", text: "mirror op done" }] };
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

test(
  "pi-pending mirror surfaces a host-owned pending row in attached peer terminals",
  { timeout: 90_000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-pending-mirror-"));
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
      submitter.submit("trigger mirror test");
      const call = await brain.waitForCall(TIMEOUT);
      call.respond(toolCall("mirror_test_long_op", {}));

      await observer.waitForOutput("MIRROR_PENDING_ROW", TIMEOUT);
      await submitter.waitForOutput("MIRROR_PENDING_ROW", TIMEOUT);

      const second = await brain.waitForCall(TIMEOUT);
      second.respond(text("post-tool reply"));

      const start = Date.now();
      let observerScreen;
      while (Date.now() - start < TIMEOUT) {
        observerScreen = (await observer.visibleScreen()).join("\n");
        if (!observerScreen.includes("MIRROR_PENDING_ROW")) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(
        !observerScreen.includes("MIRROR_PENDING_ROW"),
        `mirror row should clear after tool finishes on observer:\n${observerScreen}`,
      );
    } finally {
      await submitter.close();
      await observer.close();
      await removeRoot(root);
    }
  },
);
