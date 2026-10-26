/**
 * 插件注册表 + 汉化字典
 * @module integrations/registry
 * ============================================================================
 * 迁移说明（standalone-v2）：从旧版 vendor/standalone/plugins.mjs 原样迁移，
 * 仅补本行 @module 标注；PLUGINS / TOOL_I18N / BROWSER_ACTIONS /
 * pluginById / localizeTool 全部原样保留。
 * 设计目标：**加一个插件 = 往 PLUGINS 里加一条对象**，前端自动渲染，不用改 UI 代码。
 *
 * 三种 kind：
 *   builtin-tool     —— 宿主自身注册的工具集（按 prefix 从 ctx.tools 里挑）
 *   builtin-browser  —— 内置 Chromium 的动作
 *   adapter          —— 外部社交平台适配器（QQ / 小红书 …），只有配置项与占位动作，
 *                       真正接入时把它替换成 builtin-tool 或加 routes 即可
 *
 * 安全性：adapter 的 secret 字段在 GET /api/plugins 里一律打码，只有 PUT 才接收真值。
 */

export const PARAM_I18N = {
  action: "操作",
  readingId: "阅读 ID",
  journalId: "信笺 ID",
  sentence: "摘句",
  url: "链接地址",
  json: "信笺内容（JSON）",
  count: "数量",
  page: "页码",
  cursor: "游标",
  id: "ID",
  body: "内容",
  mode: "模式",
  input: "输入",
  model: "模型",
  script: "脚本",
  maxChars: "最大字数",
  waitMs: "等待毫秒",
  fullPage: "整页截图",
  width: "宽",
  height: "高",
  max: "上限",
};

export const ACTION_I18N = {
  read: "读取",
  list: "列表",
  delete: "删除",
  correct: "修正",
  export: "导出",
  select: "选定摘句",
  write: "写入",
  revise: "修订",
};

export const TOOL_I18N = {
  bili_humanism_guide: {
    label: "阅读指南",
    desc: "生成信笺前先读这份人文阅读与证据写作指南",
    hint: "无参数，直接调用即可",
  },
  bili_humanism_read: {
    label: "读取视频",
    desc: "按 BV 号或链接读取 B站内容，返回可引用的证据材料",
    hint: "填 BV 号或视频链接；会受单轮预算限制",
  },
  bili_humanism_source: {
    label: "读取来源片段",
    desc: "对已读取的内容按页翻阅原始片段，便于引用具体时间点",
    hint: "需要先「读取视频」拿到阅读 ID",
  },
  bili_humanism_candidates: {
    label: "候选视频",
    desc: "拉取最多 3 条公开热门候选，作为本轮可选素材",
    hint: "只读，不会自动选中",
  },
  bili_humanism_status: {
    label: "运行状态",
    desc: "查看暂停状态、任务用量、已读 ID 与可用性",
    hint: "排查问题的第一站",
  },
  bili_humanism_cancel: {
    label: "取消任务",
    desc: "按任务 ID 取消正在进行的读取",
    hint: "已取消的任务不会产生半截手账",
  },
  bili_humanism_journal: {
    label: "写信笺",
    desc: "针对值得记录的阅读写一篇可复查的私人手账",
    hint: "需要阅读 ID + 结构化 JSON（见参数模板）",
  },
  bili_humanism_inbox: {
    label: "手账收件箱",
    desc: "完整读取本地手账，支持分页与大收件箱索引",
    hint: "只读",
  },
  bili_humanism_memory: {
    label: "记忆管理",
    desc: "查看、修正或删除 AI 自己的记忆条目",
    hint: "action 选 list / delete / correct",
  },
  bili_humanism_import: {
    label: "导入外部文本",
    desc: "把宿主产出的 ASR 或画面文字挂到某次阅读上",
    hint: "用于字幕缺失时的补材",
  },
  bili_humanism_personality: {
    label: "人格札记",
    desc: "读取或选定写进 human-world.md 的摘句",
    hint: "action 选 read（读）/ select（选定一句）",
  },
};

/** 浏览器动作汉化 */
export const BROWSER_ACTIONS = {
  text: { label: "取正文", desc: "打开页面并抽取可见正文与标题" },
  screenshot: { label: "截图", desc: "整页或视口截图，返回 PNG" },
  html: { label: "取 HTML", desc: "原始 DOM，排查结构用" },
  links: { label: "取链接", desc: "列出页面所有链接" },
  eval: { label: "执行脚本", desc: "在页面上下文里求值（可在设置中关闭）" },
  status: { label: "浏览器状态", desc: "是否已启动、超时与回收参数" },
};

/**
 * 插件清单
 * ---------------------------------------------------------------------------
 * 加新插件：复制一个对象改 id/name/desc 即可。
 * adapter 类的 config 字段会渲染成设置表单，PUT /api/plugins/<id> 写入。
 */
export const PLUGINS = [
  {
    id: "humanism",
    name: "B站人文学习",
    icon: "📖",
    group: "内容",
    kind: "builtin-tool",
    prefix: "bili_humanism_",
    desc: "读 B站视频、写信笺手账、积累可修正的人格札记。上游 MIT 项目自编译版。",
    source: "github.com/InariNGT-Ofiicial/dsh-bili-humanism",
  },
  {
    id: "browser",
    name: "内置浏览器",
    icon: "🌐",
    group: "工具",
    kind: "builtin-browser",
    desc: "随服务自带的 headless Chromium。API 被风控挡住时，浏览器仍能拿到页面内容。",
    source: "Playwright + Chromium 156",
  },
  {
    id: "video",
    name: "视频解析",
    icon: "🎬",
    group: "内容",
    kind: "proxy",
    desc: "本地 7863 视频解析服务：视频信息、字幕（含串轨防御）、评论、弹幕。",
    baseEnv: "VIDEO_SERVICE_BASE",
    baseDefault: "http://127.0.0.1:7863",
    actions: [
      { id: "info", label: "视频信息", method: "GET", path: "/info", fields: ["bvid"] },
      { id: "subtitles", label: "字幕", method: "GET", path: "/subtitles", fields: ["bvid"] },
      { id: "comments", label: "评论", method: "GET", path: "/comments", fields: ["bvid"] },
      { id: "danmaku", label: "弹幕", method: "GET", path: "/danmaku", fields: ["bvid"] },
    ],
  },
  {
    id: "qq",
    name: "QQ",
    icon: "💬",
    group: "社交",
    kind: "adapter",
    status: "unconfigured",
    desc: "通过 OneBot / NapCat 网关收发 QQ 消息。填好网关地址并启用后，可作为对话渠道。",
    config: [
      { key: "endpoint", label: "网关地址", type: "text", placeholder: "http://127.0.0.1:3000", help: "OneBot v11 HTTP 地址" },
      { key: "token", label: "访问令牌", type: "password", placeholder: "可留空", secret: true },
      { key: "targetGroups", label: "允许的群号", type: "text", placeholder: "逗号分隔，留空=不启用群聊" },
      { key: "enabled", label: "启用", type: "boolean", default: false },
    ],
    actions: [{ id: "probe", label: "连通性测试", method: "POST", path: "/api/plugins/qq/probe", fields: [] }],
    note: "需要先自行部署 OneBot 网关；本面板只负责配置与探活，不会代替你登录。",
  },
  {
    id: "xhs",
    name: "小红书",
    icon: "📕",
    group: "社交",
    kind: "adapter",
    handler: "xhs",
    status: "unconfigured",
    desc: "只读采集小红书笔记：用内置 Chromium 读页面 DOM，绕开 x-s 签名问题。",
    config: [
      {
        key: "cookie",
        label: "登录 Cookie",
        type: "password",
        placeholder: "a1=...; web_session=...;",
        secret: true,
        help: "浏览器登录小红书 → 开发者工具 → Network 任意请求 → 复制 Cookie 整串。不填多半会撞登录墙。",
      },
      { key: "defaultLimit", label: "默认条数", type: "number", default: 10, help: "单次最多 30 条" },
      { key: "enabled", label: "启用", type: "boolean", default: false },
    ],
    actions: [
      { id: "search", label: "搜索笔记", method: "GET", fields: ["keyword", "limit"] },
      { id: "note", label: "读笔记正文", method: "POST", fields: ["url"] },
    ],
    note: "只读：不点赞/不收藏/不评论/不发私信；请求间隔 ≥3 秒、单次上限 30 条。内容版权归原作者，转载商用需授权。",
  },
  {
    id: "webhook",
    name: "通用 Webhook",
    icon: "🔗",
    group: "社交",
    kind: "adapter",
    status: "unconfigured",
    desc: "把工具调用结果 POST 到任意地址，用于接自建机器人 / 企业微信 / 飞书等。",
    config: [
      { key: "url", label: "回调地址", type: "text", placeholder: "https://example.com/hook" },
      { key: "secret", label: "签名密钥", type: "password", secret: true },
      { key: "enabled", label: "启用", type: "boolean", default: false },
    ],
    actions: [{ id: "test", label: "发送测试", method: "POST", path: "/api/plugins/webhook/test", fields: [] }],
    note: "最省事的接法：别的平台要什么字段，就在回调里拼。",
  },
];

export function pluginById(id) {
  return PLUGINS.find((p) => p.id === id) || null;
}

/** 给工具补齐中文名与说明；没有映射的保留原名。 */
export function localizeTool(tool) {
  const zh = TOOL_I18N[tool.name] || {};
  const params = {};
  for (const [k, v] of Object.entries(tool.parameters || {})) {
    params[k] = { ...v, label: PARAM_I18N[k] || k };
    if (v && v.enum) params[k].enum = v.enum.map((e) => ({ value: e, label: ACTION_I18N[e] || e }));
  }
  return {
    ...tool,
    label: zh.label || tool.name,
    descZh: zh.desc || tool.description || "",
    hint: zh.hint || "",
    parameters: params,
  };
}
