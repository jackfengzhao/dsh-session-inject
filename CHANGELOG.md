# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/).

## [0.3.0] — 2026-11-23

Wait semantics and observability. Motivated by a real failure: Hermes' MCP client timeout is fixed
at 300 s, so a `wait_ms=300000` call was cut off client-side, the response (and with it the only
copy of `submission_id`) was lost, and the caller could neither poll nor tell "dsh is dead" from
"still working".

### Added
- `submissions_list` tool — re-discover a submission by `session_id` / `status`.
- `phase` on every status (`queued` | `running` | `stalled` | `done` | `failed` | `orphaned`),
  plus `idle_ms`, `last_activity_at`, `steps_seen`, `queue_position`, `reply_preview`.
- Persistence to `<DSH_HOME>/dsh-session-inject/submissions.jsonl`: snapshots survive a dsh
  restart; old ids return `phase: "orphaned"` with the last known state instead of `unknown`.
  Startup compaction + 24 h TTL (`persistTtlHours`).
- Event heartbeat: `last_event_type` / `last_activity_at` / `steps_seen` are fed from the target
  session's own event stream, so a `stalled` phase means "no events", not "failed".
- Optional SSE progress: `notifications/progress` every `progressIntervalMs` when the caller sends
  `params._meta.progressToken`; verified with `@modelcontextprotocol/sdk` 1.32.2.
- `maxWaitMs` / `defaultWaitMs` / `stallMs` / `progressIntervalMs` config keys.

### Changed
- `wait_ms` above `maxWaitMs` (240 000) is **capped, not rejected**: the response is
  `ok:true, status:"running", wait_capped:true, requested_ms, effective_ms, submission_id`.
- `E_TIMEOUT` is never returned for a wait (kept in the table for compatibility).
- `wait_ms` omitted now defaults to 3 000 ms (explicit `0` = return after admission).
- `submission_id` is returned in **every** branch, error responses included.

## [0.2.0] — 2026-11-23

The first live run showed four concrete defects: `busy` was `true` for every session (it read the
wrong state field), `session_create` was implemented but never registered in `tools/list`, reply
extraction could return reasoning text, and every poll re-scanned the entire event log instead of
continuing from a cursor.

### Added
- `session_create` tool (gated by `allowCreate`).
- Optional Bearer token (`config.token` or `DSH_SESSION_INJECT_TOKEN`), constant-time compare.
- `turn_end_reason`, `last_event_type`, `assistant_texts` in inject results.
- Verification tooling: official-SDK MCP client check, disconnect/recover, stall, progress, TTL,
  concurrency and scan benchmarks under `tools/`.

### Fixed
- `busy` was `true` for every session (wrong state field) — now derived from the running agents.
- `session_create` existed but was not registered in `tools/list`.
- Reply extraction could pick up reasoning text; it now takes assistant text blocks only and stops
  at `turn/end` with a reason.
- `waitForTurn` re-scanned the whole event log each poll; it now scans incrementally with a cursor.

## [0.1.0] — 2026-11-22

First working version.

### Added
- Loopback MCP endpoint (`127.0.0.1:3090/mcp/session-inject`) with `sessions_list`,
  `session_inject`, `inject_status`.
- Injection through the Host command the Web GUI uses
  (`ctx.sessionController.prompt`), so the target session executes the turn itself.
- `queue` / `steer` delivery modes, `wait_ms`, per-session serialization, reply capture anchored on
  the session's `turn/end`.

[0.3.0]: https://github.com/jackfengzhao/dsh-session-inject/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/jackfengzhao/dsh-session-inject/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/jackfengzhao/dsh-session-inject/releases/tag/v0.1.0
