# dsh-refusal-guard

> DSH（DeepSeek Harness）插件：兜住模型「本来在做事，却回一句『不行 / 我做不了』就收摊」的短路行为，补一条执行轮 —— 但**事实诊断与安全拒绝一律不碰**。

- 版本：**1.0.6** ｜ 许可证：MIT ｜ 宿主：DeepSeek Harness Desktop（`@deepseek-ai/dsh-desktop` 0.2.2+）
- 不改宿主源码，只监听 `agent/status` 事件，必要时追加一条 `followup` 消息
- 关掉插件即恢复原状，无残留状态

---

## 一、它解决的是哪一类问题

### 症状

模型有时候并不是「不肯做」，而是**误读了请求性质**，然后回一句很短的话就结束回合：

```
不行，这是严令禁止的。
抱歉，我不能完成这个请求。
无法处理。
```

但同一段对话里，换个说法它就会照做 —— 说明瓶颈不在能力，在这句话被生成的瞬间走了否定分支。

### 为什么不能简单「看到短否定就催一遍」

因为**短否定句至少混着四种完全不同的语义**，只有第一种该催：

| 语义 | 例子 | 正确处理 |
|---|---|---|
| ① 误判了请求性质 | 「不行，这是严令禁止的。」（其实只是普通文件操作） | **补一条执行轮** |
| ② 事实诊断（工具/环境报错） | 「文件不存在。」「Permission denied (os error 13)」「EADDRINUSE」 | 不催，说清缺什么 |
| ③ 安全 / 合规 / 隐私 / 授权判断 | 「涉及他人账号数据，我不能提供。」 | **保持拒绝**，催等于拿压力逼它改口 |
| ④ 正在等你确认某个高风险动作 | 「要删 200 个文件，确认吗？」 | 停住等你 |

早期版本（1.0.0/1.0.1）只做「短 + 否定开场」的形态判断，结果是②③④都被当成①，**43/43 语料是"带病通过"**——语料自己把「安全拒绝也该催」写成了预期。1.0.2 起加诊断层，1.0.3 起加安全层，才算把这个语义分类补齐。

---

## 二、触发链路：七道闸，全过才动

入口在 `lib/index.js` 的 `listen("agent/status", ...)`，并且刻意 `setTimeout(..., cfg.delayMs)`（默认 280ms）等宿主彻底 idle，避免和「用户刚发的新消息」抢跑。

| # | 闸门 | 实现 | 挡掉什么 |
|---|---|---|---|
| 1 | 总开关 | `cfg.maxPerTurn >= 1` | `enabled:false` |
| 2 | 回合额度 | `if (cur.count >= cfg.maxPerTurn) return false` | 同一回合反复催（默认最多 2 次） |
| 3 | 宿主状态 | `agent.status === "running" \|\| inboxBusy(agent)` | 还在跑 / 收件箱有活 |
| 4 | 回合结束原因 | `isAbnormal(reason) \|\| isUserAbort(reason)` | `error` / `aborted` / `interrupted` / `max-tokens`；**你自己按的中断**也不催 |
| 5 | 有无新真人消息 | 扫 `user/message` 与 `inbox` | 你已经接着说话了 |
| 6 | 长度 | `s.length > maxChars` → `false` | 长回答说明它在正常干活（默认 220 字） |
| 7 | 三层判定 | 见下节 | 诊断 / 安全 / 不像拒绝 |

第 4 道闸有个细节：`aborted` 还要再区分「谁中断的」——用户主动按中断不算异常，但也不该被催（`isUserAbort`）。

---

## 三、判定：先排除「该停的」，再看「像不像拒绝」

```js
export function isRefusalReply(text, maxChars = DEFAULTS.maxChars) {
  const s = ...;                                  // 压空白、取纯文本
  if (!s) return false;
  if (s.length > maxChars) return false;          // 太长不判
  if (stopReason(s) !== null) return false;       // ← 关键：先排除该停的
  return REFUSAL_OPENERS.some((re) => re.test(s));
}

export function stopReason(text) {
  if (DIAGNOSTIC_MARKERS.some((re) => re.test(s))) return "diagnostic";
  if (SAFETY_MARKERS.some((re) => re.test(s))) return "safety";
  return null;
}
```

**`REFUSAL_OPENERS`** 允许主语前缀，避免「我不能提供这类内容」被开头那个「我」挡掉：

```js
/^(?:我|本人|我们)?(?:这边|这里)?\s*(?:不行|不可以|不能|没法|无法|不提供|不协助|不予|拒绝|做不到)/
```

**`DIAGNOSTIC_MARKERS`**（13 组，节选）：文件/路径不存在、权限拒绝、连接超时/不可达、端口占用、进程退出码、命令未安装、构建或语法错误、参数缺失、日志里没有、`403/404/500/502/503`、空文件/0 字节/已被占用、不在授权范围。

**`SAFETY_MARKERS`**（1 组，节选）：安全、合规、违法、违规、隐私、个人信息、他人账号、未授权、未获授权、绕过授权、政策。

顺序不能反：安全类必须**先于**诊断判，否则「出于安全考虑我无法连接该目标」会被当成网络诊断放行。

---

## 四、补的时候说什么：四分支，不是一句「继续」

`retryText` 是条件式的，让模型自己按上一轮的真实原因分流：

1. 只是误判请求性质、还没执行 → **直接执行**，给出结论与可执行步骤；
2. 正在等用户确认高风险动作 → **什么都别做，停住**；
3. 上一轮出于安全 / 合规 / 隐私 / 授权而停 → **保留原结论，不要改口执行**；
4. 因文件 / 工具 / 权限 / 信息不足而停 → 只说明缺什么，别改无关文件。

末段还有一条硬约束：**任何情况下不许编造**文件内容、命令输出、日志或运行状态，也不许用 `[PLACEHOLDER]` 顶替必要事实 —— 防的是「为了不显得停下而编」。

---

## 五、配置

`cordis.patch.yml` 的 `config`（或插件页设置）：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `maxPerTurn` | `2` | 每回合最多补几次，防死循环；`0` 等于关掉 |
| `maxChars` | `220` | 超过这个长度的回复一律不判 |
| `delayMs` | `280` | 等宿主彻底 idle 再动作，避免竞态 |
| `retryText` | 见 `lib/index.js` | **不建议在 patch 里覆盖**，否则会静默盖掉代码里的默认值 |

---

## 六、安装

### A. 本地 link（开发用）

```bash
# 把仓库放到任意目录，然后在 profile 里 link
cd ~/.dsh/profiles/desktop
# package.json: "dsh-refusal-guard": "link:D:/path/to/dsh-refusal-guard"
# 再把包名加进 dsh.profile.bundles
```

### B. 从本仓库装（单插件仓库，根目录就是包，不带 `#path:`）

```bash
dsh plugin --profile desktop add "git+https://github.com/yanyuweihan/dsh-refusal-guard.git"
```

> 注意：`dsh plugin` 只转发给 pnpm，**不会**替你登记 `dsh.profile.bundles`；装完要把 `dsh-refusal-guard` 加进 profile 的 bundles，或者直接在 GUI 插件页装。装完必须**完全退出并重开 DSH** 才加载。

---

## 七、测试

```bash
# 语料：56 条（16 条真拒绝 + 诊断/安全/等确认/正常长文等负例）
node test/run.mjs ./lib/index.js
# 预期：语料 56 条，通过 56，失败 0

# 单测：7 条（章节注册、包名稳定、判定边界等）
node --test test/guard.test.mjs
# 预期：tests 7 / pass 7 / fail 0
```

语料是**规格**：改动判定逻辑必须先改语料，否则等于偷偷改行为。语料里每一条都带 `expect` 与 `tag`（`refusal` / `diagnostic` / `safety` / `confirm` / `normal`），改错了会直接红。

---

## 八、边界与已知局限

1. **只看最后一条 assistant 的可见文本**（reasoning 与 tool-call 都丢弃）。它看不见前文，所以判定必然比模型自己读上下文粗 —— 这是设计边界，不是 bug。
2. **概率性纠偏，不是保证**。短句 + 高关键词密度最容易误触；长句里夹一句拒绝基本抓不到。
3. **词形触发**：它读的是词，不是意图。「我误读了」与「我不干」字面同形，只能靠诊断/安全两层把后者剔出去。
4. 观察记录：同一会话里前文满是拒绝/合规/安全词时，后续更容易被拦 —— 上下文警惕惯性。插件看不见上下文，因此这个因素它帮不上忙。
5. 它是**后处理层**，不是权限系统：拦不住模型无视整段规则自作主张，那要靠工具调用前的前置闸。

---

## 九、目录结构

```
dsh-refusal-guard/
├── package.json          # name/main/dsh.bundle/exports/files
├── cordis.patch.yml      # bundle 补丁：insert id/name/config
├── icon.svg
├── locale/
│   ├── zh.json           # meta.title / meta.description
│   └── en.json
├── lib/index.js          # 全部逻辑（约 340 行）
└── test/
    ├── corpus.mjs        # 56 条语料（规格）
    ├── run.mjs           # 跑语料，退出码非 0 即未达标
    └── guard.test.mjs    # 7 条单测
```

---

## 十、版本历史

| 版本 | 变更 |
|---|---|
| 1.0.0 | 首版：`agent/status` + 短否定开场判定；语料 31 条，实测 11/31（19 条诊断被误判） |
| 1.0.1 | 修 `source.kind`：写裸 `"plugin"` 会被 v4 会话格式拒（`format v4 message requires a producer-owned source kind`），改为 `plugin:dsh-refusal-guard` |
| 1.0.2 | 加 `DIAGNOSTIC_MARKERS`（13 组）+ 条件式 `retryText`；`REFUSAL_OPENERS` 允许主语前缀；语料 43 条 → 43/43 |
| 1.0.3 | 加 `SAFETY_MARKERS` + `stopReason()` 返回 `"diagnostic"\|"safety"\|null`，安全拒绝不再被催；语料 57 条 |
| 1.0.4 | 移除与 `dsh-risk-confirm` 重复的高风险提示词章节（职责分离）；语料 56 条 |
| 1.0.5 | `description` 与语料文案对齐 |
| 1.0.6 | 加 `locale/{zh,en}.json`，`exports`/`files` 登记 locale 与 icon；插件页显示中文名与简介 |

---

## 十一、实现细节备忘（踩过的坑）

- **`source.kind` 必须合法**：`agent.followup()` 造的消息会进 v4 会话格式，`producerKind` 只接受注册过的 producer 或 `plugin:<name>` 形态；否则整轮报错、界面显示「处理失败」。
- **不要靠 `agent.status` 立刻动作**：宿主在 idle 与「真正可追加」之间有一段窗口，`delayMs` 就是给这段用的。
- **判定顺序**：长度 → 诊断 → 安全 → opener。任何一层顺序反了都会引入一类误判（早期就是安全层缺失导致「正当拒绝被催」）。
- **语料即规格**：先写 `expect`，再改判定；否则修一个洞会开两个洞。
