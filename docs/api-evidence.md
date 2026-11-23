# API evidence — the dsh 0.8.6 surface this plugin is built on

All excerpts were extracted from
`C:\Users\<user>\AppData\Local\Programs\DeepSeek Harness\resources\app.asar`
with a minimal asar reader (`tools/asar.mjs`, no `@electron/asar` dependency)
and cross-checked with the live `cordis_inspect_query` Host `Service` provider.

## 1. The dead end: `prompt.submit`

`readonly prompt: { submit(input: PromptSubmitArgs) }` exists, but it belongs to
`ModsApi` (the Claude-Code-style **mods** bridge), and `PromptSubmitArgs` carries
only text — no session id:

```ts
// dsh/node_modules/@deepseek-ai/dsh-tool-cordis/src/api-catalog.ts
// Within `ModsApi`:
readonly prompt: {
    submit(input: PromptSubmitArgs): Promise<{
        text: string;
    }>;
};

// Type catalog entry:
{
    name: 'PromptSubmitArgs',
    declaration: 'export interface PromptSubmitArgs {\n    text: string;\n    asUser?: boolean;\n}',
},
```

So it can only submit into the mod's own session and cannot address an arbitrary
session id. Not used here.

## 2. The supported Host command: `sessionController.prompt`

Live contract from `cordis_inspect_query` (platform `host`, provider `Service`,
`service: "sessionController"`):

```
@Remote('prompt') async prompt(request: SessionPromptRequest, signal: AbortSignal): Promise<SessionPromptValue>
  description: "Admit one prompt after explicitly resuming its Session."
  @param request - Session identity, prompt content, source metadata, and delivery mode.
  @param signal  - caller cancellation before prompt admission begins.
  @returns acknowledgement that the Agent accepted the prompt.
```

```
// dsh/node_modules/@deepseek-ai/dsh-api-session-controller/src/types.ts
export interface SessionPromptRequest {
  readonly requestId: SessionRequestId
  readonly sessionId: SessionId
  readonly mode: 'queue' | 'steer'
  readonly content: readonly PromptContentPart[]
  readonly clientTimeZone?: string
}
export interface SessionPromptValue {
  readonly accepted: true
}
```

### Implementation (exact source)

```ts
// dsh/node_modules/@deepseek-ai/dsh-api-session-controller/src/index.ts:463-494
/**
 * Admit one prompt after explicitly resuming its Session.
 * @param request - Session identity, prompt content, source metadata, and delivery mode.
 * @param signal - caller cancellation before prompt admission begins.
 * @returns acknowledgement that the Agent accepted the prompt.
 */
@Remote('prompt')
async prompt(request: SessionPromptRequest, signal: AbortSignal): Promise<SessionPromptValue> {
  signal.throwIfAborted()
  if (request.content.length > 0 && !hasPromptContent(request.content)) {
    throw new RemoteError('gateway/bad-request', 'prompt content must include non-whitespace text or an attachment', {})
  }
  const clientTimeZone = request.clientTimeZone === undefined
    ? undefined
    : canonicalClientTimeZone(request.clientTimeZone)
  if (request.clientTimeZone !== undefined && clientTimeZone === undefined) {
    throw new RemoteError(
      'session/invalid-time-zone',
      'clientTimeZone must be UTC or a valid IANA Area/Location name',
      { value: request.clientTimeZone },
    )
  }
  // The caller is recorded only when it is not the owner, so owner messages keep their exact source.
  const principal = principalOf(this.ctx.invocation)
  const source: MessageSource = {
    kind: request.content.length === 0 ? 'retry' : 'user',
    rpcId: request.requestId,
    ...(clientTimeZone === undefined ? {} : { clientTimeZone }),
    ...(principal === undefined ? {} : { principal }),
  }
  return this.commands.prompt(request, source)
}
```

```ts
// dsh/node_modules/@deepseek-ai/dsh-api-session-controller/src/commands.ts:323-389
async prompt(request: SessionPromptRequest, source: MessageSource): Promise<SessionPromptValue> {
  const agent = await this.resolveAgent(request.sessionId)
  if (this.hasPromptRequest(agent.session, request.requestId)) return { accepted: true }
  ...
  const content = await this.ctx.attachments.admitPromptContent(admission.content)
  if (this.hasPromptRequest(agent.session, request.requestId)) return { accepted: true }
  const message: UserMessage = createUserMessage({ content, source })
  if (this.ctx.agents.get(agent.id) !== agent) {
    throw new RemoteError('session/not-found', `session "${agent.id}" was disposed during prompt admission`, { sessionId: agent.id })
  }
  using binding = this.ctx.fileUploads.bindPrompt(agent, admission.receiptIds, request.requestId)
  if (request.mode === 'steer') agent.steer(message)
  else agent.followup(message)
  binding.commit()
  ...
  return { accepted: true }
}
```

`resolveAgent` resumes a cold session and returns a stable `session/not-found`
for an unknown id, so the plugin validates with the same call before injecting
(`lib/session-api.mjs: resolveSession`).

## 3. Why a direct in-process call is allowed

`@Remote` only records discovery metadata; it does not replace the method:

```ts
// dsh/node_modules/@deepseek-ai/dsh-typert-protocol/src/index.ts:352-362
function remoteDecorator(
  invocation: RemoteInvocationMarker,
  options: RemoteMarkerOptions = {},
): RemoteMethodDecorator {
  return function <This extends object, Args extends unknown[], Result>(
    _method: (this: This, ...args: Args) => Result,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
  ): void {
    addMarkerInitializer(context, invocation, options)
  }
}
```

And the only caller-dependent branch — the principal — is explicitly safe outside
a Remote call:

```ts
// dsh/node_modules/@deepseek-ai/dsh-typert-protocol/src/principal.ts
/**
 * ...
 * @returns the caller's principal when it is not the owner; `undefined` for the
 *   owner and for trusted in-process code outside a Remote call.
 */
export function principalOf(invocation: RemoteInvocation | undefined): Principal | undefined {
  const principal = invocation?.peer.principal
  return principal?.kind === 'owner' ? undefined : principal
}
```

This is why the plugin calls `ctx.get('sessionController').prompt(...)` directly
and gets `source.kind = 'user'`, no subagent, no HTTP auth token.

## 4. Reading the turn back

The prompt is admitted asynchronously (`accepted: true`), so the plugin waits on
the Session log for **its own** `user/message` (matched by
`data.source.rpcId === requestId`) and then for the next `turn/end`, returning the
last `assistant/message` in that range:

```
[user/message] seq=58 source={"kind":"user","rpcId":"dsh-session-inject-...","clientTimeZone":"Asia/Shanghai"}
[assistant/message] seq=63 turn=6  text: "EVID-MWT3PBI0"
[turn/end] seq=65 data={"turn":6,"reason":{"kind":"completed"}}
```

Session state (`cursor`, `running`, `queue`) comes from
`sessionController.state`, and the session list from `ctx.agents.list()` +
`sessionQuery.readTitle`.

## 5. `@Remote` methods used

| Method | Use |
|---|---|
| `sessionController.prompt(request, signal)` | admit the user turn |
| `sessionController.resolveAgent(sessionId)` | validate / resume the target |
| `sessionController.state({sessionId}, signal)` | busy flag + cursor |
| `sessionController.create(request)` | create a scratch Session (`session_create`) |
| `sessionController.selectModel(request)` | pin the scratch Session's model |
| `sessionQuery.readTitle(sessionId, signal?)` | title |

## 6. `state()` — what `busy` must mean (v0.2 fix)

v0.1 treated `state.active` as busy. In the Host, `active` is `true` for **any**
live Agent, so every live session looked busy. The real turn flag is `running`:

```ts
// dsh/node_modules/@deepseek-ai/dsh-api-session-controller/src/state/controller.ts:135-163
private async readState(sessionId: SessionId, signal: AbortSignal, retried = false): Promise<SessionState> {
  signal.throwIfAborted()
  const agent = this.ctx.agents.get(sessionId)
  if (agent !== undefined) {
    if (agent.session.header.cwd === undefined) rejectNotFound({ kind: 'session', sessionId })
    return {
      cursor: agent.session.seq - 1,
      active: true,
      running: agent.status === 'running',
      queue: queueItems(agent),
      pendingInput: this.pendingInput(agent.session.id),
    }
  }
  const state = await this.historyController.usingObservation({ sessionId, projection: false }, signal, (observation) => {
    if (!retried && observation.source === 'live') return undefined
    if (observation.header.cwd === undefined) rejectNotFound({ kind: 'session', sessionId })
    return {
      cursor: observation.cursor,
      active: false,
      running: false,
      queue: null,
      pendingInput: this.pendingInput(observation.header.id),
    }
  })
  signal.throwIfAborted()
  return state ?? this.readState(sessionId, signal, true)
}
```

```ts
// dsh/node_modules/@deepseek-ai/dsh-agent-loop/src/agent.ts
get status(): AgentStatus {
  return this.phase.kind === 'idle' || this.phase.kind === 'maintenance' ? 'idle' : 'running'
}
// AgentStatus = 'idle' | 'running'
```

Therefore `busy = state.running === true || state.queue.length > 0`.

## 7. `turn/end` reasons — success vs failure (v0.2 fix)

`turn/end` carries a merge-extensible `TurnEndReason`; only some kinds mean the
turn failed:

```ts
// dsh/node_modules/@deepseek-ai/dsh-session/src/types.ts
export interface TurnEndReasonMap {
  completed: { kind: 'completed' }
  /** A cancellation request interrupted the live turn. */
  aborted: { kind: 'aborted'; reason: TurnEndCancelCause }
  blocked: { kind: 'blocked' }
  /**
   * The turn failed. `error` is always a structured failure: the `LlmError`
   * facts verbatim, or `{ message: errorChain(error), code }` flattened from
   * any other error, where `code` is `TOOL_ACTIVATION_FAILED` for a failed
   * tool condition and `UNKNOWN` otherwise.
   */
  error: { kind: 'error'; error: LlmFailure }
  /** At least one step reached its output-token ceiling ... */
  'max-tokens': { kind: 'max-tokens' }
  interrupted: { kind: 'interrupted' }   // crash-orphaned closer
  // forked: seed-only
}
```

The plugin marks `aborted` / `blocked` / `error` / `interrupted` as
`status=failed`; `completed` and `max-tokens` remain `done` (max-tokens is a
truncated success, not an error).

## 8. Incremental log reads — `snapshotEvents(from)` (v0.2 fix)

`Session.snapshotEvents(from?)` takes an optional log offset. The Host itself
uses that form to scan only unseen receipts:

```ts
// dsh/node_modules/@deepseek-ai/dsh-api-session-controller/src/commands.ts
for (const event of session.snapshotEvents(receipts.offset)) {
  if (event.type !== 'agent/inbox/spliced' && event.type !== 'user/message') continue
  ...
}
```

v0.2 therefore keeps a cursor and calls `snapshotEvents(cursor)` each poll
instead of `snapshotEvents()` (full copy) + filter.

