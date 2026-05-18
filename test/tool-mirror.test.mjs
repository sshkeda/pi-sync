import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInteractiveMock, toolCall, text } from '../../pi-mock/dist/index.js';

const EXTENSION = new URL('../index.ts', import.meta.url).pathname;
const TIMEOUT = 45_000;

function writePiWrapper(root) {
  const piWrapper = join(root, 'pi-wrapper.sh');
  writeFileSync(piWrapper, `#!/usr/bin/env bash\nargs=()\nfor a in "$@"; do [[ "$a" == "--no-session" ]] && continue; args+=("$a"); done\nexec "${process.env.PI_SYNC_TEST_PI_BINARY ?? 'pi'}" "\${args[@]}"\n`);
  chmodSync(piWrapper, 0o755);
  return piWrapper;
}

test('pi-sync mirrors native tool execution lifecycle to an attached terminal', { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-tool-'));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'shared.jsonl');
  const piWrapper = writePiWrapper(root);
  const probeExtension = join(root, 'sync-probe-tool.mjs');
  writeFileSync(sessionFile, '', 'utf8');
  writeFileSync(probeExtension, `
export default function syncProbeTool(pi) {
  pi.registerTool({
    name: 'sync_probe_tool',
    label: 'Sync Probe Tool',
    description: 'Deterministic pi-sync test tool',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      return { content: [{ type: 'text', text: 'SYNC_TOOL_OUTPUT' }] };
    },
  });
}
`);

  const brain = (req) => {
    const transcript = JSON.stringify(req.messages ?? []);
    if (transcript.includes('SYNC_TOOL_OUTPUT')) return text('SYNC_TOOL_FINAL');
    return toolCall('sync_probe_tool', {});
  };

  const common = {
    brain,
    extensions: [EXTENSION, probeExtension],
    piProvider: 'pi-mock',
    piModel: 'mock',
    startupTimeoutMs: 20_000,
    terminal: { cols: 110, rows: 34 },
    cwd: root,
    env: { PI_LANE_ROOT: laneRoot, PI_SYNC_POLL_MS: '25', PI_SYNC_HOST_IDLE_MS: '1000' },
    piBinary: piWrapper,
    piArgs: ['--session', sessionFile],
  };

  const a = await createInteractiveMock(common);
  const b = await createInteractiveMock(common);
  try {
    a.clearOutput();
    b.clearOutput();
    a.submit('run the sync tool mirror test');

    await a.waitForOutput('SYNC_TOOL_OUTPUT', TIMEOUT);
    await a.waitForOutput('SYNC_TOOL_FINAL', TIMEOUT);
    await b.waitForOutput('SYNC_TOOL_OUTPUT', TIMEOUT);
    await b.waitForOutput('SYNC_TOOL_FINAL', TIMEOUT);

    const screen = (await b.visibleScreen()).join('\n');
    assert.match(screen, /SYNC_TOOL_OUTPUT/);
    assert.match(screen, /SYNC_TOOL_FINAL/);
  } finally {
    await a.close();
    await b.close();
    rmSync(root, { recursive: true, force: true });
  }
});
