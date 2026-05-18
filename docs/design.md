# pi-sync design

## Not a CLI

`pi-sync` is the underlying mechanism that makes multiple `pi --session <id>` processes act as attached views of the same live session.

## Roles

- **session lane**: a `pi-lane` coordination scope keyed by session id/file.
- **executor**: the process currently running the model/tool turn.
- **attached view**: any terminal UI attached to the same session lane.
- **event bus**: append/fanout stream of Pi UI/runtime events.

## Event model

Borrow from `pi-manager` telemetry capture:

- `attach` / `detach`
- `input`
- `queued_input`
- `agent_start`
- `message_start`
- `message_update`
- `message_end`
- `tool_call`
- `tool_result`
- `tool_execution_start`
- `tool_execution_update`
- `tool_execution_end`
- `agent_end`

The difference: pi-manager consumes one foreground stream; pi-sync broadcasts the canonical stream to all attached views. Native attached UIs replay supported remote events through `ctx.ui.replayAgentEvent(event)` when the Pi core replay patch is present.

## Expected flow

1. `pi --session X` starts.
2. It joins storage at `~/.pi/lane/sessions/{sessionKey}/lanes/{lane}/sync`.
3. It hydrates normal Pi history from the session JSONL file.
4. It subscribes to live lane events by tailing `events.jsonl`.
5. If user submits input and no executor is active, it claims the executor lease using `turn.lock/owner.json`.
6. Executor emits canonical events to the lane.
7. All attached views render those events through native replay or widget fallback.
8. If a follower submits input while the executor lease is fresh, it writes `queued_input`; the active owner converts that into a follow-up user message.
9. Late joiners replay from the current active turn's byte offset and then keep tailing live events.

## Visual sync target

For a deterministic test, two attached TUI panes should have visually identical visible screens after each event tick, except for optional local chrome like cursor focus.

## Test strategy

Use `pi-mock` interactive/video tests:

- launch two real Pi processes with the same session
- send prompt into A
- assert B receives/render same user prompt and assistant response
- take repeated screenshots/visibleScreen snapshots
- assert visual diff below threshold or exact screen text match

The current extension is already useful, but the long-term target is still to move the shared event stream into Pi core so multi-attach is a first-class `pi --session X` behavior rather than extension-mediated polling.
