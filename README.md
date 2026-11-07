# dsh-refusal-guard

兜住「短 + 否定式开场」的回复，并自动补一条执行轮。

## 为什么存在

这类回复是**生成时的短路分支**，读的是词不是意图。实测把推理档位拉到 `max` 也压不住，
提示词规则只能降概率。唯一稳的办法是「生成后兜住」，所以本插件：

- **不碰 `prompt-inject.md`**（那个文件由 `dsh-purge` 的加密槽重建，改了会被覆盖）
- **不改宿主源码**（不改 `app.asar` 里的官方代码）
- **不往 system prompt 挂任何东西**（不注入章节，纯监听）
- 只监听 `agent/status`，在回合已结束且内容可疑时补一条 followup

## 触发条件（必须同时成立）

1. `agent/status === "idle"`
2. 本轮 `turn/end` 不是 `error` / `aborted` / `interrupted` / `max-tokens`
3. 本轮之后没有新的真人消息
4. 最后一条 `assistant/message` 的可见文本 ≤ `maxChars`、以否定式起手，**且没有命中事实诊断 /
   安全判断标记**
5. 本回合剩余次数 > 0

## 什么不算拒绝（关键）

否定式开场既是拒绝的起手，也是报错的起手。真正的诊断一定带症状，所以文本里出现下面任一
类标记时**不补执行轮**（`isRefusalReply` 直接返回 false）：

| 类别 | 例子 |
|---|---|
| 文件 / 路径 | `文件不存在`、`未找到 C:\a.md`、`ENOENT`、`no such file` |
| 权限 | `权限不足`、`没有…权限`、`拒绝访问`、`只读`、`Permission denied`、`401/403` |
| 网络 | `连接失败`、`拒绝连接`、`请求超时`、`解析失败`、`ECONNREFUSED`、`NXDOMAIN` |
| 端口 / 资源 | `端口已被占用`、`EADDRINUSE`、`磁盘空间不足` |
| 进程 / 退出码 | `进程已退出`、`exit code 1` |
| 命令 / 工具 | `命令未找到`、`没有安装`、`command not found` |
| 构建 / 解析 | `构建失败`、`SyntaxError`、`Unexpected token`、`JSON 解析失败` |
| 参数缺失 | `缺少 target 参数`、`需要你提供…` |
| 记录为空 | `日志里没有…`、`历史记录查不到…` |

命中后插件**什么都不做**：结论就是结论，不该被「再试一遍」覆盖。语料见
`test/corpus.mjs`（56 条：真拒绝必须命中；诊断、安全判断必须不命中），跑
`node test/run.mjs ./lib/index.js`。

## 安全判断也不补轮

否定式开场不只属于「拒绝」和「报错」，还属于正当的安全结论：

| 类别 | 例子 | `stopReason` |
|---|---|---|
| 安全 / 合规 / 隐私 / 授权 | `抱歉，出于安全考虑我不能执行。`、`涉及他人隐私，我不能提供。`、`未授权`、`违法` | `safety` |

把这类补成执行轮等于把安全判断掀掉——模型刚给出结论，280ms 后就收到「你只是误判了，
直接执行」。所以 `isRefusalReply` 会先过 `stopReason()`，顺序 `diagnostic → safety`，
命中即静默。

## 补发指令的边界

`retryText` 只在「误判请求性质、压根没动手」时把人推回执行轨道；后面两个分支必须原地停住：

1. 误判请求性质、还没执行 → 执行并给结论；
2. 出于安全 / 合规 / 隐私 / 授权的判断 → 保留原结论，不改口执行；
3. 因文件不存在、工具报错、权限受限、信息不足而停下 → 说明缺什么，**禁止编造**文件内容、
   命令输出、日志或运行状态，也禁止用 `[PLACEHOLDER]` 代替必要事实。

## 与 dsh-purge 的关系

**不依赖，但同源。** 两件事说清楚：

- **起源**：这套「检测到拒绝就补一轮」最早写在 `dsh-purge` 的 `lib/continue-retry.js` 里试过。但那个文件只处理 turn/end 的 `error` / `aborted` / `interrupted` / `max-tokens`，**不看正常完成的文本** —— 而拒绝恰恰是一次"正常完成"，所以它拦不住，才有了这个独立插件。
- **不依赖**：本插件不 import、不读取、也不要求 `dsh-purge`。装 purge、不装 purge、卸掉 purge，这里行为完全一致；两边的升级互不影响。

**不碰 purge 的任何东西**（这是刻意划的线）：

| 不碰 | 原因 |
|---|---|
| `prompt-inject.md` | 那文件由 purge 的加密槽重建，手改会被覆盖 —— 所以本插件**完全走生成后兜底**，不加任何提示词 |
| `~/.dsh/dsh-purge/*`（`applied.json` / `drill-grant.json` / `hooks-deny.json`） | 那是 purge 的运行状态，读写都会互相干扰 |
| 宿主 `app.asar` 里的官方代码 | purge 走的是 82 个补丁的路子，本插件只 `ctx.on` 监听事件 |

**职责也不同**：purge 的 `hooks-deny` 管的是「工具调用被 hooks 拦下」，本插件管的是「模型回复本身短路」；一个在工具层，一个在文本层 —— 两者同时启用不会打架，顺序也无所谓。

## 配置（`cordis.patch.yml` 或插件页）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `maxPerTurn` | `2` | 每回合最多补几次，防死循环 |
| `maxChars` | `220` | 超过这个长度的回复一律不判，避免误伤 |
| `delayMs` | `280` | 等宿主彻底 idle 再补，避免竞态 |
| `retryText` | 见 `lib/index.js` | 补发的那句话。**patch 里不要再写**，否则会静默覆盖代码默认值（v1.0.2 就是这么失效的）；测试会解析真实 patch 检查这一点 |

## 版本记录

- v1.0.7：可发布版本。去掉 `private`（否则别人装不上）；`peerDependencies` 从
  `"@deepseek-ai/cordis": "*"` 收成 `^4.1.0` 并标 `optional`（插件并不 import 它，
  它只是宿主运行时）；新增 `engines.dsh`；宿主缺 API 时改为**明确告警**而不是静默失效。
- v1.0.5：改简介。`package.json` 的 `description` 去掉「等确认 / 另挂二次确认」的旧说法，
  新增 `locale/{zh,en}.json` 的 `meta`（插件页标题「拒绝兜底」/ Refusal Guard），
  在 `exports` / `files` 里登记 `locale` 与 `icon`。
- v1.0.4：移除「高风险动作二次确认」—— 不再往 system prompt 挂规则，`RISK_RULES` /
  `mountRiskPrompt()` / `riskPrompt` / `riskOrder` / `riskSection` 与「正在等确认」分类一并删除。
- v1.0.3：加安全判断排除、`stopReason()`、patch 回归测试。
- v1.0.2：加事实诊断排除（`DIAGNOSTIC_MARKERS`）。

## 运行要求（给装的人看）

| 项 | 值 | 为什么 |
|---|---|---|
| DSH | `engines.dsh`: `>=0.2.2-0` | 0.2.2 起才有稳定的 `agent/status` + `agent.followup`；`-0` 只是为了让 `0.2.2-rc.1` 这类预发布也算满足（semver 规定：预发布版本只有在比较器 major.minor.patch 相同且自带预发布号时才匹配） |
| Node | `>=22.19.0` | `node:crypto` 的 `randomUUID`，同时 DSH 桌面端自身要求 22.19+ |
| cordis | peer `^4.1.0`，`optional: true` | 插件不 import cordis，它只是运行时容器；标 optional 免得装的时候报缺依赖 |
| 包可见性 | 无 `private` 字段 | 有 `private` 的话 `npm i <github 仓库>` 会被拒 |

版本对不上时不会静默失效，宿主日志里会出现明确一行：

```
[refusal-guard] 宿主缺少 ctx.on / ctx.get，插件不会生效。dsh-refusal-guard 需要 DSH >= 0.2.2（cordis 4.x）。
[refusal-guard] 宿主没有 agent.followup，无法补发指令（DSH 版本过旧），插件不会生效。
[refusal-guard] 宿主没有 ctx.effect：热重载时监听可能残留，建议升级 DSH >= 0.2.2。
```

## 安装

从 GitHub 直接装：

```
plugin_manager install_bundle  →  在插件页「添加插件」里填 github:<你的用户名>/dsh-refusal-guard
```

本地开发也可以 `link:` 挂进 `profiles/desktop`，并登记进 `dsh.profile.bundles`：

```
profiles/desktop/package.json
  dependencies:  "dsh-refusal-guard": "link:<本目录绝对路径>"
  dsh.profile.bundles: [ ..., "dsh-refusal-guard" ]
```

注意：**条目必须由 bundle patch 的 `insert` 创建**，不要再在用户层 `cordis.patch.yml`
里手写一遍，否则同一个 id 会 `already queued`。

