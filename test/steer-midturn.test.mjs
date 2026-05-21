import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInteractiveMock, createControllableBrain, text, bash } from "../../pi-mock/dist/index.js";

const EXTENSION = new URL("../index.ts", import.meta.url).pathname;
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

function summarize(messages) {
  return messages.map((m) => {
    if (typeof m.content === "string") return `${m.role}:${m.content}`;
    const parts = (m.content ?? []).map((p) => {
      if (p.type === "text") return `text:${p.text}`;
      if (p.type === "tool_use") return `tool_use:${p.name}`;
      if (p.type === "tool_result") return `tool_result`;
      return p.type;
    });
    return `${m.role}:${parts.join("|")}`;
  });
}

test(
  "pi-sync mid-turn steer reaches active host turn before stop_reason",
  { timeout: 90_000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sync-steer-midturn-"));
    const sessionFile = join(root, "shared.jsonl");
    const piWrapper = writePiWrapper(root);
    writeFileSync(sessionFile, "", "utf8");
    const brain = createControllableBrain();
    const mock = await createInteractiveMock({
      brain: brain.brain,
      extensions: [EXTENSION],
      piProvider: "pi-mock",
      piModel: "mock",
      startupTimeoutMs: 20_000,
      terminal: { cols: 110, rows: 32 },
      cwd: root,
      env: { PI_LANE_ROOT: join(root, "lane"), PI_SYNC_POLL_MS: "25", PI_SYNC_HOST_IDLE_MS: "5000" },
      piBinary: piWrapper,
      piArgs: ["--session", sessionFile],
    });
    try {
      mock.submit("STEER_USER_PROMPT");
      const call1 = await brain.waitForCall(TIMEOUT);
      call1.respond(bash("sleep 2 && echo step1"));

      await new Promise((resolve) => setTimeout(resolve, 500));
      mock.submit("STEER_MIDTURN_TEXT");
      await new Promise((resolve) => setTimeout(resolve, 300));

      const call2 = await brain.waitForCall(TIMEOUT);
      const summary = summarize(call2.request.messages);
      assert.ok(
        summary.some((m) => m.includes("STEER_MIDTURN_TEXT")),
        `mid-turn steer must appear in the same turn's next brain call:\n${summary.join("\n")}`,
      );
      call2.respond(text("STEER_FINAL_RESPONSE"));
      await mock.waitForOutput("STEER_FINAL_RESPONSE", TIMEOUT);

      const tail = await Promise.race([
        brain.waitForCall(2_000).then((c) => c).catch(() => null),
      ]);
      assert.equal(
        tail,
        null,
        "steered text must not also trigger a separate follow-up turn",
      );
    } finally {
      await mock.close();
      await removeRoot(root);
    }
  },
);

test(
  "pi-sync mid-turn steer from a peer terminal reaches the active host turn",
  { timeout: 120_000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sync-steer-peer-"));
    const sessionFile = join(root, "shared.jsonl");
    const piWrapper = writePiWrapper(root);
    writeFileSync(sessionFile, "", "utf8");
    const brain = createControllableBrain();
    const common = {
      brain: brain.brain,
      extensions: [EXTENSION],
      piProvider: "pi-mock",
      piModel: "mock",
      startupTimeoutMs: 20_000,
      terminal: { cols: 110, rows: 32 },
      cwd: root,
      env: { PI_LANE_ROOT: join(root, "lane"), PI_SYNC_POLL_MS: "25", PI_SYNC_HOST_IDLE_MS: "5000" },
      piBinary: piWrapper,
      piArgs: ["--session", sessionFile],
    };
    const submitter = await createInteractiveMock(common);
    const steerer = await createInteractiveMock(common);
    try {
      submitter.submit("PEER_STEER_PROMPT");
      const call1 = await brain.waitForCall(TIMEOUT);
      call1.respond(bash("sleep 2 && echo peer-step"));

      await steerer.waitForOutput("PEER_STEER_PROMPT", TIMEOUT);
      await new Promise((resolve) => setTimeout(resolve, 500));
      steerer.submit("PEER_STEER_TEXT");
      await new Promise((resolve) => setTimeout(resolve, 300));

      const call2 = await brain.waitForCall(TIMEOUT);
      const summary = summarize(call2.request.messages);
      assert.ok(
        summary.some((m) => m.includes("PEER_STEER_TEXT")),
        `peer's mid-turn steer must appear in the active host turn:\n${summary.join("\n")}`,
      );
      call2.respond(text("PEER_STEER_DONE"));
      await submitter.waitForOutput("PEER_STEER_DONE", TIMEOUT);
      await steerer.waitForOutput("PEER_STEER_DONE", TIMEOUT);
    } finally {
      await submitter.close();
      await steerer.close();
      await removeRoot(root);
    }
  },
);
