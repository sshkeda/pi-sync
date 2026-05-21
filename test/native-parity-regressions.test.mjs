import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInteractiveMock, createControllableBrain, text } from '../../pi-mock/dist/index.js';

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

function latestUserText(request) {
  const userMessages = (request.messages ?? []).filter((message) => message.role === 'user');
  const content = userMessages.at(-1)?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => part?.type === 'text' || part?.type === 'input_text' ? part.text : '').join('');
}

nodeTest('pi-sync lets later input handlers see interactive input before the host prompt is sent', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-input-order-'));
  const sessionFile = join(root, 'shared.jsonl');
  const markerFile = join(root, 'input-marker.jsonl');
  const helperExt = join(root, 'input-observer.mjs');
  const brain = createControllableBrain();
  writeFileSync(sessionFile, '', 'utf8');
  writeFileSync(helperExt, `
import { appendFileSync } from 'node:fs';
export default function inputObserver(pi) {
  pi.on('input', (event) => {
    appendFileSync(${JSON.stringify(markerFile)}, JSON.stringify({ source: event.source, text: event.text }) + '\\n');
    return undefined;
  });
}
`, 'utf8');

  const mock = await createInteractiveMock({
    brain: brain.brain,
    // pi-sync first intentionally matches the common package-load hazard: a
    // handled result must not starve normal observer/transform hooks forever.
    extensions: [EXTENSION, helperExt],
    piProvider: 'pi-mock',
    piModel: 'mock',
    startupTimeoutMs: 20_000,
    terminal: { cols: 110, rows: 34 },
    cwd: root,
    env: { PI_LANE_ROOT: join(root, 'lane'), PI_SYNC_POLL_MS: '25', PI_SYNC_HOST_IDLE_MS: '1000' },
    piBinary: writePiWrapper(root),
    piArgs: ['--session', sessionFile],
  });

  try {
    mock.submit('SYNC_INPUT_ORDER_PROMPT');
    const call = await brain.waitForCall(TIMEOUT);
    call.respond(text('SYNC_INPUT_ORDER_DONE'));
    await mock.waitForOutput('SYNC_INPUT_ORDER_DONE', TIMEOUT);

    assert.ok(existsSync(markerFile), 'later input observer should be called for interactive input');
    const events = readFileSync(markerFile, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(events.some((event) => event.source === 'interactive' && event.text === 'SYNC_INPUT_ORDER_PROMPT'), `missing interactive input event after pi-sync handler; saw ${JSON.stringify(events)}`);
  } finally {
    await mock.close();
    await removeRoot(root);
  }
});

nodeTest('pi-sync preserves input transforms before forwarding to the host', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-input-transform-'));
  const sessionFile = join(root, 'shared.jsonl');
  const helperExt = join(root, 'input-transformer.mjs');
  const brain = createControllableBrain();
  writeFileSync(sessionFile, '', 'utf8');
  writeFileSync(helperExt, `
export default function inputTransformer(pi) {
  pi.on('input', (event) => {
    if (event.text === 'SYNC_TRANSFORM_ORIGINAL') return { action: 'transform', text: 'SYNC_TRANSFORMED_FOR_HOST' };
    return undefined;
  });
}
`, 'utf8');

  const mock = await createInteractiveMock({
    brain: brain.brain,
    extensions: [EXTENSION, helperExt],
    piProvider: 'pi-mock',
    piModel: 'mock',
    startupTimeoutMs: 20_000,
    terminal: { cols: 110, rows: 34 },
    cwd: root,
    env: { PI_LANE_ROOT: join(root, 'lane'), PI_SYNC_POLL_MS: '25', PI_SYNC_HOST_IDLE_MS: '1000' },
    piBinary: writePiWrapper(root),
    piArgs: ['--session', sessionFile],
  });

  try {
    mock.submit('SYNC_TRANSFORM_ORIGINAL');
    const call = await brain.waitForCall(TIMEOUT);
    assert.equal(latestUserText(call.request), 'SYNC_TRANSFORMED_FOR_HOST');
    call.respond(text('SYNC_TRANSFORM_DONE'));
    await mock.waitForOutput('SYNC_TRANSFORM_DONE', TIMEOUT);
  } finally {
    await mock.close();
    await removeRoot(root);
  }
});

nodeTest('pi-sync runs before_agent_start system prompt hooks on the host turn like native Pi', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-before-agent-system-'));
  const sessionFile = join(root, 'shared.jsonl');
  const helperExt = join(root, 'before-agent-system-helper.mjs');
  const brain = createControllableBrain();
  writeFileSync(sessionFile, '', 'utf8');
  writeFileSync(helperExt, `
export default function beforeAgentSystemHelper(pi) {
  pi.on('before_agent_start', (event) => ({
    systemPrompt: event.systemPrompt + '\\nBEFORE_AGENT_SYSTEM_MARKER',
  }));
}
`, 'utf8');

  const mock = await createInteractiveMock({
    brain: brain.brain,
    extensions: [EXTENSION, helperExt],
    piProvider: 'pi-mock',
    piModel: 'mock',
    startupTimeoutMs: 20_000,
    terminal: { cols: 110, rows: 34 },
    cwd: root,
    env: { PI_LANE_ROOT: join(root, 'lane'), PI_SYNC_POLL_MS: '25', PI_SYNC_HOST_IDLE_MS: '1000' },
    piBinary: writePiWrapper(root),
    piArgs: ['--session', sessionFile],
  });

  try {
    mock.submit('SYNC_BEFORE_AGENT_SYSTEM_PROMPT');
    const call = await brain.waitForCall(TIMEOUT);
    assert.match(JSON.stringify(call.request.system), /BEFORE_AGENT_SYSTEM_MARKER/, 'host request should include before_agent_start system prompt mutation');
    call.respond(text('SYNC_BEFORE_AGENT_SYSTEM_DONE'));
    await mock.waitForOutput('SYNC_BEFORE_AGENT_SYSTEM_DONE', TIMEOUT);
  } finally {
    await mock.close();
    await removeRoot(root);
  }
});

nodeTest('pi-sync runs extension slash commands immediately during an active host turn like native Pi', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-command-midturn-'));
  const sessionFile = join(root, 'shared.jsonl');
  const helperExt = join(root, 'command-helper.mjs');
  const brain = createControllableBrain();
  writeFileSync(sessionFile, '', 'utf8');
  writeFileSync(helperExt, `
export default function commandHelper(pi) {
  pi.registerCommand('_parity_ping', {
    description: 'notify immediately',
    handler: async (_args, ctx) => ctx.ui.notify('PARITY_COMMAND_RAN', 'info'),
  });
}
`, 'utf8');

  const mock = await createInteractiveMock({
    brain: brain.brain,
    extensions: [EXTENSION, helperExt],
    piProvider: 'pi-mock',
    piModel: 'mock',
    startupTimeoutMs: 20_000,
    terminal: { cols: 110, rows: 34 },
    cwd: root,
    env: { PI_LANE_ROOT: join(root, 'lane'), PI_SYNC_POLL_MS: '25', PI_SYNC_HOST_IDLE_MS: '5000' },
    piBinary: writePiWrapper(root),
    piArgs: ['--session', sessionFile],
  });

  try {
    mock.submit('SYNC_COMMAND_MIDTURN_PROMPT');
    const activeCall = await brain.waitForCall(TIMEOUT);
    await mock.waitForOutput('SYNC_COMMAND_MIDTURN_PROMPT', TIMEOUT);

    mock.clearOutput();
    mock.submit('/_parity_ping');
    await mock.waitForOutput('PARITY_COMMAND_RAN', 2_000);

    activeCall.respond(text('SYNC_COMMAND_MIDTURN_DONE'));
    await mock.waitForOutput('SYNC_COMMAND_MIDTURN_DONE', TIMEOUT);
  } finally {
    await mock.close();
    await removeRoot(root);
  }
});
