#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInteractiveMock, script, text } from '../../pi-mock/dist/index.js';

const EXTENSION = new URL('../index.ts', import.meta.url).pathname;
const PI_BINARY = process.env.PI_SYNC_TEST_PI_BINARY ?? 'pi';
const timeout = Number(process.env.PI_SYNC_BENCH_TIMEOUT_MS ?? 30_000);
const iterations = Number(process.env.PI_SYNC_BENCH_N ?? 7);
const rates = (process.argv[2]?.split(',') ?? ['100', '50', '25', '10']).map((v) => Number(v.trim())).filter(Boolean);

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

function p95(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)] ?? 0;
}

function writePiWrapper(root) {
  const piWrapper = join(root, 'pi-wrapper.sh');
  writeFileSync(piWrapper, `#!/usr/bin/env bash\nargs=()\nfor a in "$@"; do [[ "$a" == "--no-session" ]] && continue; args+=("$a"); done\nexec "${PI_BINARY}" "\${args[@]}"\n`);
  chmodSync(piWrapper, 0o755);
  return piWrapper;
}

async function runRate(pollMs) {
  const root = mkdtempSync(join(tmpdir(), `pi-sync-bench-${pollMs}-`));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'shared.jsonl');
  const piWrapper = writePiWrapper(root);
  writeFileSync(sessionFile, '', 'utf8');

  const responses = Array.from({ length: iterations }, (_, i) => text(`SYNC_BENCH_RESPONSE_${pollMs}_${i}`));
  const common = {
    brain: script(...responses),
    extensions: [EXTENSION],
    piProvider: 'pi-mock',
    piModel: 'mock',
    startupTimeoutMs: 20_000,
    terminal: { cols: 100, rows: 30 },
    cwd: root,
    env: { PI_LANE_ROOT: laneRoot, PI_SYNC_POLL_MS: String(pollMs), PI_SYNC_HOST_IDLE_MS: '1000' },
    piBinary: piWrapper,
    piArgs: ['--session', sessionFile],
  };

  const a = await createInteractiveMock(common);
  const b = await createInteractiveMock(common);
  const rows = [];
  try {
    a.clearOutput();
    b.clearOutput();
    for (let i = 0; i < iterations; i++) {
      const prompt = `SYNC_BENCH_PROMPT_${pollMs}_${i}`;
      const response = `SYNC_BENCH_RESPONSE_${pollMs}_${i}`;
      const t0 = performance.now();
      a.submit(prompt);
      const pa = a.waitForOutput(response, timeout).then(() => performance.now());
      const pb = b.waitForOutput(response, timeout).then(() => performance.now());
      const [ta, tb] = await Promise.all([pa, pb]);
      rows.push({ i, localMs: ta - t0, remoteMs: tb - t0, syncOverheadMs: tb - ta });
      // Give agent_end/session flush a small window before the next prompt.
      await new Promise((r) => setTimeout(r, Math.max(30, pollMs * 2)));
    }
  } finally {
    await a.close();
    await b.close();
    rmSync(root, { recursive: true, force: true });
  }
  assert.equal(rows.length, iterations);
  return rows;
}

console.log(`# pi-sync latency benchmark`);
console.log(`iterations=${iterations}`);
console.log(`metric: remote-overhead = time(B sees response) - time(A sees response)`);
console.log(`note: push/native bus lower bound should be near renderer+IPC cost, typically single-digit ms; polling adds ~pollMs/2 average and ~pollMs worst-case per event burst.\n`);

const all = [];
for (const rate of rates) {
  const rows = await runRate(rate);
  const overhead = rows.map((r) => r.syncOverheadMs);
  const local = rows.map((r) => r.localMs);
  const remote = rows.map((r) => r.remoteMs);
  all.push({ rate, rows, overhead });
  console.log(`PI_SYNC_POLL_MS=${rate}`);
  console.log(`  local median=${median(local).toFixed(1)}ms remote median=${median(remote).toFixed(1)}ms`);
  console.log(`  sync overhead median=${median(overhead).toFixed(1)}ms p95=${p95(overhead).toFixed(1)}ms max=${Math.max(...overhead).toFixed(1)}ms`);
}

const baseline = all.find((r) => r.rate === 100) ?? all[0];
const fast = all[all.length - 1];
if (baseline && fast && baseline !== fast) {
  const speedup = median(baseline.overhead) / Math.max(1, median(fast.overhead));
  console.log(`\nobserved overhead speedup ${baseline.rate}ms → ${fast.rate}ms polling: ${speedup.toFixed(1)}x`);
}
console.log(`projected push bus vs 100ms polling: roughly 10x–50x lower sync overhead for small event bursts; no change to model/tool execution time.`);
