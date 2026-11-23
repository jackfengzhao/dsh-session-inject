# dsh-session-inject

[![version](https://img.shields.io/badge/version-0.3.0-blue.svg)](CHANGELOG.md)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22.13-339933.svg)](https://nodejs.org/)
[![platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-lightgrey.svg)](#requirements)

English | [简体中文](README.zh-CN.md)

A **DeepSeek Harness (`dsh`) Host plugin** that exposes a loopback MCP endpoint so an external
agent (for example [Hermes](https://github.com/NousResearch/hermes-agent)) can inject a user turn
**into one exact live dsh session** and read back that turn's final reply.

The target session executes the turn **itself** — its own model, tools, cwd, permission preset and
context. **No subagent is spawned.**

```text
Hermes ──MCP over HTTP (127.0.0.1:3090)──▶ dsh plugin ──sessionController.prompt──▶ target session
                    ◀──────────── reply_text / phase / submission_id ─────────────┘
```

---

## Table of contents

- [Why this plugin exists](#why-this-plugin-exists)
- [Features](#features)
- [Requirements](#requirements)
- [Quickstart](#quickstart)
- [MCP tools](#mcp-tools)
- [Wait semantics](#wait-semantics)
- [Phases](#phases)
- [Recommended long-task sequence](#recommended-long-task-sequence)
- [Configuration](#configuration)
- [Security](#security)
- [Limits](#limits)
- [Troubleshooting](#troubleshooting)
- [Project layout](#project-layout)
- [Development](#development)
- [Documentation](#documentation)
- [Related projects](#related-projects)
- [License](#license)

## Why this plugin exists

**Author's note — what actually drove this.** I run dsh with long-lived project sessions: one
session per project, holding weeks of decisions, file layout, the traps already hit and the
reasoning behind them. Before this plugin I dispatched work the "proper" way — as a subagent. Two
things went wrong, every time:

1. **The parent agent starts freelancing.** A finished dispatch wakes the parent session with a
   completion notice; the parent, holding the entire project history and its own opinions, then
   *improves* the result — rewrote the checklist I had approved, swapped a verified screenshot for
   one of its own, edited files the worker had just delivered. Work that came back correct got
   altered by an agent that was only supposed to be supervising. I've come to call it
   **添油加醋** — seasoning a dish nobody asked to be seasoned.
2. **The subagent is context-poor and pays full price for it.** A child starts from a narrow
   prompt: it knows nothing about the project's conventions, so every dispatch needed a hand-written
   `CONTEXT.md`, and answers came back technically right but blind to the surrounding design. And
   because it is a fresh conversation, its prefix cache starts at zero — the same instruction costs
   uncached input tokens on every dispatch, while the long-lived session that already holds that
   context re-reads it at cache-hit prices (measured on this setup: ~99% hit from the second request
   inside one session, 77–82% across long project sessions).

So the thing I actually wanted was: **send the instruction into the session that already knows the
project, and let that session do the work** — with its memory of the decisions, its understanding of
the code, and its warm cache. No child agent in the middle, no supervising agent rewriting the
result.

**Where this came from.** All of it started with
[`dsh-hermes-link`](https://github.com/Tianbuyu-wwx/dsh-hermes-link) — the original Hermes ↔ dsh
dispatch bridge (`@tianbuyu-wwx/dsh-hermes-link` 0.6.11, written for dsh 0.1.5-rc.2) — and its
dsh 0.2.x compatibility fork
[`guiyinrenshi/dsh-hermes-link`](https://github.com/guiyinrenshi/dsh-hermes-link) (published unscoped
as the npm package `dsh-hermes-link`, 0.8.6). Both are dispatch bridges in the literal sense:
Hermes calls `dispatch_task`, dsh **spawns a subagent**, and a `continuable` child wakes the parent
session when it finishes — precisely the behaviour described above. I first tried to fix it in
place: a `session_prompt` tool that routed the text through `ctx.subagents.sendMessage/prompt`. The
Host rejects that for root sessions (`UNAUTHORIZED: send_message requires another agent in the
subagent tree`), because the subagent API is scoped to the subagent tree by design. That dead end is
why this exists as a **separate plugin**: it uses the session-controller API instead, never reads or
modifies dsh-hermes-link's files, and either project can be uninstalled without touching the other.

**What the plugin does.** It delivers a real user turn into that session's timeline, exactly as if
typed, by calling the same Host command the Web GUI send button uses:

```ts
// @deepseek-ai/dsh-api-session-controller (dsh 0.2.x)
@Remote('prompt')
async prompt(request: SessionPromptRequest, signal: AbortSignal): Promise<SessionPromptValue>
// SessionPromptRequest { requestId, sessionId, mode: 'queue' | 'steer', content, clientTimeZone? }
```

The `ctx.subagents.sendMessage/prompt` path is **not** usable for this: the Host scopes it to the
subagent tree and rejects root or unrelated sessions
(`UNAUTHORIZED: send_message requires another agent in the subagent tree`).
Exact source excerpts: [`docs/api-evidence.md`](docs/api-evidence.md).

## Features

- **Session-native execution** — the prompt lands as a `source.kind = "user"` message, and the
  session answers with its own model, tools, cwd and context.
- **Five MCP tools** — `sessions_list`, `session_inject`, `inject_status`, `submissions_list`,
  `session_create`; JSON-RPC 2.0 over HTTP with `initialize` / `ping` / `tools/list` / `tools/call`.
- **A wait that never loses the handle** — `wait_ms` is capped at **240 s**, below the 300 s MCP
  client timeout; every branch, errors included, returns a `submission_id`.
- **Recoverable** — `submissions_list` re-discovers a submission by session even when the first
  response was lost; records are persisted, so after a dsh restart an old id returns
  `phase: "orphaned"` with its last known state instead of `unknown`.
- **Observable** — `phase`, `idle_ms`, `last_event_type` and `steps_seen` come from the session's
  own event stream (`turn/start`, `step/start`, `tool/call`, `assistant/message`, `turn/end`), so
  "thinking", "running a tool" and "dead" are distinguishable.
- **Optional SSE progress** — `notifications/progress` every 8 s when the client sends
  `params._meta.progressToken`; verified with the official `@modelcontextprotocol/sdk`.
- **Zero runtime dependencies**, loopback-only, optional Bearer token.

## Requirements

| Item | Requirement |
|---|---|
| dsh | 0.2.x (uses `ctx.sessionController.prompt`; also verified on the 0.8.x desktop build) |
| Node | ≥ 22.13 (the runtime bundled with dsh satisfies this) |
| Hermes | any recent build with MCP server support — optional, any MCP client works |
| Network | loopback only; the listener never binds beyond `127.0.0.1` by default |

## Quickstart

```bash
# 1) install into one or more dsh profiles
dsh plugin --profile web     add /path/to/dsh-session-inject
dsh plugin --profile desktop add /path/to/dsh-session-inject

# 2) confirm the bundle is listed (dsh plugin add does not always write it)
#    ~/.dsh/profiles/<profile>/package.json -> dsh.profile.bundles += "dsh-session-inject"

# 3) restart dsh (the plugin loads in-process), then check
curl -s http://127.0.0.1:3090/health

# 4) point Hermes at it
hermes mcp add dsh-session-inject --url http://127.0.0.1:3090/mcp/session-inject
#    prompts: "require authentication?" -> n    "enable all tools?" -> y

# 5) reload MCP in Hermes (/reload-mcp) or start a new session
```

A full walkthrough — second machine, Linux commands, verification checklist, troubleshooting —
lives in [`docs/INSTALL.md`](docs/INSTALL.md).

## MCP tools

| Tool | Arguments | Result |
|---|---|---|
| `sessions_list` | — | `[{ session_id, title, model, cwd, busy }]` |
| `session_inject` | `session_id?`, `content` (1..32000), `delivery` (`queue`\|`steer`), `wait_ms?` | `{ ok, session_id, submission_id, status, phase, wait_capped, requested_ms, effective_ms, elapsed_ms, steps_seen, last_event_type, last_activity_at, idle_ms, reply_text?, turn_end_seq?, turn_end_reason?, assistant_texts? }` |
| `inject_status` | `submission_id` | `{ submission_id, session_id, status, phase, queue_position, started_at, elapsed_ms, steps_seen, last_event_type, last_activity_at, idle_ms, reply_preview, wait_capped, reply_text?, error?, turn_end_reason?, orphaned? }` |
| `submissions_list` | `session_id?`, `limit?` (10), `status?` | summary rows, newest first |
| `session_create` | `cwd?`, `agentPreset?`, `provider?`, `model?` | `{ ok, session_id }` |

`session_id` is optional on `session_inject`; when omitted the first live session is used.

## Wait semantics

- `wait_ms` omitted → `defaultWaitMs` (**3000**). An explicit `0` returns right after admission.
- Values above `maxWaitMs` (**240000**) are **capped, not rejected**:
  `{ ok: true, status: "running", wait_capped: true, requested_ms, effective_ms, submission_id }`.
- A capped wait is **not** an error: the turn keeps running. Poll `inject_status` or
  `submissions_list`.
- `submission_id` is present in **every** response, including `E_INVALID_SPEC`,
  `E_UNKNOWN_SESSION`, `E_NO_LIVE_SESSION` and `E_INJECT_FAILED`.

## Phases

| phase | meaning |
|---|---|
| `queued` | waiting behind another submission for the same session (`queue_position` ≥ 1) |
| `running` | admitted, recent session events |
| `stalled` | admitted but no event for longer than `stallMs` (120 s) — **still alive, not failed**; recovers on the next event |
| `done` | reply captured (`reply_text`) |
| `failed` | admission rejected, or the turn ended `aborted` / `blocked` / `error` / `interrupted` |
| `orphaned` | persisted record from a previous dsh process; the last known state is returned, never `unknown` |

## Recommended long-task sequence

Hermes' MCP client timeout is fixed at **300 s**, so lean on ids instead of one long request:

```text
session_inject(wait_ms=0)        -> submission_id immediately
then every 10-30 s:
  inject_status(submission_id)   -> phase / idle_ms / reply_preview
  submissions_list(session_id)   -> recovers the id if the first response was lost
until phase == "done"            -> reply_text
```

## Configuration

Override in the profile's `cordis.patch.yml` (`~/.dsh/profiles/<profile>/cordis.patch.yml`), never
in the plugin's own file:

```yaml
- id: dsh-session-inject
  name: 'dsh-session-inject'
  config:
    port: 3090
    host: '127.0.0.1'
```

| Key | Default | Meaning |
|---|---|---|
| `port` / `host` | `3090` / `127.0.0.1` | loopback listener |
| `token` | env `DSH_SESSION_INJECT_TOKEN` | when set, requests need `Authorization: Bearer <token>` |
| `maxWaitMs` | `240000` | `wait_ms` cap; capped waits return `status: "running"` |
| `defaultWaitMs` | `3000` | wait used when `wait_ms` is omitted |
| `stallMs` | `120000` | `idle_ms` above this becomes `phase: "stalled"` |
| `progressIntervalMs` | `8000` | SSE `notifications/progress` cadence |
| `persistPath` | `<DSH_HOME>/dsh-session-inject/submissions.jsonl` | durable snapshots (`null` disables) |
| `persistTtlHours` | `24` | startup prune horizon |
| `maxTurnMs` | `600000` | internal ceiling per submission |
| `allowCreate` | `true` | `false` hides `session_create` |
| `legacyScan` | `false` | test-only A/B full-log scan switch |

## Security

- **Loopback only.** The default bind is `127.0.0.1`; there is no CORS and no TLS. Never bind it to
  a LAN interface or port-forward it — this plugin types into a session on your behalf.
- **Token.** Without a token, any local process can inject prompts. On shared machines set
  `DSH_SESSION_INJECT_TOKEN` and send the Bearer header from the client.
- **Irreversible by design.** Injected text stays in the session timeline exactly like a human
  message; it cannot be recalled. Injecting does not change the session's model, permissions or
  tool set.
- No existing dsh security setting is modified and no dsh core file is patched.

## Limits

- `content` ≤ **32000 characters** per injection.
- `queue` is serialized per session; `steer` is not queued and still reports the shared turn's final
  message.
- Persisted records keep only `reply_preview` (≤ 200 chars), not the full reply — read the session
  timeline for the complete text.
- `sessions_list` reports **live** agents only; cold sessions are not resumed just to be listed.
  Right after a dsh restart the list can be empty until the UI re-opens a session.
- One dsh profile per port: two profiles cannot both hold `3090`.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| nothing listens on 3090 | plugin missing from `dsh.profile.bundles`, or dsh not restarted; `EADDRINUSE` means another profile holds the port |
| Hermes shows no tools | `/reload-mcp` not run, or `hermes mcp ls` reports it disabled |
| `submissions_list` missing | the client cached the pre-0.3 tool list — reload MCP |
| `E_UNKNOWN_SESSION` | that id is not a running session (fresh restart, UI not restored yet) — wait a moment or `session_create` |
| stuck in `queued` | the target session is busy with another turn |
| `stalled` for a long time | long thinking or a long tool call; `idle_ms` keeps growing and the phase recovers on the next event |

More: [`docs/INSTALL.md`](docs/INSTALL.md).

## Project layout

```text
index.mjs               Host plugin entry (Cordis loader row)
lib/server.mjs          MCP JSON-RPC HTTP server, 5 tools, SSE progress
lib/session-api.mjs     sessionController.prompt / turn wait / live session list
lib/records.mjs         submission registry, phases, queueing, persistence
cordis.patch.yml        bundle patch (loader insert + defaults)
install.ps1             Windows helper (register + ensure the bundle entry)
examples/               Hermes-side curl examples (sh / ps1)
tools/                  verification, evidence capture, benchmarks
docs/                   install guide, API evidence, delivery report, history
```

## Development

```bash
npm install                 # only for tools/ (the official MCP SDK is a devDependency)
npm run test:smoke          # health + tools/list + a short inject
npm run test:mcp            # full handshake with the official SDK client
npm run test:wait           # wait_ms capping (240 s)
npm run test:recover        # hard disconnect -> submissions_list -> done
npm run test:stall          # stalled detection
npm run test:progress       # SSE progress notifications
```

The plugin itself has **no runtime dependencies**.

## Documentation

| Doc | Content |
|---|---|
| [`docs/INSTALL.md`](docs/INSTALL.md) | install on another machine (Windows + Linux), verification checklist, troubleshooting |
| [`docs/api-evidence.md`](docs/api-evidence.md) | exact dsh source excerpts the plugin builds on |
| [`docs/REPORT.md`](docs/REPORT.md) | delivery report: API investigation, acceptance results, per-version changes |
| [`CHANGELOG.md`](CHANGELOG.md) | release notes |
| [`docs/history/`](docs/history/) | original task briefs used to build v0.2 and v0.3 |

## Related projects

- **[Tianbuyu-wwx/dsh-hermes-link](https://github.com/Tianbuyu-wwx/dsh-hermes-link)** — the original
  Hermes ↔ dsh dispatch bridge (`@tianbuyu-wwx/dsh-hermes-link`, 0.6.11, dsh 0.1.5-rc.2).
- **[guiyinrenshi/dsh-hermes-link](https://github.com/guiyinrenshi/dsh-hermes-link)** — its dsh 0.2.x
  compatibility fork (npm: `dsh-hermes-link`, 0.8.6); the dispatch model described above.

Both spawn a subagent per dispatch. This plugin deliberately does not: it drives an existing session
instead. The two approaches can coexist — neither reads or modifies the other's files.

## License

[MIT](LICENSE)
