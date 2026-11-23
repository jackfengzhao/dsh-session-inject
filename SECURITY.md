# Security policy

## What this plugin can do

`dsh-session-inject` delivers a user turn into a live DeepSeek Harness session. Whatever the target
session can do with its own model, tools, cwd and permission preset, the injected content can ask it
to do — file edits, shell commands, network calls. Treat the endpoint as **equivalent to typing in
the dsh window**.

It does not patch dsh core, does not change any dsh security setting, and only reads the public Host
API (`sessionController.prompt`, agent list, tool catalog).

## Built-in boundaries

| Boundary | Behaviour |
|---|---|
| Bind address | `127.0.0.1` by default; deliberately no option to reach a LAN interface without an explicit config edit |
| CORS | none — browsers cannot call this endpoint cross-origin |
| Transport | plain HTTP on loopback; no TLS (a TLS listener on loopback adds no protection) |
| Authentication | optional Bearer token (`config.token` or `DSH_SESSION_INJECT_TOKEN`), compared in constant time |
| Rate / size | `content` ≤ 32 000 chars; one queued turn per session at a time |
| Data written | `<DSH_HOME>/dsh-session-inject/submissions.jsonl` — ids, timestamps, phases, ≤200-char reply previews; **no full prompts or replies** |
| Secrets in logs | never logged; error messages redact the token value |

Anything the injected text causes the session to do is **out of scope for this plugin** — it is the
session's model and tools, under the session's permission preset, executing the instruction.

## Recommendations

- Keep `host: 127.0.0.1`. Do not port-forward, tunnel or reverse-proxy this endpoint.
- On shared or multi-user machines, set `DSH_SESSION_INJECT_TOKEN` and send
  `Authorization: Bearer <token>` from the client.
- Point the client at the specific session you intend to drive; `hermes-<id>` mirror sessions are
  projections of another agent's conversation — not a place to inject.
- Remember injections are permanent: they land in the session timeline like a human message.

## Reporting a vulnerability

Open a private security advisory on GitHub (Security → Advisories) rather than a public issue.
Please include the dsh version, the exact request, and the observed behaviour. Expect an initial
reply within a few days; fixes ship as a patch release with a `CHANGELOG` entry.
