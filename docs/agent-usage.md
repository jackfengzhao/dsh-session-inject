# Using this plugin as an agent

Written for the model on the other side of the MCP connection: what to call, in what order, and
what the returned fields actually mean. Human setup lives in [`INSTALL.md`](INSTALL.md); the
authoritative field list is in the [README](../README.md#mcp-tools).

## 1. Before you inject anything

```text
GET  http://127.0.0.1:3090/health          -> {"ok":true, "version":"0.3.0", "live_sessions":[...]}
call sessions_list                          -> [{ session_id, title, model, cwd, busy }]
```

- **Never bind or call this endpoint outside loopback.** It types into a session as the user.
- **Pick a `session-<uuid>`, not `hermes-<id>`.** An id starting with `hermes-` is a mirror of
  another agent's conversation; injecting there talks to a reflection, not to the project session.
  Confirm by `title` and `model` — a project session carries the project's own title and model.
- An empty `sessions_list` right after a dsh restart is normal: dsh only reports sessions the UI has
  opened. Either wait for the user to open one, or `session_create` a fresh one (it starts with no
  project history, which defeats the point of using this plugin).
- `busy` is informational. The field that decides what is happening is `phase`.

## 2. Two recipes

### Short turn (seconds)

```text
session_inject(session_id, content, wait_ms=3000..120000)
  -> { status:"done", reply_text, steps_seen, turn_end_reason }
```

Use when the answer fits one turn. `wait_ms` above `maxWaitMs` (240000) is capped, never an error.

### Long turn (minutes)

```text
session_inject(session_id, content, wait_ms=0)   -> submission_id immediately
repeat every 10-30 s:
  inject_status(submission_id)   -> phase, idle_ms, steps_seen, reply_preview
  submissions_list(session_id)   -> recovers the id if the first response was lost
until phase == "done"            -> reply_text
```

Why not one long call: MCP clients time out at ~300 s. The plugin caps at 240 s so the id always
reaches you, but a 20-minute task will always finish on the polling side, not in the call.

## 3. Field semantics

| Field | Read it as |
|---|---|
| `phase: "queued"` | another submission holds this session; `queue_position` tells you how far back |
| `phase: "running"` | admitted; the session is working |
| `phase: "stalled"` | admitted, no events for > `stallMs` (120 s). **Still running.** Long thinking or a long tool call; do not re-inject because of it |
| `phase: "done"` | `reply_text` is the answer |
| `phase: "failed"` | refused at admission, or the turn ended `aborted` / `blocked` / `error` / `interrupted` — read `error` and `turn_end_reason` |
| `phase: "orphaned"` | record from a previous dsh process; the turn is not observable any more. `reply_preview` (≤200 chars) is all that survives — read the session timeline for the full text |
| `idle_ms` | milliseconds since the last event. Growing value + `running` = thinking, not hung |
| `steps_seen` | step counter for this turn. Growing = progress |
| `wait_capped: true` | your `wait_ms` was reduced; `requested_ms` / `effective_ms` show both. Not an error |

## 4. queue or steer

- `queue` (default) — serialized behind the session's current turn. Use it for nearly everything:
  the session finishes its work, then reads yours.
- `steer` — not queued, delivered mid-turn. Use it to correct course ("stop touching the CSS, the
  bug is in the physics loop"). It still reports the shared turn's final message, so a `steer` may
  return a reply that answers more than your text.

## 5. Writing the injected text

It arrives as a **real user message**. Consequences:

- The session keeps it forever; it cannot be recalled or edited afterwards.
- Whatever the session can do with its tools, your text can ask for. Do not inject instructions you
  would not type by hand into that session.
- `content` is limited to 32 000 characters. Put long reference material in a file the session can
  read, and point at the path.
- Give constants and acceptance criteria explicitly. A task brief that asks the model to derive its
  own physics or prove feasibility first will spend most of the turn deriving, not delivering.
- Ask for a bounded report ("read-only, ≤300 words") when the goal is information; otherwise a
  project session will happily start writing tests and refactoring.

## 6. Errors and what to do

| Error | Meaning | Action |
|---|---|---|
| `E_UNKNOWN_SESSION` (-32030) | that id is not a running session | pick from the `live_sessions` list it returns; or `session_create` |
| `E_NO_LIVE_SESSION` | no session is open at all | ask the user to open one, or `session_create` |
| `E_INVALID_SPEC` | bad arguments (empty `content`, over 32 000 chars, unknown `delivery`) | fix the payload |
| `E_INJECT_FAILED` | `sessionController.prompt` rejected the turn | read `error`; usually the session is mid-transition — retry once, then report |
| `E_AUTH_REQUIRED` (-32001) | server has a token configured | send `Authorization: Bearer <token>` |
| tool not found | your client cached the pre-0.3 tool list | reload MCP (`/reload-mcp` in Hermes) |

Every one of these responses still carries a `submission_id` field (may be `null` when nothing was
admitted) — keep it if present.

## 7. Monitoring discipline

- Poll `inject_status`, not the transcript. `phase` + `idle_ms` + `steps_seen` are three numbers;
  reading the session's thinking on every poll costs orders of magnitude more than the task itself.
- Read the session timeline once, at the end, if you need context beyond `reply_text`.
- A capped wait, a `stalled` phase or a lost response are all recoverable states. The only genuinely
  bad outcomes are `failed` and a server that is not listening.

## 8. When this channel is the wrong tool

| Situation | Better choice |
|---|---|
| One-off narrow task, no project context needed | a subagent / fresh session — much cheaper |
| Task needs the project's accumulated history and conventions | this plugin (that is the whole point) |
| Parallel independent workstreams | several sessions, one injection each; a single session serializes |
| You need the model changed for one task | not supported here — the session keeps its own model |

Measured cost of the wrong choice: driving a 6 M-token project session for a read-only self-check
cost about 29 minutes and ≈$0.23; the same job as a fresh subagent costs roughly a fifth to a tenth
of that. Use the project session when the context *is* the value.
