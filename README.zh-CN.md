# dsh-session-inject

[![version](https://img.shields.io/badge/version-0.3.0-blue.svg)](CHANGELOG.md)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22.13-339933.svg)](https://nodejs.org/)
[![platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-lightgrey.svg)](#环境要求)

[English](README.md) | 简体中文

一个 **DeepSeek Harness（dsh）Host 插件**：在本机回环地址上开一个 MCP 端点，让外部 agent
（例如 [Hermes](https://github.com/NousResearch/hermes-agent)）把一段用户消息**注入指定的某一个活着的
dsh 会话**，并读回该回合的最终回复。

回合由**目标会话本体**执行——用它自己的模型、工具、工作目录、权限预设和上下文，**不会 spawn 子代理**。

```text
Hermes ──MCP over HTTP (127.0.0.1:3090)──▶ dsh 插件 ──sessionController.prompt──▶ 目标会话
                  ◀──────────── reply_text / phase / submission_id ─────────────┘
```

---

## 目录

- [为什么需要这个插件](#为什么需要这个插件)
- [特性](#特性)
- [环境要求](#环境要求)
- [快速开始](#快速开始)
- [MCP 工具](#mcp-工具)
- [等待语义](#等待语义)
- [阶段（phase）](#阶段phase)
- [长任务推荐调用序列](#长任务推荐调用序列)
- [配置项](#配置项)
- [安全边界](#安全边界)
- [已知限制](#已知限制)
- [常见问题](#常见问题)
- [项目结构](#项目结构)
- [开发与自测](#开发与自测)
- [文档](#文档)
- [相关项目](#相关项目)
- [许可证](#许可证)

## 为什么需要这个插件

**作者按 —— 起因。** 我用 dsh 的方式是"一个项目一个长命会话"：几周的决策、目录结构、踩过的坑和当时的判断，
都在这个会话里。这个插件之前，我是按"正规做法"把活派给子代理的。结果每次都出两件事：

1. **父代理开始自由发挥。** 子任务一完成，父会话会收到一条完成通知被唤醒；而父会话手里握着整个项目的历史和
   它自己的主意，于是开始"改进"结果——把我已经验收过的清单重写一遍、把验证过的截图换成它自己选的、动子代理
   刚交付的文件。**本来做对了的活，被一个只该在旁边看着的代理改了味**，这就是我说的**添油加醋**。
2. **子代理天生缺上下文，还为此付全价。** 子代理从一段窄提示出发，不懂项目的约定，所以每次派活都得先手写
   一份 `CONTEXT.md`；回答技术上没错，但对周边设计是瞎的。更糟的是，它是全新会话，前缀缓存从零开始——同一段
   指令每次都要按未命中价重算；而那个已经装着上下文的会长话，第二次请求起就能吃到缓存（本机实测：同一会话
   内约 99% 命中，长项目会话整体 77~82%）。

所以我真正想要的是：**把指令送进那个已经懂这个项目的会话，让会话本体去干**——带着它对决策的记忆、对代码的
理解、和已经热了的缓存。中间不要子代理，旁边不要一个监督者来改结果。

**来龙去脉。** 这一切的起点是 [`dsh-hermes-link`](https://github.com/Tianbuyu-wwx/dsh-hermes-link)
——最初那版 Hermes ↔ dsh 派发桥（`@tianbuyu-wwx/dsh-hermes-link` 0.6.11，为 dsh 0.1.5-rc.2 写的），
以及它在 dsh 0.2.x 上的兼容分支
[`guiyinrenshi/dsh-hermes-link`](https://github.com/guiyinrenshi/dsh-hermes-link)（npm 上以无 scope 的
`dsh-hermes-link` 发布，0.8.6）。两个都是字面意义上的"派发桥"：Hermes 调 `dispatch_task`，dsh
**spawn 一个子代理**，`continuable` 子代理结束时唤醒父会话——正是上面那两个毛病的来源。我先试的是就地修：
加一个 `session_prompt` 工具，把文本走 `ctx.subagents.sendMessage/prompt` 投进去。结果被宿主按根会话拒绝
（`UNAUTHORIZED: send_message requires another agent in the subagent tree`）——子代理 API 本来就被限定在
子代理树内。这条路走死，才有了这个**独立插件**：它走 session-controller API，不读也不改 dsh-hermes-link 的
任何文件，两个项目谁卸谁都能单独存在。

**插件做的事。** 它把一条真正的用户回合投递进那个会话的时间线，等同于你亲手打进去——调用的是 Web GUI
发送按钮走的那条 Host 命令：

```ts
// @deepseek-ai/dsh-api-session-controller (dsh 0.2.x)
@Remote('prompt')
async prompt(request: SessionPromptRequest, signal: AbortSignal): Promise<SessionPromptValue>
// SessionPromptRequest { requestId, sessionId, mode: 'queue' | 'steer', content, clientTimeZone? }
```

`ctx.subagents.sendMessage/prompt` 这条路**走不通**：Host 把它限定在子代理树内，根会话/无关会话会被拒绝
（`UNAUTHORIZED: send_message requires another agent in the subagent tree`）。
源码证据见 [`docs/api-evidence.md`](docs/api-evidence.md)。

## 特性

- **会话本体执行** —— 消息以 `source.kind = "user"` 落进时间线，会话用自身模型/工具/上下文作答。
- **五个 MCP 工具** —— `sessions_list`、`session_inject`、`inject_status`、`submissions_list`、
  `session_create`；JSON-RPC 2.0 over HTTP，支持 `initialize` / `ping` / `tools/list` / `tools/call`。
- **等待永不丢句柄** —— `wait_ms` 硬上限 **240 秒**（低于 MCP 客户端 300 秒超时）；**任何分支**（含报错）
  都返回 `submission_id`。
- **可找回** —— 首个响应丢失时，用 `submissions_list` 按会话重新找回提交；记录落盘，dsh 重启后旧 id 返回
  `phase: "orphaned"` 与最后已知状态，而不是 `unknown`。
- **状态可见** —— `phase`、`idle_ms`、`last_event_type`、`steps_seen` 取自会话事件流
  （`turn/start`、`step/start`、`tool/call`、`assistant/message`、`turn/end`），能区分"在思考""在跑工具""死了"。
- **可选 SSE 进度** —— 客户端带 `params._meta.progressToken` 时每 8 秒发一条 `notifications/progress`；
  已用官方 `@modelcontextprotocol/sdk` 验证收到。
- **零运行时依赖**，只绑回环，可选 Bearer token。

## 环境要求

| 项 | 要求 |
|---|---|
| dsh | 0.2.x（使用 `ctx.sessionController.prompt`；亦在 0.8.x 桌面版验证通过） |
| Node | ≥ 22.13（dsh 自带运行时满足） |
| Hermes | 任一支持 MCP server 的近期版本 —— 可选，任何 MCP 客户端都能连 |
| 网络 | 仅回环；默认不会绑到 `127.0.0.1` 之外 |

## 快速开始

```bash
# 1) 装进一个或多个 dsh profile
dsh plugin --profile web     add /path/to/dsh-session-inject
dsh plugin --profile desktop add /path/to/dsh-session-inject

# 2) 确认包名在 bundles 里（dsh plugin add 不一定自动写）
#    ~/.dsh/profiles/<profile>/package.json -> dsh.profile.bundles 追加 "dsh-session-inject"

# 3) 重启 dsh（插件是进程内加载的），然后自检
curl -s http://127.0.0.1:3090/health

# 4) 让 Hermes 连上来
hermes mcp add dsh-session-inject --url http://127.0.0.1:3090/mcp/session-inject
#    交互问：需要鉴权？ -> n      启用全部工具？ -> y

# 5) 在 Hermes 里 /reload-mcp 或开新会话，工具才会出现
```

完整的换机部署（含 Linux 命令、验收清单、排错）见 [`docs/INSTALL.zh-CN.md`](docs/INSTALL.zh-CN.md)。

## MCP 工具

| 工具 | 参数 | 返回 |
|---|---|---|
| `sessions_list` | 无 | `[{ session_id, title, model, cwd, busy }]` |
| `session_inject` | `session_id?`、`content`（1..32000）、`delivery`（`queue`\|`steer`）、`wait_ms?` | `{ ok, session_id, submission_id, status, phase, wait_capped, requested_ms, effective_ms, elapsed_ms, steps_seen, last_event_type, last_activity_at, idle_ms, reply_text?, turn_end_seq?, turn_end_reason?, assistant_texts? }` |
| `inject_status` | `submission_id` | `{ submission_id, session_id, status, phase, queue_position, started_at, elapsed_ms, steps_seen, last_event_type, last_activity_at, idle_ms, reply_preview, wait_capped, reply_text?, error?, turn_end_reason?, orphaned? }` |
| `submissions_list` | `session_id?`、`limit?`（默认 10）、`status?` | 摘要列表，最新在前 |
| `session_create` | `cwd?`、`agentPreset?`、`provider?`、`model?` | `{ ok, session_id }` |

`session_inject` 的 `session_id` 可省略，省略时投给第一个活会话。

## 等待语义

- 不传 `wait_ms` → `defaultWaitMs`（**3000**）；显式传 `0` → 受理后立即返回。
- 超过 `maxWaitMs`（**240000**）不是报错，而是**截断**：
  `{ ok: true, status: "running", wait_capped: true, requested_ms, effective_ms, submission_id }`。
- 截断**不是失败**：回合仍在跑，用 `inject_status` / `submissions_list` 继续跟。
- `submission_id` 出现在**每一个**响应里，包括 `E_INVALID_SPEC`、`E_UNKNOWN_SESSION`、
  `E_NO_LIVE_SESSION`、`E_INJECT_FAILED`。

## 阶段（phase）

| phase | 含义 |
|---|---|
| `queued` | 排在同一会话的其他提交后面（`queue_position` ≥ 1） |
| `running` | 已受理，最近有事件 |
| `stalled` | 已受理，但超过 `stallMs`（120 秒）没有事件 —— **还活着，不是失败**，下一个事件即恢复 |
| `done` | 已拿到回复（`reply_text`） |
| `failed` | 受理被拒，或回合以 `aborted` / `blocked` / `error` / `interrupted` 结束 |
| `orphaned` | 上一个 dsh 进程留下的持久化记录；返回最后已知状态，绝不说 `unknown` |

## 长任务推荐调用序列

Hermes 的 MCP 客户端超时固定 **300 秒**，所以别指望一次长请求拿结果，靠 id 跟：

```text
session_inject(wait_ms=0)        -> 立刻拿到 submission_id
之后每 10~30 秒：
  inject_status(submission_id)   -> phase / idle_ms / reply_preview
  submissions_list(session_id)   -> 首个响应丢了也能按会话找回
直到 phase == "done"             -> reply_text
```

## 配置项

在 profile 的 `cordis.patch.yml`（`~/.dsh/profiles/<profile>/cordis.patch.yml`）里覆盖，
不要改插件目录里那份：

```yaml
- id: dsh-session-inject
  name: 'dsh-session-inject'
  config:
    port: 3090
    host: '127.0.0.1'
```

| 键 | 默认 | 说明 |
|---|---|---|
| `port` / `host` | `3090` / `127.0.0.1` | 回环监听地址 |
| `token` | 环境变量 `DSH_SESSION_INJECT_TOKEN` | 设置后请求需带 `Authorization: Bearer <token>` |
| `maxWaitMs` | `240000` | `wait_ms` 上限；截断返回 `status: "running"` |
| `defaultWaitMs` | `3000` | 不传 `wait_ms` 时的等待 |
| `stallMs` | `120000` | `idle_ms` 超过即 `phase: "stalled"` |
| `progressIntervalMs` | `8000` | SSE `notifications/progress` 间隔 |
| `persistPath` | `<DSH_HOME>/dsh-session-inject/submissions.jsonl` | 提交记录落盘位置（`null` 关闭） |
| `persistTtlHours` | `24` | 启动时清理过期记录 |
| `maxTurnMs` | `600000` | 单次提交内部等待上限 |
| `allowCreate` | `true` | `false` 隐藏 `session_create` |
| `legacyScan` | `false` | 仅供测试的 A/B 全量扫描开关 |

## 安全边界

- **只绑回环。** 默认 `127.0.0.1`，无 CORS、无 TLS。**绝不要**绑到局域网地址或做端口转发——
  这个插件的语义就是"以你的名义往会话里打字"。
- **token。** 不开 token 时，本机任何进程都能注入。共享机器请设 `DSH_SESSION_INJECT_TOKEN` 并在客户端带 Bearer。
- **不可撤回。** 注入的文本与用户发言等价，永久留在会话时间线；注入不会改变会话的模型、权限或工具集。
- 不修改 dsh 任何既有安全设置，也不改 dsh core 的任何一个文件。

## 已知限制

- 单次 `content` ≤ **32000 字符**。
- `queue` 按会话串行；`steer` 不排队，返回的仍是同一回合的最终消息。
- 落盘记录只保留 `reply_preview`（≤200 字），不含完整回复——全文请读会话时间线。
- `sessions_list` 只列**活**会话；不会为了列出来而唤醒冷会话。dsh 刚重启时列表可能为空，等 UI 重新打开会话。
- 一个 profile 占一个端口：两个 profile 不能同时占 `3090`。

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 3090 不监听 | 插件没进 `dsh.profile.bundles`，或 dsh 没重启；`EADDRINUSE` 表示另一个 profile 占着端口 |
| Hermes 看不到工具 | 没跑 `/reload-mcp`，或 `hermes mcp ls` 显示未启用 |
| 少了 `submissions_list` | 客户端缓存了 0.3 之前的工具列表 —— 重新加载 MCP |
| `E_UNKNOWN_SESSION` | 该 id 不是正在跑的会话（刚重启、UI 还没恢复）—— 等几秒或 `session_create` |
| 一直 `queued` | 目标会话正在跑别的回合 |
| `stalled` 很久 | 长思考或长命令；`idle_ms` 持续增长，事件一到自动恢复 |

更多见 [`docs/INSTALL.zh-CN.md`](docs/INSTALL.zh-CN.md)。

## 项目结构

```text
index.mjs               Host 插件入口（Cordis loader row）
lib/server.mjs          MCP JSON-RPC HTTP 服务、5 个工具、SSE 进度
lib/session-api.mjs     sessionController.prompt / 回合等待 / 活会话列表
lib/records.mjs         提交登记、phase、排队、持久化
cordis.patch.yml        bundle patch（loader 插入 + 默认配置）
install.ps1             Windows 一键注册脚本（装依赖 + 补 bundles）
examples/               Hermes 侧 curl 示例（sh / ps1）
tools/                  验收、证据采集、基准测试
docs/                   部署指南、API 证据、交付报告、历史任务书
```

## 开发与自测

```bash
npm install                 # 只为 tools/（官方 MCP SDK 是 devDependency）
npm run test:smoke          # health + tools/list + 短任务注入
npm run test:mcp            # 官方 SDK 客户端完整握手
npm run test:wait           # wait_ms 截断（240 秒）
npm run test:recover        # 硬断开 -> submissions_list -> done
npm run test:stall          # stalled 判定
npm run test:progress       # SSE 进度通知
```

插件本体**无运行时依赖**。

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/INSTALL.zh-CN.md`](docs/INSTALL.zh-CN.md) | 换机部署（Windows + Linux）、验收清单、排错 |
| [`docs/api-evidence.md`](docs/api-evidence.md) | 插件所依赖的 dsh 源码摘录 |
| [`docs/REPORT.md`](docs/REPORT.md) | 交付报告：API 调研、验收结果、各版本变更 |
| [`CHANGELOG.md`](CHANGELOG.md) | 版本记录 |
| [`docs/history/`](docs/history/) | 构建 v0.2 / v0.3 时的原始任务书 |

## 相关项目

- **[Tianbuyu-wwx/dsh-hermes-link](https://github.com/Tianbuyu-wwx/dsh-hermes-link)** —— 最初的
  Hermes ↔ dsh 派发桥（`@tianbuyu-wwx/dsh-hermes-link`，0.6.11，面向 dsh 0.1.5-rc.2）。
- **[guiyinrenshi/dsh-hermes-link](https://github.com/guiyinrenshi/dsh-hermes-link)** —— 它在 dsh 0.2.x
  上的兼容分支（npm: `dsh-hermes-link`，0.8.6），也就是上面说的那套派发模型。

这两个项目每次派发都会 spawn 一个子代理；本插件刻意不这么做，而是驱动一个已有会话。两种方式可以共存——
谁都不读也不改对方的文件。

## 许可证

[MIT](LICENSE)
