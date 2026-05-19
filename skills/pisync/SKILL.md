---
name: pisync
description: Inspect Pi sync runtime identity, sync state, host health, and live instances. Use when checking current Pi session/sync identity, debugging same-session multi-terminal coordination, or deciding whether another Pi runtime or sync host is live/stale.
---

# pisync - Pi sync inspector

Use `pisync` for Pi session/sync/runtime introspection. Use `pbb` only for background bash jobs. The default output is human-readable; add `--json` when parsing is needed.

## Commands

```bash
pisync
pisync id
pisync ps
pisync syncs
pisync paths
pisync doctor
```

Use JSON when programmatic parsing is needed:

```bash
pisync --json
pisync ps --json
pisync doctor --json
```

## Agent Guidelines

- Use `pisync id` to verify the current Pi runtime identity: session id, session key, session file, instance id, sync id, and sync root.
- Use `pisync ps` to see live/stale Pi runtimes attached to the same sync session.
- Use `pisync syncs` or `pisync` to inspect sync heads, host health, and instance liveness.
- Use `pisync doctor` first when Pi sync state appears broken.
- Do not use `pisync` for background bash logs or process control; use `pbb` for that.
- Treat stale/disconnected instances as coordination warnings, not as current-agent state.

`pil` remains as a deprecated compatibility alias for older shells and prompts.
