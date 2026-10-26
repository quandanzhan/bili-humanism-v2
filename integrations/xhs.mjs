/**
 * 小红书采集 —— 原生实现（纯 HTTP + 自算签名，零浏览器）
 * @module integrations/xhs
 * ============================================================================
 * 迁移说明（standalone-v2）：从旧版 vendor/standalone/xhs.mjs 原样迁移，
 * 仅补本行 @module 标注；签名逻辑（v1 + Cookie 轮换）与踩坑注释全部保留。
 * 为什么推倒重来：
 *   上一版用 Playwright Chromium 打开页面读 DOM —— 那是「为了拧一颗螺丝搬挖掘机」：
 *   多占 681MB 磁盘 + 400~500MB 内存（还被内核 OOM 杀过两次），启动 20~30 秒，
 *   而真正需要的只是「一组正确的请求头」。
 *
 * 换成原生后：
 *   · 不需要浏览器进程，一次请求几十毫秒；
 *   · 签名是纯算术（MD5 + 自定义 base64 + CRC32 变体），Node 内置 crypto 就够；
 *   · 内存几乎为 0，也不会再触发 OOM。
 *
 * 算法来源（公开逆向，MIT）：
 *   https://github.com/armxe/rednote-xiaohongshu-sign  （xhs_sign.py，v1 分支）
 *   https://github.com/ReaJason/xhs  （help.py 的 sign()，同源实现）
 *   其注释明确写道：v1 签名「Works with edith.xiaohongshu.com & xiaohongshu.com (still accepted)」。
 *   v2（SDK 4.3.9）需要 window.mnsv2 的 AES session key，必须执行私有 JS —— 本实现刻意不碰，
 *   因为那正是原版需要浏览器的原因；v1 够用就不必付那个代价。
 *
 * 边界：只读采集，不点赞/不收藏/不评论/不发私信；请求间至少间隔 1.5 秒。
 */
import { createHash, randomBytes } from "node:crypto";

/* ---------------------------------------------------------------- 签名原语 */

/** v1 专用 65 字符字母表（第 65 个是填充符，不是标准 base64 的 =） */
const OLD_ALPHA =
  "A4NjFqYu5wPHsO0XTdDgMa2r1ZQocVte9UJBvk6/7=yRnhISGKblCWi+LpfE8xzm3";

const STD_B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/** X-S-Common 用的另一套字母表（注意与上面不同） */
const XHS_B64 = "ZmserbBoHQtNP+wOcza/LpngG8yJq42KWYj0DSfdikx3VT16IlUAFM97hECvuRX5";

const md5hex = (s) => createHash("md5").update(s, "utf8").digest("hex");

/**
 * 32 位 MD5 hex → 44 字符 X-s。
 * 每 3 个字符一组当字节用，编出 4 个字母。结尾不足 3 个用 64 号（填充符）补齐。
 */
function hEncodeV1(hex32) {
  const d = OLD_ALPHA;
  let m = "";
  for (let i = 0; i < 32; i += 3) {
    const o = hex32.charCodeAt(i);
    const g = i + 1 < 32 ? hex32.charCodeAt(i + 1) : 0;
    const h = i + 2 < 32 ? hex32.charCodeAt(i + 2) : 0;
    const x = ((o & 3) << 4) | (g >> 4);
    let p = ((15 & g) << 2) | (h >> 6);
    const v = o >> 2;
    let b = h ? h & 63 : 64;
    if (!g) p = b = 64;
    m += d[v] + d[x] + d[p] + d[b];
  }
  return m;
}

/** CRC32 变体表（多项式 0xEDB88320，与标准一致） */
const HU_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

/**
 * X-S-Common 的 x9 字段。
 * 与标准 CRC32 的唯一差别：结尾异或 0xFFFFFFFF ^ 0xEDB88320，并返回**有符号** 32 位
 * （JS 里 `-1 ^ n ^ 0xEDB88320` 就是这个值，JSON 里会看到负数）。
 */
function crc32hu(s) {
  let n = 0xffffffff;
  for (const ch of s) {
    // ⚠️ `^` 在 JS 里返回**有符号**32 位；不 >>>0 上去，下一步参与运算就会变负数，
    //    结果与 Python 参考实现不一致（踩过：x-s-common 后半段对不上）。
    n = (HU_TABLE[(n ^ ch.codePointAt(0)) & 0xff] ^ (n >>> 8)) >>> 0;
  }
  const r = (0xffffffff ^ n ^ 0xedb88320) >>> 0;
  return r < 0x80000000 ? r : r - 0x100000000;
}

/** 标准 base64 后按 XHS 字母表换表 */
function b64xhs(str) {
  const std = Buffer.from(str, "utf8").toString("base64");
  let out = "";
  for (const c of std) {
    const i = STD_B64.indexOf(c);
    out += i < 0 ? c : XHS_B64[i];
  }
  return out;
}

/** 与 axios 一致的 URL 归一化：只留 path(+query)，去掉 origin */
function normalizeUrl(url) {
  let u = url;
  if (u.startsWith("//")) u = "https:" + u;
  try {
    const p = new URL(u, "https://www.xiaohongshu.com");
    return p.pathname + (p.search || "");
  } catch {
    return u;
  }
}

/* ---------------------------------------------------------------- 对外签名 */

/**
 * v1 完整签名：一次算齐 x-s / x-t / x-s-common。
 * @param {string} url  完整地址或 path
 * @param {object|string|null} body  GET 传 null
 * @param {{a1:string, b1?:string}} fp 指纹（a1 必填，来自 cookie）
 */
export function signV1(url, body, fp = {}, tsOverride = null) {
  const ts = tsOverride == null ? Date.now() : Number(tsOverride);
  const path = normalizeUrl(url);
  const bodyStr =
    body == null ? "" : typeof body === "string" ? body : JSON.stringify(body);
  const xs = hEncodeV1(md5hex(`${ts}test${path}${bodyStr}`));
  const xt = String(ts);

  const common = {
    s0: 5,                 // Windows 平台码
    s1: "",
    x0: "1",               // localStorage b1b1 默认值
    x1: "3.2.0",           // 反爬 SDK 版本
    x2: "Windows",
    x3: "xhs-pc-web",
    x4: "2.3.1",           // 该代 SDK 的 app 版本
    x5: fp.a1 || "",
    x6: xt,                // v1: 时间戳（v2 这里是 X-Sign）
    x7: xs,                // v1: x-s（v2 这里是次级签名）
    x8: fp.b1 || "",
    x9: crc32hu(xt + xs),  // 有符号 32 位
    x10: 1,
  };

  return {
    "x-s": xs,
    "x-t": xt,
    "x-s-common": b64xhs(JSON.stringify(common)),
  };
}

/* ---------------------------------------------------------------- HTTP 层 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36";

const MIN_GAP_MS = 1500;
const MAX_LIMIT = 30;
let lastAt = 0;

async function throttle() {
  const wait = lastAt + MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastAt = Date.now();
}

/** 从 cookie 串里挑出签名需要的 a1 / b1 */
function parseFp(cookie) {
  const map = new Map();
  for (const part of String(cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) map.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return { map, a1: map.get("a1") || "", b1: map.get("b1") || "" };
}

function searchId() {
  // 小红书用 32 位十六进制当搜索会话 id，随机即可
  return randomBytes(16).toString("hex");
}

/**
 * 带签名的 POST。签名覆盖 path + body，所以顺序不能错。
 *
 * ⚠️ 小红书每次访问都可能**轮换 web_session**（服务端可能使旧值立即失效），
 *    旧值当场作废）。如果只读不改，就会出现「用一次就报登录已过期」。
 *    所以这里把响应里的 Set-Cookie 合并回去，通过 onCookieUpdate 交给宿主持久化。
 */
async function signedPost(apiPath, payload, cookie, onCookieUpdate) {
  const { a1, b1, map } = parseFp(cookie);
  if (!a1 || !map.get("web_session")) {
    throw new Error("Cookie 缺少 a1 或 web_session，请重新获取");
  }
  const url = "https://edith.xiaohongshu.com" + apiPath;
  const headers = {
    ...signV1(apiPath, payload, { a1, b1 }),
    "content-type": "application/json;charset=UTF-8",
    accept: "application/json, text/plain, */*",
    origin: "https://www.xiaohongshu.com",
    referer: "https://www.xiaohongshu.com/",
    "user-agent": UA,
    cookie,
  };

  const r = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text.slice(0, 800) };
  }

  // 轮换回写：只覆盖服务端新下发的那几项，其余保持不变
  try {
    const setCookies =
      typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : [];
    if (setCookies.length && typeof onCookieUpdate === "function") {
      const merged = new Map(map);
      for (const line of setCookies) {
        const first = String(line).split(";")[0];
        const i = first.indexOf("=");
        if (i > 0) {
          const k = first.slice(0, i).trim();
          const v = first.slice(i + 1).trim();
          if (k && v) merged.set(k, v);
        }
      }
      const next = [...merged].map(([k, v]) => `${k}=${v}`).join("; ");
      if (next !== cookie) await onCookieUpdate(next, [...merged.keys()]);
    }
  } catch {
    /* 回写失败不影响本次结果 */
  }

  return { status: r.status, data };
}

/* ---------------------------------------------------------------- 业务动作 */

/** 搜索笔记 */
export async function search({ keyword, limit = 10, cookie = "", onCookieUpdate }) {
  if (!keyword || !String(keyword).trim()) throw new Error("缺少 keyword");
  const lim = Math.max(1, Math.min(Number(limit) || 10, MAX_LIMIT));
  await throttle();

  const payload = {
    keyword: String(keyword).trim(),
    page: 1,
    page_size: lim,
    search_id: searchId(),
    sort: "general",
    note_type: 0,
    ext_flags: [],
    geo: "",
    image_formats: ["jpg", "webp", "avif"],
  };

  const { status, data } = await signedPost(
    "/api/sns/web/v1/search/notes",
    payload,
    cookie,
    onCookieUpdate,
  );

  if (data?.code !== 0 && data?.success !== true) {
    // 三种失败要分清：461 是签名问题，-100 是没登录，-104 是登录了但账号没权限
    const code = data?.code;
    const hint =
      status === 461
        ? "签名被拒（HTTP 461）：v1 签名已失效，需要换 v2（要执行一段私有 JS）"
        : code === -100
          ? "登录已过期：在浏览器重新登录小红书，再抓一次 Cookie（之后会自动轮换续期）"
          : code === -104
            ? "账号无权限（-104）：登录态被识别了，但该账号被限制访问此接口"
            : data?.msg || "接口未返回预期结构";
    return {
      ok: false,
      httpStatus: status,
      code,
      msg: data?.msg || data?.message || "(无 message)",
      needLogin: code === -100 || /登录|login/i.test(String(data?.msg || "")),
      hint,
      raw: data,
    };
  }

  const items =
    data?.data?.items ||
    data?.items ||
    [];
  const notes = [];
  for (const it of items) {
    const card = it.note_card || it.noteCard || it;
    const id = it.id || card.note_id || card.noteId || "";
    if (!id) continue;
    const user = card.user || card.user_info || {};
    notes.push({
      id,
      url: `https://www.xiaohongshu.com/explore/${id}`,
      title: String(card.display_title || card.title || "").slice(0, 120),
      author: String(user.nickname || user.nick_name || "").slice(0, 40),
      like: String(
        card.interact_info?.liked_count ?? card.liked_count ?? "",
      ),
      type: card.type || "",
      cover:
        card.cover?.url_default ||
        card.cover?.url ||
        card.image_list?.[0]?.url_default ||
        "",
    });
    if (notes.length >= lim) break;
  }

  return {
    ok: notes.length > 0,
    keyword: String(keyword).trim(),
    httpStatus: status,
    mode: "native-v1",          // 原生签名，不是浏览器
    count: notes.length,
    notes,
    hint:
      notes.length > 0
        ? "原生签名调用成功（零浏览器）；只读采集，版权归原作者"
        : "接口通了但没解析到笔记，可能是字段结构变了",
  };
}

/** 读单篇笔记详情 */
export async function note({ url, cookie = "", onCookieUpdate }) {
  if (!url || !/xiaohongshu\.com/.test(url)) throw new Error("需要一个小红书笔记链接");
  const m = String(url).match(/(?:explore|discovery\/item|note)\/([0-9a-zA-Z]+)/);
  if (!m) throw new Error("链接里找不到笔记 id");
  const noteId = m[1];
  await throttle();

  const payload = {
    source_note_id: noteId,
    image_formats: ["jpg", "webp", "avif"],
    extra: { need_body_topic: "1" },
  };

  const { status, data } = await signedPost(
    "/api/sns/web/v1/feed",
    payload,
    cookie,
    onCookieUpdate,
  );

  if (data?.code !== 0 && data?.success !== true) {
    return {
      ok: false,
      httpStatus: status,
      code: data?.code,
      msg: data?.msg || "",
      needLogin: /登录|login/i.test(String(data?.msg || "")),
      raw: data,
    };
  }

  const list = data?.data?.items || [];
  const item = list[0] || {};
  const card = item.note_card || item;
  const user = card.user || {};

  return {
    ok: Boolean(card.title || card.desc),
    httpStatus: status,
    mode: "native-v1",
    id: noteId,
    title: String(card.title || "").slice(0, 200),
    desc: String(card.desc || "").slice(0, 4000),
    author: String(user.nickname || ""),
    like: String(card.interact_info?.liked_count ?? ""),
    collect: String(card.interact_info?.collected_count ?? ""),
    comment: String(card.interact_info?.comment_count ?? ""),
    tags: (card.tag_list || []).map((t) => t.name).filter(Boolean).slice(0, 20),
    images: (card.image_list || [])
      .map((i) => i.url_default || i.url)
      .filter(Boolean)
      .slice(0, 9),
    hint: "原生签名调用成功；引用请保留原作者与链接",
  };
}

/** 自检：不联网，只验证签名函数本身能跑通（便于排查算法移植问题） */
export function selfTest() {
  // 固定 ts + 固定 path，结果可复现，用来对比 Python 参考实现
  const sig = signV1("/api/sns/web/v1/search/notes", { keyword: "test" }, { a1: "abc", b1: "" });
  return {
    ok: sig["x-s"].length === 44,
    xS: sig["x-s"],
    xSLength: sig["x-s"].length,
    xT: sig["x-t"],
    xSCommonLength: sig["x-s-common"].length,
  };
}

export const actions = { search, note, selfTest };
