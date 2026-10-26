/**
 * 浏览器资源池 —— 内置浏览器（Playwright Chromium / headless）
 * @module integrations/browser-pool
 * ============================================================================
 * 迁移说明（standalone-v2）：从旧版 vendor/standalone/browser.mjs 原样迁移，
 * 仅改模块名；惰性启动、90s 空闲回收、小内存启动参数全部保留。
 * 设计要点（对应「参考 Codex 的内置浏览器，不额外装浏览器」）：
 *   1. **随服务自带**：chromium 由 playwright 下载到 ~/.cache/ms-playwright，
 *      不需要用户另装 Chrome、也不需要 selenium 容器。
 *   2. **惰性启动 + 复用**：第一次调用才起浏览器，之后复用同一个 browser，
 *      空闲 IDLE_MS 自动关闭 —— 3.6G 内存的机器上不能让它常驻吃 300MB。
 *   3. **单页串行**：一个小机器上跑并发页面只会互相拖死，这里用互斥锁排队。
 *   4. **等渲染完再取内容**：B站是 SPA，domcontentloaded 时 title/body 都是空的，
 *      所以默认 load + 短等，且 text/html 取不到时自动多等一轮。
 *
 * 安全：不执行外部传入的任意 shell；eval 仅限页面上下文且可关闭。
 */
import { chromium } from "playwright";

const IDLE_MS = Number(process.env.BROWSER_IDLE_MS || 90_000);      // 空闲多久关浏览器
const NAV_TIMEOUT = Number(process.env.BROWSER_NAV_TIMEOUT || 45_000);
const MAX_TEXT = Number(process.env.BROWSER_MAX_TEXT || 60_000);    // 正文截断上限
const ALLOW_EVAL = process.env.BROWSER_ALLOW_EVAL !== "false";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36";

let browser = null;
let context = null;
let idleTimer = null;
let queue = Promise.resolve();   // 串行化：一次只跑一个动作

function touchIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    close().catch(() => {});
  }, IDLE_MS);
  idleTimer.unref?.();
}

async function ensureBrowser() {
  if (browser && browser.isConnected()) return browser;
  browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-setuid-sandbox",
      "--no-zygote",
      "--disable-blink-features=AutomationControlled",
      // ↓ 小内存机器必须压的几项（3.6G 总内存，曾被 512M 限额 OOM 杀过一次）
      "--renderer-process-limit=1",     // 只允许一个渲染进程
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--disable-features=Translate,BackForwardCache,AcceptCHFrame",
      "--js-flags=--max-old-space-size=256",
      "--disk-cache-size=33554432",     // 32M 磁盘缓存，别让它膨胀
      "--media-cache-size=8388608",
    ],
  });
  context = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1440, height: 900 },
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    extraHTTPHeaders: { "accept-language": "zh-CN,zh;q=0.9" },
  });
  return browser;
}

async function withPage(fn) {
  const run = async () => {
    const b = await ensureBrowser();
    const page = await context.newPage();
    try {
      return await fn(page);
    } finally {
      await page.close().catch(() => {});
      touchIdle();
    }
  };
  // 串行排队，避免并发页面把内存打爆
  const next = queue.then(run, run);
  queue = next.catch(() => {});
  return next;
}

/**
 * 用一个**独立的 context**（可注入 Cookie）执行任务，完成后关掉该 context。
 *
 * 为什么不是直接复用共享 context：登录态 Cookie 是域级、跨页面的，
 * 注入到共享 context 会污染所有其它调用（比如你随手取个网页也被当成登录用户）。
 * 独立 context 只多几百 KB，浏览器进程仍然是同一个。
 */
export async function withContext(cookies, fn) {
  const run = async () => {
    const b = await ensureBrowser();
    const c = await b.newContext({
      userAgent: UA,
      viewport: { width: 1440, height: 900 },
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
      extraHTTPHeaders: { "accept-language": "zh-CN,zh;q=0.9" },
    });
    if (Array.isArray(cookies) && cookies.length) {
      await c.addCookies(cookies).catch(() => {});
    }
    const page = await c.newPage();
    try {
      return await fn(page, c);
    } finally {
      await page.close().catch(() => {});
      await c.close().catch(() => {});
      touchIdle();
    }
  };
  const next = queue.then(run, run);
  queue = next.catch(() => {});
  return next;
}

/** 把 "a=1; b=2" 这种浏览器里复制的 cookie 串转成 Playwright 需要的结构。 */
export function parseCookieString(raw, domain) {
  if (!raw || typeof raw !== "string") return [];
  return raw
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const i = pair.indexOf("=");
      if (i <= 0) return null;
      return {
        name: pair.slice(0, i).trim(),
        value: pair.slice(i + 1).trim(),
        domain,
        path: "/",
        secure: true,
      };
    })
    .filter(Boolean);
}

/** 打开页面并尽量等到有内容（SPA 友好）。 */
async function open(page, url, waitMs = 2500) {
  const resp = await page.goto(url, { waitUntil: "load", timeout: NAV_TIMEOUT }).catch(async (e) => {
    // load 超时也继续：很多页面长连接挂住，但 DOM 已经可用
    if (!/Timeout/i.test(String(e?.message))) throw e;
    return null;
  });
  if (waitMs > 0) await page.waitForTimeout(waitMs);
  return resp;
}

async function readBody(page) {
  // title / body 可能晚于 load，给一次补等
  for (let i = 0; i < 3; i++) {
    const info = await page.evaluate(() => ({
      title: document.title || "",
      text: (document.body && document.body.innerText) || "",
      href: location.href,
    }));
    if (info.title || info.text.length > 40) return info;
    await page.waitForTimeout(1200);
  }
  return page.evaluate(() => ({
    title: document.title || "",
    text: (document.body && document.body.innerText) || "",
    href: location.href,
  }));
}

export const actions = {
  /** 打开页面，返回标题 + 正文（默认动作） */
  async text({ url, waitMs, maxChars }) {
    return withPage(async (page) => {
      const resp = await open(page, url, waitMs);
      const info = await readBody(page);
      const limit = Math.min(Number(maxChars) || MAX_TEXT, MAX_TEXT);
      return {
        ok: true,
        url: info.href,
        status: resp ? resp.status() : null,
        title: info.title,
        textLength: info.text.length,
        truncated: info.text.length > limit,
        text: info.text.slice(0, limit),
      };
    });
  },

  /** 截图（base64；可直接给视觉模型） */
  async screenshot({ url, waitMs, fullPage = true, width, height }) {
    return withPage(async (page) => {
      if (width || height) {
        await page.setViewportSize({
          width: Number(width) || 1440,
          height: Number(height) || 900,
        });
      }
      const resp = url ? await open(page, url, waitMs) : null;
      const buf = await page.screenshot({ fullPage: Boolean(fullPage), type: "png" });
      return {
        ok: true,
        url: page.url(),
        status: resp ? resp.status() : null,
        title: await page.title(),
        format: "png",
        bytes: buf.length,
        base64: buf.toString("base64"),
      };
    });
  },

  /** 原始 HTML（排查结构用，体积大，默认截断） */
  async html({ url, waitMs, maxChars = 200_000 }) {
    return withPage(async (page) => {
      const resp = await open(page, url, waitMs);
      const content = await page.content();
      return {
        ok: true,
        url: page.url(),
        status: resp ? resp.status() : null,
        title: await page.title(),
        length: content.length,
        truncated: content.length > maxChars,
        html: content.slice(0, maxChars),
      };
    });
  },

  /** 取页面里所有链接（导航/找入口用） */
  async links({ url, waitMs, max = 200 }) {
    return withPage(async (page) => {
      await open(page, url, waitMs);
      const items = await page.evaluate((lim) => {
        const seen = new Set();
        const out = [];
        for (const a of document.querySelectorAll("a[href]")) {
          const href = a.href;
          const text = (a.innerText || a.title || "").trim().slice(0, 80);
          if (!href || seen.has(href)) continue;
          seen.add(href);
          out.push({ href, text });
          if (out.length >= lim) break;
        }
        return out;
      }, Number(max) || 200);
      return { ok: true, url: page.url(), count: items.length, links: items };
    });
  },

  /** 页面内求值（默认开启，可用 BROWSER_ALLOW_EVAL=false 关闭） */
  async eval({ url, waitMs, script }) {
    if (!ALLOW_EVAL) throw new Error("eval 已被禁用（BROWSER_ALLOW_EVAL=false）");
    if (!script || typeof script !== "string") throw new Error("缺少 script");
    return withPage(async (page) => {
      await open(page, url, waitMs);
      const value = await page.evaluate(script);
      return { ok: true, url: page.url(), value };
    });
  },

  /** 健康检查：顺便告诉你浏览器在不在 */
  async status() {
    return {
      ok: true,
      running: Boolean(browser && browser.isConnected()),
      idleMs: IDLE_MS,
      navTimeout: NAV_TIMEOUT,
      evalAllowed: ALLOW_EVAL,
    };
  },
};

export async function close() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  const b = browser;
  browser = null;
  context = null;
  if (b) await b.close().catch(() => {});
}

process.on("exit", () => {
  close().catch(() => {});
});
