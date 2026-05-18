import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOST = new URL('../bin/pi-sync-host.js', import.meta.url).pathname;

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`pi-sync-host did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function livePids(pids) {
  const out = execFileSync('ps', ['-axo', 'pid=,stat='], { encoding: 'utf8' });
  const live = new Set(out.trim().split(/\n/).map((line) => {
    const [pid, stat] = line.trim().split(/\s+/);
    return stat?.startsWith('Z') ? undefined : Number(pid);
  }).filter(Boolean));
  return pids.filter((pid) => live.has(pid));
}

test('pi-sync-host exits after idle timeout when no clients remain', { timeout: 10_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-host-idle-'));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'session.jsonl');
  writeFileSync(sessionFile, '', 'utf8');

  const child = spawn(process.execPath, [
    HOST,
    '--session-file', sessionFile,
    '--session-key', 'idle-test',
    '--lane', 'main',
  ], {
    cwd: root,
    env: {
      ...process.env,
      PI_LANE_ROOT: laneRoot,
      PI_SYNC_HOST_IDLE_MS: '300',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  try {
    const result = await waitForExit(child, 5_000);
    assert.deepEqual(result, { code: 0, signal: null });
    assert.equal(stderr, '');
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    rmSync(root, { recursive: true, force: true });
  }
});

test('pi-sync-host initializes empty short-id session files with the filename id', { timeout: 10_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-host-short-id-'));
  const laneRoot = join(root, 'lane');
  const shortId = 'ShortId12345';
  const sessionFile = join(root, `2026-05-18T04-20-00-000Z_${shortId}.jsonl`);
  writeFileSync(sessionFile, '', 'utf8');

  const child = spawn(process.execPath, [
    HOST,
    '--session-file', sessionFile,
    '--session-key', 'short-id-test',
    '--lane', 'main',
  ], {
    cwd: root,
    env: {
      ...process.env,
      PI_LANE_ROOT: laneRoot,
      PI_SYNC_HOST_IDLE_MS: '300',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForExit(child, 5_000);
    const header = JSON.parse(readFileSync(sessionFile, 'utf8').split(/\r?\n/)[0]);
    assert.equal(header.id, shortId);
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    rmSync(root, { recursive: true, force: true });
  }
});

test('pi-sync-host fresh startup lock prevents duplicate same-session hosts', { timeout: 10_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-sync-host-lock-'));
  const laneRoot = join(root, 'lane');
  const sessionFile = join(root, 'session.jsonl');
  const sessionKey = 'lock-test';
  writeFileSync(sessionFile, '', 'utf8');

  const children = Array.from({ length: 12 }, () => spawn(process.execPath, [
    HOST,
    '--session-file', sessionFile,
    '--session-key', sessionKey,
    '--lane', 'main',
  ], {
    cwd: root,
    env: {
      ...process.env,
      PI_LANE_ROOT: laneRoot,
      PI_SYNC_HOST_IDLE_MS: '1000',
      PI_SYNC_HOST_LEASE_MS: '5000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }));

  try {
    await sleep(750);
    assert.ok(livePids(children.map((child) => child.pid)).length <= 1, 'only one host process may survive startup');

    const hostEventsPath = join(laneRoot, 'sessions', sessionKey, 'lanes', 'main', 'sync', 'host-events.jsonl');
    const hostStarts = existsSync(hostEventsPath)
      ? readFileSync(hostEventsPath, 'utf8').split(/\n/).filter((line) => line.includes('"type":"host_start"')).length
      : 0;
    assert.equal(hostStarts, 1, 'only one host should emit host_start for a session/lane');
  } finally {
    for (const child of children) {
      if (child.exitCode === null) child.kill('SIGTERM');
    }
    await Promise.allSettled(children.map((child) => waitForExit(child, 2_000)));
    rmSync(root, { recursive: true, force: true });
  }
});
