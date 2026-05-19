import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInteractiveMock, createControllableBrain } from '../../pi-mock/dist/index.js';

const EXTENSION = new URL('../index.ts', import.meta.url).pathname;
const TIMEOUT = 30_000;

function writePiWrapper(root) {
  const piWrapper = join(root, 'pi-wrapper.sh');
  writeFileSync(piWrapper, `#!/usr/bin/env bash\nargs=()\nfor a in "$@"; do [[ "$a" == "--no-session" ]] && continue; args+=("$a"); done\nexec "${process.env.PI_SYNC_TEST_PI_BINARY ?? 'pi'}" "\${args[@]}"\n`);
  chmodSync(piWrapper, 0o755);
  return piWrapper;
}

async function removeRoot(root) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 4 || !['ENOTEMPTY', 'EBUSY', 'ENOENT'].includes(error?.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

test('pi-sync lane status counts live terminals per lane and numeric join resolves display ids', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-lane-command-'));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'shared.jsonl');
  const piWrapper = writePiWrapper(root);
  const brain = createControllableBrain();
  writeFileSync(sessionFile, '', 'utf8');

  const common = {
    brain: brain.brain,
    extensions: [EXTENSION],
    piProvider: 'pi-mock',
    piModel: 'mock',
    startupTimeoutMs: 20_000,
    terminal: { cols: 120, rows: 32 },
    cwd: root,
    env: { PI_LANE_ROOT: laneRoot, PI_SYNC_POLL_MS: '25', PI_SYNC_HOST_IDLE_MS: '1000', PI_SYNC_INSTANCE_STALE_MS: '5000' },
    piBinary: piWrapper,
    piArgs: ['--session', sessionFile],
  };

  const a = await createInteractiveMock(common);
  const b = await createInteractiveMock(common);
  try {
    a.clearOutput();
    b.clearOutput();

    a.submit('/lane new side');
    await a.waitForOutput(/created and joined side/, TIMEOUT);

    a.clearOutput();
    a.submit('/lane status');
    await a.waitForOutput(/current L2 \(side\)[\s\S]*connected 1/, TIMEOUT);

    b.clearOutput();
    b.submit('/lane status');
    await b.waitForOutput(/current L1 \(main\)[\s\S]*connected 1/, TIMEOUT);

    b.clearOutput();
    b.submit('/lane join 2');
    await b.waitForOutput(/joined L2 \(side\)/, TIMEOUT);

    b.clearOutput();
    b.submit('/lane status');
    await b.waitForOutput(/current L2 \(side\)[\s\S]*connected 2/, TIMEOUT);

    const screen = (await b.visibleScreen()).join('\n');
    assert.doesNotMatch(screen, /no lane 2/, screen);
  } finally {
    await a.close();
    await b.close();
    await removeRoot(root);
  }
});
