import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInteractiveMock, createControllableBrain, text } from '../../pi-mock/dist/index.js';

const EXTENSION = new URL('../index.ts', import.meta.url).pathname;
const TIMEOUT = 30_000;
const PROVIDER = 'anthropic';
const MODEL = 'claude-3-7-sonnet-20250219';

function writePiWrapper(root) {
  const piWrapper = join(root, 'pi-wrapper.sh');
  writeFileSync(piWrapper, `#!/usr/bin/env bash\nargs=()\nfor a in "$@"; do [[ "$a" == "--no-session" ]] && continue; args+=("$a"); done\nexec "${process.env.PI_SYNC_TEST_PI_BINARY ?? 'pi'}" "\${args[@]}"\n`);
  chmodSync(piWrapper, 0o755);
  return piWrapper;
}

async function removeRoot(root) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try { rmSync(root, { recursive: true, force: true }); return; }
    catch (error) {
      if (attempt === 4 || !['ENOTEMPTY', 'EBUSY', 'ENOENT'].includes(error?.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

function seedThinkingSession(sessionFile, root) {
  const now = new Date().toISOString();
  writeFileSync(sessionFile, [
    JSON.stringify({ type: 'session', version: 3, id: 'thinking-parity', timestamp: now, cwd: root }),
    JSON.stringify({ type: 'model_change', id: 'm0', parentId: null, timestamp: now, provider: PROVIDER, modelId: MODEL }),
    JSON.stringify({ type: 'thinking_level_change', id: 't0', parentId: 'm0', timestamp: now, thinkingLevel: 'xhigh' }),
  ].join('\n') + '\n', 'utf8');
}

test('pi-sync forwards restored reasoning/thinking level to host request like native Pi', { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-thinking-parity-'));
  const sessionFile = join(root, 'shared.jsonl');
  const brain = createControllableBrain();
  seedThinkingSession(sessionFile, root);

  const mock = await createInteractiveMock({
    brain: brain.brain,
    extensions: [EXTENSION],
    piProvider: PROVIDER,
    piModel: MODEL,
    startupTimeoutMs: 20_000,
    terminal: { cols: 110, rows: 34 },
    cwd: root,
    env: { PI_LANE_ROOT: join(root, 'lane'), PI_SYNC_POLL_MS: '25', PI_SYNC_HOST_IDLE_MS: '1000' },
    piBinary: writePiWrapper(root),
    piArgs: ['--session', sessionFile],
  });

  try {
    mock.submit('SYNC_THINKING_PARITY_PROMPT');
    const call = await brain.waitForCall(TIMEOUT);
    assert.deepEqual(
      call.request.thinking,
      { type: 'enabled', budget_tokens: 8192, display: 'summarized' },
      `expected Anthropic thinking params from restored xhigh level; request keys=${Object.keys(call.request).join(',')}`,
    );
    call.respond(text('SYNC_THINKING_PARITY_DONE'));
    await mock.waitForOutput('SYNC_THINKING_PARITY_DONE', TIMEOUT);
  } finally {
    await mock.close();
    await removeRoot(root);
  }
});
