/**
 * AI 模型路由测试（任务 B 验收）
 * ============================================================================
 * 运行：node tests/model-routing.test.mjs（本目录）或
 *       node vendor/standalone-v2/tests/model-routing.test.mjs（项目根）
 *
 * 说明：
 * · 通道配置写入临时文件（BILI_HUMANISM_MODELS），不碰生产 models.json
 * · 网络调用全部用 mock fetch 拦截，测试不依赖真实 API Key
 * · suite/test/assert 辅助函数与 ai-tasks/shared/test-utils.mjs 同名同签名
 *   （任务 G 固化统一 runner 后可无缝替换为 import 共享版本）
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ----------------------------------------------------------------
// 0. 测试辅助（API 兼容 shared/test-utils.mjs）
// ----------------------------------------------------------------

function assert(condition, message = "断言失败") {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      message || `断言失败: 期望 ${JSON.stringify(expected)}, 实际 ${JSON.stringify(actual)}`,
    );
  }
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`✅ ${name}`);
    return true;
  } catch (e) {
    console.error(`❌ ${name}`);
    console.error(`   ${e.message}`);
    if (e.stack) console.error(`   ${e.stack.split("\n").slice(1, 3).join("\n   ")}`);
    return false;
  }
}

async function suite(name, tests) {
  console.log(`\n🧪 ${name}`);
  console.log("─".repeat(60));
  let passed = 0;
  let failed = 0;
  for (const [testName, testFn] of Object.entries(tests)) {
    const ok = await test(testName, testFn);
    if (ok) passed++;
    else failed++;
  }
  console.log("─".repeat(60));
  console.log(`总计: ${passed + failed} | 通过: ${passed} | 失败: ${failed}`);
  return { passed, failed, total: passed + failed };
}

/** 临时替换 globalThis.fetch，返回还原函数 */
function withMockFetch(handler) {
  const orig = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = orig;
  };
}

/** 构造一个 OpenAI 兼容的成功响应体 */
function okBody(content) {
  return JSON.stringify({
    choices: [{ message: { role: "assistant", content } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    model: "mock-model",
  });
}

/** 构造 mock fetch Response（只用到 ok/status/text） */
function mockResp(status, bodyText) {
  return { ok: status >= 200 && status < 300, status, text: async () => bodyText };
}

// ----------------------------------------------------------------
// 1. 隔离环境：配置写到临时文件（必须在 import 被测模块之前设置）
// ----------------------------------------------------------------

const tmpDir = mkdtempSync(join(tmpdir(), "bili-models-test-"));
const tmpFile = join(tmpDir, "models.json");
process.env.BILI_HUMANISM_MODELS = tmpFile;

const { chat, pickChannel, testChannel } = await import("../models/router.mjs");
const { add, list, remove, update, masked, load } = await import("../models/channels.mjs");

/** 清空通道（每个用例前调用，保证互不污染） */
function resetChannels() {
  for (const c of list()) remove(c.id);
}

// ----------------------------------------------------------------
// 2. 用例
// ----------------------------------------------------------------

const { failed } = await suite("AI 模型路由（任务 B）", {
  // ---- 通道管理 ----
  "能添加通道，返回 ID 且 apiKey 打码": () => {
    resetChannels();
    const ch = add({
      name: "Test",
      baseURL: "https://api.test.com/v1",
      apiKey: "synthetic-channel-key",
      model: "test-model",
      priority: 10,
    });
    assert(ch.id, "返回了通道 ID");
    assertEqual(ch.name, "Test");
    assertEqual(ch.apiKey, "***", "返回值里 apiKey 必须打码");
    remove(ch.id);
  },

  "通道按优先级排序（小的在前）": () => {
    resetChannels();
    const a = add({ name: "A", baseURL: "https://a.test/v1", apiKey: "k", model: "a", priority: 20 });
    const b = add({ name: "B", baseURL: "https://b.test/v1", apiKey: "k", model: "b", priority: 10 });
    const channels = list();
    assertEqual(channels[0].name, "B", "优先级 10 在前");
    assertEqual(channels[1].name, "A", "优先级 20 在后");
    remove(a.id);
    remove(b.id);
  },

  "masked() 前端版本不泄露真实 key": () => {
    resetChannels();
    const ch = add({ name: "K", baseURL: "https://k.test/v1", apiKey: "synthetic-masked-key", model: "m", priority: 1 });
    const m = masked();
    assertEqual(m.channels[0].apiKey, "***");
    assertEqual(m.channels[0].hasKey, true);
    remove(ch.id);
  },

  "重复的 baseURL+model 拒绝添加（DUP）": () => {
    resetChannels();
    const ch = add({ name: "D1", baseURL: "https://dup.test/v1", apiKey: "k", model: "same", priority: 1 });
    try {
      add({ name: "D2", baseURL: "https://dup.test/v1", apiKey: "k", model: "same", priority: 2 });
      throw new Error("期望抛出 DUP 但没有");
    } catch (e) {
      assertEqual(e.code, "DUP");
    }
    remove(ch.id);
  },

  "update() 传 *** 保持原 key 不变": () => {
    resetChannels();
    const ch = add({ name: "U", baseURL: "https://u.test/v1", apiKey: "synthetic-origin", model: "m", priority: 1 });
    const full = list().find((x) => x.id === ch.id);
    assertEqual(full.apiKey, "synthetic-origin");
    update(ch.id, { apiKey: "***", priority: 5 });
    const after = list().find((x) => x.id === ch.id);
    assertEqual(after.apiKey, "synthetic-origin", "*** 应视为不修改");
    assertEqual(after.priority, 5, "priority 应更新");
    remove(ch.id);
  },

  "remove() 能删除通道": () => {
    resetChannels();
    const ch = add({ name: "R", baseURL: "https://r.test/v1", apiKey: "k", model: "m", priority: 1 });
    assertEqual(remove(ch.id), true);
    assertEqual(list().length, 0);
    assertEqual(remove("ch_not_exist"), false, "删不存在的通道返回 false");
  },

  // ---- chat()：无通道 ----
  "没有通道时 chat 抛 NO_CHANNEL": async () => {
    resetChannels();
    try {
      await chat([{ role: "user", content: "test" }]);
      throw new Error("期望抛出错误但没有");
    } catch (e) {
      assertEqual(e.code, "NO_CHANNEL");
    }
  },

  "没有 apiKey 的通道不参与调用": async () => {
    resetChannels();
    add({ name: "NoKey", baseURL: "https://nokey.test/v1", apiKey: "", model: "m", priority: 1 });
    try {
      await chat([{ role: "user", content: "test" }]);
      throw new Error("期望抛出错误但没有");
    } catch (e) {
      assertEqual(e.code, "NO_CHANNEL", "无 key 通道应被过滤，等效于没有可用通道");
    }
    resetChannels();
  },

  "未启用的通道不参与调用": async () => {
    resetChannels();
    const ch = add({ name: "Off", baseURL: "https://off.test/v1", apiKey: "k", model: "m", priority: 1 });
    update(ch.id, { enabled: false });
    try {
      await chat([{ role: "user", content: "test" }]);
      throw new Error("期望抛出错误但没有");
    } catch (e) {
      assertEqual(e.code, "NO_CHANNEL", "enabled=false 通道应被过滤");
    }
    resetChannels();
  },

  // ---- chat()：正常调用 ----
  "chat() 正常调用返回 { text, usage, channel }": async () => {
    resetChannels();
    const ch = add({ name: "Solo", baseURL: "https://solo.test/v1", apiKey: "k", model: "m", priority: 1 });
    const restore = withMockFetch(async () => mockResp(200, okBody("你好，我是模型")));
    try {
      const r = await chat([{ role: "user", content: "hi" }]);
      assertEqual(r.text, "你好，我是模型");
      assertEqual(r.channel, "Solo");
      assert(r.usage && r.usage.total_tokens === 15, "usage 应透传");
    } finally {
      restore();
      remove(ch.id);
    }
  },

  // ---- chat()：自动降级 ----
  "429 限流自动降级到下一个通道": async () => {
    resetChannels();
    const a = add({ name: "Rate", baseURL: "https://rate.test/v1", apiKey: "k", model: "m1", priority: 10 });
    const b = add({ name: "Backup", baseURL: "https://bak.test/v1", apiKey: "k", model: "m2", priority: 20 });
    const called = [];
    const restore = withMockFetch(async (url, init) => {
      called.push(url);
      if (url.startsWith("https://rate.test")) {
        return mockResp(429, JSON.stringify({ error: { message: "slow down" } }));
      }
      return mockResp(200, okBody("备用通道应答"));
    });
    try {
      const r = await chat([{ role: "user", content: "hi" }]);
      assertEqual(r.channel, "Backup", "应降级到第二个通道");
      assertEqual(r.text, "备用通道应答");
      assertEqual(called.length, 2, "两个通道各调用一次");
      assert(called[0].includes("rate.test"), "先按优先级尝试 rate");
    } finally {
      restore();
      remove(a.id);
      remove(b.id);
    }
  },

  "503 不可用自动降级到下一个通道": async () => {
    resetChannels();
    const a = add({ name: "Down", baseURL: "https://down.test/v1", apiKey: "k", model: "m1", priority: 10 });
    const b = add({ name: "Up", baseURL: "https://up.test/v1", apiKey: "k", model: "m2", priority: 20 });
    const restore = withMockFetch(async (url) => {
      if (url.startsWith("https://down.test")) return mockResp(503, JSON.stringify({ error: { message: "overloaded" } }));
      return mockResp(200, okBody("正常应答"));
    });
    try {
      const r = await chat([{ role: "user", content: "hi" }]);
      assertEqual(r.channel, "Up");
    } finally {
      restore();
      remove(a.id);
      remove(b.id);
    }
  },

  "超时自动降级到下一个通道": async () => {
    resetChannels();
    const a = add({ name: "Slow", baseURL: "https://slow.test/v1", apiKey: "k", model: "m1", priority: 10 });
    const b = add({ name: "Fast", baseURL: "https://fast.test/v1", apiKey: "k", model: "m2", priority: 20 });
    const restore = withMockFetch(async (url) => {
      if (url.startsWith("https://slow.test")) {
        const e = new Error("The operation was aborted due to timeout");
        e.name = "AbortError";
        throw e;
      }
      return mockResp(200, okBody("快速通道应答"));
    });
    try {
      const r = await chat([{ role: "user", content: "hi" }], { timeoutMs: 5000 });
      assertEqual(r.channel, "Fast", "超时也应降级");
    } finally {
      restore();
      remove(a.id);
      remove(b.id);
    }
  },

  "400 等不可降级错误直接抛出（换通道也没用）": async () => {
    resetChannels();
    const a = add({ name: "Bad", baseURL: "https://bad.test/v1", apiKey: "k", model: "m1", priority: 10 });
    const b = add({ name: "Next", baseURL: "https://next.test/v1", apiKey: "k", model: "m2", priority: 20 });
    let called = 0;
    const restore = withMockFetch(async () => {
      called++;
      return mockResp(400, JSON.stringify({ error: { message: "invalid request" } }));
    });
    try {
      await chat([{ role: "user", content: "hi" }]);
      throw new Error("期望抛出错误但没有");
    } catch (e) {
      assertEqual(e.code, "CHANNEL_FAILED");
      assertEqual(e.status, 400);
      assertEqual(called, 1, "不应尝试第二个通道");
    } finally {
      restore();
      remove(a.id);
      remove(b.id);
    }
  },

  "所有通道都 429 时抛 ALL_CHANNELS_FAILED": async () => {
    resetChannels();
    const a = add({ name: "F1", baseURL: "https://f1.test/v1", apiKey: "k", model: "m1", priority: 10 });
    const b = add({ name: "F2", baseURL: "https://f2.test/v1", apiKey: "k", model: "m2", priority: 20 });
    const restore = withMockFetch(async () => mockResp(429, JSON.stringify({ error: { message: "rate limited" } })));
    try {
      await chat([{ role: "user", content: "hi" }]);
      throw new Error("期望抛出错误但没有");
    } catch (e) {
      assertEqual(e.code, "ALL_CHANNELS_FAILED");
      assertEqual(e.data.tried.join(","), "F1,F2");
      assert(e.data.lastError, "应带上最后一个错误信息");
    } finally {
      restore();
      remove(a.id);
      remove(b.id);
    }
  },

  // ---- testChannel ----
  "testChannel() 成功返回 { ok, status, ms, sample }": async () => {
    const restore = withMockFetch(async () => mockResp(200, okBody("可用")));
    try {
      const r = await testChannel({ name: "T", baseURL: "https://t.test/v1", apiKey: "k", model: "m" });
      assertEqual(r.ok, true);
      assertEqual(r.status, 200);
      assert(typeof r.ms === "number" && r.ms >= 0, "ms 是耗时数字");
      assertEqual(r.sample, "可用");
    } finally {
      restore();
    }
  },

  "testChannel() 失败返回 { ok:false, status, ms, error }": async () => {
    const restore = withMockFetch(async () => mockResp(401, JSON.stringify({ error: { message: "invalid api key" } })));
    try {
      const r = await testChannel({ name: "T", baseURL: "https://t.test/v1", apiKey: "k", model: "m" });
      assertEqual(r.ok, false);
      assertEqual(r.status, 401);
      assertEqual(r.error, "invalid api key");
    } finally {
      restore();
    }
  },

  "testChannel() 缺 key 直接判失败": async () => {
    const r = await testChannel({ name: "NoKey", baseURL: "https://nk.test/v1", apiKey: "", model: "m" });
    assertEqual(r.ok, false);
    assertEqual(r.error, "没有填 API Key");
  },

  // ---- pickChannel ----
  "pickChannel() 探测并返回第一个可用通道": async () => {
    resetChannels();
    const a = add({ name: "P1", baseURL: "https://p1.test/v1", apiKey: "k", model: "m1", priority: 10 });
    const b = add({ name: "P2", baseURL: "https://p2.test/v1", apiKey: "k", model: "m2", priority: 20 });
    const restore = withMockFetch(async (url) => {
      if (url.startsWith("https://p1.test")) return mockResp(500, JSON.stringify({ error: { message: "boom" } }));
      return mockResp(200, okBody("可用"));
    });
    try {
      const r = await pickChannel();
      assertEqual(r.channel.name, "P2", "第一个探测失败应继续探测第二个");
      assertEqual(r.probe.ok, true);
    } finally {
      restore();
      remove(a.id);
      remove(b.id);
    }
  },

  "pickChannel() 无可用通道返回 null": async () => {
    resetChannels();
    const r = await pickChannel();
    assertEqual(r, null);
  },
});

// ----------------------------------------------------------------
// 3. 清理与退出码
// ----------------------------------------------------------------

resetChannels();
try {
  rmSync(tmpDir, { recursive: true, force: true });
} catch {
  /* Windows 下偶尔占用，忽略 */
}

if (failed > 0) {
  console.error(`\n❌ ${failed} 个用例失败`);
  process.exit(1);
}
console.log("\n✅ 全部通过");
