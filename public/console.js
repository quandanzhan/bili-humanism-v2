/* ============================================================================
 * 海棠控制台 · 交互逻辑
 * —— 原生 JS，无框架、无 CDN，离线可用
 * ========================================================================= */

(() => {
  'use strict'

  // ------------------------------------------------------------------ 工具函数
  const $ = (id) => document.getElementById(id)
  const KEY = 'haitang.console.cred'

  function safeDisplay(value) {
    let text = String(value ?? '')
    const secrets = [state.cred?.pass]
    document.querySelectorAll('input[type="password"]').forEach((input) => {
      if (input.value !== '***') secrets.push(input.value)
    })
    for (const secret of secrets) {
      if (secret && secret.length >= 4) text = text.split(secret).join('[REDACTED]')
    }
    return text
      .replace(/https?:\/\/[^\s<>"'`]+/gi, (value) => {
        try {
          const url = new URL(value)
          if (url.username) url.username = 'REDACTED'
          if (url.password) url.password = 'REDACTED'
          for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, 'REDACTED')
          if (url.hash) url.hash = 'REDACTED'
          return url.href
        } catch { return value }
      })
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, '$1 [REDACTED]')
      .replace(/(["']?(?:api[-_]?key|password|secret|token|authorization|cookie)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;<>}]+)/gi, '$1[REDACTED]')
      .replace(/([?&][^=&#\s]+=)[^&#\s]*/g, '$1REDACTED')
  }

  const state = {
    cred: null,          // { user, pass }
    channels: [],
    auto: true,
    tools: [],
    health: null,
    account: null,       // B站登录状态
    smtp: null,          // SMTP 配置（密码打码）
    persona: null,       // 人格（语气外壳）
    memory: null,        // 记忆（可修正）
    schedule: null,      // 刷视频时间表（上海时区）
    reply: null,         // 私信回复循环（接管 V1）
    writes: null,        // 写权限策略（发评论）
    nodes: null,         // 解析节点（远端服务器健康）
    vision: null,        // 视觉链后端
    mcp: null,           // MCP 服务器
    scope: null,         // 场景工具集
    allTools: null,      // 全部工具名（场景勾选用）
    digest: null,        // 日报
    digestDate: null,    // 当前查看的日期
    // gen 是「代号」：每次刷新自增，用来作废在途的轮询（旧代号的结果一律丢弃）。
    // 必须初始化为数字——之前只写了 key/timer，gen 是 undefined，
    // undefined + 1 === NaN，而 NaN !== NaN 恒为 true，
    // 于是 startQr 拿到结果后立刻被自己丢弃，二维码永远刷不出来（2026-10-22 实测 bug）。
    qr: { key: null, timer: null, tick: null, gen: 0, deadline: 0 },
    chat: [],            // { role, content, degraded, meta }
    sending: false
  }

  /** 统一 toast 提示 */
  function toast(msg, kind = 'info', ms = 3600) {
    const box = $('toasts')
    const node = document.createElement('div')
    node.className = `toast ${kind}`
    node.textContent = safeDisplay(msg)
    box.appendChild(node)
    setTimeout(() => {
      node.style.opacity = '0'
      node.style.transform = 'translateX(14px)'
      node.style.transition = '0.25s'
      setTimeout(() => node.remove(), 260)
    }, ms)
  }

  /** 秒 → 人类可读 */
  function fmtUptime(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '—'
    const s = Math.floor(ms / 1000)
    if (s < 60) return `${s}s`
    const m = Math.floor(s / 60)
    if (m < 60) return `${m}m ${s % 60}s`
    const h = Math.floor(m / 60)
    if (h < 24) return `${h}h ${m % 60}m`
    return `${Math.floor(h / 24)}d ${h % 24}h`
  }

  // ------------------------------------------------------------------ 认证
  function loadCred() {
    try {
      const raw = sessionStorage.getItem(KEY)
      if (!raw) return null
      const c = JSON.parse(raw)
      return c && c.user ? c : null
    } catch {
      return null
    }
  }

  function saveCred(cred) {
    state.cred = cred
    try { sessionStorage.setItem(KEY, JSON.stringify(cred)) } catch { /* 隐私模式 */ }
  }

  function clearCred() {
    state.cred = null
    try { sessionStorage.removeItem(KEY) } catch { /* ignore */ }
  }

  function authHeader() {
    if (!state.cred) return {}
    return { Authorization: 'Basic ' + btoa(`${state.cred.user}:${state.cred.pass}`) }
  }

  /** 带认证的请求；401 时弹登录 */
  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: {
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        ...authHeader(),
        ...(opts.headers || {})
      }
    })

    if (res.status === 401) {
      showLogin('凭据无效或已过期，请重新登录')
      throw Object.assign(new Error('未认证'), { code: 'UNAUTHORIZED' })
    }

    let data = null
    const text = await res.text()
    if (text) {
      try { data = JSON.parse(text) } catch { data = { raw: text } }
    }

    if (!res.ok) {
      throw Object.assign(new Error(safeDisplay(data?.error || `请求失败（${res.status}）`)), {
        status: res.status,
        code: data?.code,
        data
      })
    }
    return data
  }

  function showLogin(message) {
    $('loginMask').hidden = false
    if (message) {
      $('loginErr').textContent = message
      $('loginErr').hidden = false
    }
    setTimeout(() => $('loginUser').focus(), 60)
  }

  // ------------------------------------------------------------------ 数据加载
  async function loadHealth() {
    // health 不需要认证，用它判断服务是否活着
    try {
      const res = await fetch('/api/health')
      const h = await res.json()
      state.health = h
      const pill = $('pillHealth')
      pill.className = 'pill ' + (h.status === 'ok' ? 'ok' : 'err')
      pill.innerHTML = `<i class="dot"></i>${h.status === 'ok' ? '运行中' : '异常'} · ${fmtUptime(h.uptime)}`
      $('footInfo').textContent =
        `工具 ${h.tools?.total ?? 0} 个 · 可用通道 ${h.models?.available ?? 0} 个 · 更新于 ${new Date().toLocaleTimeString()}`
    } catch {
      const pill = $('pillHealth')
      pill.className = 'pill err'
      pill.innerHTML = '<i class="dot"></i>服务不可达'
    }
  }

  async function loadChannels() {
    try {
      const d = await api('/api/channels')
      state.channels = d.channels || []
      state.auto = d.auto !== false
      $('autoToggle').checked = state.auto
      const pill = $('pillChannels')
      const enabled = state.channels.filter(c => c.enabled !== false).length
      pill.className = 'pill ' + (enabled > 0 ? 'ok' : 'warn')
      pill.textContent = `通道 ${enabled}/${state.channels.length}`

      // 快速开始卡片里的运行信息
      if (d.file) {
        $('cfgFile').textContent = d.file
        $('cfgFile').title = d.file
      }
      $('cfgAuto').textContent = state.auto ? '已开启（按优先级降级）' : '已关闭（只用首个通道）'

      renderChannels()
    } catch (err) {
      if (err.code !== 'UNAUTHORIZED') {
        $('channelList').innerHTML = `<div class="empty">读取通道失败：${escapeHtml(err.message)}</div>`
      }
    }
  }

  async function loadTools() {
    try {
      const d = await api('/api/tools')
      state.tools = d.tools || []
      $('pillTools').textContent = `工具 ${state.tools.length}`
      renderTools()
    } catch (err) {
      if (err.code !== 'UNAUTHORIZED') {
        $('toolList').innerHTML = `<div class="empty">读取工具失败：${escapeHtml(err.message)}</div>`
      }
    }
  }

  async function refreshAll() {
    await loadHealth()
    await Promise.all([loadChannels(), loadTools(), loadAccount(), loadSettings()])
    // 通道要先拿到（时间表里的「用哪个 AI 接口」下拉依赖它）
    await Promise.all([loadPersona(), loadMemory(), loadSchedule(), loadReply(), loadWrites(), loadNodes(), loadVision(), loadMcp(), loadScope(), loadDigest()])
  }

  // ------------------------------------------------------------------ 账号 / 设置
  async function loadAccount() {
    try {
      const d = await api('/api/account/bili/status')
      state.account = d
      renderAccount()
    } catch (err) {
      if (err.code !== 'UNAUTHORIZED') $('accStatus').innerHTML = `<div class="empty">读取账号失败：${escapeHtml(err.message)}</div>`
    }
    loadXhs()
  }

  function renderAccount() {
    const a = state.account || {}
    const box = $('accStatus')
    if (a.loggedIn) {
      const level = a.level ?? '—'
      box.innerHTML = `
        <div class="profile">
          <div class="profile-avatar">
            ${a.avatar
              ? `<img src="${escapeHtml(a.avatar)}" alt="" referrerpolicy="no-referrer" />`
              : '<span class="avatar-fallback">B</span>'}
          </div>
          <div class="profile-main">
            <div class="profile-name">
              ${escapeHtml(a.uname || '已登录')}
              ${a.vip ? '<span class="chip chip-vip">大会员</span>' : ''}
              <span class="chip chip-lv">Lv${escapeHtml(String(level))}</span>
            </div>
            <div class="profile-meta">
              <span class="meta-item"><b>UID</b> ${escapeHtml(String(a.mid ?? '—'))}</span>
              <span class="meta-item"><b>等级</b> Lv${escapeHtml(String(level))}</span>
              ${a.updatedAt ? `<span class="meta-item"><b>Cookie 更新</b> ${new Date(a.updatedAt).toLocaleString()}</span>` : '<span class="meta-item"><b>Cookie 来源</b> V1 凭据文件</span>'}
            </div>
          </div>
          <span class="badge ok">已登录</span>
        </div>`
    } else {
      const why = a.reason === 'NO_CREDENTIAL' ? '凭据文件里还没有 Cookie'
        : a.reason === 'NAV_FAILED' ? '接口探测失败，Cookie 可能已失效'
        : 'Cookie 已失效或未登录'
      box.innerHTML = `
        <div class="profile profile-guest">
          <div class="profile-avatar"><span class="avatar-fallback">?</span></div>
          <div class="profile-main">
            <div class="profile-name">未登录</div>
            <div class="profile-meta"><span class="meta-item">${escapeHtml(why)}</span></div>
            <div class="profile-hint">点下方「扫码登录 B 站」，用手机客户端扫一下即可</div>
          </div>
        </div>`
    }
  }

  /** 登录成功横幅（显示账号 / 等级 / UID） */
  function showLoginSuccess(user) {
    const box = $('accSuccess')
    if (!user) { box.hidden = true; return }
    box.innerHTML = `
      <span class="ok-ico">✓</span>
      <span>登录成功：<b>${escapeHtml(user.uname || '')}</b>
        <span class="chip chip-lv">Lv${escapeHtml(String(user.level ?? '—'))}</span>
        <span class="chip">UID ${escapeHtml(String(user.mid ?? '—'))}</span>
      </span>
      <span class="ok-sub">Cookie 已写入凭据文件</span>`
    box.hidden = false
    clearTimeout(showLoginSuccess._t)
    showLoginSuccess._t = setTimeout(() => { box.hidden = true }, 12000)
  }

  /** 停掉当前二维码轮询与倒计时 */
  function stopQr() {
    if (state.qr.timer) { clearTimeout(state.qr.timer); state.qr.timer = null }
    if (state.qr.tick) { clearInterval(state.qr.tick); state.qr.tick = null }
    state.qr.key = null
    state.qr.gen += 1          // 递增代号，废弃所有在途轮询
    state.qr.deadline = 0
  }

  /** 倒计时刷新 */
  function startCountdown() {
    const tickFn = () => {
      const left = Math.max(0, state.qr.deadline - Date.now())
      const mm = String(Math.floor(left / 60000)).padStart(2, '0')
      const ss = String(Math.floor((left % 60000) / 1000)).padStart(2, '0')
      $('qrTimer').textContent = left > 0 ? `有效期 ${mm}:${ss}` : '二维码已过期'
      if (left <= 0) {
        $('qrMask').hidden = false
        $('qrMaskText').textContent = '已过期 · 请刷新'
        $('qrHint').textContent = '二维码已过期，点「刷新二维码」重新生成'
        if (state.qr.timer) { clearTimeout(state.qr.timer); state.qr.timer = null }
        if (state.qr.tick) { clearInterval(state.qr.tick); state.qr.tick = null }
      }
    }
    tickFn()
    state.qr.tick = setInterval(tickFn, 1000)
  }

  /** 生成/刷新二维码 */
  async function startQr() {
    stopQr()
    const gen = state.qr.gen
    $('btnQrLogin').disabled = true
    $('btnQrRefresh').disabled = true
    $('qrWrap').hidden = false
    $('qrMask').hidden = true
    $('qrHint').textContent = '正在生成二维码…'
    $('qrImg').removeAttribute('src')
    try {
      const d = await api('/api/account/bili/qrcode', { method: 'POST' })
      if (gen !== state.qr.gen) return        // 期间又点了刷新，丢弃这次结果
      state.qr.key = d.key
      state.qr.deadline = Date.now() + (Number(d.expiresIn) || 600) * 1000
      if (d.image) {
        $('qrImg').src = d.image
        $('qrImg').hidden = false
        $('qrHint').textContent = '等待扫码…'
      } else {
        $('qrImg').hidden = true
        $('qrHint').innerHTML = `二维码图片渲染失败，请在手机上打开：<br /><a href="${escapeHtml(d.url)}" target="_blank" rel="noreferrer">${escapeHtml(d.url)}</a>`
      }
      startCountdown()
      pollQr(gen)
    } catch (err) {
      if (err.code !== 'UNAUTHORIZED') {
        $('qrHint').textContent = '生成失败：' + safeDisplay(err.message)
        toast('获取二维码失败：' + safeDisplay(err.message), 'err')
      }
    } finally {
      $('btnQrLogin').disabled = false
      $('btnQrRefresh').disabled = false
    }
  }

  /** 轮询扫码状态（gen 变了就自动作废，避免旧轮询复活） */
  async function pollQr(gen) {
    if (gen !== state.qr.gen || !state.qr.key) return
    try {
      const r = await api('/api/account/bili/qrcode/poll?key=' + encodeURIComponent(state.qr.key))
      if (gen !== state.qr.gen) return
      if (r.state === 'waiting') $('qrHint').textContent = '等待扫码…'
      else if (r.state === 'scanned') $('qrHint').textContent = '已扫码，请在手机上确认'
      else if (r.state === 'confirmed') {
        stopQr()
        $('qrWrap').hidden = true
        showLoginSuccess(r.user)
        toast('登录成功' + (r.user?.uname ? '：' + r.user.uname : ''), 'ok', 4200)
        await loadAccount()
        return
      } else if (r.state === 'expired') {
        $('qrMask').hidden = false
        $('qrMaskText').textContent = '已过期 · 请刷新'
        $('qrHint').textContent = r.message || '二维码已过期，请点「刷新二维码」'
        if (state.qr.timer) { clearTimeout(state.qr.timer); state.qr.timer = null }
        return
      } else if (r.state === 'error') {
        $('qrHint').textContent = r.message || '登录异常'
        return
      }
    } catch (err) {
      if (err.code === 'UNAUTHORIZED' || gen !== state.qr.gen) return
      $('qrHint').textContent = '轮询失败：' + safeDisplay(err.message)
    }
    if (gen === state.qr.gen) state.qr.timer = setTimeout(() => pollQr(gen), 2000)
  }

  async function loadXhs() {
    try {
      const d = await api('/api/account/xhs')
      $('xhsState').textContent = d.hasCookie
        ? `已保存：${d.cookieMasked}${d.enabled ? ' · 已启用' : ' · 未启用'}`
        : '尚未保存 Cookie'
      $('xhsEnabled').checked = Boolean(d.enabled)
      $('xhsCookie').placeholder = d.hasCookie ? '留空或 *** 表示不修改' : '粘贴 web_session=... 等完整 Cookie'
    } catch (err) {
      if (err.code !== 'UNAUTHORIZED') $('xhsState').textContent = '读取失败：' + safeDisplay(err.message)
    }
  }

  async function loadSettings() {
    try {
      const d = await api('/api/settings/smtp')
      state.smtp = d
      $('smtpEnabled').checked = Boolean(d.enabled)
      $('smtpHost').value = d.host || ''
      $('smtpPort').value = d.port || 465
      $('smtpSecurity').value = d.security || 'ssl'
      $('smtpUser').value = d.user || ''
      $('smtpPass').value = d.hasPassword ? '***' : ''
      $('smtpFrom').value = d.from || ''
      $('smtpTo').value = d.to || ''
      const st = d.status || {}
      $('smtpState').textContent = st.configured
        ? `${st.transport} · 发件 ${st.from || '—'} → 收件 ${st.to || '—'}${st.nodemailer ? '' : ' · ⚠ nodemailer 未安装'}${d.legacyFrom ? ' · 已从 ' + d.legacyFrom + ' 继承' : ''}`
        : '尚未配置：填完保存后点「发送测试邮件」验证'
    } catch (err) {
      if (err.code !== 'UNAUTHORIZED') $('smtpState').textContent = '读取设置失败：' + safeDisplay(err.message)
    }
  }

  async function saveSmtp() {
    const patch = {
      enabled: $('smtpEnabled').checked,
      host: $('smtpHost').value.trim(),
      port: Number($('smtpPort').value) || 465,
      security: $('smtpSecurity').value,
      user: $('smtpUser').value.trim(),
      pass: $('smtpPass').value,
      from: $('smtpFrom').value.trim(),
      to: $('smtpTo').value.trim()
    }
    $('btnSmtpSave').disabled = true
    try {
      await api('/api/settings/smtp', { method: 'PUT', body: JSON.stringify(patch) })
      toast('预警设置已保存', 'ok', 2400)
      await loadSettings()
    } catch (err) {
      if (err.code !== 'UNAUTHORIZED') toast(err.message, 'err')
    } finally {
      $('btnSmtpSave').disabled = false
    }
  }

  async function testSmtp() {
    $('btnSmtpTest').disabled = true
    $('smtpState').textContent = '正在发送测试邮件…'
    try {
      const r = await api('/api/settings/smtp/test', { method: 'POST', body: JSON.stringify({}) })
      toast(`测试邮件已发送（${r.latencyMs}ms）`, 'ok', 4200)
      $('smtpState').textContent = `测试邮件发送成功 · ${r.latencyMs}ms`
    } catch (err) {
      if (err.code !== 'UNAUTHORIZED') {
        toast('发送失败：' + safeDisplay(err.message), 'err', 6000)
        $('smtpState').textContent = '发送失败：' + safeDisplay(err.message)
      }
    } finally {
      $('btnSmtpTest').disabled = false
    }
  }

  // ------------------------------------------------------------------ 渲染
  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ))
  }

  // ------------------------------------------------------------------ 人格（语气外壳）
  async function loadPersona() {
    try {
      const d = await api('/api/persona')
      state.persona = d
      renderPersona()
    } catch (err) {
      if (err.code !== 'UNAUTHORIZED') $('personaBody').innerHTML = `<div class="empty">读取人格失败：${escapeHtml(err.message)}</div>`
    }
  }

  function renderPersona() {
    const p = state.persona || {}
    const list = p.personas || []
    const active = list.find((x) => x.id === p.active) || list[0]
    $('personaBody').innerHTML = active
      ? `<div class="persona-active">
           <div class="profile-name">${escapeHtml(active.name)}
             ${active.alias ? `<span class="chip">${escapeHtml(active.alias)}</span>` : ''}
             <span class="chip chip-lv">${escapeHtml(active.callUser || '')}</span>
           </div>
           <div class="profile-meta"><span class="meta-item"><b>人格码</b> ${escapeHtml((active.code || '').slice(0, 46))}…</span></div>
           <div class="profile-hint">边界规则 ${(p.boundaries || []).length} 条 · 片段 ${(p.fragments || []).length} 个 · 只读</div>
         </div>`
      : '<div class="empty">还没迁移人格（legacy/persona 为空）</div>'

    $('personaSelect').innerHTML = list
      .map((x) => `<option value="${escapeHtml(x.id)}" ${x.id === p.active ? 'selected' : ''}>${escapeHtml(x.name)}${x.alias ? ' · ' + escapeHtml(x.alias) : ''}</option>`)
      .join('')

    $('fragList').innerHTML = (p.fragments || [])
      .map((f) => `<button class="frag" data-frag="${escapeHtml(f.file)}" title="点开查看原文">
          <span class="frag-role">${escapeHtml(f.role || '')}</span>
          <span class="frag-name">${escapeHtml(f.file)}</span>
          <span class="frag-size">${f.size ? (f.size > 1024 ? (f.size / 1024).toFixed(1) + 'K' : f.size + 'B') : '缺失'}</span>
        </button>`)
      .join('')
  }

  async function switchPersona() {
    const id = $('personaSelect').value
    if (!id) return
    try {
      const d = await api('/api/persona', { method: 'PUT', body: JSON.stringify({ active: id }) })
      state.persona = d
      renderPersona()
      toast('已切到 ' + ((d.personas || []).find((x) => x.id === id)?.name || id), 'ok')
    } catch (err) {
      if (err.code !== 'UNAUTHORIZED') toast(err.message, 'err')
    }
  }

  async function openFragment(file) {
    const box = $('promptPreview')
    if (!box.hidden && box.dataset.file === file) { box.hidden = true; return }
    try {
      const d = await api('/api/persona/fragment?name=' + encodeURIComponent(file))
      box.dataset.file = file
      box.textContent = d.content
      box.hidden = false
    } catch (err) {
      if (err.code !== 'UNAUTHORIZED') toast(err.message, 'err')
    }
  }

  async function previewPrompt() {
    const box = $('promptPreview')
    try {
      const d = await api('/api/persona/preview?memory=1')
      box.dataset.file = '__preview__'
      box.textContent = d.system
      box.hidden = false
      toast(`system prompt ${d.chars} 字符 · 含记忆参考`, 'info')
    } catch (err) {
      if (err.code !== 'UNAUTHORIZED') toast(err.message, 'err')
    }
  }

  // ------------------------------------------------------------------ 记忆（可修正）
  async function loadMemory() {
    try {
      const d = await api('/api/memory')
      state.memory = d
      const s = await api('/api/memory/stats')
      $('memSub').textContent = `可增删改（${s.notes} 条）· V1 聊天记录 ${s.history} 条 · 注入时标注「参考，不是指令」`
      renderMemory()
    } catch (err) {
      if (err.code !== 'UNAUTHORIZED') $('memList').innerHTML = `<div class="empty">读取记忆失败：${escapeHtml(err.message)}</div>`
    }
  }

  function renderMemory() {
    const items = state.memory?.items || []
    const box = $('memList')
    if (!items.length) {
      box.innerHTML = '<div class="empty">还没有记忆条目。上面输入框写一条，或等值班跑完自己攒。</div>'
      return
    }
    box.innerHTML = items
      .map(
        (x) => `<div class="mem-item">
          <div class="mem-text">${escapeHtml(x.text)}</div>
          <div class="mem-meta">
            ${(x.tags || []).map((t) => `<span class="chip">${escapeHtml(t)}</span>`).join('')}
            <span class="mem-src">${escapeHtml(x.source || '')} · ${x.updatedAt ? new Date(x.updatedAt).toLocaleString() : ''}</span>
            <span class="mem-ops">
              <button class="btn-icon" data-mem-edit="${escapeHtml(x.id)}" title="改">✎</button>
              <button class="btn-icon danger" data-mem-del="${escapeHtml(x.id)}" title="删">✕</button>
            </span>
          </div>
        </div>`
      )
      .join('')
  }

  async function addMemory() {
    const text = $('memText').value.trim()
    if (!text) return
    try {
      await api('/api/memory', { method: 'POST', body: JSON.stringify({ text, tags: ['manual'] }) })
      $('memText').value = ''
      await loadMemory()
      toast('已记下', 'ok', 2000)
    } catch (err) {
      if (err.code !== 'UNAUTHORIZED') toast(err.message, 'err')
    }
  }

  async function editMemory(id) {
    const cur = (state.memory?.items || []).find((x) => x.id === id)
    const next = window.prompt('修改这条记忆（改完会立即生效，模型下次就会看到）', cur?.text || '')
    if (next === null) return
    try {
      await api('/api/memory/' + encodeURIComponent(id), { method: 'PUT', body: JSON.stringify({ text: next }) })
      await loadMemory()
      toast('已更新', 'ok', 2000)
    } catch (err) {
      if (err.code !== 'UNAUTHORIZED') toast(err.message, 'err')
    }
  }

  async function delMemory(id) {
    if (!window.confirm('删除这条记忆？删了就找不回来了（会留一份 notes.json.bak 备份）')) return
    try {
      await api('/api/memory/' + encodeURIComponent(id), { method: 'DELETE' })
      await loadMemory()
      toast('已删除', 'ok', 2000)
    } catch (err) {
      if (err.code !== 'UNAUTHORIZED') toast(err.message, 'err')
    }
  }

  async function showChatHistory() {
    const box = $('memChat')
    if (!box.hidden) { box.hidden = true; return }
    try {
      const d = await api('/api/memory/chat?limit=12')
      const rows = (d.history || []).map(
        (h) => `<div class="chat-row">
          <div class="chat-u">你：${escapeHtml(String(h.user || '').slice(0, 160))}</div>
          <div class="chat-a">AI：${escapeHtml(String(h.assistant || '').slice(0, 240))}</div>
          <div class="chat-t">${h.at ? new Date(Number(h.at) * 1000).toLocaleString() : ''}</div>
        </div>`
      )
      box.innerHTML = rows.length ? rows.join('') : '<div class="empty">没有聊天记录</div>'
      box.hidden = false
    } catch (err) {
      if (err.code !== 'UNAUTHORIZED') toast(err.message, 'err')
    }
  }

  // ------------------------------------------------------------------ 刷视频时间（上海时区）


  // ------------------------------------------------------------------ 日报
  async function loadDigest(date) {
    try {
      const d = await api('/api/digest')
      state.digest = d
      if (!state.digestDate) state.digestDate = (d.today && d.today.date) || null
      if (date) state.digestDate = date
      // 查看的若不是今天，单独拉那天的全文
      let md = (d.today && d.today.markdown) || ''
      let rounds = (d.today && d.today.rounds) || 0
      let summary = (d.today && d.today.summary) || ''
      if (state.digestDate && state.digestDate !== (d.today && d.today.date)) {
        const one = await api('/api/digest/' + encodeURIComponent(state.digestDate))
        md = one.markdown || ''
        rounds = one.rounds || 0
        summary = ''
      }
      renderDigest(md, rounds, summary)
    } catch (err) {
      if (err.code !== 'UNAUTHORIZED') $('digestNow').textContent = '读取失败：' + safeDisplay(err.message)
    }
  }

  function renderDigest(md, rounds, summary) {
    const d = state.digest || {}
    const today = d.today || {}
    $('digestNow').innerHTML =
      `<b>${escapeHtml(state.digestDate || '-')}</b>` +
      (state.digestDate === today.date ? ' <span class="tag" style="font-size:11px">今天</span>' : '') +
      ` · ${rounds} 轮 · ${md ? md.length : 0} 字` +
      (d.state && d.state.pushedDates && d.state.pushedDates.length
        ? `<span class="dot">·</span>已推送 ${d.state.pushedDates.length} 天`
        : '')

    const dates = d.dates || []
    $('digestDates').innerHTML = dates.length
      ? dates.map((x) => `<button class="tab ${x.date === state.digestDate ? 'on' : ''}" data-d="${escapeHtml(x.date)}">${escapeHtml(x.date.slice(5))} <span class="tabn">${x.rounds}</span></button>`).join('')
      : '<span class="empty">还没有日报</span>'
    document.querySelectorAll('#digestDates .tab').forEach((b) => {
      b.addEventListener('click', () => loadDigest(b.dataset.d))
    })

    $('digestSummary').innerHTML = summary
      ? `一句话：${escapeHtml(summary.slice(0, 200))}`
      : ''

    // 极简渲染：标题行加粗、引用灰化，其余按普通行
    $('digestMd').innerHTML = md
      ? md.split('\n').map((l) => {
          if (/^#\s/.test(l)) return `<div class="md-h1">${escapeHtml(l.replace(/^#\s*/, ''))}</div>`
          if (/^##\s/.test(l)) return `<div class="md-h2">${escapeHtml(l.replace(/^##\s*/, ''))}</div>`
          if (/^>\s/.test(l)) return `<div class="md-quote">${escapeHtml(l.replace(/^>\s*/, ''))}</div>`
          if (!l.trim()) return '<div class="md-gap"></div>'
          return `<div class="md-p">${escapeHtml(l)}</div>`
        }).join('')
      : '<div class="empty">这天还没有记录</div>'
  }

  async function pushDigest() {
    $('btnDigestPush').disabled = true
    try {
      const r = await api('/api/digest/push', {
        method: 'POST',
        body: JSON.stringify({ date: state.digestDate || undefined })
      })
      toast(`已推送 ${r.date}（${r.rounds} 轮，${r.watched} 条，分 ${r.parts} 段）`, 'ok', 3600)
      await loadDigest()
    } catch (err) {
      if (err.code !== 'UNAUTHORIZED') toast(err.message, 'err', 5000)
    } finally {
      $('btnDigestPush').disabled = false
    }
  }

  // ------------------------------------------------------------------ 视觉能力
  async function loadVision() {
    try {
      const d = await api('/api/vision')
      state.vision = d
      renderVision()
    } catch (err) {
      if (err.code !== 'UNAUTHORIZED') $('visionNow').textContent = '读取失败：' + safeDisplay(err.message)
    }
  }

  function renderVision() {
    const d = state.vision || {}
    const bs = d.backends || []
    const ready = bs.filter((b) => b.ready).length
    $('visionNow').innerHTML = `<b>${ready}</b> / ${bs.length} 个后端可用` +
      (d.cacheSize ? `<span class="dot">·</span>缓存 ${d.cacheSize} 条` : '')

    $('visionList').innerHTML = bs.map((b) => {
      const cls = b.ready ? 'up' : 'off'
      const tag = b.needsKey ? (b.hasKey ? '已配密钥' : '缺密钥') : '免密钥'
      return `<div class="node-item">
        <span class="node-dot ${cls}"></span>
        <div class="node-main">
          <div class="node-name">${escapeHtml(b.name)}<span class="node-ms">${escapeHtml(b.model || '')} · ${tag}</span></div>
          ${b.needsKey ? `<input class="node-token" type="password" data-id="${escapeHtml(b.id)}" placeholder="${b.hasKey ? '密钥已配置（留空=不改）' : '填 API Key'}" />` : ''}
        </div>
      </div>`
    }).join('') || '<div class="empty">没有配置视觉后端</div>'
  }

  async function saveVision() {
    $('btnVisionSave').disabled = true
    try {
      const cur = (state.vision && state.vision.backends) || []
      const inputs = Array.from(document.querySelectorAll('#visionList .node-token'))
      const backends = cur.map((b) => {
        const el = inputs.find((i) => i.dataset.id === b.id)
        const out = { ...b }
        delete out.ready; delete out.hasKey
        if (el && el.value.trim()) out.apiKey = el.value.trim()
        return out
      })
      await api('/api/vision', { method: 'PUT', body: JSON.stringify({ backends }) })
      toast('视觉密钥已保存', 'ok', 2400)
      await loadVision()
    } catch (err) {
      if (err.code !== 'UNAUTHORIZED') toast(err.message, 'err', 5000)
    } finally {
      $('btnVisionSave').disabled = false
    }
  }

  async function testVision() {
    $('btnVisionTest').disabled = true
    $('visionNow').textContent = '测试中（纯色图，能答对颜色才算通）…'
    try {
      const r = await api('/api/vision/test', { method: 'POST', body: '{}' })
      if (r.ok) {
        $('visionNow').innerHTML = `<b class="wr-on">通过</b> · ${escapeHtml(r.backend)} · ${r.wallMs}ms · 答「${escapeHtml(String(r.text || '').slice(0, 20))}」`
      } else {
        const tried = (r.tried || []).map((t) => `${t.backend}: ${t.message}`).join('；')
        $('visionNow').innerHTML = `<b class="wr-off">失败</b> · ${escapeHtml(tried || r.error || '')}`
      }
    } catch (err) {
      $('visionNow').textContent = '测试失败：' + safeDisplay(err.message)
    } finally {
      $('btnVisionTest').disabled = false
    }
  }

  // ------------------------------------------------------------------ MCP 服务器
  async function loadMcp() {
    try {
      const d = await api('/api/mcp')
      state.mcp = d
      renderMcp()
    } catch (err) {
      if (err.code !== 'UNAUTHORIZED') $('mcpNow').textContent = '读取失败：' + safeDisplay(err.message)
    }
  }

  function renderMcp() {
    const d = state.mcp || {}
    const cfg = (d.config && d.config.servers) || []
    const st = {}
    ;((d.status && d.status.servers) || []).forEach((x) => { st[x.id] = x })
    const conn = Object.values(st).filter((x) => x.connected).length
    $('mcpNow').innerHTML = `<b>${cfg.length}</b> 个服务器 · <b>${conn}</b> 个已连接` +
      `<span class="dot">·</span>工具通过 mcp_list / mcp_call 访问`

    $('mcpList').innerHTML = cfg.map((x) => {
      const s2 = st[x.id] || {}
      const cls = x.enabled === false ? 'off' : (s2.connected ? 'up' : 'down')
      const tail = x.enabled === false ? '已停用' : (s2.connected ? `${s2.toolCount} 个工具` : '未连接')
      return `<div class="node-item">
        <span class="node-dot ${cls}"></span>
        <div class="node-main">
          <div class="node-name">${escapeHtml(x.name || x.id)}<span class="node-ms">${escapeHtml(x.id)} · ${tail}</span></div>
          <div class="node-note">${escapeHtml(x.command || '')} ${escapeHtml((x.args || []).join(' '))}</div>
        </div>
        <button class="btn btn-ghost btn-sm mcp-del" data-id="${escapeHtml(x.id)}">删</button>
      </div>`
    }).join('') || '<div class="empty">还没有 MCP 服务器</div>'

    document.querySelectorAll('.mcp-del').forEach((btn) => {
      btn.addEventListener('click', () => removeMcp(btn.dataset.id))
    })
  }

  async function removeMcp(id) {
    const cur = ((state.mcp && state.mcp.config && state.mcp.config.servers) || []).filter((x) => x.id !== id)
    try {
      await api('/api/mcp', { method: 'PUT', body: JSON.stringify({ servers: cur }) })
      toast('已删除 ' + id, 'ok', 2000)
      await loadMcp()
    } catch (err) {
      toast(err.message, 'err', 4000)
    }
  }

  async function addMcp() {
    const id = $('mcpNewId').value.trim()
    const cmd = $('mcpNewCmd').value.trim()
    const args = $('mcpNewArgs').value.trim().split(/\s+/).filter(Boolean)
    if (!id || !cmd) return toast('id 和命令都要填', 'err', 3000)
    const cur = ((state.mcp && state.mcp.config && state.mcp.config.servers) || []).slice()
    if (cur.some((x) => x.id === id)) return toast('id 已存在', 'err', 3000)
    cur.push({ id, name: id, enabled: true, command: cmd, args })
    try {
      await api('/api/mcp', { method: 'PUT', body: JSON.stringify({ servers: cur }) })
      $('mcpNewId').value = ''; $('mcpNewCmd').value = ''; $('mcpNewArgs').value = ''
      toast('已添加，点「连接测试」看能不能通', 'ok', 3200)
      await loadMcp()
    } catch (err) {
      toast(err.message, 'err', 4000)
    }
  }

  async function probeMcp() {
    $('btnMcpProbe').disabled = true
    $('mcpNow').textContent = '连接测试中（会真的起进程握手）…'
    try {
      const r = await api('/api/mcp/probe', { method: 'POST', body: '{}' })
      const bad = (r.servers || []).filter((x) => x.error)
      state.mcp = { config: state.mcp?.config, status: r.status }
      renderMcp()
      if (bad.length) $('mcpNow').innerHTML += ` · <b class="wr-off">${bad.length} 个失败：${escapeHtml(bad[0].error)}</b>`
    } catch (err) {
      $('mcpNow').textContent = '测试失败：' + safeDisplay(err.message)
    } finally {
      $('btnMcpProbe').disabled = false
    }
  }

  // ------------------------------------------------------------------ 场景工具集
  let scopeScene = 'duty'

  async function loadScope() {
    try {
      const [sc, tl] = await Promise.all([api('/api/tools/scope'), api('/api/tools')])
      state.scope = sc.scopes || {}
      state.allTools = (tl.tools || tl || []).map((t) => t.name).filter(Boolean)
      renderScope()
    } catch (err) {
      if (err.code !== 'UNAUTHORIZED') $('scopeNow').textContent = '读取失败：' + safeDisplay(err.message)
    }
  }

  function renderScope() {
    const scopes = state.scope || {}
    const names = Object.keys(scopes)
    if (!names.length) { $('scopeNow').textContent = '没有配置场景'; return }
    if (!names.includes(scopeScene)) scopeScene = names[0]

    $('scopeNow').innerHTML = `共 <b>${names.length}</b> 个场景 · 没勾选的工具，那个场景的模型连名字都看不到`

    $('scopeTabs').innerHTML = names.map((n) =>
      `<button class="tab ${n === scopeScene ? 'on' : ''}" data-scene="${escapeHtml(n)}">${escapeHtml(n)} <span class="tabn">${(scopes[n] || []).length}</span></button>`
    ).join('')
    document.querySelectorAll('#scopeTabs .tab').forEach((b) => {
      b.addEventListener('click', () => { scopeScene = b.dataset.scene; renderScope() })
    })

    const cur = scopes[scopeScene] || []
    $('scopeGrid').innerHTML = (state.allTools || []).map((t) => {
      const on = cur.includes(t)
      return `<label class="scope-item ${on ? 'on' : ''}">
        <input type="checkbox" data-tool="${escapeHtml(t)}" ${on ? 'checked' : ''} />
        <span>${escapeHtml(t)}</span>
      </label>`
    }).join('')
    document.querySelectorAll('#scopeGrid input').forEach((cb) => {
      cb.addEventListener('change', () => cb.closest('.scope-item').classList.toggle('on', cb.checked))
    })
  }

  async function saveScope() {
    $('btnScopeSave').disabled = true
    try {
      const tools = Array.from(document.querySelectorAll('#scopeGrid input'))
        .filter((x) => x.checked).map((x) => x.dataset.tool)
      await api('/api/tools/scope', { method: 'PUT', body: JSON.stringify({ scene: scopeScene, tools }) })
      toast(`场景「${scopeScene}」已保存（${tools.length} 个工具）`, 'ok', 2600)
      await loadScope()
    } catch (err) {
      if (err.code !== 'UNAUTHORIZED') toast(err.message, 'err', 5000)
    } finally {
      $('btnScopeSave').disabled = false
    }
  }

  // ------------------------------------------------------------------ 解析节点（远端服务器）
  async function loadNodes(force) {
    try {
      const d = await api('/api/nodes' + (force ? '?force=1' : ''))
      state.nodes = d
      renderNodes()
    } catch (err) {
      if (err.code !== 'UNAUTHORIZED') $('nodesNow').textContent = '读取失败：' + safeDisplay(err.message)
    }
  }

  function renderNodes() {
    const d = state.nodes || {}
    const sum = d.summary || {}
    const at = d.checkedAt ? new Date(d.checkedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '—'
    $('nodesNow').innerHTML =
      `<b>${sum.up || 0}</b> 在线 · <b class="${sum.down ? 'wr-on' : ''}">${sum.down || 0}</b> 离线 · ` +
      `${sum.skipped || 0} 未启用<span class="dot">·</span>检测于 ${at}` +
      (d.cached ? `<span class="dot">·</span>缓存 ${Math.round((d.ageMs || 0) / 1000)}s` : '')

    const nodes = d.nodes || []
    $('nodeList').innerHTML = nodes.length
      ? nodes.map((n) => {
          const cls = n.ok === true ? 'up' : n.ok === false ? 'down' : 'off'
          const right = n.ok === true
            ? `<span class="node-ms">${n.ms}ms</span>`
            : n.ok === false
              ? `<span class="node-err">${escapeHtml(n.error || ('HTTP ' + (n.status || '?')))}</span>`
              : `<span class="node-off">${escapeHtml(n.reason || '未启用')}</span>`
          const body = n.ok === true && n.body ? `<div class="node-body">${escapeHtml(n.body)}</div>` : ''
          return `<div class="node-item">
            <span class="node-dot ${cls}"></span>
            <div class="node-main">
              <div class="node-name">${escapeHtml(n.name)}${right}</div>
              <input class="node-url" data-id="${escapeHtml(n.id)}" value="${escapeHtml(n.url || '')}" placeholder="填健康检查地址，如 http://host/api/health" />
              ${n.needsAuth ? `<input class="node-token" type="password" data-id="${escapeHtml(n.id)}" placeholder="${n.hasAuth ? '令牌已配置（留空=不改）' : '填 Bearer 令牌'}" />` : ''}
              ${n.note ? `<div class="node-note">${escapeHtml(n.note)}</div>` : ''}
              ${body}
            </div>
          </div>`
        }).join('')
      : '<div class="empty">没有配置节点</div>'
  }

  async function probeNodes() {
    $('btnNodesProbe').disabled = true
    $('nodesNow').textContent = '检测中…'
    try {
      await loadNodes(true)
    } finally {
      $('btnNodesProbe').disabled = false
    }
  }

  async function saveNodes() {
    $('btnNodesSave').disabled = true
    try {
      const cur = (state.nodes && state.nodes.config && state.nodes.config.nodes) || []
      const inputs = Array.from(document.querySelectorAll('.node-url'))
      const tokens = Array.from(document.querySelectorAll('.node-token'))
      const nodes = cur.map((n) => {
        const el = inputs.find((i) => i.dataset.id === n.id)
        const tEl = tokens.find((i) => i.dataset.id === n.id)
        const url = el ? el.value.trim() : n.url
        const out = { ...n, url, enabled: Boolean(url) }
        delete out.hasAuth  // 只读字段，回传给后端没意义
        // 填了才更新令牌；留空表示沿用服务器上已存的那个
        if (tEl && tEl.value.trim()) out.auth = tEl.value.trim()
        return out
      })
      // 兜底：如果配置还没加载过，就直接按输入框顺序拼
      const payload = nodes.length ? nodes : inputs.map((i) => ({ id: i.dataset.id, name: i.dataset.id, url: i.value.trim(), enabled: Boolean(i.value.trim()) }))
      await api('/api/nodes', { method: 'PUT', body: JSON.stringify({ nodes: payload }) })
      toast('节点地址已保存并重新检测', 'ok', 2400)
      await loadNodes(true)
    } catch (err) {
      if (err.code !== 'UNAUTHORIZED') toast(err.message, 'err', 5000)
    } finally {
      $('btnNodesSave').disabled = false
    }
  }

  // ------------------------------------------------------------------ 写权限
  async function loadWrites() {
    try {
      const d = await api('/api/writes')
      state.writes = d
      renderWrites()
    } catch (err) {
      if (err.code !== 'UNAUTHORIZED') $('wrNow').textContent = '读取失败：' + safeDisplay(err.message)
    }
  }

  function renderWrites() {
    const d = state.writes || {}
    const p = d.policy || {}
    $('wrEnabled').checked = p.enabled !== false
    $('wrReply').checked = p.allowCommentReply !== false
    $('wrNew').checked = p.allowNewComment === true
    $('wrPerHour').value = p.maxPerHour || 12
    $('wrPerMin').value = p.maxPerMinute || 2
    $('wrChars').value = p.maxChars || 400

    const state_ = p.enabled === false
      ? '<b class="wr-off">已关闭</b> · 任何写操作都会被拒绝'
      : `<b class="wr-on">已开启</b> · 本小时 ${d.lastHour || 0}/${p.maxPerHour} 次 · 本分钟 ${d.lastMinute || 0}/${p.maxPerMinute}`
    $('wrNow').innerHTML = state_

    const recent = d.recent || []
    $('wrLog').innerHTML = recent.length
      ? recent.slice(0, 6).map((w) => `<div class="sched-line"><span class="t">${String(w.at).slice(11, 19)}</span>${w.ok ? '✓' : '✗'} ${escapeHtml(w.kind)} · ${escapeHtml(String(w.target || ''))} · ${escapeHtml(String(w.text || '').slice(0, 40))}${w.error ? ' · ' + escapeHtml(w.error) : ''}</div>`).join('')
      : '<div class="empty">还没有写过东西</div>'
  }

  async function saveWrites() {
    $('btnWrSave').disabled = true
    try {
      const body = {
        enabled: $('wrEnabled').checked,
        allowCommentReply: $('wrReply').checked,
        allowNewComment: $('wrNew').checked,
        maxPerHour: Number($('wrPerHour').value) || 12,
        maxPerMinute: Number($('wrPerMin').value) || 2,
        maxChars: Number($('wrChars').value) || 400
      }
      await api('/api/writes', { method: 'PUT', body: JSON.stringify(body) })
      toast(body.enabled ? '写权限已保存' : '写权限已关闭', 'ok', 2600)
      await loadWrites()
    } catch (err) {
      if (err.code !== 'UNAUTHORIZED') toast(err.message, 'err', 5000)
    } finally {
      $('btnWrSave').disabled = false
    }
  }

  // ------------------------------------------------------------------ 私信回复（接管 V1）
  async function loadReply() {
    try {
      const [st, hist] = await Promise.all([api('/api/reply/status'), api('/api/reply/history?limit=5')])
      state.reply = { status: st, history: hist.items || [] }
      renderReply()
    } catch (err) {
      if (err.code !== 'UNAUTHORIZED') $('replyNow').textContent = '读取失败：' + safeDisplay(err.message)
    }
  }

  function renderReply() {
    const d = state.reply || {}
    const st = d.status || {}
    const mode = st.mode || 'off'
    const label = { off: '已关闭', dry: '演练中', live: '运行中' }[mode] || mode
    const chip = $('replyMode')
    if (chip) {
      chip.textContent = label
      chip.className = 'chip ' + (mode === 'live' ? 'chip-lv' : mode === 'dry' ? 'chip-run' : 'chip-ok')
    }
    const sel = $('replyModeSel')
    if (sel && document.activeElement !== sel) sel.value = mode

    const stats = st.stats || {}
    const bits = []
    bits.push(`<b>${label}</b> · 对方的 uid ${st.talker || '—'}`)
    bits.push(st.seeded ? `已回 ${st.repliedCount || 0} 条记录` : '尚未打底（上线前会先跳过全部历史）')
    if (stats.lastAt) bits.push(`最近一次 ${new Date(stats.lastAt).toLocaleString('zh-CN', { hour12: false })}（${stats.lastMode}，${stats.lastChars || 0} 字）`)
    if (st.lastPoll?.at) {
      const sec = Math.round((Date.now() - new Date(st.lastPoll.at).getTime()) / 1000)
      bits.push(`上次检查 ${sec}s 前`)
    }
    if (st.busy) bits.push('<span class="chip chip-run">正在回复…</span>')
    $('replyNow').innerHTML = bits.join('<span class="dot">·</span>')

    const logs = st.log || []
    $('replyLog').innerHTML = logs.length
      ? logs.slice(-6).reverse().map((l) => `<div class="sched-line"><span class="t">${String(l.at).slice(11, 19)}</span>${escapeHtml(l.phase)}${l.tool ? ' · ' + escapeHtml(l.tool) : ''}${l.ms ? ' · ' + l.ms + 'ms' : ''}${l.message ? ' · ' + escapeHtml(l.message) : ''}</div>`).join('')
      : '<div class="empty">还没有运行记录</div>'

    const hist = d.history || []
    $('replyHist').innerHTML = hist.length
      ? hist.map((h) => `<div class="reply-item">
          <div class="reply-meta">${new Date(h.at).toLocaleString('zh-CN', { hour12: false })} · ${escapeHtml(h.mode)}${h.channel ? ' · ' + escapeHtml(h.channel) : ''}${h.steps ? ' · 工具 ' + h.steps + ' 次' : ''}</div>
          <div class="reply-in"><b>收到</b>${escapeHtml(String(h.user || '').slice(0, 160))}</div>
          <div class="reply-out"><b>回复</b>${escapeHtml(String(h.assistant || '').slice(0, 260))}</div>
        </div>`).join('')
      : '<div class="empty">还没有回复记录</div>'
  }

  async function saveReplyMode() {
    $('btnReplySave').disabled = true
    try {
      const mode = $('replyModeSel').value
      await api('/api/reply', { method: 'PUT', body: JSON.stringify({ mode }) })
      toast(mode === 'live' ? '已开启：会真的回私信' : mode === 'dry' ? '已切演练：只生成不发送' : '已关闭', 'ok', 3000)
      await loadReply()
    } catch (err) {
      if (err.code !== 'UNAUTHORIZED') toast(err.message, 'err', 5000)
    } finally {
      $('btnReplySave').disabled = false
    }
  }

  async function drillReply() {
    $('btnReplyDrill').disabled = true
    toast('演练中，大概 30~90 秒…', 'info', 4000)
    try {
      const d = await api('/api/reply/run', { method: 'POST', body: JSON.stringify({ simulate: '（面板演练）用一句话说说你现在能做什么' }) })
      const r = d.result || {}
      toast(r.ok ? '演练完成，结果在下方记录里' : '演练失败：' + (r.message || ''), r.ok ? 'ok' : 'err', 5000)
      await loadReply()
    } catch (err) {
      if (err.code !== 'UNAUTHORIZED') toast(err.message, 'err', 6000)
    } finally {
      $('btnReplyDrill').disabled = false
    }
  }

  async function loadSchedule() {
    try {
      const d = await api('/api/schedule')
      state.schedule = d
      renderSchedule()
    } catch (err) {
      if (err.code !== 'UNAUTHORIZED') $('schedNow').textContent = '读取时间表失败：' + safeDisplay(err.message)
    }
  }

  function renderSchedule() {
    const d = state.schedule || {}
    const cfg = d.config || {}
    const st = d.state || {}
    const now = st.now || {}
    $('schedEnabled').checked = cfg.enabled !== false
    $('schedPerDay').value = cfg.perDay || 6
    $('schedInterval').value = cfg.intervalMinutes || 45

    // 通道下拉：把「用哪个 AI 接口」做成可选
    const chs = state.channels || []
    const cur = cfg.task?.channelId || ''
    $('schedChannel').innerHTML =
      `<option value="">按优先级自动（默认）</option>` +
      chs.map((c) => `<option value="${escapeHtml(c.id)}" ${c.id === cur ? 'selected' : ''}>${escapeHtml(c.name)} · ${escapeHtml(c.model)}${c.vision ? ' 👁' : ''}</option>`).join('')

    const next = st.nextRunAt?.at || '今天不再跑'
    $('schedNow').innerHTML =
      `<span class="sched-clock">现在 ${escapeHtml(now.text || '—')} <span class="chip">Asia/Shanghai</span></span>` +
      `<span class="sched-next">今日 ${st.todayRuns || 0}/${cfg.perDay || 0} 次 · 下次 ${escapeHtml(next)}</span>` +
      `<span class="chip ${st.inAnyWindow ? 'chip-ok' : ''}">${st.inAnyWindow ? '在时段内' : '不在时段'}</span>`

    $('schedWins').innerHTML = (cfg.windows || [])
      .map(
        (w, i) => `<div class="win-row" data-i="${i}">
          <label class="switch" title="启用">
            <input type="checkbox" data-win="enabled" ${w.enabled !== false ? 'checked' : ''} /><i></i>
          </label>
          <input class="win-name" data-win="name" value="${escapeHtml(w.name)}" maxlength="12" />
          <input class="win-time" data-win="start" value="${escapeHtml(w.start)}" placeholder="HH:MM" />
          <span class="win-dash">→</span>
          <input class="win-time" data-win="end" value="${escapeHtml(w.end)}" placeholder="HH:MM" />
          <span class="win-per">上限</span>
          <input class="win-num" data-win="perDay" type="number" min="1" max="48" value="${w.perDay || 2}" />
          <button class="btn-icon danger" data-win-del="${i}" title="删掉这个时段">✕</button>
        </div>`
      )
      .join('') || '<div class="empty">还没有时段，点下面「+ 加时段」</div>'

    const runs = (st.runs || []).slice(-6).reverse()
    $('schedLog').innerHTML = runs.length
      ? '<div class="sched-log-title">最近运行</div>' + runs.map((r) =>
          `<div class="sched-log-row ${r.ok ? 'ok' : 'err'}">
            <span>${escapeHtml(r.timeText || r.at || '')}</span>
            <span>${r.ok ? '✓' : '✗'} ${r.steps || 0} 步 · ${r.channel || ''} ${r.ms ? r.ms + 'ms' : ''}</span>
            <span class="sched-log-txt">${escapeHtml(String(r.text || r.error || '').slice(0, 200))}</span>
          </div>`).join('')
      : ''
  }

  function collectSchedule() {
    const wins = []
    document.querySelectorAll('#schedWins .win-row').forEach((row) => {
      const g = (k) => row.querySelector(`[data-win="${k}"]`)
      wins.push({
        id: 'w' + (wins.length + 1),
        name: g('name').value.trim() || '时段',
        start: g('start').value.trim(),
        end: g('end').value.trim(),
        enabled: g('enabled').checked,
        perDay: Number(g('perDay').value) || 1
      })
    })
    return {
      enabled: $('schedEnabled').checked,
      perDay: Number($('schedPerDay').value) || 6,
      intervalMinutes: Number($('schedInterval').value) || 45,
      windows: wins,
      task: { channelId: $('schedChannel').value || '' }
    }
  }

  async function saveSchedule() {
    $('btnSchedSave').disabled = true
    try {
      const d = await api('/api/schedule', { method: 'PUT', body: JSON.stringify(collectSchedule()) })
      state.schedule = { ...(state.schedule || {}), config: d.config, state: d.state }
      renderSchedule()
      toast('时间表已保存（上海时间）', 'ok', 2600)
    } catch (err) {
      if (err.code !== 'UNAUTHORIZED') toast(err.message, 'err', 5000)
    } finally {
      $('btnSchedSave').disabled = false
    }
  }

  async function runScheduleNow() {
    $('btnSchedRun').disabled = true
    $('schedNow').insertAdjacentHTML('beforeend', '<span class="chip chip-run">正在跑…</span>')
    try {
      const d = await api('/api/schedule/run', { method: 'POST', body: '{}' })
      const r = d.result || {}
      toast(r.ok ? `跑完：${r.steps || 0} 步 / ${r.ms}ms` : '本轮失败：' + (r.error || ''), r.ok ? 'ok' : 'err', 6000)
      await loadSchedule()
    } catch (err) {
      if (err.code !== 'UNAUTHORIZED') toast(err.message, 'err', 6000)
    } finally {
      $('btnSchedRun').disabled = false
    }
  }

  async function resetSchedule() {
    try {
      const d = await api('/api/schedule/reset', { method: 'POST', body: '{}' })
      state.schedule = { ...(state.schedule || {}), state: d.state }
      renderSchedule()
      toast('今日计数已清零', 'ok', 2000)
    } catch (err) {
      if (err.code !== 'UNAUTHORIZED') toast(err.message, 'err')
    }
  }

  function renderChannels() {
    const box = $('channelList')

    if (!state.channels.length) {
      box.innerHTML = `
        <div class="empty">
          还没有接入任何模型通道。<br />
          点右上角「+ 添加通道」填入 Base URL、模型 ID、API Key 即可启用真实 AI 对话。<br />
          在添加之前，对话会返回<strong>离线规则回复</strong>（不会卡住，但也不是 AI 答的）。
        </div>`
      return
    }

    box.innerHTML = ''
    state.channels.forEach((c, index) => {
      const row = document.createElement('div')
      row.className = 'channel-row' + (c.enabled === false ? ' disabled' : '')
      row.draggable = true
      row.dataset.id = c.id
      row.dataset.index = String(index)

      row.innerHTML = `
        <span class="drag-handle" title="拖拽调整优先级">⠿</span>
        <span class="prio" title="优先级：数字越小越先用">${escapeHtml(c.priority)}</span>
        <div class="channel-main">
          <div class="channel-name">
            <span>${escapeHtml(c.name)}</span>
            <span class="model">${escapeHtml(c.model)}</span>
            ${c.vision ? '<span class="badge vision" title="支持图像输入（能看到 bili_frames 抽的真实画面）">👁 视觉</span>' : ''}
            <span class="badge" data-role="testbadge" hidden></span>
          </div>
          <div class="channel-meta" title="${escapeHtml(c.baseURL)}">${escapeHtml(c.baseURL)}${c.note ? ' · ' + escapeHtml(c.note) : ''}</div>
        </div>
        <span class="switch" title="${c.enabled === false ? '已停用' : '启用中'}">
          <input type="checkbox" data-role="enable" ${c.enabled === false ? '' : 'checked'} />
          <i></i>
        </span>
        <div class="channel-actions">
          <button class="btn-icon" data-role="up" title="上移（提高优先级）">↑</button>
          <button class="btn-icon" data-role="down" title="下移（降低优先级）">↓</button>
          <button class="btn-icon" data-role="test" title="测试连通性">测</button>
          <button class="btn-icon" data-role="edit" title="编辑">✎</button>
          <button class="btn-icon danger" data-role="del" title="删除">✕</button>
        </div>`
      box.appendChild(row)
    })

    bindChannelRowEvents()
    bindDragAndDrop()
  }

  function renderTools() {
    const box = $('toolList')
    if (!state.tools.length) {
      box.innerHTML = '<div class="empty">当前未加载任何工具（<code>tools/</code> 目录为空，属正常状态）。</div>'
      return
    }
    box.innerHTML = state.tools.map(t => `
      <div class="tool-row">
        <div>
          <div class="tool-name">${escapeHtml(t.name)}</div>
          <div class="tool-desc">${escapeHtml(t.description || '（无描述）')}</div>
        </div>
        <label class="switch" title="${t.enabled ? '点击停用' : '点击启用'}">
          <input type="checkbox" data-tool="${escapeHtml(t.name)}" ${t.enabled ? 'checked' : ''} />
          <i></i>
        </label>
      </div>`).join('')
  }

  function renderChat() {
    const log = $('chatLog')

    if (!state.chat.length) {
      log.innerHTML = '<div class="chat-empty">发一条消息试试。当前没有配置通道时会返回<strong>离线规则回复</strong>，并在这里标注出来。</div>'
      return
    }

    log.innerHTML = ''
    state.chat.forEach(m => {
      const wrap = document.createElement('div')
      const kind = m.role === 'user' ? 'user' : (m.error ? 'assistant err' : (m.degraded ? 'assistant degraded' : 'assistant'))
      wrap.className = `msg ${kind}`

      const bubble = document.createElement('div')
      bubble.className = 'bubble'
      bubble.textContent = m.content
      wrap.appendChild(bubble)

      if (m.role !== 'user' && (m.degraded || m.meta)) {
        const meta = document.createElement('div')
        meta.className = 'msg-meta'
        const parts = []
        if (m.degraded) parts.push('离线规则')
        if (m.meta) parts.push(m.meta)
        meta.textContent = parts.join(' · ')
        wrap.appendChild(meta)
      }

      log.appendChild(wrap)
    })

    log.scrollTop = log.scrollHeight
  }

  // ------------------------------------------------------------------ 通道交互
  function bindChannelRowEvents() {
    document.querySelectorAll('.channel-row').forEach(row => {
      const id = row.dataset.id
      const idx = Number(row.dataset.index)

      row.querySelector('[data-role="enable"]').addEventListener('change', async (e) => {
        try {
          await api(`/api/channels/${id}`, {
            method: 'PATCH',
            body: JSON.stringify({ enabled: e.target.checked })
          })
          toast(e.target.checked ? '已启用' : '已停用', 'ok', 1800)
          await loadChannels()
        } catch (err) {
          if (err.code !== 'UNAUTHORIZED') toast(err.message, 'err')
          e.target.checked = !e.target.checked
        }
      })

      row.querySelector('[data-role="up"]').addEventListener('click', () => moveChannel(idx, -1))
      row.querySelector('[data-role="down"]').addEventListener('click', () => moveChannel(idx, 1))

      row.querySelector('[data-role="test"]').addEventListener('click', async (e) => {
        const btn = e.currentTarget
        const badge = row.querySelector('[data-role="testbadge"]')
        btn.disabled = true
        badge.hidden = false
        badge.className = 'badge testing'
        badge.textContent = '测试中…'
        try {
          const r = await api(`/api/channels/${id}/test`, { method: 'POST', body: '{}' })
          if (r.ok) {
            badge.className = 'badge ok'
            badge.textContent = `${r.latencyMs}ms`
            toast(`通道可用：${r.latencyMs}ms${r.sample ? ' · ' + r.sample.slice(0, 24) : ''}`, 'ok')
          } else {
            badge.className = 'badge err'
            badge.textContent = '失败'
            toast(`通道不可用：${r.error || '未知错误'}`, 'err', 5200)
          }
        } catch (err) {
          badge.className = 'badge err'
          badge.textContent = '失败'
          if (err.code !== 'UNAUTHORIZED') toast(err.message, 'err', 5200)
        } finally {
          btn.disabled = false
        }
      })

      row.querySelector('[data-role="edit"]').addEventListener('click', () => openEdit(state.channels[idx]))
      row.querySelector('[data-role="del"]').addEventListener('click', async () => {
        const c = state.channels[idx]
        if (!confirm(`确定删除通道「${c.name}」（${c.model}）？此操作不可撤销。`)) return
        try {
          await api(`/api/channels/${id}`, { method: 'DELETE' })
          toast('通道已删除', 'ok', 2000)
          await Promise.all([loadChannels(), loadHealth()])
        } catch (err) {
          if (err.code !== 'UNAUTHORIZED') toast(err.message, 'err')
        }
      })
    })
  }

  /** 上移/下移：本地交换后提交顺序 */
  async function moveChannel(index, delta) {
    const next = index + delta
    if (next < 0 || next >= state.channels.length) return
    const arr = state.channels.slice()
    const [item] = arr.splice(index, 1)
    arr.splice(next, 0, item)
    state.channels = arr
    renderChannels()
    await persistOrder()
  }

  async function persistOrder() {
    try {
      const ids = state.channels.map(c => c.id)
      const d = await api('/api/channels/reorder', {
        method: 'POST',
        body: JSON.stringify({ ids })
      })
      state.channels = d.channels || state.channels
      renderChannels()
      toast('优先级已保存', 'ok', 1600)
    } catch (err) {
      if (err.code !== 'UNAUTHORIZED') toast(`排序保存失败：${err.message}`, 'err')
      await loadChannels()
    }
  }

  function bindDragAndDrop() {
    let draggingId = null

    document.querySelectorAll('.channel-row').forEach(row => {
      row.addEventListener('dragstart', (e) => {
        draggingId = row.dataset.id
        row.classList.add('dragging')
        e.dataTransfer.effectAllowed = 'move'
        // Firefox 需要设置数据才会触发拖拽
        try { e.dataTransfer.setData('text/plain', draggingId) } catch { /* ignore */ }
      })

      row.addEventListener('dragend', () => {
        row.classList.remove('dragging')
        document.querySelectorAll('.drop-target').forEach(n => n.classList.remove('drop-target'))
      })

      row.addEventListener('dragover', (e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        if (row.dataset.id !== draggingId) row.classList.add('drop-target')
      })

      row.addEventListener('dragleave', () => row.classList.remove('drop-target'))

      row.addEventListener('drop', async (e) => {
        e.preventDefault()
        row.classList.remove('drop-target')
        const targetId = row.dataset.id
        if (!draggingId || draggingId === targetId) return

        const arr = state.channels.slice()
        const from = arr.findIndex(c => c.id === draggingId)
        const to = arr.findIndex(c => c.id === targetId)
        if (from < 0 || to < 0) return
        const [item] = arr.splice(from, 1)
        arr.splice(to, 0, item)
        state.channels = arr
        renderChannels()
        await persistOrder()
      })
    })
  }

  // ------------------------------------------------------------------ 编辑弹窗
  function openEdit(c) {
    const dlg = document.createElement('dialog')
    dlg.style.cssText = `
      border:1px solid rgba(255,255,255,.16); border-radius:16px; padding:0;
      background:#10161f; color:#e9eff7; width:min(520px,92vw); box-shadow:0 30px 70px rgba(0,0,0,.6);`
    dlg.innerHTML = `
      <form method="dialog" style="padding:22px 22px 18px; font-family:inherit;">
        <h3 style="margin:0 0 4px;font-size:15px;">编辑通道</h3>
        <p style="margin:0 0 16px;font-size:11.5px;color:#6b7c92;">
          API Key 留空表示不修改（当前：${c.apiKey ? '已配置' : '未配置'}）
        </p>
        <div style="display:grid;gap:11px;">
          <label><span style="display:block;font-size:11.5px;color:#9aa9bd;margin-bottom:5px;">名称</span>
            <input name="name" value="${escapeHtml(c.name)}" maxlength="40" style="width:100%"></label>
          <label><span style="display:block;font-size:11.5px;color:#9aa9bd;margin-bottom:5px;">模型 ID</span>
            <input name="model" value="${escapeHtml(c.model)}" maxlength="120" style="width:100%"></label>
          <label><span style="display:block;font-size:11.5px;color:#9aa9bd;margin-bottom:5px;">Base URL</span>
            <input name="baseURL" value="${escapeHtml(c.baseURL)}" style="width:100%"></label>
          <label><span style="display:block;font-size:11.5px;color:#9aa9bd;margin-bottom:5px;">API Key</span>
            <input name="apiKey" type="password" placeholder="留空不修改" autocomplete="off" style="width:100%"></label>
          <label><span style="display:block;font-size:11.5px;color:#9aa9bd;margin-bottom:5px;">优先级（越小越优先）</span>
            <input name="priority" type="number" value="${escapeHtml(c.priority)}" style="width:100%"></label>
          <label><span style="display:block;font-size:11.5px;color:#9aa9bd;margin-bottom:5px;">备注</span>
            <input name="note" value="${escapeHtml(c.note || '')}" maxlength="160" style="width:100%"></label>
          <label style="display:flex;align-items:center;gap:9px;font-size:12.5px;color:#9aa9bd;">
            <input type="checkbox" name="vision" ${c.vision ? 'checked' : ''} style="width:auto;margin:0" />
            支持图像输入（👁 勾上后 bili_frames 抽的画面才会附图给这个模型）</label>
        </div>
        <div style="display:flex;gap:9px;justify-content:flex-end;margin-top:18px;">
          <button value="cancel" style="padding:8px 14px;border-radius:9px;border:1px solid rgba(255,255,255,.14);background:transparent;color:#e9eff7;cursor:pointer;">取消</button>
          <button value="save" style="padding:8px 14px;border-radius:9px;border:0;background:linear-gradient(135deg,#5b8cff,#8b5cf6);color:#fff;cursor:pointer;">保存</button>
        </div>
      </form>`

    // dialog 内的输入框复用了全局样式，需要补一点内联约束
    dlg.querySelectorAll('input').forEach(inp => {
      inp.style.cssText = 'width:100%;padding:9px 11px;border-radius:9px;border:1px solid rgba(255,255,255,.14);background:rgba(0,0,0,.28);color:#e9eff7;font-family:inherit;font-size:13px;'
    })

    document.body.appendChild(dlg)
    dlg.showModal()

    dlg.addEventListener('close', async () => {
      const save = dlg.returnValue === 'save'
      const form = dlg.querySelector('form')
      if (save) {
        const el = (n) => form.elements[n]
        const patch = {
          name: el('name').value.trim(),
          model: el('model').value.trim(),
          baseURL: el('baseURL').value.trim(),
          priority: el('priority').value,
          note: el('note').value.trim(),
          vision: el('vision').checked
        }
        const key = el('apiKey').value.trim()
        if (key) patch.apiKey = key
        try {
          await api(`/api/channels/${c.id}`, { method: 'PATCH', body: JSON.stringify(patch) })
          toast('已保存', 'ok', 2000)
          await Promise.all([loadChannels(), loadHealth()])
        } catch (err) {
          if (err.code !== 'UNAUTHORIZED') toast(`保存失败：${err.message}`, 'err', 5000)
        }
      }
      dlg.remove()
    })
  }

  // ------------------------------------------------------------------ 对话
  /** 解析一帧 SSE 文本 */
  function parseFrame(frame) {
    const lines = frame.split('\n')
    let event = 'message'
    const dataLines = []
    for (const line of lines) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
    }
    if (!dataLines.length) return null
    try {
      return { event, payload: JSON.parse(dataLines.join('\n')) }
    } catch {
      return { event, payload: { raw: dataLines.join('\n') } }
    }
  }

  async function sendChat(text) {
    const useStream = $('streamToggle').checked
    state.chat.push({ role: 'user', content: text })
    renderChat()

    // 占位的助手气泡（流式时持续追加）
    const slot = { role: 'assistant', content: '', meta: '' }
    state.chat.push(slot)
    renderChat()

    const messages = state.chat
      .filter(m => m.role === 'user' || (m.role === 'assistant' && m.content))
      .map(m => ({ role: m.role, content: m.content }))

    state.sending = true
    $('btnSend').disabled = true

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({ messages, stream: useStream })
      })

      if (res.status === 401) {
        showLogin('凭据无效或已过期，请重新登录')
        throw Object.assign(new Error('未认证'), { code: 'UNAUTHORIZED' })
      }

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}))
        throw Object.assign(new Error(safeDisplay(errData.error || `HTTP ${res.status}`)), { code: errData.code })
      }

      if (!useStream) {
        const d = await res.json()
        slot.content = d.content || '（空响应）'
        slot.degraded = Boolean(d.degraded)
        slot.meta = [d.model, d.channel].filter(Boolean).join(' · ')
        renderChat()
        return
      }

      // 流式：手工读 SSE
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })

        const frames = buf.split('\n\n')
        buf = frames.pop()

        for (const raw of frames) {
          const f = parseFrame(raw)
          if (!f) continue
          const p = f.payload || {}

          if (f.event === 'content') {
            slot.content += p.content ?? ''
            renderChat()
          } else if (f.event === 'done') {
            slot.degraded = Boolean(p.degraded)
            slot.meta = [p.model, p.channel].filter(Boolean).join(' · ')
          } else if (f.event === 'error') {
            slot.error = true
            slot.content = slot.content || `请求失败：${p.error || '未知错误'}`
            slot.meta = p.code || ''
          }
        }
        renderChat()
      }

      if (!slot.content) slot.content = '（没有收到内容）'
      renderChat()
    } catch (err) {
      if (err.code !== 'UNAUTHORIZED') {
        slot.error = true
        slot.content = slot.content || `请求失败：${err.message}`
        renderChat()
        toast(err.message, 'err')
      }
    } finally {
      state.sending = false
      $('btnSend').disabled = false
    }
  }

  // ------------------------------------------------------------------ 事件绑定
  function bindEvents() {
    // 登录
    $('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault()
      const user = $('loginUser').value.trim()
      const pass = $('loginPass').value
      if (!user || !pass) return

      saveCred({ user, pass })
      $('loginBtn').disabled = true
      try {
        await api('/api/channels')
        $('loginMask').hidden = true
        $('loginErr').hidden = true
        $('loginPass').value = ''
        toast('登录成功', 'ok', 2000)
        await refreshAll()
        renderChat()
      } catch (err) {
        clearCred()
        $('loginErr').textContent = err.code === 'UNAUTHORIZED' ? '用户名或密码不正确' : `连接失败：${err.message}`
        $('loginErr').hidden = false
      } finally {
        $('loginBtn').disabled = false
      }
    })

    $('btnLogout').addEventListener('click', () => {
      clearCred()
      showLogin('已退出，请重新登录')
    })

    $('btnRefresh').addEventListener('click', async () => {
      await refreshAll()
      toast('已刷新', 'ok', 1500)
    })

    // 自动模式
    $('autoToggle').addEventListener('change', async (e) => {
      try {
        await api('/api/channels/auto', {
          method: 'PUT',
          body: JSON.stringify({ auto: e.target.checked })
        })
        toast(e.target.checked ? '已开启自动降级' : '已关闭自动降级', 'ok', 2000)
        $('cfgAuto').textContent = e.target.checked ? '已开启（按优先级降级）' : '已关闭（只用首个通道）'
      } catch (err) {
        if (err.code !== 'UNAUTHORIZED') toast(err.message, 'err')
        e.target.checked = !e.target.checked
      }
    })

    // 新增表单
    $('btnAddToggle').addEventListener('click', () => {
      const form = $('addForm')
      form.hidden = !form.hidden
      if (!form.hidden) form.elements['name'].focus()
    })
    $('btnAddCancel').addEventListener('click', () => {
      $('addForm').hidden = true
      $('addErr').hidden = true
    })

    $('addForm').addEventListener('submit', async (e) => {
      e.preventDefault()
      const f = e.target
      // 注意：不能用 f.name（那是 form 的 name 属性字符串），必须走 elements
      const el = (n) => f.elements[n]
      const body = {
        name: el('name').value.trim(),
        baseURL: el('baseURL').value.trim(),
        model: el('model').value.trim(),
        apiKey: el('apiKey').value.trim(),
        note: el('note').value.trim()
      }
      if (el('priority').value !== '') body.priority = Number(el('priority').value)

      $('btnAddSubmit').disabled = true
      try {
        await api('/api/channels', { method: 'POST', body: JSON.stringify(body) })
        f.reset()
        $('addErr').hidden = true
        $('addForm').hidden = true
        toast('通道已添加', 'ok', 2400)
        await Promise.all([loadChannels(), loadHealth()])
      } catch (err) {
        if (err.code !== 'UNAUTHORIZED') {
          $('addErr').textContent = err.message
          $('addErr').hidden = false
        }
      } finally {
        $('btnAddSubmit').disabled = false
      }
    })

    // 对话
    $('chatForm').addEventListener('submit', (e) => {
      e.preventDefault()
      const text = $('chatText').value.trim()
      if (!text || state.sending) return
      $('chatText').value = ''
      sendChat(text)
    })

    $('btnClearChat').addEventListener('click', () => {
      state.chat = []
      renderChat()
    })

    // 账号：扫码登录 / 刷新 / 取消
    $('btnQrLogin').addEventListener('click', startQr)
    $('btnQrRefresh').addEventListener('click', startQr)
    $('btnQrCancel').addEventListener('click', () => { stopQr(); $('qrWrap').hidden = true })
    $('btnAccRefresh').addEventListener('click', () => { loadAccount(); loadHealth() })

    // 人格（语气外壳）
    $('btnPersonaSave').addEventListener('click', switchPersona)
    $('btnPersonaPreview').addEventListener('click', previewPrompt)
    $('fragList').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-frag]')
      if (btn) openFragment(btn.dataset.frag)
    })

    // 记忆（可修正）
    $('btnMemAdd').addEventListener('click', addMemory)
    $('memText').addEventListener('keydown', (e) => { if (e.key === 'Enter') addMemory() })
    $('btnMemChat').addEventListener('click', showChatHistory)
    $('memList').addEventListener('click', (e) => {
      const ed = e.target.closest('[data-mem-edit]')
      if (ed) return editMemory(ed.dataset.memEdit)
      const del = e.target.closest('[data-mem-del]')
      if (del) return delMemory(del.dataset.memDel)
    })

    // 刷视频时间（上海时区）
    $('btnWrSave')?.addEventListener('click', saveWrites)
    $('btnNodesProbe')?.addEventListener('click', probeNodes)
    $('btnNodesSave')?.addEventListener('click', saveNodes)
    $('btnVisionSave')?.addEventListener('click', saveVision)
    $('btnVisionTest')?.addEventListener('click', testVision)
    $('btnMcpAdd')?.addEventListener('click', addMcp)
    $('btnMcpProbe')?.addEventListener('click', probeMcp)
    $('btnScopeSave')?.addEventListener('click', saveScope)
    $('btnDigestPush')?.addEventListener('click', pushDigest)
    $('btnReplySave')?.addEventListener('click', saveReplyMode)
    $('btnReplyDrill')?.addEventListener('click', drillReply)
    $('btnSchedSave').addEventListener('click', saveSchedule)
    $('btnSchedRun').addEventListener('click', runScheduleNow)
    $('btnSchedReset').addEventListener('click', resetSchedule)
    $('btnSchedAddWin').addEventListener('click', () => {
      const i = document.querySelectorAll('#schedWins .win-row').length
      $('schedWins').insertAdjacentHTML(
        'beforeend',
        `<div class="win-row" data-i="${i}">
          <label class="switch"><input type="checkbox" data-win="enabled" checked /><i></i></label>
          <input class="win-name" data-win="name" value="新时段" maxlength="12" />
          <input class="win-time" data-win="start" value="20:00" placeholder="HH:MM" />
          <span class="win-dash">→</span>
          <input class="win-time" data-win="end" value="21:00" placeholder="HH:MM" />
          <span class="win-per">上限</span>
          <input class="win-num" data-win="perDay" type="number" min="1" max="48" value="1" />
          <button class="btn-icon danger" data-win-del="new" title="删掉这个时段">✕</button>
        </div>`
      )
    })
    $('schedWins').addEventListener('click', (e) => {
      const del = e.target.closest('[data-win-del]')
      if (!del) return
      const row = del.closest('.win-row')
      if (row) row.remove()
    })

    // 小红书 Cookie
    $('btnXhsSave').addEventListener('click', async () => {
      $('btnXhsSave').disabled = true
      try {
        await api('/api/account/xhs', {
          method: 'PUT',
          body: JSON.stringify({ cookie: $('xhsCookie').value.trim(), enabled: $('xhsEnabled').checked })
        })
        $('xhsCookie').value = ''
        toast('小红书配置已保存', 'ok', 2400)
        await loadXhs()
      } catch (err) {
        if (err.code !== 'UNAUTHORIZED') toast(err.message, 'err')
      } finally {
        $('btnXhsSave').disabled = false
      }
    })

    // 工具开关（事件委托，列表重渲染后依然有效）
    $('toolList').addEventListener('change', async (e) => {
      const input = e.target.closest('input[data-tool]')
      if (!input) return
      const name = input.getAttribute('data-tool')
      const enabled = input.checked
      try {
        await api(`/api/tools/${encodeURIComponent(name)}/enabled`, {
          method: 'PUT',
          body: JSON.stringify({ enabled })
        })
        toast(`${name} 已${enabled ? '启用' : '停用'}`, 'ok', 1800)
        const t = state.tools.find(x => x.name === name)
        if (t) t.enabled = enabled
      } catch (err) {
        input.checked = !enabled
        if (err.code !== 'UNAUTHORIZED') toast(err.message, 'err')
      }
    })

    // SMTP
    $('smtpForm').addEventListener('submit', (e) => { e.preventDefault(); saveSmtp() })
    $('btnSmtpTest').addEventListener('click', testSmtp)
  }

  // ------------------------------------------------------------------ 启动
  async function boot() {
    bindEvents()
    renderChat()

    state.cred = loadCred()
    if (!state.cred) {
      showLogin()
      await loadHealth()   // health 无需认证，先把服务状态点亮
      return
    }

    await refreshAll()
  }

  document.addEventListener('DOMContentLoaded', boot)
})()
