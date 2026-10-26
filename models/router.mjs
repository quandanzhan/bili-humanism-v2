import { redactText, redactData, safeUrl, registerSecrets, urlSecrets, completionUrl } from '../gateway/runtime.mjs'
/**
 * AI 模型路由器（对话调用 + 自动降级）
 * ============================================================================
 * @module models/router
 * @description 「给对话用的大模型入口」的统一门面：
 *              - chat()：按优先级依次尝试可用通道，429/503/超时自动降级
 *              - pickChannel()：按优先级探测，返回第一个可用通道
 *              - testChannel()：调一次最小请求验证单个通道是否可用
 * 通道配置管理见 ./channels.mjs，底层调用与错误分类见 ./fallback.mjs。
 *
 * 接口约定（ai-tasks/shared/interfaces.d.ts）：
 *   chat(messages, opts) -> Promise<{ text, usage, channel }>
 *   pickChannel()        -> Promise<{ channel, probe } | null>
 *   testChannel(ch)      -> Promise<{ ok, status?, ms, sample?/error? }>
 *
 * 错误码（ai-tasks/shared/error-codes.md，3xxx 模型路由）：
 *   NO_CHANNEL / CHANNEL_TIMEOUT / CHANNEL_FAILED / CHANNEL_RATE_LIMITED / ALL_CHANNELS_FAILED
 * @exports {Function} chat - 与 AI 模型对话（自动降级）
 * @exports {Function} pickChannel - 按优先级找第一个可用通道
 * @exports {Function} testChannel - 测试单个通道可用性
 */
import { getAvailableChannels, callChannel } from "./fallback.mjs";
import { alertChannel } from "../gateway/notifier.mjs";

// ----------------------------------------------------------------
// 1. 核心聊天接口（自动降级）
// ----------------------------------------------------------------

/**
 * 与 AI 模型对话（自动降级 + 可选工具调用循环）
 *
 * 「节点调用」说明：传了 opts.tools 时，模型可以返回 tool_calls，
 * 本函数会通过 opts.toolRunner 真正执行工具、把结果以 role:'tool' 回填，
 * 再让模型接着推理，直到它给出普通文本回答或到达 maxRounds。
 *
 * @param {Array} messages - 消息数组 [{ role, content }]
 * @param {Object} opts - 可选参数
 * @param {number} [opts.maxTokens=800] - 单次补全上限
 * @param {number} [opts.temperature=0.7]
 * @param {number} [opts.timeoutMs=60000] - 单次 HTTP 超时
 * @param {Array}  [opts.tools] - OpenAI 格式工具定义（[{type:'function',function:{...}}]）
 * @param {Function} [opts.toolRunner] - async (name, args) => 结果；抛错会被回填给模型
 * @param {number} [opts.maxRounds=5] - 工具循环上限（超过即 TOOL_LOOP_EXCEEDED）
 * @param {Function} [opts.onEvent] - 进度回调 ({type:'tool'|'tool_result', ...})
 * @returns {Promise<{ text, usage, channel, model, steps, rounds }>}
 * @throws {Error} code NO_CHANNEL / ALL_CHANNELS_FAILED / TOOL_LOOP_EXCEEDED /
 *                 其他通道错误（400/401 等不可降级错误原样上抛）
 */
export async function chat(messages, opts = {}) {
  const {
    maxTokens = 800,
    temperature = 0.7,
    timeoutMs = 60000,
    tools = null,
    toolRunner = null,
    maxRounds = 5,
    onEvent = null,
    channelId = null,
  } = opts;

  // 1. 按优先级获取可用通道列表
  const all = await getAvailableChannels();
  if (!all.length) {
    const err = new Error("没有可用的模型通道（请在「设置 → AI 模型」添加）");
    err.code = "NO_CHANNEL";
    // 这是「值班直接停摆」级别，必须报警（进程内调用不走 HTTP 中间件）
    alertChannel({ level: 'none', code: 'NO_CHANNEL', detail: err.message });
    throw err;
  }
  // 指定通道（调度任务里「用哪个 AI 接口」）→ 提到队首；
  // 仍然保留其余通道兜底：指定通道挂了不该让整轮值班直接失败。
  let channels = all;
  if (channelId) {
    const pref = all.find((c) => c.id === channelId);
    if (!pref) {
      const err = new Error(`指定的模型通道不存在或未启用：${channelId}`);
      err.code = "NO_CHANNEL";
      err.data = { channelId, available: all.map((c) => ({ id: c.id, name: c.name })) };
      // 值班引用了被删掉的通道 → 每轮都会失败，必须让人知道（节流兜住风暴）
      alertChannel({ level: 'none', code: 'NO_CHANNEL', detail: `${err.message}（值班指定的通道，可能是删除/停用后配置没跟着改）` });
      throw err;
    }
    channels = [pref, ...all.filter((c) => c.id !== channelId)];
  }

  const useTools = Array.isArray(tools) && tools.length > 0;

  // 2. 依次尝试每个通道（工具循环整体重跑，避免半途换通道导致上下文错乱）
  let lastError = null;
  const tried = [];
  for (const ch of channels) {
    try {
      tried.push(ch.name);
      const result = await runOnChannel(ch, messages, {
        maxTokens, temperature, timeoutMs,
        tools: useTools ? tools : null,
        toolRunner, maxRounds, onEvent,
      });
      console.log(`[models] ✓ 通道 ${ch.name} 应答成功${result.steps.length ? `（工具 ${result.steps.length} 次，${result.rounds} 轮）` : ""}`);
      return { ...result, channel: ch.name, model: ch.model };
    } catch (e) {
      lastError = e;
      // 429（限流）/ 503（暂时不可用）/ 超时 / 5xx（上游服务错误）→ 自动降级到下一通道。
      // 这是「故障隔离」的关键：某个通道挂了不影响用户对话。
      // ⚠️ 2026-10-23：5xx 原来不降级直接抛——实测 AMD Radeon 自部署口反复
      //   「500: 504 Gateway Timeout」（上游瞬时错），值班连着失败好几轮都没换通道。
      //   换通道对 5xx 是**有用**的（错误出自那台机器的负载，不是我们的请求），所以纳入降级。
      const transient =
        e.status === 429 || e.status === 503 ||
        e.code === "CHANNEL_TIMEOUT" ||
        (Number(e.status) >= 500 && Number(e.status) < 600);
      if (transient) {
        const why = e.code === "CHANNEL_TIMEOUT" ? `超时（${e.data?.timeoutMs ?? "?"}ms）` : `返回 ${e.status}`;
        console.warn(`[models] 通道 ${ch.name} ${why}，尝试降级到下一通道`);
        alertChannel({
          level: 'down', channel: ch.name, code: e.code || 'CHANNEL_FAILED',
          status: e.status ?? 'timeout', detail: redactText(e.message || e).slice(0, 400), tried: [...tried],
        });
        continue;
      }
      // 其他错误（400 参数错 / 401 key 无效）不降级，直接抛出——
      // 这类错误换通道也没用，且需要让用户看到原始原因。
      // 但「抛出」不等于「沉默」：进程内调用不经过 HTTP 错误中间件，
      // 不在这里报警，主人就永远收不到（本次修复的主因）。
      alertChannel({
        level: 'hard', channel: ch.name, code: e.code || 'UNKNOWN_ERROR',
        status: e.status ?? '-', detail: String(e.message || e).slice(0, 400), tried: [...tried],
      });
      throw e;
    }
  }

  // 3. 所有通道都失败
  alertChannel({
    level: 'all', code: lastError?.code || 'ALL_CHANNELS_FAILED',
    status: lastError?.status ?? '-', detail: String(lastError?.message || '未知'), tried,
  });
  const err = new Error("所有模型通道都不可用");
  err.code = "ALL_CHANNELS_FAILED";
  err.data = { lastError: lastError?.message, tried: channels.map((c) => c.name) };
  throw err;
}

/**
 * 在单个通道上跑完一轮（可能多轮的）工具调用循环
 * @private
 * @param {Object} ch - 通道配置
 * @param {Array} messages - 原始消息
 * @param {Object} opts - 见 chat()
 * @returns {Promise<{ text, usage, steps, rounds }>}
 */
async function runOnChannel(ch, messages, opts) {
  const { maxTokens, temperature, timeoutMs, tools, toolRunner, maxRounds, onEvent } = opts;
  const conversation = messages.map((m) => ({ ...m }));
  const steps = [];
  const usageTotal = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  for (let round = 1; round <= maxRounds; round++) {
    const res = await callChannel(ch, conversation, { maxTokens, temperature, timeoutMs, tools });
    if (res.usage) {
      usageTotal.prompt_tokens += res.usage.prompt_tokens || 0;
      usageTotal.completion_tokens += res.usage.completion_tokens || 0;
      usageTotal.total_tokens += res.usage.total_tokens || 0;
    }

    // 没有工具调用 → 就是最终回答
    if (!res.toolCalls.length) {
      return { text: res.text, usage: usageTotal, steps, rounds: round };
    }

    // 模型要调工具：必须把 assistant 的 tool_calls 原样带回去，
    // 否则下一轮 role:'tool' 消息找不到对应的 tool_call_id，OpenAI 兼容端会 400
    conversation.push({
      role: "assistant",
      content: res.text || "",
      tool_calls: res.toolCalls.map((tc) => ({
        id: tc.id,
        type: tc.type || "function",
        function: { name: tc.function?.name, arguments: tc.function?.arguments ?? "{}" },
      })),
    });

    // 本轮工具可能产出图像块（bili_frames 抽的真实画面），先收集，轮末统一附图
    const pendingImages = [];

    for (const tc of res.toolCalls) {
      const name = tc.function?.name || "";
      const rawArgs = tc.function?.arguments ?? "{}";
      let args = {};
      let parseError = null;
      try {
        args = typeof rawArgs === "string" ? JSON.parse(rawArgs || "{}") : rawArgs;
      } catch (e) {
        parseError = `参数不是合法 JSON：${redactText(e?.message || e)}`;
        args = { __raw: rawArgs };
      }

      onEvent?.({ type: "tool", round, tool: name, args, callId: tc.id });

      let content;
      let ok = true;
      if (parseError) {
        ok = false;
        content = JSON.stringify({ error: parseError, code: "TOOL_ARGS_INVALID" });
      } else if (typeof toolRunner !== "function") {
        ok = false;
        content = JSON.stringify({ error: "服务端未接入工具执行器", code: "TOOL_RUNNER_MISSING" });
      } else {
        try {
          const r = await toolRunner(name, args);
          // 工具可以返回 { ..., images: [dataURL...] }（bili_frames 就是这样把真实画面
          // 交给视觉模型的）。图像**不能**塞进 role:'tool' —— OpenAI 兼容协议里
          // 工具消息只允许文本，所以先收集，等本轮工具都回填完再单插一条 user 消息。
          if (r && typeof r === "object" && Array.isArray(r.images) && r.images.length) {
            pendingImages.push(...r.images.slice(0, 6));
            const { images, ...rest } = r;
            content = JSON.stringify({ ...rest, imagesAttached: images.length });
          } else {
            content = typeof r === "string" ? r : JSON.stringify(r);
          }
        } catch (e) {
          // 工具失败不能中断对话：把错误回填给模型，让它决定换个参数或换工具
          ok = false;
          content = JSON.stringify({
            error: redactText(e?.message || e),
            code: e?.code || "TOOL_EXECUTION_ERROR",
            ...(e?.data ? { data: e.data } : {}),
          });
        }
      }

      // 工具可能返回很大的 JSON（搜索结果/评论），截断避免撑爆上下文
      const limit = Number(process.env.CHAT_TOOL_RESULT_CHARS) || 8000;
      if (content.length > limit) {
        content = content.slice(0, limit) + `\n…（结果过长已截断，原长 ${content.length} 字符）`;
      }

      conversation.push({ role: "tool", tool_call_id: tc.id || `call_${round}`, content });

      const step = { round, tool: name, args, ok, preview: content.slice(0, 300) };
      steps.push(step);
      onEvent?.({ type: "tool_result", round, tool: name, ok, preview: step.preview });
    }

    // 本轮有图像 → 以 user 消息附图（role:'tool' 只能放文本，这是协议限制）
    if (pendingImages.length) {
      if (ch.vision === true) {
        conversation.push({
          role: "user",
          content: [
            {
              type: "text",
              text: `上面工具返回附带了 ${pendingImages.length} 张视频真实画面帧（按时间先后排列）。请结合画面内容判断，不要只看标题或字幕；只在确实看清的范围内描述。`,
            },
            ...pendingImages.map((u) => ({ type: "image_url", image_url: { url: u } })),
          ],
        });
        onEvent?.({ type: "images", round, count: pendingImages.length });
      } else {
        // 通道不吃图：说清「图看不到」，但别让模型以为完全没依据 ——
        // 工具已经在返回值里附了 visualSummary（每帧的亮度/主色/饱和度/暗部占比实测值），
        // 那是能用来做「色调级」判断的真数据。边界必须讲明白，否则它要么瞎编、要么放弃作答。
        conversation.push({
          role: "user",
          content:
            `注意：当前模型通道（${ch.name}）不支持图像输入，那 ${pendingImages.length} 张画面帧本身你看不到。\n` +
            `但工具返回值里有 visualSummary，是每帧的**像素实测统计**（亮度/主色/饱和度/对比度/暗部占比）。\n` +
            `用法边界：\n` +
            `· 可以说：整体偏暗还是偏亮、冷色还是暖色、是不是大面积死黑、像不像字幕板/夜景这类色调结论；\n` +
            `· 不能说：画面里是谁、在做什么、有没有某个具体物体 —— 这些必须真看到图，数据里没有。\n` +
            `作答时说明「看的是画面色调数据，不是画面图像」。`,
        });
      }
      pendingImages.length = 0;
    }
  }

  const err = new Error(`工具调用超过 ${maxRounds} 轮仍未收敛`);
  err.code = "TOOL_LOOP_EXCEEDED";
  err.data = { maxRounds, steps };
  throw err;
}

// ----------------------------------------------------------------
// 2. 通道健康检查
// ----------------------------------------------------------------

/**
 * 调一次最小请求验证通道是否可用（从旧版 models.mjs 迁移，逻辑不变）
 * @param {Object} ch - 通道配置 { name, baseURL, apiKey, model }
 * @param {number} [timeoutMs=20000] - 探测超时
 * @returns {Promise<{ ok: boolean, status?: number, ms: number, sample?: string, error?: string }>}
 */
export async function testChannel(ch, timeoutMs = 20000) {
  if (!ch.apiKey) return { ok: false, error: "没有填 API Key" };
  registerSecrets([ch.apiKey, ...urlSecrets(ch.baseURL)])
  const url = completionUrl(ch.baseURL)
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + ch.apiKey,
      },
      body: JSON.stringify({
        model: ch.model,
        messages: [{ role: "user", content: "只回复两个字：可用" }],
        max_tokens: 16,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const ms = Date.now() - t0;
    const text = await r.text();
    if (!r.ok) {
      let msg = text.slice(0, 300);
      try {
        const j = JSON.parse(text);
        msg = j?.error?.message || j?.message || j?.msg || msg;
      } catch {
        /* 保留原文 */
      }
      return { ok: false, status: r.status, ms, error: redactText(msg, [ch.apiKey]) };
    }
    let content = "";
    try {
      const j = JSON.parse(text);
      content = j?.choices?.[0]?.message?.content || "";
    } catch {
      /* 非 JSON */
    }
    return { ok: true, status: r.status, ms, sample: redactText(content, [ch.apiKey]).slice(0, 60) };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: redactText(e?.message || e) };
  }
}

// ----------------------------------------------------------------
// 3. 通道选择（供对话 / 面板使用）
// ----------------------------------------------------------------

/**
 * 按优先级找第一个可用的通道（从旧版 models.mjs 迁移，逻辑不变）
 * 依次探测，直到有一个通过；全都探测失败也返回第一个，让调用方拿到真实错误。
 * @returns {Promise<{ channel: Object, probe: Object }|null>} 无可用通道时返回 null
 */
export async function pickChannel() {
  const items = await getAvailableChannels();
  if (!items.length) return null;
  for (const ch of items) {
    const r = await testChannel(ch, 12000);
    if (r.ok) return { channel: ch, probe: r };
  }
  // 全都探测失败也返回第一个，让调用方拿到真实错误
  return { channel: items[0], probe: { ok: false, error: "全部通道测试失败" } };
}

export default { chat, pickChannel, testChannel };
