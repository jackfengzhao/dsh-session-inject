# 给 dsh 的改进任务书：dsh-session-inject v0.3 —— 等待语义与状态可观测性

> 用法：整段复制到 dsh 会话（建议用开发这个插件的会话，保留上下文）。先读文件再改，改完必须实测。

---

【任务：dsh-session-inject 改进到 v0.3。目标：保留"等待回复"能力，但**任何情况下调用方都不会丢失 submission_id、不会误判 dsh 挂掉**。工作目录 C:\Users\<user>\Documents\code\dsh-session-inject\】

## 0. 背景（2026-11-23 真实故障，已复现）

Hermes 侧 MCP 客户端超时是 **300s**（固定）。我用 `session_inject(wait_ms=300000)` 向一个长任务会话投递：
- 任务确实在会话里跑了 29 分钟并成功完成；
- 但 300s 到点后调用被客户端掐断，**响应没回来 → 我没有 submission_id → `inject_status` 无处可查**，只能靠翻磁盘猜状态。

结论：**长等待不能依赖"最后一个响应"**。等待要保留，但状态必须随时可查、可续、可恢复。

## 1. 需求（按优先级）

**R1. wait_ms 上限与截断（不报错）**
- 新增 config `maxWaitMs`，默认 **240000**；`wait_ms` 超过即截断，返回体带 `wait_capped:true, requested_ms, effective_ms`。
- 截断后**必须**返回 `{ok:true, status:"running", submission_id, ...}`，绝不能报 E_TIMEOUT 或什么都不给。

**R2. 新工具 `submissions_list`（找回入口）**
- 参数：`session_id?`、`limit?`（默认 10）、`status?`。
- 返回每条：`submission_id, session_id, status, phase, started_at, elapsed_ms, steps_seen, last_event_type, last_activity_at, idle_ms, reply_preview(≤200 字), wait_capped`。
- 用途：**调用方丢了 id 也能按会话找回正在跑/刚结束的提交**。

**R3. `inject_status` 增补**
- 新增字段：`phase` ∈ `queued|running|stalled|done|failed|orphaned`、`last_activity_at`、`idle_ms`、`steps_seen`、`reply_preview`、`queue_position`。
- 状态判定：`idle_ms > 120000`（config `stallMs`）→ `phase="stalled"`（**不是失败**，只是"长时间无事件"）；一旦新事件到来恢复 `running`。

**R4. 事件心跳来源**
- `last_activity_at` / `last_event_type` 取目标会话的事件流（`turn/start`、`step/start`、`request/header`、`tool/call`、`assistant/message`、`turn/end`）。
- 目的：调用方能看到"它还在思考/还在跑工具"，与"真的死了"区分开。

**R5. 提交记录持久化（防重启失联）**
- 落盘到 `~/.dsh/dsh-session-inject/submissions.jsonl`（追加写，字段同 R2 + `reply_text` 摘要）。
- dsh 重启后，对旧 `submission_id` 查询返回 `phase="orphaned"` + 最后已知状态与时间，**不能返回 unknown**。
- 启动时清理/标记超过 24h 的记录。

**R6. MCP progress 通知（可选，能就做）**
- 调用方在 `_meta.progressToken` 提供 token 时，每 5~15s 发一条 `notifications/progress`：`{phase, elapsed_ms, steps_seen, last_event_type}`。
- 用官方 `@modelcontextprotocol/sdk` 客户端验证确实能收到 ≥2 条；收不到就退回 R2/R3 轮询，并在文档写明"progress 需客户端支持"。

**R7. 统一返回契约**
- **任何分支（成功/截断/失败/超时/参数错误）都必须带 `submission_id`**；错误 `data` 里也要带，便于调用方续查。
- `reply_preview` 只放 assistant 文本，**不得包含 reasoning/thinking**。

**R8. 文档**
- README 增加"长任务推荐调用序列"：`session_inject(wait_ms=0)` → `submissions_list`/`inject_status` 轮询（10~30s 一次）→ 拿到 `reply_text`；
- 写明 wait_ms 上限、stallMs、progress 支持情况、prompt.submit/子代理死路（保留现有说明）；
- REPORT.md 追加 "v0.3 等待语义" 章节：故障复现 → 改法 → 证据。

## 2. 验收（全部要实测证据）

A. `wait_ms=600000` → 返回 `running` + `wait_capped:true` + `submission_id`，**不报错**；
B. 长任务 + `curl --max-time 5` 主动断开 → 用 `submissions_list` 找回该提交 → `inject_status` 跟进到 `done`，`reply_text` 正确；
C. 造一个"长时间无事件"的任务（会话里 sleep 150s）→ `phase="stalled"`、`idle_ms>120000`，随后完成变 `done`；
D. 重启 dsh 后 `inject_status(旧 id)` → `phase="orphaned"`（不是 unknown）；
E. （若做 R6）SDK 客户端收到 ≥2 条 progress；
F. 回归：不带 wait_ms 的短任务仍 ≤3s 返回 `done`；`sessions_list`/`session_create` 行为不变。

## 3. 约束

- 不改 `sessionController.prompt` 路线，不改 dsh-hermes-link 任何文件；
- 不改 Hermes 侧配置（它固定 300s 超时，插件要在这个约束下工作）；
- web 侧可热加载验证（`workspace_control refresh`），desktop 需重启（给出 `tools/verify-desktop.ps1` 更新）；
- 报告里不得出现任何 key/token；
- 同一问题推导超过 3 分钟就写脚本实测；连续 3 次不成，停下报卡点。
