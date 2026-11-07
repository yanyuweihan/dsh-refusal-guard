import { test } from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { apply, DEFAULTS, isRefusalReply, resolveConfig, stopReason } from "../lib/index.js";

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
