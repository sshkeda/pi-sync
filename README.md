# pi-sync

Multi-terminal live session sharing for [Pi](https://github.com/earendil-works/pi-mono). Open the same Pi session in multiple terminal windows and they stay in sync — user input, streaming responses, tool calls, and status updates all mirror across attached terminals in real time. Late-joining terminals hydrate from session state.

```bash
pi --session <session-id-or-path>
# in another terminal
pi --session <same-session-id-or-path>
```

Both terminals attach to the same live session/lane and render the same conversation/tool/status stream.

## Target invariant

Two Pi terminals attached to the same session should behave like two views of one live session:

- user input in one view appears in both
- assistant streaming deltas appear in both
- tool calls/results/status updates appear in both
- late joiners hydrate from session JSONL + live lane state
- one active agent turn per session/lane unless explicitly forked

## Design direction

Build on `pi-lane` for lane identity, live runtime registry, and coordination. Generalize the event capture/context machinery from `pi-manager`:

- capture `message_update`, `tool_call`, `tool_result`, `tool_execution_start/update/end`, `input`, `agent_start/end`
- publish events to a same-session bus
- attached UIs subscribe and render the shared event stream
- control/input is coordinated through a session leader/lease so agents do not double-run

## Current implementation slice

`index.ts` is a Pi extension/runtime bus, and `bin/pi-sync-host.js` is the first per-session host process:

- auto-starts a fresh per-session/same-lane `pi-sync-host` on `session_start`
- host writes heartbeat/status to `~/.pi/lane/sessions/{sessionKey}/lanes/{lane}/sync/host.json`
- host listens on a short macOS-safe Unix socket under `$TMPDIR/pi-sync-*.sock` and records host lifecycle/prompt queue events
- host now owns `AgentSession` execution: normal terminal input is intercepted by attached UIs and forwarded to `pi-sync-host`
- attached terminals replay host-owned native AgentSession events; terminal Pi processes are now UI clients for normal prompts
- explicit `-e/--extension` test/local extensions are propagated into the host via `PI_SYNC_HOST_EXTENSIONS`
- uses the pi-lane root/session key/lane as shared storage
- appends live events to `~/.pi/lane/sessions/{sessionKey}/lanes/{lane}/sync/events.jsonl`
- attached same-session/same-lane peers poll the bus and de-duplicate event IDs
- with the `pi-sync` Pi core patch installed, peers replay remote agent events through `ctx.ui.replayAgentEvent(event)`, i.e. Pi's native interactive renderer
- without the core patch, `pi-sync` fails during UI startup; native replay is a hard requirement, not a fallback path
- late joiners replay from the current active turn's `turnStartOffset`
- one active agent turn per session/lane is enforced with an atomic `turn.lock/owner.json` lease and heartbeat, with stale-lock recovery
- competing attached-terminal input is published as `queued_input` and delivered by the active owner as a follow-up instead of starting a second peer model call
- followers refresh their session manager from disk before accepting input and after remote turn completion
- remote replay is serialized/awaited to preserve native renderer ordering

This is now a host-owned same-session sync substrate: normal prompts run inside `pi-sync-host`, and terminals are UI clients. Remaining hardening is around full Pi command parity, explicit host shutdown/cleanup policy, and background-job ownership details for every extension/tool edge case.

## Utilities

```bash
npm run bench:latency -- 100,25,10
npm run record:side-by-side
```

- `scripts/benchmark-latency.mjs` measures local-vs-attached render latency under different `PI_SYNC_POLL_MS` values.
- `scripts/record-side-by-side.mjs` uses pi-mock SVG screenshots, macOS `sips`, ImageMagick, and ffmpeg to create `artifacts/pi-sync-side-by-side.mp4`.

## Proof tests

- `test/current-no-live-mirror.test.mjs` documents current Pi behavior without pi-sync: two Pi processes using the same session file do **not** mirror live output.
- `test/installed-native-replay-smoke.test.mjs` proves the installed Pi stack exposes native replay before hosted prompts run.
- `test/native-live-sync.test.mjs` proves pi-sync publishes native updates from one same-session terminal to another and keeps tree navigation on the main sync lane without hidden branch lanes.
- `test/late-join-active-turn.test.mjs` proves a new attached terminal hydrates an already-active turn.
- `test/tool-mirror.test.mjs` proves tool execution output/final response mirror to an attached terminal.
- `test/turn-lease.test.mjs` proves a follower cannot start a competing same-session agent turn while another attached terminal owns the turn lease.
