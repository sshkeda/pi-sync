import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInteractiveMock, script, text } from '../../pi-mock/dist/index.js';

const TIMEOUT = 30_000;

test('current pi --session does not live-mirror the same session in another terminal', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-current-'));
  const sessionFile = join(root, 'shared.jsonl');
  const piWrapper = join(root, 'pi-wrapper.sh');
  writeFileSync(sessionFile, '', 'utf8');
  writeFileSync(piWrapper, `#!/usr/bin/env bash\nargs=()\nfor a in "$@"; do [[ "$a" == "--no-session" ]] && continue; args+=("$a"); done\nexec "${process.env.PI_SYNC_TEST_PI_BINARY ?? 'pi'}" "\${args[@]}"\n`);
  chmodSync(piWrapper, 0o755);

  const common = {
    brain: script(text('SYNC_TEST_ASSISTANT_RESPONSE')),
    piProvider: 'pi-mock',
    piModel: 'mock',
    startupTimeoutMs: 20_000,
    terminal: { cols: 100, rows: 28 },
    cwd: root,
    piBinary: piWrapper,
    piArgs: ['--session', sessionFile],
  };

  const a = await createInteractiveMock(common);
  const b = await createInteractiveMock(common);
  try {
    a.clearOutput();
    b.clearOutput();
    a.submit('SYNC_TEST_USER_PROMPT');
    await a.waitForOutput('SYNC_TEST_ASSISTANT_RESPONSE', TIMEOUT);

    let mirrored = true;
    try {
      await b.waitForOutput('SYNC_TEST_USER_PROMPT', 3_000);
      await b.waitForOutput('SYNC_TEST_ASSISTANT_RESPONSE', 3_000);
    } catch {
      mirrored = false;
    }

    assert.equal(mirrored, false, 'Current Pi unexpectedly live-mirrors same-session output');
  } finally {
    await a.close();
    await b.close();
    rmSync(root, { recursive: true, force: true });
  }
});
