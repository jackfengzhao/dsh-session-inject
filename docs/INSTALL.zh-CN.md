# 在另一台机器部署 dsh-session-inject（dsh 插件 + Hermes MCP）

> English version: [`INSTALL.md`](INSTALL.md)


目标：新机器上有一套 **dsh（DeepSeek Harness）+ Hermes**，让 Hermes 通过 MCP 把任务**直接注入 dsh 的某个会话**，由会话本体执行（不 spawn 子代理）。

```
Hermes ──MCP(HTTP, 127.0.0.1:3090)──▶ dsh 进程内的插件 ──sessionController.prompt──▶ 目标会话
```

- 插件：`dsh-session-inject` 0.3.0（本目录）
- 端口：默认 `127.0.0.1:3090`，**只绑回环**，不跨机暴露
- 适用：dsh 0.2.x（插件按 `ctx.sessionController.prompt` 接入）；Node ≥ 22.13（dsh 自带运行时满足）

---

## 1. 打包（在**当前这台**机器上做）

只带运行时文件，25MB 的 `node_modules` 是测试用的（devDependency 只有官方 MCP SDK），不要带：

```powershell
# Windows
tar -czf dsh-session-inject.tgz --exclude node_modules --exclude test-workspace dsh-session-inject
```

```bash
# Linux / macOS
tar -czf dsh-session-inject.tgz --exclude=node_modules --exclude=test-workspace dsh-session-inject
```

必须存在的文件（约 100 KB）：

```
dsh-session-inject/
├─ package.json          # name/version/engines + dsh.bundle.patch
├─ cordis.patch.yml      # 注册成 loader row（含默认 port/host）
├─ index.mjs             # 入口
├─ lib/                  # server.mjs / session-api.mjs / records.mjs
├─ install.ps1           # Windows 一键注册（可选）
└─ README.md
```

拷到目标机任意目录（示例用 `C:\opt\dsh-session-inject` 或 `/opt/dsh-session-inject`）。

> ⚠️ 不要放进 `~/.dsh/profiles/<p>/node_modules/` 里再手工改 bundles——虽然能跑，但 `dsh plugin` 会覆盖链接关系，以后升级会很乱。

---

## 2. 装进 dsh（目标机）

### 2.1 确认 dsh 与 profile 名

```bash
dsh --help                     # 能跑就说明 CLI 在 PATH
ls ~/.dsh/profiles             # 常见：web / desktop
```

### 2.2 注册插件（会自动 pnpm link + 写 dependency）

```bash
dsh plugin --profile web     add C:\opt\dsh-session-inject      # Windows
dsh plugin --profile web     add /opt/dsh-session-inject        # Linux
```

想两个 profile 都装就各跑一次（`desktop` 同理）。

### 2.3 确认它进了 bundles

`dsh plugin add` 会写 `dependencies`，但**不一定会把包名加进 `dsh.profile.bundles`**。检查：

```bash
python - <<'PY'
import json, os
p = os.path.expanduser("~/.dsh/profiles/web/package.json")
d = json.load(open(p, encoding="utf-8"))
print(d.get("dependencies"))
print(d["dsh"]["profile"]["bundles"])
PY
```

`bundles` 里没有 `dsh-session-inject` 就手工加一行（Windows 也可直接跑目录里的 `pwsh -File .\install.ps1 -Profiles web`，它会自动补）：

```bash
# 手动补：把 "dsh-session-inject" 追加到 dsh.profile.bundles 数组末尾
```

### 2.4 重启 dsh

**必须重启**（插件是进程内加载的）。web 模式：

```bash
dsh web --no-open --port 3080
```

已经是活会话的话，也可以在会话里跑 `workspace_control action=refresh` 热加载，但重启最干净。

---

## 3. 自检（dsh 侧）

```bash
curl -s http://127.0.0.1:3090/health
# {"ok":true,"version":"0.3.0","host":"127.0.0.1","port":3090,"auth":"open",
#  "live_sessions":[...],"counters":{...},"store":{"live":..,"persisted":..,"persist_path":"..."}}

curl -s -X POST http://127.0.0.1:3090/mcp/session-inject \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
# 应看到 5 个工具：sessions_list, session_inject, inject_status, submissions_list, session_create
```

`live_sessions` 为空是正常的：**dsh 重启后要等 UI 打开某个会话**（或你 `session_create` 建一个），才会有活会话可投递。

---

## 4. 接进 Hermes（目标机）

```bash
hermes mcp add dsh-session-inject --url http://127.0.0.1:3090/mcp/session-inject
```

两个交互问：

1. `Does this server require authentication?` → **n**（没开 token 时）
2. `Enable all N tools?` → **y**

非交互（bash，含 git-bash）：

```bash
printf 'n\ny\n' | hermes mcp add dsh-session-inject --url http://127.0.0.1:3090/mcp/session-inject
```

验证与生效：

```bash
hermes mcp test dsh-session-inject     # ✓ Connected (… ms), 5 tools
hermes mcp ls                          # 列表里能看到
```

Hermes 里 **`/reload-mcp`** 或**开新会话**后，才会出现原生工具 `mcp__dsh_session_inject__*`。

---

## 5. 功能验收（按顺序打一遍）

| # | 动作 | 期望 |
|---|---|---|
| 1 | `sessions_list` | 列出 dsh 会话（`session-*`；`hermes-*` 是镜像会话，**别往里投**） |
| 2 | `session_create` + `session_inject` 短任务（"只回复 OK"） | 秒级返回 `status:"done"` + `reply_text` |
| 3 | `session_inject` 假会话 id | `E_UNKNOWN_SESSION`(-32030)，附活会话列表 |
| 4 | 长任务 + `wait_ms=600000` | **240 秒**返回 `status:"running"`、`wait_capped:true`、带 `submission_id`（不报错、不丢单） |
| 5 | `submissions_list` / `inject_status` 跟到 `done` | 拿到最终 `reply_text`；`phase` 会从 `running`→`stalled`（>120s 无事件）→`done` |
| 6 | 重启 dsh 后 `inject_status(旧 id)` | `phase:"orphaned"` + 最后状态/preview，**不是 unknown** |

第 4 条是这套链路的关键：Hermes 的 MCP 客户端固定 **300s** 超时，插件把等待硬截断在 **240s**，所以 id 永远到得了调用方手里。

---

## 6. 配置项（可选）

改 `~/.dsh/profiles/<profile>/cordis.patch.yml`（不要改插件目录里的那份），加一行覆盖：

```yaml
- id: dsh-session-inject
  name: 'dsh-session-inject'
  config:
    port: 3091            # 两个 profile 同时跑时避免抢 3090
    host: '127.0.0.1'
```

| 键 | 默认 | 说明 |
|---|---|---|
| `port` / `host` | 3090 / 127.0.0.1 | 改动后 Hermes 的 URL 要同步改 |
| `token` | 空 | 也可用环境变量 `DSH_SESSION_INJECT_TOKEN`；非空则要求 `Authorization: Bearer …` |
| `maxWaitMs` | 240000 | `wait_ms` 硬上限；被截断仍返回 `submission_id` |
| `defaultWaitMs` | 3000 | 不传 `wait_ms` 时等这么久 |
| `stallMs` | 120000 | 无事件超过这个值 → `phase:"stalled"`（仍是 running，不是失败） |
| `progressIntervalMs` | 8000 | `_meta.progressToken` + SSE 时的进度通知间隔 |
| `persistPath` | `<DSH_HOME>/dsh-session-inject/submissions.jsonl` | 提交记录落盘位置 |
| `persistTtlHours` | 24 | 落盘记录保留时长 |
| `maxTurnMs` | 600000 | 单回合最长等待 |
| `allowCreate` | true | 是否允许 `session_create` |

---

## 7. 安全边界（务必看）

- **只绑回环**。这个插件的语义是"以你的名义往会话里打字"，等于能读能跑——绝不能 `host: 0.0.0.0` 或做端口转发。
- 多用户/共享机器建议开 token：`export DSH_SESSION_INJECT_TOKEN=<随机串>`，Hermes 侧在 `hermes mcp add` 里选需要鉴权并填 Bearer。
- 注入的消息会**永久留在会话时间线里**（和用户发言一样，不可撤回）。
- 别把 `hermes-<id>` 镜像会话当目标（那是 Hermes 对话的投影）。

---

## 8. 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| `3090` 不监听 | 插件没进 `dsh.profile.bundles`、或 dsh 没重启；`EADDRINUSE` 则是另一个 profile 正占着 3090 |
| Hermes 看不到工具 | 没 `/reload-mcp`；或 `hermes mcp ls` 里状态不是 enabled |
| 缺 `submissions_list` | 客户端握手缓存了旧的 4 个工具 → `/reload-mcp` |
| `E_UNKNOWN_SESSION` | 该会话没在跑（dsh 刚重启、UI 尚未恢复锚点）；等几秒或先 `session_create` |
| 投递成功但一直 `queued` | 目标会话正在跑别的回合，排队等它结束 |
| `phase:"stalled"` 一直不变 | 会话在长思考/长命令，属正常；`idle_ms` 会持续增长，事件一到即恢复 |
| desktop 模式端口少一个 | desktop 不开 3080（那是 dsh-hermes-link 的桥），与本插件无关；插件只用 3090 |
| Windows 路径带空格 | 命令里加引号，并用原生路径 `C:\opt\...`，不要用 `/c/opt/...` |

---

## 9. 卸载 / 回滚

```bash
dsh plugin --profile web     remove dsh-session-inject
dsh plugin --profile desktop remove dsh-session-inject
# 再从 package.json 的 dsh.profile.bundles 里删掉同名条目，重启 dsh

hermes mcp remove dsh-session-inject
```

残留可手工清理：`~/.dsh/dsh-session-inject/`（submissions.jsonl）。

---

## 10. 升级

把新版本目录覆盖到安装位置 → 重启 dsh → `curl /health` 看 `version`。
`package.json` 里 `engines.node` 变了要留意 dsh 自带 Node 版本是否满足。
