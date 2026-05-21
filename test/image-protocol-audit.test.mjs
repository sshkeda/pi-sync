import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const INDEX = new URL('../index.ts', import.meta.url).pathname;
const HOST = new URL('../bin/pi-sync-host.js', import.meta.url).pathname;

test('pi-sync host prompt protocol carries interactive image attachments', () => {
  const index = readFileSync(INDEX, 'utf8');
  const host = readFileSync(HOST, 'utf8');

  const hostPromptType = index.match(/type HostPrompt = \{[\s\S]*?\n\};/)?.[0] ?? '';
  assert.match(hostPromptType, /images\??:/, 'HostPrompt should include image attachments from Pi input events');

  const inputHandler = index.match(/pi\.on\("input"[\s\S]*?return undefined;\n  \}\);/)?.[0] ?? '';
  assert.match(inputHandler, /event\.images/, 'input handler should read event.images without unsafe casts');
  assert.match(inputHandler, /sendHostPrompt\([\s\S]*\.images\)/, 'input handler should forward images to host prompts');

  assert.match(host, /images/, 'host socket prompt handling should preserve images');
  assert.match(host, /agentSession\.prompt\([^)]*images/s, 'host should pass images to agentSession.prompt options');
});
