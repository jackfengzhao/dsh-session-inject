# dsh-session-inject 交付报告

- 日期：2026-11-23（Asia/Shanghai）
- dsh：0.8.6（profile `web` 运行中，`desktop` 已安装待重启）
- 插件版本：0.3.0（v0.1 初版见第 3 节；v0.2 修复见第 9 节；v0.3 等待语义见第 10 节）
- 交付目录：`C:\Users\<user>\Documents\code\dsh-session-inject\`
- 运行端点：`http://127.0.0.1:3090/mcp/session-inject`（健康检查 `/health`）

> **发布前脱敏说明**：本报告与 `evidence/` 下的原始输出在公开发布时做了三处替换——
> 本机用户名 → `<user>`、会话标题 → `<redacted-title>`、镜像会话 id 与模型服务商 →
> `hermes-<redacted-id>` / `<provider>`。其余字段（状态、耗时、错误码、事件类型、模型名）
> 保持原始值，可逐条与复跑结果对照。

## 0. 结论

在 `web` profile 中插件已**热加载并实测通过**：Hermes 可以列出活会话、向指定
session id 投递用户回合、同步取回该回合最终回复、查询投递状态；不存在的
session id 返回结构化 `E_UNKNOWN_SESSION` 并附活会话列表；同会话并发投递被
串行化，回复不串台。`desktop` profile 已通过 `dsh plugin add` 安装并写入
`dsh.profile.bundles`，但需要重启 desktop 端才能验证（本会话无法重启它）。

## 1. API 依据（原文摘录）

完整摘录见 [`docs/api-evidence.md`](api-evidence.md)。要点：

### 1.1 已排除的死路：`prompt.submit`

`prompt.submit` 确实存在，但它挂在 **ModsApi**（Claude-Code mods 桥）上，参数
只有 `{ text, asUser? }`，没有 session id，无法指定目标会话：

```ts
readonly prompt: {
    submit(input: PromptSubmitArgs): Promise<{ text: string }>;
};
export interface PromptSubmitArgs { text: string; asUser?: boolean; }
```

`subagents.sendMessage / subagents.prompt` 仍受子代理树限制，不用于根会话。

### 1.2 实际使用的入口：`ctx.sessionController.prompt`

`cordis_inspect_query`（host / Service / `sessionController`）给出的真实契约：

```ts
@Remote('prompt') async prompt(request: SessionPromptRequest, signal: AbortSignal): Promise<SessionPromptValue>
// Admit one prompt after explicitly resuming its Session.

export interface SessionPromptRequest {
  readonly requestId: SessionRequestId
  readonly sessionId: SessionId
  readonly mode: 'queue' | 'steer'
  readonly content: readonly PromptContentPart[]
  readonly clientTimeZone?: string
}
export interface SessionPromptValue { readonly accepted: true }
```

源码实现（`dsh-api-session-controller/src/index.ts:469-494`）：

```ts
@Remote('prompt')
async prompt(request: SessionPromptRequest, signal: AbortSignal): Promise<SessionPromptValue> {
  signal.throwIfAborted()
  ...
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

`commands.prompt` 最终 `agent.followup(message)`（queue）或 `agent.steer(message)`
—— 消息以 `content.source.kind === 'user'` 落进目标会话日志，由该会话自己的
agent loop 执行（不 spawn 子代理）。

`@Remote` 只是元数据装饰器（`remoteDecorator` 只做 `addMarkerInitializer`），
不替换方法；`principalOf(undefined)` 明确返回 `undefined`。因此在插件里直接调用
`ctx.get('sessionController').prompt(...)` 是受支持的进程内调用。

### 1.3 取回回复

`prompt` 只返回 `{accepted:true}`。插件在会话事件里等待：

1. 找到 `user/message` 且 `data.source.rpcId === our requestId` 的锚点；
2. 等待该锚点之后第一个 `turn/end`；
3. 取区间内最后一条 `assistant/message` 的文本块拼接，即为该回合最终回复。

实测片段：

```
[user/message] seq=106 source={"kind":"user","rpcId":"dsh-session-inject-...","clientTimeZone":"Asia/Shanghai"}
[assistant/message] seq=108 turn=11  text: "EVID-MWT3SPLQ"
[turn/end] seq=110 data={"turn":11,"reason":{"kind":"completed"}}
```

## 2. MCP 工具

| 工具 | 参数 | 返回 |
|---|---|---|
| `sessions_list` | 无 | `[{session_id,title,model,cwd,busy}]` |
| `session_inject` | `session_id?`、`content`(1..32000)、`delivery`(`queue`\|`steer`)、`wait_ms?` | `{ ok, session_id, submission_id, status, reply_text?, turn_end_seq?, last_event_type?, turn_end_reason?, assistant_texts?, elapsed_ms }` |
| `inject_status` | `submission_id` | `{ submission_id, session_id, status, reply_text?, error?, failure?, turn_end_seq?, last_event_type?, turn_end_reason?, assistant_texts?, elapsed_ms }` |
| `session_create` | `cwd?`、`agentPreset?`、`provider?`、`model?` | `{ ok, session_id }` |

- 状态机：`queued -> running -> done | failed`。
- `wait_ms=0`：admission 后立即返回（最多等 750ms 让状态从 queued 变为 running）。
- `wait_ms>0`：最多等这么久；超时返回 JSON-RPC `E_TIMEOUT`（带
  `submission_id`），后台继续跑，之后可用 `inject_status` 取回。
- 同 session 串行队列：第二个投递保持 `queued`，等第一个回合结束后才开始，
  因此不会出现交叉回合。
- 错误码：`E_UNKNOWN_SESSION` / `E_INJECT_FAILED` / `E_TIMEOUT` /
  `E_NO_LIVE_SESSION`（+ `E_INVALID_SPEC` / `E_UNKNOWN_TOOL` /
  `E_AUTH_REQUIRED` / `E_INTERNAL`）。会话类错误的 `message` 末尾附当前活会话
  id 列表，`data.live_sessions` 同时给出数组。

## 3. 六项验收实测

证据文件均在 `docs/evidence/`。

### A. `sessions_list` 返回真实活会话（含 `session-3b7b923d-...`）✅

时间：2026-11-23T18:09:02+08（UTC 10:09:02）。证据：
[`03-sessions-list.json`](evidence/03-sessions-list.json)。

```json
{"session_id":"session-3b7b923d-6745-481a-8145-9b0b7f699534","title":"<redacted-title>",
 "model":"<provider>/mimo-v2.6-flash","cwd":"C:\\Users\\<user>\\Hermes","busy":true}
```

同一响应（`content[0].text` 为 JSON 数组）还列出 `session-c8bc66df-...`、
`hermes-<redacted-id>...`、`session-3e2b7ded-...`，共 4 条。

### B. 向测试会话投递后，该会话本体产生新回合 ✅

测试会话：`session-3e2b7ded-74fb-4fea-803d-0cbc0d81e344`（18:03:34 新建，工作目录
`...\dsh-session-inject\test-workspace`，模型 `<provider>/mimo-v2.6-flash`）。

- 投递 `只回复 EVID-MWT3SPLQ，不要解释。` 于 18:09:03，`status=done`，
  `turn_end_seq=110`（[`04-inject.json`](evidence/04-inject.json)）。
- 会话 projcache（[`09-projcache.json`](evidence/09-projcache.json)）：

```json
"sessionStats": { "turns": 15, "steps": 15, "lastTurn": 15 },
"turnOutline": { "turns": [
  { "turn": 11, "seq": 103, "prompt": "只回复 EVID-MWT3SPLQ，不要解释。", "response": "EVID-MWT3SPLQ" },
  { "turn": 14, "seq": 130, "prompt": "只回复 CURL-OK，不要解释。", "response": "CURL-OK" }
] }
```

  从空白会话开始，每次投递恰好 `turn/start` +1、`turn/end` +1
  （[`08-session-events.txt`](evidence/08-session-events.txt) 统计：15 个
  `turn/start`、15 个 `turn/end`、15 条用户锚点消息）；时间线（HUD 同一份
  projcache）可见该条用户消息与回复。

### C. 返回体拿到该回合回复文本，与时间线逐字一致 ✅

- `04-inject.json`：`reply_text = "EVID-MWT3SPLQ"`；
  `08-session-events.txt`：`[assistant/message] seq=108 turn=11 text:"EVID-MWT3SPLQ"`。
- curl 实跑：`reply_text = "CURL-OK"`；事件日志 `seq=135 turn=14 text:"CURL-OK"`。
- 首轮（PowerShell `Invoke-WebRequest` 发送时中文被编码成 `?`，非插件问题）：
  `reply_text = "INJECT-OK — 收到。这看起来是一条注入/连通性测试消息，..."`，
  与 projcache 中 turn 1 的 `response` 完全一致。

### D. 不存在的 session_id → `E_UNKNOWN_SESSION` 且附活会话列表 ✅

证据：[`06-unknown-session.json`](evidence/06-unknown-session.json)。

```json
{"code":-32030,
 "message":"unknown session_id: session_id \"session-does-not-exist-0000\" is not a known DSH session (live sessions: session-3b7b923d-..., session-c8bc66df-..., hermes-<redacted-id>..., session-3e2b7ded-...)",
 "data":{"error_code":"E_UNKNOWN_SESSION","live_sessions":["session-3b7b923d-...","session-c8bc66df-...","hermes-<redacted-id>...","session-3e2b7ded-..."],
         "cause":"session \"session-does-not-exist-0000\" not found"}}
```

### E. 并发两次投递同一会话 → 第二个排队，不交叉回合 ✅

证据：[`07-concurrent.json`](evidence/07-concurrent.json)（18:06:28 起，总耗时 3029ms）。

| 请求 | 回复 | 耗时 |
|---|---|---|
| `只回复 CONC-A` | `CONC-A` | 1331ms |
| `只回复 CONC-B` | `CONC-B` | 3186ms（排在 A 之后） |

会话日志（[`08-session-events.txt`](evidence/08-session-events.txt)）确认这是两个
独立回合：

```
[turn/start] turn=12 -> [user/message] seq=115 CONC-A -> [assistant/message] seq=117 "CONC-A" -> [turn/end] seq=119
[turn/start] turn=13 -> [user/message] seq=124 CONC-B -> [assistant/message] seq=126 "CONC-B" -> [turn/end] seq=128
```

第二个投递在第一个回合结束前一直处于 `queued`，没有出现交叉回合。

### F. Hermes 侧 curl 示例 + 真实输出 ✅

脚本：[`examples/hermes-curl.ps1`](examples/hermes-curl.ps1)（Windows，UTF-8 payload 文件
避免 PowerShell 5.1 的 ISO-8859-1 编码问题）；另附
[`examples/hermes-curl.sh`](examples/hermes-curl.sh)。

实际执行：

```powershell
powershell -File .\examples\hermes-curl.ps1 `
  -SessionId "session-3e2b7ded-74fb-4fea-803d-0cbc0d81e344" `
  -Content "只回复 CURL-OK，不要解释。"
```

真实输出（原样，[`10-curl-output.txt`](evidence/10-curl-output.txt)）：

```json
{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"{\n  \"ok\": true,\n  \"session_id\": \"session-3e2b7ded-74fb-4fea-803d-0cbc0d81e344\",\n  \"submission_id\": \"sub-mwt3swa5-ivzg9ook\",\n  \"status\": \"done\",\n  \"reply_text\": \"CURL-OK\",\n  \"turn_end_seq\": 137,\n  \"elapsed_ms\": 1289\n}"}],"metadata":{"ok":true,"session_id":"session-3e2b7ded-74fb-4fea-803d-0cbc0d81e344","submission_id":"sub-mwt3swa5-ivzg9ook","status":"done","reply_text":"CURL-OK","turn_end_seq":137,"elapsed_ms":1289},"isError":false}}
```

等价 curl（bash，见脚本）：

```bash
curl -sS -X POST http://127.0.0.1:3090/mcp/session-inject \
  -H 'content-type: application/json' \
  --data-binary '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"session_inject","arguments":{"session_id":"<id>","content":"只回复 INJECT-OK","delivery":"queue","wait_ms":120000}}}'
```

最终 3 工具回归（关闭 `session_create` 测试辅助后）再跑一次
`tools/smoke.mjs`：`passed=true`，5 项检查全过
（[`11-final-smoke.json`](evidence/11-final-smoke.json)），
端点健康快照见 [`12-final-health.json`](evidence/12-final-health.json)。

## 4. 安装与精确 diff

实际安装方式（推荐，两条命令）：

```powershell
dsh plugin --profile web add "C:\Users\<user>\Documents\code\dsh-session-inject"
dsh plugin --profile desktop add "C:\Users\<user>\Documents\code\dsh-session-inject"
```

`dsh plugin add` 做了两件事：在 profile 目录 `pnpm link` 该目录，并把
`dsh-session-inject` 写进 `dsh.profile.bundles`。**没有改动任何 profile 的
`cordis.patch.yml`** —— 插入行由插件包自带的 `cordis.patch.yml` 提供：

```yaml
- insert:
    - id: dsh-session-inject
      name: 'dsh-session-inject'
      config:
        port: 3090
        host: '127.0.0.1'
```

### web profile 实际 diff（`C:\Users\<user>\.dsh\profiles\web\package.json`）

```diff
   "dependencies": {
     "@modusensus/dsh-mneme": "0.17.0",
     "@xrn1997/dsh-session-delete": "0.9.0",
     "dsh-hermes-link": "0.8.6",
+    "dsh-session-inject": "link:C:/Users/<user>/Documents/code/dsh-session-inject",
     "dsh-workspace-control": "0.8.6",
     "dshmarket": "^1.77.1"
   },
   "dsh": { "profile": { "bundles": [
     "@deepseek-ai/dsh-base",
     "@deepseek-ai/dsh-web-app",
     "dshmarket",
     "@modusensus/dsh-mneme",
     "@xrn1997/dsh-session-delete",
     "dsh-workspace-control",
-    "dsh-hermes-link"
+    "dsh-hermes-link",
+    "dsh-session-inject"
   ] } }
```

### desktop profile 实际 diff（`C:\Users\<user>\.dsh\profiles\desktop\package.json`）

```diff
   "dependencies": {
     "@modusensus/dsh-mneme": "0.16.1",
     "@xrn1997/dsh-session-delete": "0.9.0",
     "dsh-hermes-link": "0.8.6",
+    "dsh-session-inject": "link:C:/Users/<user>/Documents/code/dsh-session-inject",
     "dsh-workspace-control": "0.8.6",
     "dshmarket": "1.80.0"
   },
   "dsh": { "profile": { "bundles": [
     "@deepseek-ai/dsh-base",
     "@deepseek-ai/dsh-web-app",
     "@modusensus/dsh-mneme",
     "dshmarket",
     "@xrn1997/dsh-session-delete",
-    "dsh-workspace-control"
+    "dsh-workspace-control",
+    "dsh-session-inject"
   ] } }
```

（desktop 的 `cordis.patch.yml` 原样未动；它里面 `dsh-hermes-link: disabled: true`
与本插件无关。）

### 手工注册（如果不想用 `dsh plugin add`）

1. 把本目录复制/链接到 `<profile>\node_modules\dsh-session-inject`；
2. 在 `<profile>\package.json` 的 `dependencies` 加入
   `"dsh-session-inject": "link:<绝对路径>"`；
3. 在 `dsh.profile.bundles` 末尾加入 `"dsh-session-inject"`；
4. 重启 dsh。

`install.ps1` 封装了 1 中的前两步（`dsh plugin add` + 校验 bundles）。

## 5. 回滚

```powershell
dsh plugin --profile web remove dsh-session-inject
dsh plugin --profile desktop remove dsh-session-inject
```

然后重启 dsh。`dsh plugin remove` 会同时移除依赖与 `dsh.profile.bundles` 条目；
本插件没有改过 profile 的 `cordis.patch.yml`，因此无需还原 patch。测试会话
`session-3e2b7ded-...` 及其日志在
`C:\Users\<user>\.dsh\sessions\--C-Users-<user>-Documents-code-dsh-session-inject-test-workspace--\`
可自行删除。

## 6. 安全

- 未降低任何既有安全设置：插件不修改 approval / sandbox / permission 配置。
- 监听只绑 `127.0.0.1`，不对外网开放；无 CORS。
- 可选 Bearer：`DSH_SESSION_INJECT_TOKEN`（或 config.token）；未设置时本机任意
  进程都能调用，属于"本机信任边界"内的工具，和 dsh-hermes-link 默认行为一致。
- 不读取、不写入任何 key/token；报告与日志中无凭据明文。
- 测试只用了新建的测试会话（`session-3e2b7ded-...`），未向用户真实会话写入
  测试内容（`session-3b7b923d` 等只被 `sessions_list` 读取）。
- `session_create` 在 v0.2 起默认注册为第 4 个工具；`config.allowCreate: false`
  可关闭（v0.1 时它默认不注册）。

## 7. 已知限制 / 未验证项

- desktop profile 需要重启 desktop 端后才能验证端点是否起来；本会话只能确认
  文件与 package.json 已就位。
- `busy` 直接采用 Host 的 `agent.status === 'running'`（与 GUI 转圈同源）。
- `title` / `model` 是尽力而为：title 来自 `sessionQuery.readTitle`，model 来自
  活 Agent 的当前选择，回退到会话日志里的最后一条模型路由。
- 端口 3090 若被占用，插件只打印错误、不会崩溃；改 `port` 配置即可。
- 未做 SSE/streaming，回复是"回合结束后一次性取回"。
- 投递记录只在内存：dsh 重启或插件 reload 后旧 `submission_id` 失效；最多保留
  500 条已结束记录。
- `content` 上限 32000 字符；超出返回 `E_INVALID_SPEC`。
- `queue` 每会话串行；`steer` 不排队（v0.2 新增），其回复是该共享回合的最终消息。

## 8. 文件清单

```
index.mjs                     Host 插件入口
lib/server.mjs                MCP JSON-RPC HTTP + 5 个工具 + SSE progress
lib/session-api.mjs           sessionController.prompt / 增量 turn 等待 / 会话列表
lib/records.mjs               投递记录 + 相位 + 持久化 JSONL + 每会话串行队列
cordis.patch.yml              loader insert
install.ps1                   安装脚本
examples/hermes-curl.sh       Hermes 侧 bash 示例
examples/hermes-curl.ps1      Hermes 侧 Windows 示例
tools/asar.mjs                asar 读取器（list/cat/extract/grep）
tools/session-tail.mjs        会话 zstd 日志解码/摘要
tools/smoke.mjs               端到端 smoke
tools/test-concurrent.mjs     并发验收
tools/test-steer.mjs          steer 验收
tools/mcp-client-check.mjs    官方 MCP SDK 握手/调用验收
tools/capture-evidence.mjs    v0.1 证据采集
tools/capture-v02.mjs         v0.2 证据采集
tools/bench-scan.mjs          全量扫描 vs 增量扫描微基准
tools/inject.mjs              手工投递 CLI
tools/fake-401-server.mjs     401 fixture（仅测试）
tools/verify-desktop.ps1      desktop 重启后验证脚本
tools/test-wait-cap.mjs       v0.3 wait 截断验收
tools/test-recover.mjs        v0.3 断连找回验收
tools/test-stall.mjs          v0.3 stalled 相位验收
tools/test-progress.mjs       v0.3 MCP progress 验收
tools/test-ttl.mjs            v0.3 持久化 TTL/压缩单测
docs/REPORT.md                本报告
docs/api-evidence.md          API 原文摘录
docs/evidence/                实测输出
```

## 9. v0.2 修复（2026-11-23 19:23–19:35 +08）

### 9.1 `busy` 恒为 true

- **问题**：4 个活会话全部 `busy=true`，包括闲置数小时的会话。
- **根因**：v0.1 的 `busyOf(state)` 用了 `state.running || state.active`。
  Host 的 `sessionController.state()` 里 `active` 只表示"存在活 Agent"，
  对任何活会话都为 `true`；真正的回合状态是 `running`（`agent.status === 'running'`）。
  asar 原文（`dsh-api-session-controller/src/state/controller.ts:137-146`）：

  ```ts
  const agent = this.ctx.agents.get(sessionId)
  if (agent !== undefined) {
    ...
    return {
      cursor: agent.session.seq - 1,
      active: true,
      running: agent.status === 'running',
      queue: queueItems(agent),
      pendingInput: this.pendingInput(agent.session.id),
    }
  }
  ```

  `agent.status` 的实现（`dsh-agent-loop/src/agent.ts`）：
  `phase.kind === 'idle' || 'maintenance' ? 'idle' : 'running'`。
- **改法**：`busy = state.running === true || (state.queue?.length > 0)`，
  不再看 `active`。
- **证据**：[`2x-busy.json`](evidence/2x-busy.json)（2026-11-23T11:29:48Z）。
  - 空闲：`session-3b7b923d` `busy=false`、`hermes-<redacted-id>` `false`、
    测试会话 `false`
  - 正在跑（本会话 `session-c8bc66df`）：`busy=true`

### 9.2 `session_create` 已实现但未注册

- **根因**：v0.1 里 `buildToolsList` 用 `config.allowCreate === true` 才列出工具，
  而最终配置没有 `allowCreate`；同时 dispatcher 的 guard 也是
  `config.allowCreate === true`，两层一起把它藏掉了。
- **改法**：默认注册为第 4 个工具（`config.allowCreate: false` 可显式关闭），
  dispatcher guard 同步为 `!== false`；描述改为正式的创建语义。
- **证据**：[`2x-tools-list.json`](evidence/2x-tools-list.json) 列出 4 个工具；
  [`2x-session-create.json`](evidence/2x-session-create.json) 创建
  `session-fd7a95e8-3bf3-4ad1-a263-517b298856fe`；
  [`2x-create-inject.json`](evidence/2x-create-inject.json) 对它投递并拿到
  `reply_text:"CREATE-OK"`（`turn_end_seq=19`）。

### 9.3 鉴权

- **现状**：v0.1 代码已有 `config.token` / `DSH_SESSION_INJECT_TOKEN` 分支，但从未
  启用或验证（health 一直是 `auth:"open"`）。
- **改法**：补齐验收，并把比较改为常量时间
  `timingSafeEqual(sha256(actual), sha256(expected))`；文档写明配置方式。
- **证据**：[`2x-auth.json`](evidence/2x-auth.json)（2026-11-23T11:32:32Z）。
  临时设 `token: <redacted-test-token>` 后：不带 401、错 token 401、正确 token 200；
  health `auth="bearer-required"`。测试后已移除 token，恢复 `auth="open"`。

### 9.4 官方 MCP SDK 兼容性

- **改法**：安装 `@modelcontextprotocol/sdk`（1.32.2），新增
  `tools/mcp-client-check.mjs`，用 `Client` + `StreamableHTTPClientTransport`
  跑完整握手。
- **证据**：[`2x-mcp-client.json`](evidence/2x-mcp-client.json)：
  `initialize=ok`、`protocolVersion=2024-11-05`、
  `tools=[sessions_list, session_inject, inject_status, session_create]`；
  `sessions_list` / `session_inject` / `inject_status` 均
  `isError=false`、`content[].type="text"`；`session_inject` 回复
  `MCP-SDK-OK`。无需改服务端（notifications 的 204 被 SDK 接受）。

### 9.5 回复提取边界

- **改法**：
  - 返回 `reply_text`（最后一条 assistant 文本，可能为 `""`）、
    `last_event_type`（`turn/end` 前最后一个事件类型）、
    `assistant_texts`（本回合全部 assistant 文本数组）、`turn_end_reason`。
  - `turn/end` 的 `aborted` / `blocked` / `error` / `interrupted` 判为失败：
    `status=failed` + `E_INJECT_FAILED` + 结构化 `data.failure` /
    `data.turn_end_reason`（保留 `LlmFailure` 原文）。
- **证据**：
  - 只调工具不回复：[`2x-edge-toolonly.json`](evidence/2x-edge-toolonly.json)，
    `reply_text:""`、`last_event_type:"step/end"`、`assistant_texts:["","","",""]`、
    `turn_end_reason:{kind:"completed"}`；原始日志
    [`2x-edge-toolonly-events.txt`](evidence/2x-edge-toolonly-events.txt)
    （user seq=9 → assistant seq=18/25/32/42 全空 → turn/end seq=44）。
  - 真实 401 失败：[`2x-edge-401.json`](evidence/2x-edge-401.json)，
    `status:"failed"`、`error_code:"E_INJECT_FAILED"`、
    `turn_end_reason:{kind:"error",error:{message:"401: ... invalid api key",code:"AUTH"}}`。
    做法：临时在 web profile 加一个 `v02401` provider 指向本地 401 fixture
    （`tools/fake-401-server.mjs`），创建会话并注入；测试后已删除 provider、
    停掉 fixture。测试会话 `session-fa5f15ce-...` 仍保留 `v02401/fake-401`
    的模型选择（测试残留，不再可用，可忽略或删除该会话）。

### 9.6 `waitForTurn` 性能

- **改法**：增量扫描。记住 `cursor`，每轮调用
  `session.snapshotEvents(cursor)` 只取新增事件（Host 支持 `from` 偏移），
  不再每 150ms 复制/过滤整份日志。`/health` 暴露
  `perf.scans / perf.scan_ms / perf.scan_ms_avg / perf.events_examined`；
  配置 `legacyScan:true` 可切回 v0.1 全量扫描做 A/B。
- **证据**（20 轮测试会话 `session-3e2b7ded`）：
  - v0.1 全量：[`2x-perf-legacy.json`](evidence/2x-perf-legacy.json) —
    139 次扫描、4.40ms 总计、0.03ms/次。
  - v0.2 增量：[`2x-perf-incremental.json`](evidence/2x-perf-incremental.json) —
    12 次扫描、0.05ms 总计、≈0.004ms/次（两次模型延迟不同，比较单次扫描耗时）。
  - 大规模外推：[`2x-perf-synthetic.json`](evidence/2x-perf-synthetic.json)
    （`snapshotEvents()` 全量复制 vs `snapshotEvents(cursor)`）：

    | 事件数 | v0.1 每次 | v0.2 每次 | 倍数 |
    |---|---|---|---|
    | 10k | 0.0519ms | 0.0001ms | 479x |
    | 100k | 0.6065ms | 0.0012ms | 512x |
    | 1M | 5.8601ms | 0.0002ms | 23440x |

### 9.7 `steer` 实测（顺手项）

- **改法**：`steer` 走 `store.runImmediately`，不排进每会话串行队列（否则会被
  降级成普通 queue 回合）。
- **证据**：[`2x-steer.json`](evidence/2x-steer.json)（checks 全 true）与
  [`2x-steer-events.txt`](evidence/2x-steer-events.txt)：
  queue 投递在 t+0.75s 返回 `status:"running"`；steer 在 t+2.5s 发出，
  在 turn 2 内部落为 `user/message seq=32`（turn 结束是 seq=36），
  最终回复包含 `STEER-OK`；两个 submission 都归到同一回合（`turn_end_seq=36`）。

### 9.8 README 补充（顺手项）

已补：Hermes 侧 `mcp_servers` 接入片段、错误码表、限制（记录仅内存、
重启后 submission_id 失效、32000 字符上限、并发策略、steer 语义）。

### 9.9 diff 摘要

v0.1 目录未纳入 git，无法生成逐行 patch；以下为改动文件与行数（v0.2 后）：

| 文件 | 行数 | 改动 |
|---|---|---|
| `lib/session-api.mjs` | 414 | `eventsOf(session, from)`、`busyOf` 修复、`turnEndFailure`、增量 `waitForTurn`（约 ±120 行） |
| `lib/server.mjs` | 465 | 4 工具注册、失败结构化、`perf` 计数、常量时间 token 比较、steer 立即通道（约 ±90 行） |
| `lib/records.mjs` | 124 | 新字段 + `runImmediately`（约 +30 行） |
| `cordis.patch.yml` | 15 | 版本/配置注释（token、legacyScan 测试后移除） |
| `README.md` | 158 | 4 工具、错误码、限制、Hermes 接入、鉴权（重写） |
| `docs/api-evidence.md` | 280 | 增加 `state()` 原文、`turn/end` 原因、`snapshotEvents(from)` |
| `docs/REPORT.md` | 本文件 | 追加本章 |
| `tools/mcp-client-check.mjs` | 123 | 官方 SDK 验收 |
| `tools/bench-scan.mjs` | 74 | 扫描性能基准 |
| `tools/test-steer.mjs` | 72 | steer 验收 |
| `tools/inject.mjs` | 28 | 手工投递 CLI |
| `tools/fake-401-server.mjs` | 26 | 401 fixture |
| `tools/verify-desktop.ps1` | 112 | desktop 重启后验证 |
| `tools/capture-v02.mjs` | 81 | v0.2 证据采集 |

### 9.10 两个 profile 同步 / desktop 验证

- 两个 profile 的 `node_modules/dsh-session-inject` 都是指向本目录的 symlink，
  代码改动自动共享；`desktop` 需要**重启一次**才会加载 v0.2 进程内代码。
- 本会话没有重启任何 dsh；web 侧全程用 `workspace_control action=refresh` 热加载。
- 重启 desktop 后运行：

  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\verify-desktop.ps1
  ```

  脚本检查 `/health` 版本 ≥0.2.0、MCP initialize、4 个工具、
  `sessions_list`、`session_create → session_inject → inject_status`
  全链路（期望 `DESKTOP-OK`）。该脚本已先在 web 端点跑通：
  [`2x-verify-desktop-script-on-web.txt`](evidence/2x-verify-desktop-script-on-web.txt)
  （4 项 PASS；脚本只用 ASCII，避免 Windows PowerShell 5.1 的编码问题）。
- 注意：web 与 desktop 同时运行时都要绑 3090，会冲突；先停一个再验证另一个。

## 10. v0.3 等待语义与状态可观测性（2026-11-23 20:49–21:00 +08）

### 10.1 故障复现与结论

Hermes 的 MCP 客户端固定 300s 超时。v0.2 下
`session_inject(wait_ms=300000)` 会一直等到回合结束才发响应；客户端 300s
掐断后**响应体永久丢失**，而 `submission_id` 只存在于响应里，于是调用方
既没有 id 可查，也无法区分"dsh 挂了"和"任务还在跑"。

v0.3 的结论：等待可以保留，但**状态不能只靠最后一个响应**。四件事同时做：
等待有上限、id 处处都有、记录落盘、状态随时可查（含 stalled 心跳）。

### 10.2 需求 → 实现 → 证据

| 需求 | 实现 | 证据 |
|---|---|---|
| R1 wait 上限/截断 | `maxWaitMs=240000`；超限截断，返回 `ok:true,status:"running",wait_capped,requested_ms,effective_ms,submission_id`，不再返回 `E_TIMEOUT` | [`3x-wait-cap.json`](evidence/3x-wait-cap.json) |
| R2 `submissions_list` | 新工具，按 `session_id`/`status` 过滤、`limit` 默认 10；返回 R2 全字段 | [`3x-disconnect.json`](evidence/3x-disconnect.json) |
| R3 `inject_status` 增补 | `phase / queue_position / last_activity_at / idle_ms / steps_seen / reply_preview` | [`3x-orphaned.json`](evidence/3x-orphaned.json) |
| R4 事件心跳 | `waitForTurn` 的 `onEvent` 把每个新事件写进记录：`last_event_type`、`last_activity_at`（事件 `time`）、`steps_seen`（`step/start` 计数） | [`3x-stall.json`](evidence/3x-stall.json) |
| R5 持久化 | `<DSH_HOME>/dsh-session-inject/submissions.jsonl` 追加写，启动时按 id 压缩、丢弃 >24h；旧 id 查询返回 `phase:"orphaned"` + 最后状态 | [`3x-orphaned.json`](evidence/3x-orphaned.json) |
| R6 progress | `_meta.progressToken` + `Accept: text/event-stream` 时，`tools/call` 走 SSE，每 8s 发 `notifications/progress`，最后发结果 | [`3x-progress.json`](evidence/3x-progress.json) |
| R7 统一契约 | 先 mint 记录再校验：参数错误/未知会话/无活会话/失败回合的 `error.data` 都带 `submission_id` | [`3x-error-contract.json`](evidence/3x-error-contract.json) |
| R8 文档 | README 增加长任务调用序列、上限/stall/progress 说明；本章为 REPORT 增量 | 本文件 |

实现要点：

- 记录在**参数校验之前**创建（`store.create`），失败分支把它标成
  `failed` 并落盘，因此 `inject_status` 仍可查到"这次请求为什么失败"。
- `phase` 是读时派生：`done/failed/queued` 直接映射；`running` 在
  `now - last_activity_at > stallMs(120000)` 时变成 `stalled`（仍 `status:running`，
  不是失败），下一个事件到来即恢复。
- 持久化快照包含 `wait_capped/requested_ms/effective_ms/steps_seen/
  last_event_type/last_activity_at/reply_preview(<200)/reply_chars`；
  进程重启后这些字段原样返回，`reply_text` 只保留 preview（不落全量）。
- `wait_ms` 省略时默认等 `defaultWaitMs=3000`（显式 `0` 才是"投递即返回"），
  保证短任务仍能在默认调用下拿到 `done`（验收 F）。

### 10.3 验收 A–F 实测

| 项 | 结果 | 关键数据 | 证据 |
|---|---|---|---|
| A `wait_ms=600000` | ✅ 不报错，`running` + 截断 | wall=240080ms，HTTP 200，`wait_capped:true`，`requested_ms:600000`，`effective_ms:240000`，`submission_id:sub-mwt9mwq7-39duat0c`，`phase:stalled`（正在 sleep） | [`3x-wait-cap.json`](evidence/3x-wait-cap.json) |
| B curl `--max-time 5` 断开后找回 | ✅ | curl exit=28（5009ms，0 bytes）→ `submissions_list(session)` 找到 `sub-mwt9n4cx-hniktu6y`（`running`）→ `inject_status` 到 `done`，`reply_text:"B-DONE"` | [`3x-disconnect.json`](evidence/3x-disconnect.json) |
| C 150s 无事件 → stalled → done | ✅ | `idle_ms=124191` 时 `phase:"stalled"` 且 `status:"running"`；随后 `done`，`reply_text:"STALL-DONE"` | [`3x-stall.json`](evidence/3x-stall.json) |
| D 重启后旧 id | ✅ | 插件 reload（新进程，等价于重启加载）后：old done id → `phase:"orphaned"`, `status:"done"`, `reply_preview:"B-DONE"`；old running id → `phase:"orphaned"`, `status:"running"`；`submissions_list` 含 orphaned 行；**不是 unknown** | [`3x-orphaned.json`](evidence/3x-orphaned.json) |
| E SDK progress ≥2 | ✅ | SDK 1.32.2，收到 **4** 条 `notifications/progress`，调用最终 `done` | [`3x-progress.json`](evidence/3x-progress.json) |
| F 短任务回归 | ✅ | 不带 `wait_ms`：wall=1571ms，`status:"done"`，`reply_text:"SHORT-OK"`，`wait_capped:false`，`phase:"done"`；`sessions_list`/`session_create` 正常 | [`3x-short.json`](evidence/3x-short.json) |

补充证据：

- 截断返回后任务仍在会话里跑完：session A 的事件日志出现
  `assistant/message seq=25 "CAP-DONE"`、`turn/end seq=27`
  （[`3x-wait-cap-events.txt`](evidence/3x-wait-cap-events.txt)）。
- `E_UNKNOWN_SESSION` 也带 `submission_id`：
  [`3x-error-contract.json`](evidence/3x-error-contract.json)
  （`sub-mwt9trmk-jqkk8uxz`）。
- 最终健康快照（含 `store.persist_path / stall_ms / max_wait_ms`）：
  [`3x-final-health.json`](evidence/3x-final-health.json)。
- 更新后的 `tools/verify-desktop.ps1` 已在 web 端点整链跑通（5 工具、
  submissions_list、phase=done）：[`3x-verify-desktop-script-on-web.txt`](evidence/3x-verify-desktop-script-on-web.txt)。
- 官方 SDK 在 v0.3 最终代码上再跑一遍完整握手（5 工具、`content[].type="text"`、
  `isError=false`、`phase:"done"`）：[`3x-mcp-client.json`](evidence/3x-mcp-client.json)。
- R5 的 TTL/压缩单元验证（临时文件，不碰线上记录）：old 记录被丢弃、
  fresh 记录保留、同 id 取最新、文件被压缩、加载后标记 orphaned：
  [`3x-ttl.json`](evidence/3x-ttl.json)。

### 10.4 已知边界

- 插件 reload/重启时，正在等待的提交**watcher 会消失**：目标会话仍会跑完，
  但记录不会更新为 done（重启后显示 `orphaned` + 最后状态）。这是无法在
  无宿主持久化钩子的情况下完全避免的，已用 `submissions_list` + orphaned
  状态兜底。
- `reply_text` 不落盘（只存 `reply_preview`），所以 orphaned 记录拿不到完整
  回复；完整回复仍可从会话时间线读取。
- progress 依赖客户端支持 SSE；SDK 已验证，其他客户端可退回
  `inject_status`/`submissions_list` 轮询（10–30s 一次）。
- `stalled` 只是"超过 `stallMs` 没有事件"，不是失败；调大 `stallMs` 可减少
  长时间工具调用的误报。

### 10.5 diff 摘要（v0.2 → v0.3）

v0.2 目录未纳入 git，以下为文件行数与改动点：

| 文件 | 行数 | 改动 |
|---|---|---|
| `lib/server.mjs` | 626 | 5 工具、maxWaitMs/defaultWaitMs、统一 `submission_id`、phase 返回、SSE progress、store 配置（约 ±160 行） |
| `lib/records.mjs` | 355 | 持久化 JSONL、phase/idle/queue_position、heartbeat、orphaned（重写，+230 行） |
| `lib/session-api.mjs` | 417 | `waitForTurn` 增加 `onEvent` 心跳回调（+8 行） |
| `README.md` | 206 | v0.3 调用序列、phase 表、persistence/progress、配置表（重写） |
| `cordis.patch.yml` | 28 | 配置项注释（默认值） |
| `docs/REPORT.md` | 本文件 | 追加本章 |
| `tools/test-wait-cap.mjs` | 61 | A 验收 |
| `tools/test-recover.mjs` | 68 | B 验收 |
| `tools/test-stall.mjs` | 82 | C 验收 |
| `tools/test-progress.mjs` | 82 | E 验收 |
| `tools/test-ttl.mjs` | 39 | R5 TTL/压缩单测 |
| `tools/verify-desktop.ps1` | 117 | 5 工具 + submissions_list + phase 检查 |
| `docs/evidence/3x-*` | 新增 | 本次全部证据 |

### 10.6 desktop

两个 profile 仍共享同一 symlink，代码已同步；desktop 需重启一次后运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\verify-desktop.ps1
```

本次没有重启任何 dsh；web 侧用 `workspace_control refresh` 热加载验证。


