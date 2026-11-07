/**
 * dsh-refusal-guard
 *
 * 独立插件：拦下"短 + 否定式开场"的回复，并自动补一条执行轮。
 *
 * 设计前提：这种回复是生成时的分支，不是判断结果——提高推理档位、加提示词都压不住
 * （实测 max 档仍然触发）。唯一稳的办法是"生成后兜住"，所以本插件不碰提示词、
 * 不碰宿主源码，只监听 agent/status，在回合已结束且内容可疑时补一条 followup。
 *
 * 触发条件（必须同时成立）：
 *   1. agent/status === "idle"
 *   2. 本轮 turn/end 不是 error / aborted / interrupted / max-tokens
 *   3. 本轮之后没有新的真人消息
 *   4. 最后一条 assistant/message 的可见文本 <= maxChars 且以否定式起手
 *   5. 本回合剩余次数 > 0
 */

import { randomUUID } from "node:crypto";

export const name = "dsh-refusal-guard";

export const DEFAULTS = Object.freeze({
  enabled: true,
  /** 每回合最多自动补几次，防止死循环 */
  maxPerTurn: 2,
  /** 超过这个长度一律不判，避免误伤正常长回答 */
  maxChars: 220,
  /**
   * 补发的执行指令：只在"误判请求性质、压根没动手"时把人推回去执行。
   *
   * 两种情况必须原地停住，不许被这句话推着往下走：
   *   1. 上一轮是安全 / 合规 / 隐私 / 授权的判断结论 —— 保留结论；
   *   2. 上一轮是因为文件、工具、权限、信息而停下 —— 说明缺什么。
   */
  retryText:
    "继续处理上一条请求：如果你只是误判了请求性质、还没有执行，就直接执行并给出结论与可执行步骤。" +
    "如果上一轮是出于安全、合规、隐私或授权的判断而停，保留原结论，不要改口执行。" +
    "如果上一轮是因为文件/路径不存在、命令或工具报错、权限受限、信息不足而停下，就保留原结论，只用一句话说明缺什么、需要对方补什么，不要为此改动无关文件。" +
    "任何情况下都不要编造文件内容、命令输出、日志或运行状态，也不要用 [PLACEHOLDER] 之类占位符代替必要的事实。",
  /** 等宿主彻底 idle 后再发，避免和用户下一条消息竞态 */
  delayMs: 280,
});

/**
 * 只认短回复的"开头"，避免正文里出现"不行"就误判。
 * 允许前面挂一个主语（"我不能提供…"、"我这边没有权限…"）。
 */
const REFUSAL_OPENERS = [
  /^(?:我|本人|我们)?(?:这边|这里)?\s*(?:不行|不可以|不能|没法|无法|不提供|不协助|不予|拒绝|做不到)/,
  /^(?:我|本人|我们)?(?:这边|这里)?\s*(?:很抱歉|抱歉|对不起|不好意思)/,
  /^(?:i\s*(?:can\s*not|can't|cannot|won't|will\s*not|am\s*not\s*able)|sorry|no,)/i,
  /^(?:as\s+an?\s+(?:ai|assistant|language\s*model))/i,
];

/**
 * 事实诊断标记：这些是"查证之后得出的结论"，不是短路拒绝。
 *
 * 否定式开场（无法/不能/抱歉）既是拒绝的起手，也是报错的起手，光凭开场分不开；
 * 真正的诊断一定带症状：错误码、系统调用名、HTTP 状态、退出码、缺哪个参数、
 * 哪个路径不存在。命中这些标记就不补执行轮——否则会把"文件不存在"硬推成
 * "再试一遍"，逼模型虚构文件内容或工具输出。
 */
const DIAGNOSTIC_MARKERS = [
  // 文件 / 路径 / 目录
  /(?:文件|路径|目录|文件夹|样本|仓库|配置)[^。；\n]{0,12}(?:不存在|没有找到|未找到|找不到)/,
  /(?:不存在|没有找到|未找到|找不到)[^。；\n]{0,8}(?:文件|路径|目录|文件夹|样本)/,
  /\bnot found\b|\bno such file\b|\bENOENT\b/i,
  // 权限
  /权限不足|没有[^。；\n]{0,8}权限|无[^。；\n]{0,6}权限|权限受限|拒绝访问|只读|permission denied|\bEACCES\b|\bEPERM\b|\b401\b|\b403\b|\bbad credentials\b/i,
  // 网络
  /连接(?:失败|被拒|拒绝|超时|不上)|拒绝连接|无法连接|连不上|未响应|请求超时|解析失败|域名不存在|NXDOMAIN|\bECONNREFUSED\b|\bECONNRESET\b|\bETIMEDOUT\b|\btimeout\b|\brefused\b/i,
  // 端口 / 资源
  /端口[^。；\n]{0,10}(?:占用|被占)|\bEADDRINUSE\b|磁盘空间不足|no space left/i,
  // 进程 / 退出码
  /进程[^。；\n]{0,10}(?:退出|结束|已死)|exit code|退出码|\bexit status\b/i,
  // 命令 / 工具 / 依赖
  /(?:命令|工具|依赖|模块|包)[^。；\n]{0,12}(?:没有安装|未安装|不存在|未找到|找不到)|command not found|is not recognized/i,
  // 构建 / 语法 / 解析
  /(?:构建|编译|测试)[^。；\n]{0,8}(?:失败|挂)|SyntaxError|TypeError|ReferenceError|Unexpected token|Unexpected end of JSON|JSON 解析失败|\bEJSONPARSE\b/i,
  // 参数 / 输入缺失
  /缺少[^。；\n]{0,10}(?:参数|字段|文件|依赖|输入)|需要(?:你|先)提供|没有提供[^。；\n]{0,8}(?:参数|输入|目标)/,
  // 记录里没有
  /(?:日志|记录|历史|输出)[^。；\n]{0,12}(?:里)?(?:没有|查不到|找不到)/,
  // 其它系统症状
  /\b(?:403|404|500|502|503)\b|空文件|0 字节|已被占用|不在授权/,
];

const ABNORMAL_KINDS = new Set(["error", "aborted", "interrupted", "max-tokens"]);


/**
 * 本插件注入消息的 source.kind。
 *
 * v4 会话格式**拒绝** `kind: "plugin"`（已退役包装），会抛
 * `format v4 message requires a producer-owned source kind`
 * （`@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js:126`）。
 * 插件必须用 producer-owned 形态：`plugin:<包名>`（同文件 `producerKind()` 的兜底分支）。
 */
const OWN_KIND = "plugin:dsh-refusal-guard";

/** 自己注入的消息：不参与"有没有新真人消息"的判定。 */
const OWN_SOURCE_KINDS = new Set([OWN_KIND, "plugin", "dsh-refusal-guard", "dsh-purge"]);

/**
 * 不是「该补执行轮」的两种情况之二：安全类拒绝。
 *
 * 模型说「出于安全考虑不能执行」「涉及他人隐私」「未经授权」时，这是判断结论，
 * 不是没看懂的短路分支。补一条「你只是误判了，去执行」等于把安全判断掀掉。
 */
const SAFETY_MARKERS = [
  // 安全 / 政策 / 合规
  /安全考虑|安全机制|安全策略|安全限制|安全边界|出于安全|平台政策|使用政策|服务条款|内容政策|政策(?:不允许|禁止)|违反(?:规定|政策|条款)|合规|符合规范/i,
  /(?:^|[^不])安全(?:性)?(?:问题|风险|隐患)|可能(?:造成|导致)[^。；\n]{0,8}(?:伤害|破坏|损害)/,
  // 法律
  /违法|非法|不合法|触犯法律|法律(?:风险|责任|问题|禁止)|违规|侵权行为|版权|盗版|司法/i,
  /\b(?:illegal|unlawful|against the law|legal advice|infring(?:e|ing)|copyright|piracy)\b/i,
  // 隐私 / 个人信息
  /隐私|个人信息|个人数据|敏感信息|身份证号|手机号|住址|人脸数据|生物特征/i,
  /\b(?:privacy|personal (?:data|information)|PII|doxx?ing|stalk(?:ing)?)\b/i,
  // 授权 / 越权
  /未(?:经)?授权|未获授权|无授权|没有(?:获得)?授权|缺少(?:合法)?授权|授权证明|授权范围外|不属于授权|需要(?:你|先)授权/i,
  /\b(?:unauthori[sz]ed|without (?:authorization|permission|consent)|not authorized)\b/i,
  // 危害性内容
  /(?:武器|爆炸物|毒品|枪械|自制炸弹|制毒)|伤害(?:他人|自己)|自残|自杀|未成年人|儿童色情|骚扰|跟踪|勒索|敲诈/i,
];

/**
 * 一句话的「不该补轮」原因。命中任一即返回标签，全部不命中返回 null。
 * 顺序有意义：先技术症状，再安全结论。
 */
export function stopReason(text) {
  const s = String(text || "")
    .replace(/^[\s>*#\-]+/, "")
    .trim();
  if (!s) return null;
  if (DIAGNOSTIC_MARKERS.some((re) => re.test(s))) return "diagnostic";
  if (SAFETY_MARKERS.some((re) => re.test(s))) return "safety";
  return null;
}

export function isRefusalReply(text, maxChars = DEFAULTS.maxChars) {
  const s = String(text || "")
    .replace(/^[\s>*#\-]+/, "")
    .trim();
  if (!s) return false;
  if (s.length > maxChars) return false;
  // 先排除「不是短路拒绝」的两类：事实诊断 / 安全判断。
  if (stopReason(s) !== null) return false;
  return REFUSAL_OPENERS.some((re) => re.test(s));
}

/** 最后一轮可见回答的纯文本：reasoning 与 tool-call 都丢弃。 */
export function lastAssistantText(events) {
  const list = Array.isArray(events) ? events : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const event = list[i];
    if (event?.type !== "assistant/message") continue;
    const blocks = event?.data?.message?.content;
    if (!Array.isArray(blocks)) continue;
    const text = blocks
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text.trim())
      .filter(Boolean)
      .join("\n");
    if (text) return text;
  }
  return "";
}

export function sessionEventsOf(agent) {
  const session = agent?.session;
  if (!session) return [];
  try {
    if (typeof session.snapshotEvents === "function") return session.snapshotEvents() || [];
  } catch {
    /* ignore */
  }
  try {
    if (Array.isArray(session.events)) return session.events;
  } catch {
    /* ignore */
  }
  return [];
}

function lastTurnEnd(events) {
  const list = Array.isArray(events) ? events : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i]?.type === "turn/end") return list[i];
  }
  return null;
}

function isAbnormal(reason) {
  return Boolean(reason && ABNORMAL_KINDS.has(reason.kind));
}

function isUserAbort(reason) {
  if (!reason || reason.kind !== "aborted") return false;
  const cause = reason.reason;
  if (cause === "user" || cause === "cancel") return true;
  if (cause && typeof cause === "object") return cause.kind === "user" || cause.kind === "cancel";
  return false;
}

function hasFreshHumanTurn(events) {
  const list = Array.isArray(events) ? events : [];
  const end = lastTurnEnd(list);
  const after = end ? list.filter((e) => (e?.seq || 0) > end.seq) : list;
  return after.some((e) => {
    if (e?.type !== "user/message") return false;
    const kind = e.data?.source?.kind;
    return !OWN_SOURCE_KINDS.has(kind);
  });
}

function inboxBusy(agent) {
  try {
    const inbox = agent?.inbox;
    if (!inbox) return false;
    if (typeof inbox.hasPending === "function" && inbox.hasPending()) return true;
    if (typeof inbox.size === "number" && inbox.size > 0) return true;
    if (typeof inbox.length === "number" && inbox.length > 0) return true;
  } catch {
    /* ignore */
  }
  return false;
}

function makeFollowup(text) {
  return {
    id: `refusal-guard-${randomUUID()}`,
    role: "user",
    content: [{ type: "text", text }],
    // 只带 kind：v4 的 source 会被逐字段校验，多余字段一律不带
    source: { kind: OWN_KIND },
  };
}

/**
 * 解析生效配置：patch 里的 config 覆盖代码默认值。
 *
 * 单独导出是为了让测试能验「合成后的 cfg」，而不是只验 DEFAULTS ——
 * v1.0.2 的教训就是 patch 里留着旧 retryText，代码改了却没生效，测试还全绿。
 */
export function resolveConfig(config) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  if (typeof cfg.retryText !== "string" || !cfg.retryText.trim()) cfg.retryText = DEFAULTS.retryText;
  return cfg;
}

export function apply(ctx, config) {
  const cfg = resolveConfig(config);
  if (cfg.enabled === false) return;

  /** 走宿主 logger（有就给），没有就退回 console；前缀统一，方便用户 grep。 */
  const warn = (message) => {
    try {
      if (typeof ctx?.logger === "function") {
        const logger = ctx.logger("dsh-refusal-guard");
        if (logger && typeof logger.warn === "function") {
          logger.warn(message);
          return;
        }
      }
    } catch {
      /* 宿主 logger 形状不对就退回 console */
    }
    console.warn(`[refusal-guard] ${message}`);
  };

  // 宿主能力自检：缺 API 时明确说一句，别让人误以为「装了没反应」就是插件坏了
  const missing = [];
  if (typeof ctx?.on !== "function") missing.push("ctx.on");
  if (typeof ctx?.get !== "function") missing.push("ctx.get");
  if (missing.length > 0) {
    warn(`宿主缺少 ${missing.join(" / ")}，插件不会生效。dsh-refusal-guard 需要 DSH >= 0.2.0（cordis 4.x）。`);
    return;
  }

  /** sessionId -> { seq, count } */
  const budget = new Map();
  const timers = new Set();
  let warnedNoFollowup = false;
  let warnedNoEffect = false;

  const listen = (event, handler) => {
    try {
      return ctx.on(event, handler, { global: true });
    } catch {
      try {
        return ctx.on(event, handler);
      } catch {
        return null;
      }
    }
  };

  const take = (sessionId, seq) => {
    const cur = budget.get(sessionId);
    if (!cur || cur.seq !== seq) {
      budget.set(sessionId, { seq, count: 1 });
      return cfg.maxPerTurn >= 1;
    }
    if (cur.count >= cfg.maxPerTurn) return false;
    cur.count += 1;
    return true;
  };

  const check = (agent) => {
    const id = agent?.id || agent?.session?.id || "";
    if (!id) return;
    if (agent.status === "running" || inboxBusy(agent)) return;
    const events = sessionEventsOf(agent);
    if (hasFreshHumanTurn(events)) return;
    const end = lastTurnEnd(events);
    const reason = end?.data?.reason || null;
    if (isAbnormal(reason) || isUserAbort(reason)) return;
    const text = lastAssistantText(events);
    if (!isRefusalReply(text, cfg.maxChars)) return;
    const seq = end?.seq || 0;
    if (!take(id, seq)) return;
    if (typeof agent.followup !== "function") {
      if (!warnedNoFollowup) {
        warnedNoFollowup = true;
        warn("宿主没有 agent.followup，无法补发指令（DSH 版本过旧），插件不会生效。");
      }
      return;
    }
    try {
      agent.followup(makeFollowup(cfg.retryText));
      console.warn(
        `[refusal-guard] 拦截短否定回复并补执行轮 (session=${id}, seq=${seq}): ${text.slice(0, 80).replace(/\s+/g, " ")}`,
      );
    } catch (e) {
      console.warn("[refusal-guard] followup 失败:", e && e.message ? e.message : e);
    }
  };

  const off = listen("agent/status", (payload) => {
    if (payload?.status !== "idle") return;
    const agent = payload?.agent;
    if (!agent) return;
    const timer = setTimeout(() => {
      timers.delete(timer);
      try {
        check(agent);
      } catch (e) {
        console.warn("[refusal-guard] check 异常:", e && e.message ? e.message : e);
      }
    }, cfg.delayMs);
    timers.add(timer);
  });

  const dispose = () => {
    for (const t of timers) clearTimeout(t);
    timers.clear();
    budget.clear();
    try {
      off?.();
    } catch {
      /* ignore */
    }
  };
  if (typeof ctx.effect !== "function") {
    if (!warnedNoEffect) {
      warnedNoEffect = true;
      warn("宿主没有 ctx.effect：热重载时监听可能残留，建议升级 DSH >= 0.2.0。");
    }
  } else {
    try {
      ctx.effect(() => dispose);
    } catch {
      /* 宿主 effect 签名不一致时靠 scope 回收 */
    }
  }
  return dispose;
}

export default { name, apply, DEFAULTS, resolveConfig };
