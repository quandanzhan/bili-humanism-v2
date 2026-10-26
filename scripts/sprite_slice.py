#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
B站预览精灵图切格器（免 ffmpeg）
============================================================================
为什么需要这个：
  服务器没有 ffmpeg（2026-10-22 实测），但 B 站 `x/player/videoshot` 会直接给
  「预览精灵图」——一张 10x10 的大图，每格是一帧（480x270），并附 index 秒数表。
  这等价于官方帮我们抽好帧了，只要本地切格即可，不需要解码视频。

  切格用 PIL（bili-duty 的 .venv 里已有 PIL 11.3），做到：
    · 按 index 秒数均匀挑 N 帧
    · 缩到 maxWidth（默认 400）压成 JPEG，控制 base64 体积
    · 输出严格 JSON（stdout），错误也走 JSON（stderr 只放日志）

用法：
  echo '{"images":["https://..."],"xLen":10,"yLen":10,"xSize":480,"ySize":270,"index":[0,0,8,...],"count":6}' \
    | python3 sprite_slice.py
  或  python3 sprite_slice.py '<json>'

输出：
  {"ok":true,"total":100,"frames":[{"i":3,"sec":25,"w":400,"h":225,"b64":"..."}]}
"""
import base64
import io
import json
import sys
import urllib.request

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'


def fetch(url, timeout=15):
    req = urllib.request.Request(url, headers={
        'User-Agent': UA,
        'Referer': 'https://www.bilibili.com/',
        'Accept': 'image/avif,image/webp,image/*,*/*;q=0.8',
    })
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def _hue_name(r, g, b):
    """把一个颜色归到人类会说的色名上（含黑白灰）"""
    import colorsys
    h, s, v = colorsys.rgb_to_hsv(r / 255.0, g / 255.0, b / 255.0)
    if v < 0.12:
        return '黑'
    if s < 0.12:
        return '白' if v > 0.85 else '灰'
    hd = h * 360.0
    if hd < 15 or hd >= 345:
        return '红'
    if hd < 40:
        return '橙'
    if hd < 65:
        return '黄'
    if hd < 160:
        return '绿'
    if hd < 195:
        return '青'
    if hd < 255:
        return '蓝'
    if hd < 290:
        return '紫'
    return '品红'


def look_of(img):
    """客观像素统计（不猜内容，只量颜色）。

    为什么要有这一步：服务器上现有的模型通道**都不支持图像输入**
    （DeepSeek 系列不吃图），取到帧也只能剥掉。既然如此，至少把「这一帧
    到底是什么色调、多亮、有多少死黑」量出来交给模型——它能据此判断
    「这是夜景/这是白墙特写/这是字幕板」，而不是瞎猜。
    """
    try:
        small = img.convert('RGB').resize((32, 18))
        px = list(small.getdata())
    except Exception:
        return None
    n = float(len(px)) or 1.0
    sr = sum(p[0] for p in px) / n
    sg = sum(p[1] for p in px) / n
    sb = sum(p[2] for p in px) / n
    lumas = [0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2] for p in px]
    luma = sum(lumas) / n
    var = sum((x - luma) ** 2 for x in lumas) / n
    contrast = var ** 0.5

    sat_sum = 0.0
    dark = bright = 0
    buckets = {}
    chroma = {}
    for p in px:
        mx, mn = max(p), min(p)
        sat_sum += 0.0 if mx == 0 else (mx - mn) / float(mx)
        L = 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]
        if L < 40:
            dark += 1
        if L > 215:
            bright += 1
        name = _hue_name(*p)
        buckets[name] = buckets.get(name, 0) + 1
        if name not in ('黑', '白', '灰'):
            chroma[name] = chroma.get(name, 0) + 1
    sat = sat_sum / n
    dominant = max(buckets, key=buckets.get)
    main_chroma = max(chroma, key=chroma.get) if chroma else ''

    # ── 把数字翻成人话（措辞都留余地，不当成事实）──
    if luma < 40:
        light = '很暗'
    elif luma < 90:
        light = '偏暗'
    elif luma < 165:
        light = '亮度中等'
    else:
        light = '很亮'

    if sat < 0.18:
        satw = '几乎无彩（灰扑扑/白墙/字幕板那种）'
    elif sat < 0.38:
        satw = '色彩偏淡'
    elif sat < 0.6:
        satw = '色彩正常'
    else:
        satw = '色彩很艳'

    if contrast < 22:
        conw = '层次平'
    elif contrast < 55:
        conw = '对比中等'
    else:
        conw = '明暗对比强'

    tags = []
    dark_ratio = dark / n
    bright_ratio = bright / n
    if dark_ratio > 0.55:
        tags.append('大面积暗部（夜景/弱光/黑底）')
    if bright_ratio > 0.45:
        tags.append('大面积高光（白墙/雪景/过曝/白底）')
    if sat < 0.18 and contrast > 45:
        tags.append('像字幕板/图表/黑白画面')
    if sat > 0.5 and main_chroma in ('红', '橙', '黄'):
        tags.append('暖色为主（夕照/暖光/美食特写常见）')
    if main_chroma in ('蓝', '青') and luma < 110:
        tags.append('冷色偏暗（夜景/科技感/屏幕录屏）')

    return {
        'rgb': '%d,%d,%d' % (round(sr), round(sg), round(sb)),
        'luma': round(luma),
        'sat': round(sat, 3),
        'contrast': round(contrast),
        'darkRatio': round(dark_ratio, 2),
        'brightRatio': round(bright_ratio, 2),
        'dominant': dominant,
        'mainChroma': main_chroma,
        'text': ('%s（亮度 %d/255），%s，主色「%s」%s，%s'
                 % (light, round(luma), conw, dominant,
                    ('，以%s为主' % main_chroma) if main_chroma else '', satw)),
        'tags': tags,
    }


def dhash(im, size=8):
    """感知哈希（dHash 64 位）—— 判断两帧是不是「同一画面」。

    为什么不用 luma/主色：PPT 换页时深色底不变、亮度不变，但内容全变了，
    只看颜色会误判成「没变化」。dHash 比的是**相邻像素的梯度结构**，
    换页、换镜头都能抓住。
    参考 LENS(ECCV 2026) 用 SSIM 建「视频图」的思路，这里用更轻的 dHash 代替
    （SSIM 需要 numpy，本 venv 没有；dHash 纯 PIL 20 行，够用）。
    """
    # ⚠️ Image 只在 main() 里 import 过，模块级函数拿不到，必须就地导入
    from PIL import Image

    g = im.convert('L').resize((size + 1, size), Image.LANCZOS)
    px = list(g.getdata())
    w = size + 1
    bits = 0
    for r in range(size):
        base = r * w
        for c in range(size):
            bits = (bits << 1) | (1 if px[base + c] > px[base + c + 1] else 0)
    return bits


def hamming(a, b):
    return bin(a ^ b).count('1')


def pick_smart(cands, count):
    """按「分段预算 + 变化优先」挑帧（QCA 思路的轻量版）。

    背景（2026-10-23 实测）：6 分钟 PPT 视频均匀抽 9 帧，7/8 帧「看起来一样」，
    等于把同一张深色 PPT 看了 9 遍，白花 8 次视觉调用。

    做法：
      1. 把候选帧按时间**分段**（段数 = count），保证首尾都覆盖到，不会全挤在一段
      2. 每段内挑「与上一个选中的帧 dHash 距离最大」的那帧 —— 即这一段的转折点
      3. 段内都太像（最大距离仍 < 阈值）时，就取段中点，保证均匀兜底
    """
    n = len(cands)
    if n <= count:
        return list(range(n))

    seg = n / float(count)
    picked = []
    prev_hash = None
    for k in range(count):
        lo = int(seg * k)
        hi = max(lo + 1, int(seg * (k + 1)))
        seg_items = cands[lo:hi]
        if not seg_items:
            continue
        if prev_hash is None:
            # 第一段取中点：片头常是黑场/logo，中间更可能是正片
            best = len(seg_items) // 2
        else:
            scores = [hamming(h, prev_hash) for _, _, _, h in seg_items]
            mx = max(scores)
            best = scores.index(mx) if mx >= 6 else len(seg_items) // 2
        item = seg_items[best]
        picked.append(item)
        prev_hash = item[3]
    return picked


def fail(msg, code='SPRITE_FAILED'):
    print(json.dumps({'ok': False, 'error': msg, 'code': code}, ensure_ascii=False))
    return 1


def main():
    raw = sys.argv[1] if len(sys.argv) > 1 else sys.stdin.read()
    try:
        cfg = json.loads(raw)
    except Exception as e:
        return fail('参数不是合法 JSON: %s' % e, 'BAD_ARGS')

    images = cfg.get('images') or []
    x_len = int(cfg.get('xLen') or 0)
    y_len = int(cfg.get('yLen') or 0)
    x_size = int(cfg.get('xSize') or 0)
    y_size = int(cfg.get('ySize') or 0)
    index = cfg.get('index') or []
    count = max(1, min(12, int(cfg.get('count') or 6)))
    max_w = max(120, min(960, int(cfg.get('maxWidth') or 400)))
    select_mode = str(cfg.get('select') or 'smart').lower()
    if select_mode not in ('smart', 'uniform'):
        select_mode = 'smart'
    quality = max(40, min(92, int(cfg.get('quality') or 78)))

    if not images or not x_len or not y_len:
        return fail('缺少 images / xLen / yLen', 'BAD_ARGS')
    index = index if isinstance(index, list) else []

    try:
        from PIL import Image
    except Exception as e:
        return fail('PIL 不可用: %s' % e, 'NO_PIL')

    # ── 内存纪律（2026-10-23 真机事故后重写）────────────────────────────
    # 事故：B站精灵图整张 4800x2700，PIL 解码成 RGB 就是 38.9MB/张；
    #       原实现把所有 sheet 和全部 100 个格子都留在 frames 列表里，
    #       单次调用峰值冲到 300MB+，把 512MB 的 cgroup 撑爆 →
    #       systemd 判定 oom-kill → 服务半夜连环重启十几次 → 值班只跑了半轮。
    # 现在的做法：
    #   ① 第一遍只 Image.open 读尺寸（读头，不解像素）
    #   ② 按全局索引算出「要哪几格」，再逐张打开、只裁那几格、立刻 close
    #   ③ 同一时刻最多只有 1 张 sheet 在内存里

    def sheet_count(w, h):
        cols = min(x_len, w // x_size) if x_size else 0
        rows = min(y_len, h // y_size) if y_size else 0
        return max(0, cols), max(0, rows)

    # ① 只读尺寸
    metas = []
    for u in images:
        url = u if u.startswith('http') else ('https:' + u)
        try:
            raw = fetch(url)
            with Image.open(io.BytesIO(raw)) as im:
                w, h = im.size
            cols, rows = sheet_count(w, h)
            if cols and rows:
                metas.append({'url': url, 'cols': cols, 'rows': rows, 'count': cols * rows, 'bytes': raw})
            del raw
        except Exception as e:
            print('[slice] 读取失败 %s: %s' % (url, e), file=sys.stderr)

    # ⚠️ 关键（2026-10-23 实测发现）：
    #   B站精灵图固定给 10x10=100 格，但**只有前 N 格是真帧**，其余是空的。
    #   6 分钟视频：100 格只有 45 真帧（index 45 个，间隔 8s）
    #   19 分钟视频：300 格只有 228 真帧（index 228 个，间隔 5s）
    #   原来按「格子数」均匀挑，后面 55% 全落在空格上 → 被黑场过滤掉
    #   → 抽到的帧全挤在视频前 1/4，长视频等于只看开头。
    #   所以有效帧数必须以 index 长度为准。
    grid_total = sum(m['count'] for m in metas)
    total = min(grid_total, len(index)) if index else grid_total
    if not total:
        return fail('精灵图里没有切出任何帧', 'EMPTY_SHEET')
    orig_total = total

    def locate(gi):
        """全局帧号 → (sheet 元信息, gx, gy)"""
        acc = 0
        for m in metas:
            if gi < acc + m['count']:
                k = gi - acc
                return m, k % m['cols'], k // m['cols']
            acc += m['count']
        return None, 0, 0

    # ② 候选池（比 count 大 6 倍，给黑场/重复帧留替补）
    want = min(total, max(count * 6, count))
    if want >= total:
        cand = list(range(total))
    else:
        lo = int(total * 0.05)
        hi = max(lo + 1, total - int(total * 0.05))
        step = (hi - lo) / float(want)
        cand = sorted({min(total - 1, lo + int(step * i + step / 2)) for i in range(want)})

    def group_by_sheet(gilist):
        g = {}
        for gi in gilist:
            m, gx, gy = locate(gi)
            if m:
                g.setdefault(m['url'], []).append((gi, gx, gy))
        return g

    def crop_box(gx, gy):
        return (gx * x_size, gy * y_size, (gx + 1) * x_size, (gy + 1) * y_size)

    # ③ 第一轮：只算 dHash（缩略图 64x36，很小），不保留大图
    hashed = []
    cand_groups = group_by_sheet(cand)
    for m in metas:
        items = cand_groups.get(m['url'])
        if not items:
            continue
        try:
            with Image.open(io.BytesIO(m['bytes'])) as sheet:
                rgb = sheet.convert('RGB')
                for gi, gx, gy in items:
                    thumb = rgb.crop(crop_box(gx, gy)).resize((64, 36), Image.LANCZOS)
                    hashed.append((gi, gx, gy, dhash(thumb)))
                    del thumb
                del rgb
        except Exception as e:
            print('[slice] hash 阶段失败 %s: %s' % (m['url'], e), file=sys.stderr)
    hashed.sort(key=lambda x: x[0])

    # ④ 选帧：smart=分段+变化优先，uniform=按位置均匀
    if not hashed:
        return fail('没有可分析的帧', 'EMPTY_SHEET')
    if select_mode == 'smart':
        chosen = pick_smart(hashed, count)
    else:
        n = len(hashed)
        step = n / float(count)
        chosen = [hashed[min(n - 1, int(step * i + step / 2))] for i in range(count)]

    # ⑤ 第二轮：只裁选中的那几帧（高清），并计算 look 色卡
    out = []
    chosen_groups = group_by_sheet([c[0] for c in chosen])
    want_i = set(c[0] for c in chosen)
    for m in metas:
        items = chosen_groups.get(m['url'])
        if not items:
            continue
        try:
            with Image.open(io.BytesIO(m['bytes'])) as sheet:
                rgb = sheet.convert('RGB')
                for gi, gx, gy in items:
                    if gi not in want_i:
                        continue
                    img = rgb.crop(crop_box(gx, gy))
                    ext = img.convert('L').getextrema()
                    if ext[1] - ext[0] < 12:
                        continue  # 黑场/纯色，不要
                    look = look_of(img)
                    w, h = img.size
                    if w > max_w:
                        img = img.resize((max_w, int(h * max_w / w)), Image.LANCZOS)
                    buf = io.BytesIO()
                    img.save(buf, format='JPEG', quality=quality, optimize=True)
                    b64 = base64.b64encode(buf.getvalue()).decode('ascii')
                    sec = None
                    if gi < len(index):
                        try:
                            sec = int(index[gi])
                        except Exception:
                            sec = None
                    out.append({
                        'i': gi,
                        'sec': sec,
                        'w': img.size[0],
                        'h': img.size[1],
                        'kb': round(len(b64) * 3 / 4 / 1024, 1),
                        'look': look,
                        'b64': b64,
                    })
                    del img, buf
                del rgb
        except Exception as e:
            print('[slice] 裁帧失败 %s: %s' % (m['url'], e), file=sys.stderr)
        finally:
            m['bytes'] = None

    if not out:
        return fail('所有候选帧都是黑场/纯色', 'ALL_BLANK')

    out.sort(key=lambda f: f['i'])
    if not out:
        return fail('所有候选帧都是黑场/纯色', 'ALL_BLANK')
    total = orig_total

    print(json.dumps({'ok': True, 'total': total, 'origTotal': orig_total, 'picked': len(out), 'frames': out}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
