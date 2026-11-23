# 给 dsh 的改进任务书：dsh-session-inject v0.2

> 用法：整段复制到 dsh 会话（建议就用开发这个插件的会话，保留上下文）。先读文件再改，改完必须实测。

---

【任务：dsh-session-inject 改进到 v0.2（有 6 项必修 + 2 项验收），工作目录 C:\Users\<user>\Documents\code\dsh-session-inject\】

## 0. 现状（已由 Hermes 侧独立验收，以下都成立，不要推翻）

- `sessionController.prompt()` 路线正确，实测：投 `HERMES-VERIFY-192108` → 6.6s 回原文；目标会话 projcache 新增回合、prompt/response 逐字一致；错误路径 `E_UNKNOWN_SESSION` 带活会话列表；并发 A/B 无串台。
- 已装进 web/desktop 两个 profile，3090 在跑。**不要改 dsh-hermes-link 的任何文件**。

## 1. 必修问题（Hermes 侧实测发现）

1. **`busy` 恒为 true**：4 个会话（其中有闲了几小时的）全部报 busy=true。`busyOf(state)` 对 `state.running/active/queue` 的判断不对。
   - 要求：查清 `sessionController.state()` 的真实返回结构（asar 原文摘录贴进报告），改成"真正有未完成回合/排队"才 busy。
   - 验收：一个空闲会话 `busy=false`，正在跑的会话 `busy=true`，各给一次实测输出。
2. **`create_session` 已实现但没注册**（lib/server.mjs 里有 `createSessionTool`，tools/list 只有 3 个）。
   - 二选一：**注册成第 4 个工具**（推荐，测试时要用）或**删除死代码**。不许留着不注册的实现。
3. **无鉴权**（health 里 `auth:"open"`，只绑 127.0.0.1）。
   - 加可选 token：config/env `token`，设置了就校验 `Authorization: Bearer <token>`，没设置保持现状。
   - 验收：设置 token 后不带/带错 → 401；带对 → 正常。
4. **MCP 协议兼容性未验证**：现在只被 curl 打过，没被真正的 MCP 客户端连过。
   - 要求：用官方 SDK（`@modelcontextprotocol/sdk` 的 Client + StreamableHTTPClientTransport）连 `http://127.0.0.1:3090/mcp/session-inject`，跑完整握手 `initialize` → `notifications/initialized` → `tools/list` → `tools/call`，确认 3（或 4）个工具可用、返回值形状符合 MCP 规范（`content[].type=="text"`、`isError`）。
   - 把 client 脚本放 `tools/mcp-client-check.mjs`，把真实输出存 `docs/evidence/2x-mcp-client.json`。
5. **回复提取的边界**：
   - 回合以工具调用收尾、没有 assistant 文本时，`reply_text` 会是空串——应返回 `reply_text: ""` + `last_event_type`，并把该回合所有 assistant 文本数组一并带上，便于调用方判断。
   - 回合失败（LLM 报错/中断）时不能报 status=done，要 `status=failed` + 结构化 error（保留 `E_INJECT_FAILED`）。
   - 验收：人为造一个"只调工具不回复"和"一次 401 失败"的回合，各给证据。
6. **性能与健壮性**：`waitForTurn` 每 150ms 全量扫描 `session.events`，长会话（本项目已有 6.2M tok 历史）会越来越慢。
   - 改成增量：记住上次扫描到的 seq，只处理新增事件；或订阅 `session/event` 推送。
   - 验收：在 16 轮以上的会话里投递，报告单次扫描耗时（改前/改后）。

## 2. 顺手改进（有时间就做，不做也行）

7. `delivery:"steer"` 路径一条实测都没跑过——补一个：会话正在跑时注入 steer，确认插话生效且 reply 归属正确。
8. README 补三块：Hermes 侧接入片段（`mcp_servers: { dsh-session-inject: { url: http://127.0.0.1:3090/mcp/session-inject } }`）、错误码表、限制（记录只在内存、dsh 重启后 submission_id 失效、32000 字符上限、并发策略）。

## 3. 硬性要求

- 所有结论必须带实测证据（命令 + 真实输出），禁止只贴代码。
- 改动后两个 profile 同步（web 已跑，desktop 未验证：给出 desktop 重启后的验证脚本 `tools/verify-desktop.ps1`）。
- 不重启 dsh（由用户重启）；需要重启才生效的写清楚。
- 改完给出 diff 摘要（文件 + 行数），并在 REPORT.md 追加 "v0.2 修复" 章节：问题 → 根因 → 改法 → 证据。
- 同一问题推导超过 3 分钟就写脚本实测；连续试错 3 次不成，停下报告卡点与最短下一步。
