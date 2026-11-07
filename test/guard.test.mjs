import { test } from "node:test";
import assert from "node:assert/strict";

import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  apply,
  DEFAULTS,
  hasOnlyAdvice,
  hasReason,
  isRefusalReply,
  purgeInProfile,
  resolveConfig,
  stopReason,
} from "../lib/index.js";

function mockCtx() {
  const sections = [];
  const disposers = [];
  return {
    sections,
    disposers,
    ctx: {
      get(service) {
        if (service === "systemPrompt") {
          return {
            section(options) {
              sections.push(options);
              return () => {
                const i = sections.indexOf(options);
                if (i >= 0) sections.splice(i, 1);
              };
            },
          };
        }
        return null;
      },
      on() {
        return () => {};
      },
      effect(factory) {
        const dispose = factory();
        if (typeof dispose === "function") disposers.push(dispose);
        return () => {};
      },
      logger() {},
    },
  };
}

test("不再往 system prompt 挂任何章节", () => {
  const { ctx, sections } = mockCtx();
  const dispose = apply(ctx, {});
  assert.equal(sections.length, 0);
  dispose();
  assert.equal(sections.length, 0);
});

test("没有 systemPrompt 服务时不抛", () => {
  assert.doesNotThrow(() => apply({ get: () => null, on: () => () => {}, effect() {} }, {}));
});

test("分类逻辑：事实诊断不补轮，纯拒绝照旧", () => {
  assert.equal(isRefusalReply("抱歉，文件不存在：C:\\a.md"), false);
  assert.equal(isRefusalReply("抱歉，我无法完成这个请求。"), true);
});

test("安全判断不补轮", () => {
  for (const text of [
    "抱歉，出于安全考虑我不能执行。",
    "出于安全考虑，我不能执行这个操作。",
    "涉及他人隐私，我不能提供。",
    "我不能在没有授权的情况下操作这台主机。",
    "抱歉，这是违法的，我不能做。",
  ]) {
    assert.equal(stopReason(text), "safety", text);
    assert.equal(isRefusalReply(text), false, text);
  }
});

test("retryText 保留安全与诊断两个停住分支，且没有「等确认」分支", () => {
  assert.match(DEFAULTS.retryText, /安全、合规、隐私或授权/);
  assert.match(DEFAULTS.retryText, /文件\/路径不存在/);
  assert.equal(/等我确认/.test(DEFAULTS.retryText), false);
  assert.equal(/什么都别做/.test(DEFAULTS.retryText), false);
});

/**
 * 回归测试：patch 里的 config 覆盖 DEFAULTS。v1.0.2 就栽在 patch 留着旧 retryText，
 * 代码改了没生效，而测试只验 DEFAULTS 全绿。这里直接把真实 patch 解析出来合成一遍。
 */
function readPatchConfig() {
  const here = dirname(fileURLToPath(import.meta.url));
  const text = readFileSync(join(here, "..", "cordis.patch.yml"), "utf8");
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s+config:\s*$/.test(line));
  if (start < 0) return {};
  const out = {};
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const m = line.match(/^(\s+)([A-Za-z0-9_]+):\s*(.*)$/);
    if (!m) break;
    const [, indent, key, rawValue] = m;
    if (indent.length <= 6) break; // 退回到 insert 层级
    const value = rawValue.trim();
    if (value === "true" || value === "false") out[key] = value === "true";
    else if (/^-?\d+$/.test(value)) out[key] = Number(value);
    else out[key] = value.replace(/^["']|["']$/g, "");
  }
  return out;
}

test("真实 patch 不会覆盖掉新版 retryText，也不再带 risk 键", () => {
  const patch = readPatchConfig();
  assert.equal("retryText" in patch, false, "cordis.patch.yml 里不该再写 retryText");
  assert.equal("riskPrompt" in patch, false, "cordis.patch.yml 里不该再有 riskPrompt");
  assert.equal("riskOrder" in patch, false, "cordis.patch.yml 里不该再有 riskOrder");
  const cfg = resolveConfig(patch);
  assert.equal(cfg.retryText, DEFAULTS.retryText);
});

test("resolveConfig 仍允许显式覆盖", () => {
  const cfg = resolveConfig({ retryText: "自定义" });
  assert.equal(cfg.retryText, "自定义");
  assert.equal(resolveConfig({ retryText: "   " }).retryText, DEFAULTS.retryText);
});

test("别人能装：manifest 不带 private，且版本约束不是通配", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));

  assert.equal(pkg.private, undefined, "private 会让别人装不上");

  const dshRange = pkg.engines?.dsh;
  assert.equal(typeof dshRange, "string", "engines.dsh 必须写明支持的 DSH 版本");
  assert.notEqual(dshRange.trim(), "*", "engines.dsh 不能用通配");
  assert.match(dshRange, /\d+\.\d+/, "engines.dsh 至少要写成版本号");

  const peer = pkg.peerDependencies?.["@deepseek-ai/cordis"];
  if (peer !== undefined) {
    assert.notEqual(peer.trim(), "*", "peerDependencies 不能用 *");
    assert.match(peer, /\d+\.\d+/, "peerDependencies 要写具体版本线");
    assert.equal(
      pkg.peerDependenciesMeta?.["@deepseek-ai/cordis"]?.optional,
      true,
      "cordis 只是宿主运行时，peer 必须标 optional，否则装着要报缺依赖",
    );
  }
});

test("宿主缺 API 时给一句明确的告警，而不是静默失效", () => {
  const warnings = [];
  const original = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    apply({}, {});
  } finally {
    console.warn = original;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ctx\.on/);
  assert.match(warnings[0], /DSH/);
});

function gatedCtx(services) {
  const handlers = new Map();
  const ctx = {
    get(service) {
      if (services && Object.prototype.hasOwnProperty.call(services, service)) return services[service];
      return null;
    },
    on(event, handler) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    effect(factory) {
      factory();
      return () => {};
    },
    logger() {},
  };
  return { ctx, handlers };
}

/** 屏蔽真实 profile 的回落探测，否则跑测试的这台机器上确实装了 dsh-purge。 */
function withClearedProfile(fn) {
  const saved = process.env.DSH_PROFILE_DIR;
  delete process.env.DSH_PROFILE_DIR;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.DSH_PROFILE_DIR;
    else process.env.DSH_PROFILE_DIR = saved;
  }
}

test("requirePurge 关着时不做任何探测，照常注册", () => {
  const { ctx, handlers } = gatedCtx({});
  const dispose = apply(ctx, { requirePurge: false });
  assert.equal(handlers.has("agent/status"), true);
  dispose();
  assert.equal(handlers.size, 0);
});

test("requirePurge 打开但没有 dsh-purge：不注册监听器，并明确说一次", () => {
  const warnings = [];
  const original = console.warn;
  console.warn = (message) => warnings.push(String(message));
  let dispose;
  try {
    withClearedProfile(() => {
      const { ctx, handlers } = gatedCtx({});
      dispose = apply(ctx, { requirePurge: true });
      assert.equal(handlers.size, 0, "一个监听器都不该挂");
    });
  } finally {
    console.warn = original;
  }
  assert.equal(dispose, undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /dsh-purge/);
  assert.match(warnings[0], /不生效/);
});

test("requirePurge 打开且 dsh-purge 在：照常注册", () => {
  const { ctx, handlers } = gatedCtx({ redteam: { ok: true } });
  const dispose = apply(ctx, { requirePurge: true });
  assert.equal(handlers.has("agent/status"), true);
  dispose();
  assert.equal(handlers.size, 0);
});

test("requirePurge 只认严格 true，字符串不会把它打开", () => {
  const { ctx, handlers } = gatedCtx({});
  const dispose = apply(ctx, { requirePurge: "true" });
  assert.equal(handlers.has("agent/status"), true, '"true" 应该被当成关');
  assert.equal(resolveConfig({ requirePurge: "true" }).requirePurge, false);
  dispose();
});

test("purgeInProfile：装了且启用才算有", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-profile-"));
  const file = join(dir, "package.json");

  writeFileSync(file, JSON.stringify({ dependencies: {} }));
  assert.equal(purgeInProfile(file), false, "没装");

  writeFileSync(
    file,
    JSON.stringify({ dependencies: { "dsh-purge": "1.0.0" }, dsh: { profile: { bundles: [] } } }),
  );
  assert.equal(purgeInProfile(file), false, "装了但被 disable（bundles 里没有）");

  writeFileSync(
    file,
    JSON.stringify({
      dependencies: { "dsh-purge": "1.0.0" },
      dsh: { profile: { bundles: ["dsh-purge"] } },
    }),
  );
  assert.equal(purgeInProfile(file), true, "装了且启用");

  writeFileSync(file, "{ 这不是 JSON");
  assert.equal(purgeInProfile(file), false, "坏 JSON 当没有");

  assert.equal(purgeInProfile(join(dir, "missing.json")), false, "文件不存在当没有");
});

/* ── 有理由的拒绝就是结论 ─────────────────────────────────────── */

test("hasReason：因果 / 风险 / 条件 / 替代方案 / 结构信号", () => {
  assert.equal(hasReason("这个不能做，因为它会在你生产库上做不可逆删除。"), false, "过短：A 长度下限先拦");
  assert.equal(hasReason("这个不能做，因为它会在你生产库上执行不可逆的删除。"), true, "因果 + 风险");
  assert.equal(hasReason("我不能提供绕过检测的成品代码。能做的：在隔离环境讲检测原理。"), true, "替代方案");
  assert.equal(hasReason("这需要你先给出授权范围，否则我没法判断边界在哪里。"), true, "条件");
  assert.equal(
    hasReason("抱歉，这里是结论：先把构建管线补齐，等 CI 绿了再看运行时那个偶发超时，否则排查会被噪声带偏。"),
    true,
    "结构：够长 + 冒号说明",
  );
  assert.equal(hasReason("我不能提供这个。原因是有法律风险，我可以给你替代思路。"), true);
  assert.equal(hasReason("我不能提供这类内容。"), false, "光给结论、没给理由");
  assert.equal(hasReason("抱歉，我无法完成这个请求。"), false);
});

test("带理由的拒绝不补轮，且停因标为 reasoned", () => {
  const text = "我不能提供绕过检测的成品代码。能做的：在隔离环境讲清检测原理与固件校验逻辑。";
  assert.equal(stopReason(text), "reasoned");
  assert.equal(isRefusalReply(text), false);
});

test("短且无理由的拒绝照旧补轮", () => {
  const text = "我不能提供这类内容。";
  assert.equal(stopReason(text), null);
  assert.equal(isRefusalReply(text), true);
});

test("stopOnReasoned: false 时回到「只看表述」", () => {
  const text = "这个不能做，因为它会在你生产库上做不可逆删除。";
  assert.equal(isRefusalReply(text, DEFAULTS.maxChars, { ...DEFAULTS, stopOnReasoned: false }), false, "仍然超长/带安全词就不会命中");
  assert.equal(isRefusalReply("抱歉，我无法完成这个请求。", DEFAULTS.maxChars, { ...DEFAULTS, stopOnReasoned: false }), true);
  const short = "我不能提供这个：它会破坏你现有的配置，而且当前没有备份可以回滚。";
  assert.equal(isRefusalReply(short, DEFAULTS.maxChars, { ...DEFAULTS, stopOnReasoned: false }), true);
  assert.equal(isRefusalReply(short), false, "默认开时，带理由就不补");
});

test("reasonMinChars 控制「结构信号」的门槛", () => {
  const short = "不行：太短。";
  assert.equal(hasReason(short, 40), false, "短句不能只靠冒号算理由");
  assert.equal(hasReason(short, 5), true);
  assert.equal(resolveConfig({}).reasonMinChars, DEFAULTS.reasonMinChars);
  assert.equal(resolveConfig({ reasonMinChars: -1 }).reasonMinChars, DEFAULTS.reasonMinChars);
  assert.equal(resolveConfig({}).stopOnReasoned, true);
  assert.equal(resolveConfig({ stopOnReasoned: false }).stopOnReasoned, false);
});

test("B：只有「空建议」不算给了理由，带具体对象才算", () => {
  // 长到过了长度门槛，但建议里没有可核对的东西 —— 空话
  assert.equal(hasReason("抱歉，这一条我不能做：建议你换个思路，或者自己再想想办法。"), false, "换个思路");
  assert.equal(hasReason("抱歉，这一条我不能做：建议你找别人，我这边确实帮不上什么忙。"), false, "找别人");
  assert.equal(hasReason("抱歉，这一条我不能做：建议你查文档，文档里应该写得更清楚一些。"), false, "查文档");
  assert.equal(hasOnlyAdvice("抱歉，这一条我不能做：建议你查文档，文档里应该写得更清楚一些。"), true);
  // 同样长，但建议里有具体对象
  assert.equal(hasReason("抱歉，这一条我不能做：建议你先跑 npm test 看报错，把失败那条贴给我。"), true, "命令");
  assert.equal(hasReason("抱歉，这一条我不能做：建议把 pnpm-lock.yaml 删掉重装，再跑一次构建。"), true, "文件名");
  assert.equal(hasOnlyAdvice("抱歉，这一条我不能做：建议你先跑 npm test 看报错，把失败那条贴给我。"), false);
});

test("A：短句一律不算给了理由，不管带什么词", () => {
  for (const text of ["不行，因为不合适。", "这个不能做：有风险。", "不行，因为不合规。"]) {
    assert.equal(hasReason(text), false, text);
    assert.equal(hasReason(text, 4), true, `把门槛降到 4 时同一条应命中：${text}`);
  }
  // 空建议即便把门槛降到 4 也不算：它不是「短」，是没内容
  assert.equal(hasReason("不行，建议你换个思路。", 4), false);
});

