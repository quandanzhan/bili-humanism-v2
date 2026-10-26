/**
 * 工具调用循环（节点调用）测试
 * ============================================================================
 * 运行：node tests/tool-loop.test.mjs
 *
 * 做法：本机起一个假 OpenAI 兼容服务，按 messages 里的 tool 消息数量决定
 *       这次该返回 tool_calls 还是最终正文，从而在**真实 HTTP** 上验证循环：
 *         · 单次工具调用 → 回填 role:tool → 模型给出最终答案
 *         · 两次连续工具调用（多轮）
 *         · 工具抛错 → 错误回填给模型，对话不中断
 *         · 一直要工具 → TOOL_LOOP_EXCEEDED
 *         · 不传 tools → 老路径不受影响（请求体里没有 tools 字段）
 * 通道配置写临时文件（BILI_HUMANISM_MODELS），不碰生产配置。
 */
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function assert(cond, msg = "断言失败") {
  if (!cond) throw new Error(msg);
}
function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg || `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
}

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✅ ${name}`);
  } catch (e) {
    fail++;
    console.error(`❌ ${name}\n   ${e.message}`);
  }
}

// ----------------------------------------------------------------
// 假模型服务
// ----------------------------------------------------------------
const seenRequests = [];

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw || "{}");
    seenRequests.push(body);
    const toolMsgs = (body.messages || []).filter((m) => m.role === "tool");
    const model = body.model || "";
    let message = { role: "assistant", content: "好的" };
    let finish = "stop";

    if (!body.tools) {
      // 没传工具：直接正文
      message = { role: "assistant", content: `纯文本回答（无工具）` };
    } else if (model === "scenario-single" || model === "scenario-tool-error") {
      if (toolMsgs.length === 0) {
        message = {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "bili_video", arguments: JSON.stringify({ bvid: "BV1GJ411x7h7" }) },
            },
          ],
        };
        finish = "tool_calls";
      } else {
        const got = toolMsgs[0].content;
        message = { role: "assistant", content: `工具回填后我看到了：${String(got).slice(0, 40)}` };
      }
    } else if (model === "scenario-two-rounds") {
      if (toolMsgs.length === 0) {
        message = {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "call_a", type: "function", function: { name: "bili_search", arguments: '{"keyword":"白云号"}' } },
          ],
        };
        finish = "tool_calls";
      } else if (toolMsgs.length === 1) {
        message = {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "call_b", type: "function", function: { name: "web_fetch", arguments: '{"url":"https://example.com"}' } },
          ],
        };
        finish = "tool_calls";
      } else {
        message = { role: "assistant", content: `两轮工具都拿到了，共 ${toolMsgs.length} 条结果` };
      }
    } else if (model === "scenario-loop") {
      // 永远要工具，用来验证轮数上限
      const n = toolMsgs.length;
      message = {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: `call_${n}`, type: "function", function: { name: "file_read", arguments: '{"path":"/no/x"}' } },
        ],
      };
      finish = "tool_calls";
    } else if (model === "scenario-bad-json") {
      if (toolMsgs.length === 0) {
        message = {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "call_x", type: "function", function: { name: "bili_video", arguments: "{bad json" } }],
        };
        finish = "tool_calls";
      } else {
        message = { role: "assistant", content: "参数解析错误已被回填，我换个说法" };
      }
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl-test",
        model,
        choices: [{ index: 0, message, finish_reason: finish }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    );
  });
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;

// ----------------------------------------------------------------
// 通道配置（临时文件）
// ----------------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), "tool-loop-"));
const modelsFile = join(dir, "models.json");
writeFileSync(
  modelsFile,
  JSON.stringify({
    auto: true,
    channels: [
      {
        id: "fake",
        name: "假通道",
        baseURL: `http://127.0.0.1:${PORT}/v1`,
        apiKey: "sk-test",
        model: "scenario-single",
        priority: 10,
        enabled: true,
      },
    ],
  }),
);
process.env.BILI_HUMANISM_MODELS = modelsFile;

const { chat } = await import("../models/router.mjs");

/** 改通道 model 字段，切场景 */
function setModel(m) {
  const d = JSON.parse(readFileSync(modelsFile, "utf8"));
  d.channels[0].model = m;
  writeFileSync(modelsFile, JSON.stringify(d));
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "bili_video",
      description: "B站视频详情",
      parameters: { type: "object", properties: { bvid: { type: "string" } }, required: ["bvid"] },
    },
  },
];

console.log("=== 工具调用循环测试 ===");

await test("单次工具调用 → 回填 role:tool → 得到最终回答", async () => {
  setModel("scenario-single");
  const calls = [];
  const r = await chat([{ role: "user", content: "查 BV1GJ411x7h7 标题" }], {
    tools: TOOLS,
    toolRunner: async (name, args) => {
      calls.push({ name, args });
      return JSON.stringify({ title: "Never Gonna Give You Up" });
    },
    maxRounds: 5,
  });
  assertEqual(calls.length, 1, "应执行 1 次工具");
  assertEqual(calls[0].name, "bili_video");
  assertEqual(calls[0].args.bvid, "BV1GJ411x7h7");
  assertEqual(r.steps.length, 1);
  assertEqual(r.rounds, 2, "应该在第二轮给出正文");
  assert(r.text.includes("工具回填后我看到了"), `最终回答异常：${r.text}`);
  assert(r.usage.total_tokens >= 30, "usage 应累计两轮");
});

await test("连续两次工具调用（多轮）", async () => {
  setModel("scenario-two-rounds");
  const calls = [];
  const r = await chat([{ role: "user", content: "先搜再抓" }], {
    tools: TOOLS,
    toolRunner: async (name) => {
      calls.push(name);
      return JSON.stringify({ ok: true });
    },
    maxRounds: 5,
  });
  assertEqual(calls.length, 2);
  assertEqual(calls[0], "bili_search");
  assertEqual(calls[1], "web_fetch");
  assertEqual(r.steps.length, 2);
  assertEqual(r.rounds, 3);
});

await test("工具抛错 → 错误回填、对话不中断", async () => {
  setModel("scenario-tool-error");
  const r = await chat([{ role: "user", content: "查一下" }], {
    tools: TOOLS,
    toolRunner: async () => {
      const e = new Error("视频不存在");
      e.code = "BILI_NOT_FOUND";
      throw e;
    },
    maxRounds: 5,
  });
  assertEqual(r.steps.length, 1);
  assertEqual(r.steps[0].ok, false);
  assert(r.steps[0].preview.includes("BILI_NOT_FOUND"), "错误码应回填给模型");
  assert(r.text.length > 0, "模型应基于错误继续回答");
});

await test("参数不是合法 JSON → 回填 TOOL_ARGS_INVALID", async () => {
  setModel("scenario-bad-json");
  const r = await chat([{ role: "user", content: "x" }], {
    tools: TOOLS,
    toolRunner: async () => {
      throw new Error("不该被调用");
    },
    maxRounds: 3,
  });
  assertEqual(r.steps[0].ok, false);
  assert(r.steps[0].preview.includes("TOOL_ARGS_INVALID"));
});

await test("模型一直要工具 → TOOL_LOOP_EXCEEDED", async () => {
  setModel("scenario-loop");
  let err = null;
  try {
    await chat([{ role: "user", content: "x" }], {
      tools: TOOLS,
      toolRunner: async () => "{}",
      maxRounds: 3,
    });
  } catch (e) {
    err = e;
  }
  assert(err, "应抛错");
  assertEqual(err.code, "TOOL_LOOP_EXCEEDED");
  assertEqual(err.data.maxRounds, 3);
});

await test("不传 tools → 请求体不含 tools，老路径不变", async () => {
  setModel("scenario-single");
  seenRequests.length = 0;
  const r = await chat([{ role: "user", content: "你好" }], {});
  assertEqual(seenRequests.length, 1);
  assert(!("tools" in seenRequests[0]), "不应带 tools 字段");
  assertEqual(r.steps.length, 0);
  assertEqual(r.rounds, 1);
});

await test("传了 tools 的请求体格式正确（tools + tool_choice + 关闭并行）", async () => {
  setModel("scenario-single");
  seenRequests.length = 0;
  await chat([{ role: "user", content: "x" }], { tools: TOOLS, toolRunner: async () => "{}" });
  const first = seenRequests[0];
  assert(Array.isArray(first.tools) && first.tools.length === 1, "tools 应透传");
  assertEqual(first.tool_choice, "auto");
  assertEqual(first.parallel_tool_calls, false);
  // 第二轮必须带 assistant 的 tool_calls 与 role:tool
  const second = seenRequests[1];
  const roles = second.messages.map((m) => m.role);
  assert(roles.includes("assistant") && roles.includes("tool"), `第二轮消息角色异常：${roles}`);
  const assistant = second.messages.find((m) => m.role === "assistant");
  assert(Array.isArray(assistant.tool_calls) && assistant.tool_calls[0].id === "call_1");
  const toolMsg = second.messages.find((m) => m.role === "tool");
  assertEqual(toolMsg.tool_call_id, "call_1", "tool_call_id 必须对齐");
});

console.log(`\n=== 结果：通过 ${pass} / 失败 ${fail} ===`);
server.close();
rmSync(dir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
