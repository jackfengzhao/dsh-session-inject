# Contributing

Thanks for taking a look. This is a small, single-purpose plugin — the most useful contributions are
bug reports with a real transcript and patches that stay inside the current design.

## Development setup

```bash
git clone <your-fork>
cd dsh-session-inject
npm install                 # only tools/ needs deps (official MCP SDK, devDependency)
```

Run it against a real dsh:

```bash
dsh plugin --profile web add "$PWD"     # pnpm link + dependency
# confirm ~/.dsh/profiles/web/package.json -> dsh.profile.bundles lists "dsh-session-inject"
dsh web --no-open --port 3080           # restart loads the plugin
curl -s http://127.0.0.1:3090/health
```

While dsh is running and a session is open, `workspace_control action=refresh` reloads the plugin
without restarting dsh — handy during iteration.

## Tests

```bash
npm run test:smoke      # health, tools/list, short inject
npm run test:mcp        # official SDK client handshake + one inject
npm run test:wait       # wait_ms capping (takes ~4 min)
npm run test:recover    # curl --max-time 5, then recover via submissions_list
npm run test:stall      # >stallMs with no events -> stalled -> done
npm run test:progress   # SSE progress notifications
npm run test:concurrent # two submissions, no cross-talk
npm run test:ttl        # persistence compaction / TTL (uses a temp file)
```

Tests need a running dsh with at least one live session. `session_create` is the easiest way to get
one: `node tools/inject.mjs create`.

## Ground rules

- **No runtime dependencies.** `package.json` ships zero `dependencies`; the plugin must keep
  working with just the Node built-ins dsh already provides.
- **Loopback only.** Never add an option that binds to a non-loopback interface, and never add
  CORS. The plugin types into a session on the user's behalf.
- **No dsh core patches.** The plugin must work against a stock dsh; everything it needs is in the
  Host API (`ctx.sessionController`, `ctx.agents`, `ctx.tools`).
- **Every response carries `submission_id`.** Error branches included — that invariant is what makes
  the transport failure-tolerant.
- **Never log or echo prompts, tokens or model output to disk** beyond the documented
  `submissions.jsonl` preview, and never print a token in an error message.
- Keep the MCP tool schemas stable; adding an optional field is fine, renaming is a breaking change.

## Adding a tool

1. Define it in `lib/server.mjs` (`buildToolsList()` + the `tools/call` switch).
2. Return `{ ok, ... }` payloads and map failures through the existing `E_*` codes in
   `services/error-codes`-style helpers inside `server.mjs`.
3. Gate anything that mutates dsh state behind a config flag (see `allowCreate`).
4. Add the tool to the README tables (both languages) and to `CHANGELOG.md`.

## Pull requests

- One concern per PR; keep the diff readable.
- State how you tested it (which dsh version, which profile, live session or not).
- If the change touches wait/phase semantics, include before/after `inject_status` output.

## Reporting bugs

Please include:

- dsh version and mode (`dsh web` vs desktop app), OS;
- `curl -s http://127.0.0.1:3090/health`;
- the exact MCP request and response (redact session ids if they are sensitive);
- what the target session showed at the time (was it mid-turn? did it have a model selected?).
