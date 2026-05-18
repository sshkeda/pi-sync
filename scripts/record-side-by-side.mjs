#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createInteractiveMock, streamText } from '../../pi-mock/dist/index.js';

const PI_BINARY = process.env.PI_SYNC_TEST_PI_BINARY ?? 'pi';
const OUT = process.argv[2] ?? './artifacts/pi-sync-side-by-side.mp4';
const FPS = Number(process.env.PI_SYNC_RECORD_FPS ?? 12);
const TIMEOUT = Number(process.env.PI_SYNC_RECORD_TIMEOUT_MS ?? 30_000);

function requireCommand(cmd) {
  try { execFileSync('/usr/bin/env', ['bash', '-lc', `command -v ${cmd}`], { stdio: 'ignore' }); }
  catch { throw new Error(`Missing required command: ${cmd}`); }
}

function writePiWrapper(root) {
  const piWrapper = join(root, 'pi-wrapper.sh');
  writeFileSync(piWrapper, `#!/usr/bin/env bash\nargs=()\nfor a in "$@"; do\n  case "$a" in\n    --no-session|--no-extensions|--no-skills|--no-prompt-templates) continue ;;\n  esac\n  args+=("$a")\ndone\nexec "${PI_BINARY}" "\${args[@]}"\n`);
  chmodSync(piWrapper, 0o755);
  return piWrapper;
}

function makeRegularAgentDir(root, name, port) {
  const source = process.env.PI_SYNC_RECORD_SOURCE_AGENT_DIR ?? process.env.HOME + '/.pi/agent';
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });

  const settings = JSON.parse(readFileSync(join(source, 'settings.json'), 'utf8'));
  settings.defaultProvider = 'pi-mock';
  settings.defaultModel = 'mock';
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings, null, 2));

  let models = { providers: {} };
  try { models = JSON.parse(readFileSync(join(source, 'models.json'), 'utf8')); } catch {}
  models.providers ??= {};
  models.providers['pi-mock'] = {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    api: 'anthropic-messages',
    apiKey: 'mock-key',
    models: [{ id: 'mock', name: 'pi-mock' }],
  };
  writeFileSync(join(dir, 'models.json'), JSON.stringify(models, null, 2));

  for (const entry of ['extensions', 'skills', 'themes', 'prompts']) {
    const p = join(source, entry);
    if (existsSync(p)) symlinkSync(p, join(dir, entry), 'dir');
  }
  return dir;
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function stableSessionKey(sessionFile) {
  return createHash('sha256').update(sessionFile).digest('hex').slice(0, 24);
}

async function waitUntil(predicate, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await sleep(25);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function main() {
  requireCommand('sips');
  requireCommand('magick');
  requireCommand('ffmpeg');
  mkdirSync(dirname(OUT), { recursive: true });

  const root = mkdtempSync(join(tmpdir(), 'pi-sync-record-'));
  const framesDir = join(root, 'frames');
  mkdirSync(framesDir, { recursive: true });
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'shared.jsonl');
  const piWrapper = writePiWrapper(root);
  writeFileSync(sessionFile, '', 'utf8');

  let requestIndex = 0;
  const brain = () => {
    const i = requestIndex++;
    if (i === 0) {
      return streamText([
        'STREAMING_CHUNK_1 ',
        'STREAMING_CHUNK_2 ',
        'STREAMING_CHUNK_3 ',
        'STREAMING_DONE_ON_BOTH_TERMINALS',
      ], 350);
    }
    return streamText([
      'QUEUED_FOLLOWUP_CHUNK_1 ',
      'QUEUED_FOLLOWUP_DONE_ON_BOTH',
    ], 300);
  };

  const portA = Number(process.env.PI_SYNC_RECORD_PORT_A ?? 19371);
  const portB = Number(process.env.PI_SYNC_RECORD_PORT_B ?? 19372);
  const agentDirA = makeRegularAgentDir(root, 'agent-a', portA);
  const agentDirB = makeRegularAgentDir(root, 'agent-b', portB);
  const baseOptions = {
    brain,
    piProvider: 'pi-mock',
    piModel: 'mock',
    startupTimeoutMs: 20_000,
    terminal: { cols: 80, rows: 40 },
    cwd: root,
    piBinary: piWrapper,
    piArgs: ['--session', sessionFile],
  };

  const a = await createInteractiveMock({
    ...baseOptions,
    port: portA,
    env: { PI_CODING_AGENT_DIR: agentDirA, PI_LANE_ROOT: laneRoot, PI_SYNC_POLL_MS: '25', PI_SYNC_TURN_LEASE_MS: '30000', PI_SYNC_HOST_IDLE_MS: '1000' },
  });
  const b = await createInteractiveMock({
    ...baseOptions,
    port: portB,
    env: { PI_CODING_AGENT_DIR: agentDirB, PI_LANE_ROOT: laneRoot, PI_SYNC_POLL_MS: '25', PI_SYNC_TURN_LEASE_MS: '30000', PI_SYNC_HOST_IDLE_MS: '1000' },
  });
  let frame = 0;

  function canonicalRegion(lines) {
    const footerIndex = lines.findIndex((line) =>
      line.includes(root) || /^session id: /.test(line.trim()) || /%\//.test(line) && /\bmock\b/.test(line)
    );
    const region = footerIndex >= 0 ? lines.slice(0, footerIndex) : lines;
    return region
      .map((line) => line.trimEnd())
      // Animated pi-aura/editor border lines are local chrome. The transcript
      // content above them must match; border phase/width/count may differ.
      .filter((line) => !/^─+$/.test(line.trim()))
      // pi-working is intentionally local owner chrome; the synced transcript
      // must match even when only the active terminal shows the working timer.
      .filter((line) => !/^[\s⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]*Work(?:ing|ed) for \d/.test(line.trim()))
      .join('\n')
      .trimEnd();
  }

  async function assertCanonicalRegionsMatch(label) {
    const left = canonicalRegion(await a.visibleScreen());
    const right = canonicalRegion(await b.visibleScreen());
    if (left !== right) {
      throw new Error(`canonical region mismatch at '${label}'\n--- left ---\n${left}\n--- right ---\n${right}`);
    }
  }

  async function capture(label, copies = 1, options = {}) {
    if (!options.skipCanonicalAssert) await assertCanonicalRegionsMatch(label);
    const n = String(frame++).padStart(4, '0');
    const left = join(framesDir, `left-${n}.svg`);
    const right = join(framesDir, `right-${n}.svg`);
    const leftPng = join(framesDir, `left-${n}.png`);
    const rightPng = join(framesDir, `right-${n}.png`);
    const png = join(framesDir, `frame-${n}.png`);
    const shotOptions = { fontFamily: 'Monaco', fontSize: 10, cellWidth: 6.2, cellHeight: 13 };
    await a.screenshot({ path: left, title: `A / owner — ${label}`, ...shotOptions });
    await b.screenshot({ path: right, title: `B / attached — ${label}`, ...shotOptions });
    // sips renders pi-mock SVGs reliably on macOS; ImageMagick appends PNGs.
    execFileSync('sips', ['-s', 'format', 'png', left, '--out', leftPng], { stdio: 'ignore' });
    execFileSync('sips', ['-s', 'format', 'png', right, '--out', rightPng], { stdio: 'ignore' });
    execFileSync('magick', [leftPng, rightPng, '+append', png]);
    for (let i = 1; i < copies; i++) {
      const copy = join(framesDir, `frame-${String(frame++).padStart(4, '0')}.png`);
      execFileSync('cp', [png, copy]);
    }
  }

  try {
    // Keep startup/resources visible long enough to prove the normal config is loaded
    // (skills, pi-aura, theme scanner, packages, etc.). Skip canonical assert here
    // because startup resource discovery can race by a frame.
    await capture('normal config startup: pi-aura + scanner theme loaded', 18, { skipCanonicalAssert: true });

    // Show the animated editor/aura border while idle before moving to the
    // transcript sync proof. These frames are intentionally footer/editor-heavy.
    a.type('aura border proof');
    b.type('aura border proof');
    await sleep(200);
    await capture('idle editor border / pi-aura scanner proof', 24, { skipCanonicalAssert: true });
    a.sendKey('ctrl+u');
    b.sendKey('ctrl+u');
    await sleep(100);

    a.clearOutput();
    b.clearOutput();

    a.submit('A asks first: show pi-sync live streaming');
    await a.waitForOutput('A asks first', TIMEOUT);
    await b.waitForOutput('A asks first', TIMEOUT);

    await a.waitForOutput('STREAMING_CHUNK_1', TIMEOUT);
    await b.waitForOutput('STREAMING_CHUNK_1', TIMEOUT);
    await capture('streaming chunk 1 visible on both', 2);

    b.submit('B submits while A is streaming; this should queue');
    const syncDir = join(laneRoot, 'sessions', stableSessionKey(sessionFile), 'lanes', 'main', 'sync');
    const promptQueuePath = join(syncDir, 'prompt-queue.jsonl');
    await waitUntil(
      () => existsSync(promptQueuePath)
        && readFileSync(promptQueuePath, 'utf8').includes('B submits while A is streaming'),
      TIMEOUT,
      'host prompt queue entry',
    );
    await capture('B input queued without follower-only warning chrome', 2);

    await a.waitForOutput('STREAMING_CHUNK_2', TIMEOUT);
    await b.waitForOutput('STREAMING_CHUNK_2', TIMEOUT);
    await capture('streaming chunk 2 visible on both', 2);

    await a.waitForOutput('STREAMING_CHUNK_3', TIMEOUT);
    await b.waitForOutput('STREAMING_CHUNK_3', TIMEOUT);
    await capture('streaming chunk 3 visible on both', 2);

    await a.waitForOutput('STREAMING_DONE_ON_BOTH_TERMINALS', TIMEOUT);
    await b.waitForOutput('STREAMING_DONE_ON_BOTH_TERMINALS', TIMEOUT);
    await capture('streaming final text mirrored', 2);

    await a.waitForOutput('QUEUED_FOLLOWUP_DONE_ON_BOTH', TIMEOUT);
    await b.waitForOutput('QUEUED_FOLLOWUP_DONE_ON_BOTH', TIMEOUT);
    await capture('queued B input delivered by active owner', 2);

    const pattern = join(framesDir, 'frame-%04d.png');
    execFileSync('ffmpeg', [
      '-y',
      '-framerate', String(FPS),
      '-i', pattern,
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-pix_fmt', 'yuv420p',
      OUT,
    ], { stdio: 'inherit' });
    console.log(OUT);
  } finally {
    await a.close();
    await b.close();
    if (process.env.PI_SYNC_KEEP_RECORD_TMP !== '1') rmSync(root, { recursive: true, force: true });
    else console.log(`kept tmp ${root}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
