# dsh-session-inject

[![version](https://img.shields.io/badge/version-0.3.0-blue.svg)](CHANGELOG.md)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22.13-339933.svg)](https://nodejs.org/)
[![platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-lightgrey.svg)](#环境要求)

[English](README.md) | 简体中文

一个 **DeepSeek Harness（dsh）插件**：在回环地址上开一个 MCP 端点，任何 MCP 客户端（比如
Hermes）都能把一段用户消息**投给某一个活着的 dsh 会话**，并取回这一回合的回复。

回合由**会话本体**执行：用它自己的模型、工具、工作目录、权限预设和上下文。**不会创建子代理。**

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
- [版本演进](#版本演进)
- [文档](#文档)
- [相关项目](#相关项目)
- [许可证](#许可证)

## 为什么需要这个插件

**作者按。** 我对每个项目只用一个长期会话。几周的决策、目录结构、已经排除的路子，全都留在这个会话里。

最初的方案很常规：把活派给子代理。结果每次都出两个问题。

1. **父代理会自己接手。** 子任务一完成，父会话就被完成通知唤醒。它握着整个项目的历史和自己的判断，
   于是开始"改进"结果：重写我已经验收过的清单、把我验证过的截图换成它选的、动子代理刚交付的文件。
   **本来做对的活，被一个只该监督的代理改掉了。** 我把这叫添油加醋——菜本来够味，还要再撒一把盐。
2. **子代理没有上下文，而且这笔账很贵。** 子代理从一段窄提示开始，不知道项目的约定，所以每次派活
   都要先手写一份 `CONTEXT.md`；回答技术上没错，但对周围的设计是盲的。它还是个全新会话，前缀缓存
   从零开始，同一段指令每次都要按未命中价重新计费。而那个已经装着上下文的长期会话，从第二次请求起
   就按命中价读（本机实测：同一会话内约 99%，长项目会话整体 77~82%）。

我想要的很朴素：**把指令交给那个已经懂这个项目的会话，让它自己干**——记忆是现成的，对代码的理解是
现成的，缓存是热的。中间不要子代理，旁边也不要一个监督者来改结果。

**来龙去脉。** 起点是 [`dsh-hermes-link`](https://github.com/Tianbuyu-wwx/dsh-hermes-link)——最初那版
Hermes ↔ dsh 桥（`@tianbuyu-wwx/dsh-hermes-link` 0.6.11，面向 dsh 0.1.5-rc.2）——以及它在 dsh 0.2.x
上的兼容分支 [`guiyinrenshi/dsh-hermes-link`](https://github.com/guiyinrenshi/dsh-hermes-link)
（npm 上发布为 `dsh-hermes-link`，0.8.6）。两者派活的方式都是创建子代理，`continuable` 子任务结束时
唤醒父会话——正是上面那两个问题。

我先试的是就地改：加一个 `session_prompt` 工具，把文本走 `ctx.subagents.sendMessage/prompt` 投进去。
宿主拒绝了根会话（`UNAUTHORIZED: send_message requires another agent in the subagent tree`），因为子代理
API 本身就限定在子代理树里。于是只能做成独立插件：改用 session-controller API，不动 dsh-hermes-link
的任何文件，两个项目互不依赖。

**实现方式。** 插件把一条普通用户回合写进会话时间线，用的是 Web GUI 发送按钮那条 Host 命令：

```ts
// @deepseek-ai/dsh-api-session-controller (dsh 0.2.x)
@Remote('prompt')
async prompt(request: SessionPromptRequest, signal: AbortSignal): Promise<SessionPromptValue>
// SessionPromptRequest { requestId, sessionId, mode: 'queue' | 'steer', content, clientTimeZone? }
```

所以这段文字和你手打进去没有区别：同一个队列、同一套权限、同一批工具。回复从会话自己的事件流里读。
源码摘录见 [`docs/api-evidence.md`](docs/api-evidence.md)。

## 特性

- **在会话里跑，不在子代理里跑。** 注入的文本以 `source.kind = "user"` 消息落进时间线，会话用
  自己的模型、工具、工作目录和上下文作答。
- **五个 MCP 工具** —— `sessions_list`、`session_inject`、`inject_status`、`submissions_list`、
  `session_create`，走 JSON-RPC 2.0（`initialize`、`ping`、`tools/list`、`tools/call`）。
- **等待不会丢句柄。** `wait_ms` 上限 240 秒，低于 MCP 客户端的 300 秒超时；每个响应（包括报错）
  都带 `submission_id`。
- **能找回。** 首个响应丢了，用 `submissions_list` 按会话重新找到这次提交。记录会落盘，所以 dsh
  重启后旧 id 返回 `phase: "orphaned"` 加最后已知状态，而不是 `unknown`。
- **状态可见。** `phase`、`idle_ms`、`last_event_type`、`steps_seen` 取自会话事件流
  （`turn/start`、`step/start`、`tool/call`、`assistant/message`、`turn/end`），能分清"在思考"、
  "在跑工具"和"已经死了"。
- **可选 SSE 进度。** 客户端带 `params._meta.progressToken` 时，每 8 秒发一条
  `notifications/progress`；已用官方 SDK 验证收到。
- **无运行时依赖。** 只绑回环，可选 Bearer token。

## 环境要求

| 项 | 要求 |
|---|---|
| dsh | 0.2.x（用 `ctx.sessionController.prompt`；也在 0.8.x 桌面版验证通过） |
| Node | 22.13 及以上，dsh 自带的运行时已经满足 |
| Hermes | 可选；任何支持 MCP server 的客户端都能连 |
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

`session_id` 可以省略，省略时投给第一个活会话。

## 等待语义

- 不传 `wait_ms`，就等 `defaultWaitMs`（**3000**）；传 `0` 则受理后立刻返回。
- 超过 `maxWaitMs`（**240000**）是**截断**，不是报错：
  `{ ok: true, status: "running", wait_capped: true, requested_ms, effective_ms, submission_id }`。
- 截断不是失败。回合还在跑，继续用 `inject_status` 或 `submissions_list` 跟。
- `submission_id` 出现在**每一个**响应里，包括 `E_INVALID_SPEC`、`E_UNKNOWN_SESSION`、
  `E_NO_LIVE_SESSION`、`E_INJECT_FAILED`。

## 阶段（phase）

| phase | 含义 |
|---|---|
| `queued` | 排在同一会话的其他提交后面（`queue_position` ≥ 1） |
| `running` | 已受理，会话最近有事件 |
| `stalled` | 已受理，但超过 `stallMs`（120 秒）没有事件。**还活着，不是失败**，下一个事件就恢复 |
| `done` | 已拿到回复（`reply_text`） |
| `failed` | 受理被拒，或回合以 `aborted` / `blocked` / `error` / `interrupted` 结束 |
| `orphaned` | 上一个 dsh 进程留下的记录；返回最后已知状态，绝不说 `unknown` |

## 长任务推荐调用序列

Hermes 的 MCP 客户端超时固定 300 秒，所以别用一个长请求等结果，拿住 id 去跟：

```text
session_inject(wait_ms=0)        -> 立刻拿到 submission_id
之后每 10~30 秒：
  inject_status(submission_id)   -> phase / idle_ms / reply_preview
  submissions_list(session_id)   -> 首个响应丢了也能按会话找回
直到 phase == "done"             -> reply_text
```

## 配置项

在 profile 的 `cordis.patch.yml`（`~/.dsh/profiles/<profile>/cordis.patch.yml`）里覆盖，不要改
插件目录里那份：

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
| `token` | 环境变量 `DSH_SESSION_INJECT_TOKEN` | 设置后，请求必须带 `Authorization: Bearer <token>` |
| `maxWaitMs` | `240000` | `wait_ms` 的上限；被截断的等待返回 `status: "running"` |
| `defaultWaitMs` | `3000` | 不传 `wait_ms` 时的等待 |
| `stallMs` | `120000` | `idle_ms` 超过它就切到 `stalled` |
| `progressIntervalMs` | `8000` | SSE `notifications/progress` 的间隔 |
| `persistPath` | `<DSH_HOME>/dsh-session-inject/submissions.jsonl` | 提交记录落盘位置，`null` 关闭 |
| `persistTtlHours` | `24` | 启动时清理超过这个时长的记录 |
| `maxTurnMs` | `600000` | 单次提交的内部上限 |
| `allowCreate` | `true` | `false` 时隐藏 `session_create` |
| `legacyScan` | `false` | 仅供测试的全量扫描开关 |

## 安全边界

- **只绑回环。** 默认 `127.0.0.1`，无 CORS、无 TLS。**绝不要**绑到局域网地址或做端口转发——
  这个插件的语义就是"以你的名义往会话里打字"。
- **token。** 不设 token 时，本机任何进程都能注入。共享机器请设 `DSH_SESSION_INJECT_TOKEN`，
  客户端带 Bearer 头。
- **不可撤回。** 注入的文本和用户发言一样留在时间线里，收不回来。注入不会改变会话的模型、权限
  或工具集。
- 不改 dsh 任何既有安全设置，也不改 dsh core 的任何文件。

## 已知限制

- 单次 `content` 上限 **32000 字符**。
- `queue` 按会话串行；`steer` 不排队，返回的仍是同一回合的最终消息。
- 落盘记录只留 `reply_preview`（≤200 字），不含完整回复，全文请读会话时间线。
- `sessions_list` 只列**活**会话，不会为了列出来而唤醒冷会话。dsh 刚重启时列表可能是空的，
  等 UI 重新打开会话。
- 一个 profile 占一个端口：两个 profile 不能同时占 `3090`。

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 3090 不监听 | 插件没进 `dsh.profile.bundles`，或 dsh 没重启；`EADDRINUSE` 表示另一个 profile 占着端口 |
| Hermes 看不到工具 | 没跑 `/reload-mcp`，或 `hermes mcp ls` 显示未启用 |
| 少了 `submissions_list` | 客户端缓存了 0.3 之前的工具列表，重新加载 MCP |
| `E_UNKNOWN_SESSION` | 该 id 不是正在跑的会话（刚重启、UI 还没恢复），等几秒或调 `session_create` |
| 一直 `queued` | 目标会话正在跑别的回合 |
| `stalled` 很久 | 长思考或长命令；`idle_ms` 持续增长，事件一到就恢复 |

更多见 [`docs/INSTALL.zh-CN.md`](docs/INSTALL.zh-CN.md)。

## 项目结构

```text
index.mjs               Host 插件入口（Cordis loader row）
lib/server.mjs          MCP JSON-RPC HTTP 服务、5 个工具、SSE 进度
lib/session-api.mjs     sessionController.prompt / 回合等待 / 活会话列表
lib/records.mjs         提交登记、phase、排队、持久化
cordis.patch.yml        bundle patch（loader 插入 + 默认配置）
install.ps1             Windows 注册脚本（装依赖 + 补 bundles）
examples/               Hermes 侧 curl 示例（sh / ps1）
tools/                  验收、证据采集、基准测试
docs/                   部署指南、API 证据、交付报告、历史任务书
```

## 开发与自测

```bash
npm install                 # 只为 tools/；官方 MCP SDK 是 devDependency
npm run test:smoke          # health + tools/list + 短任务注入
npm run test:mcp            # 官方 SDK 客户端完整握手
npm run test:wait           # wait_ms 截断（240 秒）
npm run test:recover        # 硬断开 -> submissions_list -> done
npm run test:stall          # stalled 判定
npm run test:progress       # SSE 进度通知
```

插件本体**无运行时依赖**。

## 版本演进

每一版都是因为上一版在现场出了事。完整记录见 [`CHANGELOG.md`](CHANGELOG.md)，这里只留要点。

| 版本 | 坏在哪，改了什么 |
|---|---|
| 0.1.0 | 第一个能用的版本：`sessions_list`、`session_inject`、`inject_status`；`queue` / `steer`；回复锚定在会话自己的 `turn/end` 上。 |
| 0.2.0 | 首次实跑暴露的问题：`busy` 对所有会话恒为 `true`（取错状态字段，"忙不忙"等于没用）、`session_create` 写了却没注册进工具表、回复抽取会把思考文本当成答案、每次轮询都重扫整份事件日志。四条全部修掉，另加 token 鉴权。 |
| 0.3.0 | 一次真实事故：`wait_ms=300000` 被客户端 300 秒超时掐断，`submission_id` 唯一的副本也随响应丢了——既没法轮询，也分不清"死了"还是"在想"。现在等待上限 240 秒、每个响应都带 id、`submissions_list` 能找回丢失的 id、`stalled` 把"慢"和"失败"分开、记录落盘重启后变 `orphaned`。 |

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/INSTALL.zh-CN.md`](docs/INSTALL.zh-CN.md) | 换机部署（Windows + Linux）、验收清单、排错 |
| [`docs/agent-usage.md`](docs/agent-usage.md) | 给 agent / MCP 客户端看的用法：调用序列、phase 语义、错误处理 |
| [`docs/api-evidence.md`](docs/api-evidence.md) | 插件所依赖的 dsh 源码摘录 |
| [`docs/REPORT.md`](docs/REPORT.md) | 交付报告：API 调研、验收结果、各版本变更 |
| [`CHANGELOG.md`](CHANGELOG.md) | 版本记录 |

## 相关项目

- **[Tianbuyu-wwx/dsh-hermes-link](https://github.com/Tianbuyu-wwx/dsh-hermes-link)** —— 最初的
  Hermes ↔ dsh 派发桥（`@tianbuyu-wwx/dsh-hermes-link` 0.6.11，面向 dsh 0.1.5-rc.2）。
- **[guiyinrenshi/dsh-hermes-link](https://github.com/guiyinrenshi/dsh-hermes-link)** —— 它在 dsh
  0.2.x 上的兼容分支（npm: `dsh-hermes-link`，0.8.6），也就是上面说的那套派发模型。

两者每次派发都会创建子代理；本插件刻意不这么做，而是驱动一个已有会话。两种做法可以并存，
谁都不读也不改对方的文件。

## 许可证

[MIT](LICENSE)
