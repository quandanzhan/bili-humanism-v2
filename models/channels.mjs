import { DATA_DIR, safeUrl, restoreUrl, registerSecrets, urlSecrets } from '../gateway/runtime.mjs'
/**
 * AI 模型通道配置管理（从旧版 vendor/standalone/models.mjs 迁移）
 * ============================================================================
 * @module models/channels
 * @description 这是「给对话用的大模型入口」的通道配置层，只管增删改查，
 *              不做任何网络调用。调用与降级逻辑见 ./router.mjs / ./fallback.mjs。
 * 每个通道 = 一个 OpenAI 兼容端点 + 一个 token：
 *   { name, baseURL, apiKey, model, priority, enabled }
 *
 * · priority 由用户自己定，数字越小越优先
 * · 对话时按优先级依次尝试，第一个通的就用（429/超时自动降级到下一个）
 * · apiKey 从不出现在 GET 响应里（统一打码成 ***），PUT 收到 *** 视为「不修改」
 *
 * 存储：data/models.json（支持 BILI_HUMANISM_DATA / BILI_HUMANISM_MODELS 覆盖）
 * @exports {Function} load - 加载配置
 * @exports {Function} save - 保存配置
 * @exports {Function} list - 按优先级排序返回通道列表
 * @exports {Function} masked - 给前端看的版本（key 打码）
 * @exports {Function} add - 添加通道
 * @exports {Function} update - 更新通道
 * @exports {Function} remove - 删除通道
 * @exports {Function} setAuto - 设置自动模式
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

const FILE = process.env.BILI_HUMANISM_MODELS || join(DATA_DIR, 'models.json');

const DEFAULT_DATA = { auto: true, channels: [] };

/** 确保配置文件所在目录存在 */
function ensureDir() {
  try {
    mkdirSync(dirname(FILE), { recursive: true });
  } catch {
    /* 已存在 */
  }
}

/**
 * 加载通道配置（文件缺失或损坏时回退到默认空配置）
 * @returns {{ auto: boolean, channels: Array }} 配置对象
 */
export function load() {
  ensureDir();
  if (!existsSync(FILE)) {
    save(DEFAULT_DATA);
    return JSON.parse(JSON.stringify(DEFAULT_DATA));
  }
  try {
    const d = JSON.parse(readFileSync(FILE, "utf8"));
    if (!Array.isArray(d.channels)) throw new Error("bad");
    registerSecrets(d.channels.flatMap((c) => [c.apiKey, ...urlSecrets(c.baseURL)]));
    return d;
  } catch {
    save(DEFAULT_DATA);
    return JSON.parse(JSON.stringify(DEFAULT_DATA));
  }
}

/**
 * 保存通道配置
 * @param {{ auto: boolean, channels: Array }} data - 配置对象
 * @returns {Object} 原样返回 data，便于链式使用
 */
export function save(data) {
  ensureDir();
  writeFileSync(FILE, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 })
  return data;
}

/**
 * 按优先级升序列出所有通道（priority 小的在前，同优先级按名称排）
 * @returns {Array} 通道列表（含真实 apiKey，仅供服务端内部使用）
 */
export function list() {
  return [...load().channels].sort(
    (a, b) => (a.priority ?? 99) - (b.priority ?? 99) || String(a.name).localeCompare(String(b.name)),
  );
}

/**
 * 给前端看的版本：key 打码，绝不在 GET 响应里泄露真实 apiKey
 * @returns {{ auto: boolean, file: string, channels: Array }} 打码后的配置
 */
export function masked() {
  const d = load();
  return {
    auto: d.auto,
    file: FILE,
    channels: list().map((c) => ({
      id: c.id,
      name: c.name,
      baseURL: safeUrl(c.baseURL),
      model: c.model,
      priority: c.priority,
      enabled: c.enabled !== false,
      apiKey: c.apiKey ? "***" : "",
      hasKey: Boolean(c.apiKey),
      // vision：通道是否支持图像输入（bili_frames 抽的真实画面要靠它）
      vision: c.vision === true,
      note: c.note || "",
    })),
  };
}

/**
 * 校验并规范化 Base URL（去掉末尾斜杠，必须 http/https 开头）
 * @param {string} base - 原始 Base URL
 * @returns {string} 规范化后的 Base URL
 */
function checkBase(base) {
  const b = String(base || "").trim().replace(/\/$/, "");
  if (!b) throw Object.assign(new Error("Base URL 不能为空"), { code: "BAD_BASE" });
  if (!/^https?:\/\//i.test(b)) {
    throw Object.assign(new Error("Base URL 必须以 http:// 或 https:// 开头"), { code: "BAD_BASE" });
  }
  return b;
}

/**
 * 添加通道
 * @param {Object} config - { name, baseURL, apiKey?, model, priority?, note? }
 * @returns {Object} 新通道（apiKey 已打码）
 * @throws {Error} code BAD_BASE / BAD_MODEL / DUP
 */
export function add({ name, baseURL, apiKey = "", model = "", priority, note = "", vision = false }) {
  const d = load();
  const base = checkBase(baseURL);
  if (!String(model || "").trim()) {
    throw Object.assign(new Error("模型 ID 不能为空（如 DeepSeek-V4-Flash）"), { code: "BAD_MODEL" });
  }
  if (d.channels.some((x) => x.baseURL === base && x.model === String(model).trim())) {
    throw Object.assign(new Error("这个 Base URL + 模型已经加过了"), { code: "DUP" });
  }
  const maxPrio = d.channels.reduce((m, x) => Math.max(m, Number(x.priority) || 0), 0);
  const item = {
    id: "ch_" + randomBytes(4).toString("hex"),
    name: String(name || model).slice(0, 40),
    baseURL: base,
    apiKey: String(apiKey || ""),
    model: String(model).trim().slice(0, 120),
    priority:
      Number.isFinite(Number(priority)) && priority !== "" && priority !== undefined
        ? Math.trunc(Number(priority))
        : maxPrio + 10,
    enabled: true,
    vision: vision === true,
    note: String(note || "").slice(0, 160),
  };
  d.channels.push(item);
  save(d);
  registerSecrets([item.apiKey, ...urlSecrets(item.baseURL)]);
  return { ...item, baseURL: safeUrl(item.baseURL), apiKey: item.apiKey ? "***" : "" };
}

/**
 * 更新通道（只改传入的字段）
 * @param {string} id - 通道 ID
 * @param {Object} patch - 要修改的字段；apiKey 传 *** 或空串表示保持原值
 * @returns {Object|null} 更新后的通道（apiKey 打码）；id 不存在时返回 null
 * @throws {Error} code BAD_BASE
 */
export function update(id, patch = {}) {
  const d = load();
  const c = d.channels.find((x) => x.id === id);
  if (!c) return null;
  if (patch.name !== undefined) c.name = String(patch.name).slice(0, 40);
  if (patch.note !== undefined) c.note = String(patch.note).slice(0, 160);
  if (patch.priority !== undefined) {
    const n = Number(patch.priority);
    if (Number.isFinite(n)) c.priority = Math.trunc(n);
  }
  if (patch.enabled !== undefined) c.enabled = Boolean(patch.enabled);
  // vision：这个通道能不能吃图像（多模态）。只影响 bili_frames 抽帧后是否附图。
  if (patch.vision !== undefined) c.vision = Boolean(patch.vision);
  if (patch.baseURL !== undefined) c.baseURL = checkBase(restoreUrl(patch.baseURL, c.baseURL));
  if (patch.model !== undefined && String(patch.model).trim()) c.model = String(patch.model).trim().slice(0, 120);
  // apiKey：传 *** 或空字符串表示保持原值；只有明确的新值才覆盖
  if (patch.apiKey !== undefined && patch.apiKey !== "***" && String(patch.apiKey).trim()) {
    c.apiKey = String(patch.apiKey).trim();
  }
  save(d);
  registerSecrets([c.apiKey, ...urlSecrets(c.baseURL)]);
  return { ...c, baseURL: safeUrl(c.baseURL), apiKey: c.apiKey ? "***" : "" };
}

/**
 * 删除通道
 * @param {string} id - 通道 ID
 * @returns {boolean} 是否真的删掉了
 */
export function remove(id) {
  const d = load();
  const before = d.channels.length;
  d.channels = d.channels.filter((x) => x.id !== id);
  save(d);
  return d.channels.length !== before;
}

/**
 * 设置自动模式（auto=true 时对话按优先级自动挑选 / 降级通道）
 * @param {boolean} auto - 是否自动
 * @returns {boolean} 设置后的值
 */
export function setAuto(auto) {
  const d = load();
  d.auto = Boolean(auto);
  save(d);
  return d.auto;
}

/** 配置文件路径（供诊断 / 展示用） */
export const FILE_PATH = FILE;
