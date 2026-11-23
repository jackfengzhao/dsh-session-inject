# Install on another machine

Goal: a second machine runs **dsh (DeepSeek Harness)** plus **Hermes**, and Hermes can inject a turn
into a specific dsh session over MCP.

```text
Hermes ──MCP (HTTP, 127.0.0.1:3090)──▶ plugin inside the dsh process ──sessionController.prompt──▶ target session
```

- Plugin: `dsh-session-inject` 0.3.0 (this repository)
- Endpoint: `http://127.0.0.1:3090/mcp/session-inject` (health `/health`) — **loopback only**
- Needs dsh 0.2.x and Node ≥ 22.13 (the runtime shipped with dsh satisfies this)

简体中文版见 [`INSTALL.zh-CN.md`](INSTALL.zh-CN.md)。

## 1. Package it (on the source machine)

Skip `node_modules` (25 MB of dev-only tooling — the plugin itself has no runtime dependencies):

```bash
tar -czf dsh-session-inject.tgz --exclude=node_modules --exclude=test-workspace dsh-session-inject
```

What must be inside (~100 KB): `package.json`, `cordis.patch.yml`, `index.mjs`, `lib/`, `install.ps1`,
`README.md`. Unpack it anywhere on the target machine, e.g. `C:\opt\dsh-session-inject` or
`/opt/dsh-session-inject`.

> Do **not** drop it straight into `~/.dsh/profiles/<p>/node_modules/` by hand — `dsh plugin` would
> later fight with the link.

## 2. Register it in dsh

```bash
dsh --help                    # CLI present?
ls ~/.dsh/profiles            # usually web / desktop

dsh plugin --profile web     add C:\opt\dsh-session-inject     # Windows
dsh plugin --profile web     add /opt/dsh-session-inject       # Linux
# repeat for desktop if you use both
```

`dsh plugin add` writes the dependency, but **not always** the bundle entry. Confirm:

```bash
python - <<'PY'
import json, os
p = os.path.expanduser("~/.dsh/profiles/web/package.json")
d = json.load(open(p, encoding="utf-8"))
print(d.get("dependencies"))
print(d["dsh"]["profile"]["bundles"])
PY
```

If `bundles` lacks `dsh-session-inject`, append it (Windows shortcut:
`pwsh -File .\install.ps1 -Profiles web`).

Then **restart dsh** (the plugin loads in-process):

```bash
dsh web --no-open --port 3080
```

With a session already open you can hot-reload via `workspace_control action=refresh`, but a restart
is cleaner.

## 3. Self-check

```bash
curl -s http://127.0.0.1:3090/health
# {"ok":true,"version":"0.3.0","host":"127.0.0.1","port":3090,"auth":"open","live_sessions":[...],
#  "store":{"live":..,"persisted":..,"persist_path":"..."}}

curl -s -X POST http://127.0.0.1:3090/mcp/session-inject \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
# expect: sessions_list, session_inject, inject_status, submissions_list, session_create
```

An empty `live_sessions` is normal right after a restart: dsh only reports sessions the UI has
opened. Use `session_create` if you need one immediately.

## 4. Attach Hermes

```bash
hermes mcp add dsh-session-inject --url http://127.0.0.1:3090/mcp/session-inject
# "require authentication?" -> n     "enable all tools?" -> y
```

Non-interactive (bash / git-bash):

```bash
printf 'n\ny\n' | hermes mcp add dsh-session-inject --url http://127.0.0.1:3090/mcp/session-inject
```

```bash
hermes mcp test dsh-session-inject    # ✓ Connected, 5 tools
hermes mcp ls
```

Then `/reload-mcp` (or a new Hermes session) — the tools appear as `mcp__dsh_session_inject__*`.

## 5. Acceptance checklist

| # | Call | Expect |
|---|---|---|
| 1 | `sessions_list` | dsh sessions listed (`session-*`; `hermes-*` are mirror sessions — don't inject there) |
| 2 | `session_create` + `session_inject` "reply OK" | `status:"done"` + `reply_text` within seconds |
| 3 | `session_inject` with a bogus id | `E_UNKNOWN_SESSION` (-32030) plus the live-session list |
| 4 | long task with `wait_ms=600000` | returns after **240 s** with `status:"running"`, `wait_capped:true`, a `submission_id` — no error, no lost handle |
| 5 | `submissions_list` / `inject_status` until done | final `reply_text`; phase goes `running` → `stalled` (>120 s of silence) → `done` |
| 6 | restart dsh, then `inject_status(old id)` | `phase:"orphaned"` with last known state/preview — never `unknown` |

Step 4 matters: Hermes' MCP client timeout is fixed at 300 s, and the plugin caps waits at 240 s, so
the id always reaches the caller.

## 6. Options

Override in `~/.dsh/profiles/<profile>/cordis.patch.yml` (not in the plugin's own file):

```yaml
- id: dsh-session-inject
  name: 'dsh-session-inject'
  config:
    port: 3091            # avoids a clash when two profiles run at once
    host: '127.0.0.1'
```

| Key | Default | Meaning |
|---|---|---|
| `port` / `host` | 3090 / 127.0.0.1 | listener (update the Hermes URL if changed) |
| `token` | empty | or `DSH_SESSION_INJECT_TOKEN`; when set, `Authorization: Bearer` is required |
| `maxWaitMs` | 240000 | `wait_ms` cap; capped waits still return `submission_id` |
| `defaultWaitMs` | 3000 | wait when `wait_ms` is omitted |
| `stallMs` | 120000 | silence above this → `phase:"stalled"` (still running) |
| `progressIntervalMs` | 8000 | SSE progress cadence |
| `persistPath` | `<DSH_HOME>/dsh-session-inject/submissions.jsonl` | durable snapshots |
| `persistTtlHours` | 24 | startup prune horizon |
| `maxTurnMs` | 600000 | per-submission ceiling |
| `allowCreate` | true | disable `session_create` when false |

## 7. Security

- Keep it loopback. This endpoint types into a session as you — never bind `0.0.0.0`, never tunnel.
- Shared machines: `export DSH_SESSION_INJECT_TOKEN=<random>` and send the Bearer header.
- Injections are permanent timeline entries and cannot be recalled.

## 8. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| 3090 not listening | bundle entry missing, or dsh not restarted; `EADDRINUSE` = another profile holds the port |
| Hermes sees no tools | `/reload-mcp` not run; `hermes mcp ls` shows disabled |
| `submissions_list` absent | client cached the pre-0.3 tool list → reload MCP |
| `E_UNKNOWN_SESSION` | not a running session (fresh restart, UI not restored) → wait or `session_create` |
| stuck `queued` | target session busy with another turn |
| desktop mode has no 3080 | expected: desktop does not serve the Hermes-link bridge; this plugin only needs 3090 |
| Windows paths with spaces | quote them, and pass native `C:\...` paths (not `/c/...`) |

## 9. Uninstall

```bash
dsh plugin --profile web     remove dsh-session-inject
dsh plugin --profile desktop remove dsh-session-inject
# also drop it from dsh.profile.bundles, then restart dsh

hermes mcp remove dsh-session-inject
```

Leftover state: `~/.dsh/dsh-session-inject/` (submissions.jsonl) — safe to delete.
