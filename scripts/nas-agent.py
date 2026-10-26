#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
nas-agent.py —— 跑在 NAS 上的算力节点（出站拉任务，不需要开端口）

为什么是「拉」不是「被推」：
  你家 NAS 只有一条 Cloudflare Tunnel 暴露 443，22 端口不通；腾讯云也没有 IPv6。
  所以腾讯云连不上 NAS。反过来让 NAS 每 5 秒来拉一次任务就行 —— 出站连接，
  NAT / 隧道后面都能通，不用改任何网络配置。

只依赖 Python 标准库 + 系统 ffmpeg。不需要装任何 pip 包。

用法：
  1) 把 WORKER_TOKEN 发给它（和腾讯云 .env 里的一致）
  2) python3 nas-agent.py
  3) 加个 systemd / 飞牛「计划任务」开机自启

环境变量：
  CORE_BASE    主服务入口（必填，例如 https://core.example.com）
  WORKER_TOKEN 共享密钥（必填）
  AGENT_NAME   节点名，默认 nas
  FFMPEG       ffmpeg 路径，默认 ffmpeg
"""
import base64
import json
import os
import platform
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = os.environ.get('CORE_BASE', '').strip().rstrip('/')
TOKEN = os.environ.get('WORKER_TOKEN', '').strip()
AGENT = os.environ.get('AGENT_NAME', 'nas')
FFMPEG = os.environ.get('FFMPEG', 'ffmpeg')

POLL_SEC = int(os.environ.get('POLL_SEC', '5'))

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'


def log(*a):
    print('[agent]', *a, flush=True)


def http(path, method='GET', body=None, timeout=30):
    url = BASE + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        'x-worker-token': TOKEN,
        'Content-Type': 'application/json',
        'User-Agent': AGENT,
    })
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
        if not raw:
            return None
        return json.loads(raw)


# ------------------------------------------------------------------ 任务实现

def task_probe(_payload):
    """上报硬件与工具链 —— 让远端一次看清这台机器能干什么，省得人工敲命令。"""
    info = {
        'host': platform.node(),
        'system': f'{platform.system()} {platform.release()}',
        'machine': platform.machine(),
        'python': platform.python_version(),
        'cpuCount': os.cpu_count(),
        'agentVersion': '1.0.0',
    }
    # CPU 型号
    try:
        with open('/proc/cpuinfo') as f:
            for line in f:
                if 'model name' in line:
                    info['cpu'] = line.split(':', 1)[1].strip()
                    break
    except Exception:
        pass
    # 内存
    try:
        with open('/proc/meminfo') as f:
            kv = dict(line.split(':', 1) for line in f if ':' in line)
        info['memTotalMB'] = int(kv['MemTotal'].split()[0]) // 1024
        info['memAvailableMB'] = int(kv['MemAvailable'].split()[0]) // 1024
    except Exception:
        pass
    # ffmpeg 能力（重点看 qsv 在不在）
    ff = shutil.which(FFMPEG)
    info['ffmpeg'] = ff or None
    if ff:
        try:
            v = subprocess.run([ff, '-hide_banner', '-version'], capture_output=True, text=True, timeout=20)
            info['ffmpegVersion'] = (v.stdout or '').split('\n')[0][:120]
            h = subprocess.run([ff, '-hide_banner', '-hwaccels'], capture_output=True, text=True, timeout=20)
            accels = [x.strip() for x in (h.stdout or '').split('\n') if x.strip() and ':' not in x]
            info['hwaccels'] = accels
            info['hasQsv'] = 'qsv' in accels
        except Exception as e:
            info['ffmpegError'] = str(e)[:120]
    # docker
    dk = shutil.which('docker')
    info['docker'] = bool(dk)
    if dk:
        try:
            d = subprocess.run([dk, '--version'], capture_output=True, text=True, timeout=15)
            info['dockerVersion'] = (d.stdout or '').strip()[:80]
        except Exception:
            pass
    return info


# ⚠️ B站 CDN 会校验 UA：ffmpeg 默认发的是 "Lavf/6.1.1"，直接被判 403。
#    必须伪装成浏览器。Referer 和 UA 两个都要，少一个都不行（2026-10-23 实测）。
DEFAULT_UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
              '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36')


def _ffmpeg_frame(url, sec, out_path, width=1280, qsv=True, extra_headers=None):
    """抽一帧。qsv 硬解失败时自动回落软解。"""
    h = {'Referer': 'https://www.bilibili.com/', 'User-Agent': DEFAULT_UA}
    if extra_headers:
        h.update({str(k): str(v) for k, v in extra_headers.items()})
    headers = ''.join(f'{k}: {v}\r\n' for k, v in h.items())
    # ⚠️ -rw_timeout：网络 IO 超时（微秒）。不加的话，ffmpeg seek 到流尾部或
    #    CDN 慢响应时会**无限等**，任务永远不返回，上层只能超时 —— 2026-10-23 踩到。
    base = [FFMPEG, '-hide_banner', '-loglevel', 'error', '-nostdin',
            '-rw_timeout', '15000000',
            '-headers', headers]
    attempts = []
    if qsv:
        attempts.append(base + ['-hwaccel', 'qsv'])
    attempts.append(base)
    last = ''
    for cmd in attempts:
        full = cmd + ['-ss', str(sec), '-i', url,
                      '-frames:v', '1', '-vf', f'scale={width}:-2',
                      '-q:v', '3', '-y', out_path]
        try:
            p = subprocess.run(full, capture_output=True, text=True, timeout=90)
            if p.returncode == 0 and os.path.exists(out_path) and os.path.getsize(out_path) > 1024:
                return True, os.path.getsize(out_path)
            last = (p.stderr or '')[:200]
        except Exception as e:
            last = str(e)[:200]
    return False, last


def task_frames(payload):
    """按指定秒数抽帧，返回 base64 图片（不传视频，只传缩好的帧）。"""
    url = payload.get('videoUrl') or ''
    times = payload.get('times') or []
    width = int(payload.get('width') or 1280)
    qsv = bool(payload.get('qsv', True))
    if not url:
        raise ValueError('缺少 videoUrl')
    if not times:
        raise ValueError('缺少 times（秒数数组）')

    tmp = tempfile.mkdtemp(prefix='vpframe-')
    frames = []
    try:
        for i, sec in enumerate(times[:8]):
            p = os.path.join(tmp, f'f{i:02d}.jpg')
            ok, info = _ffmpeg_frame(url, sec, p, width=width, qsv=qsv, extra_headers=payload.get('headers'))
            if not ok:
                frames.append({'sec': sec, 'ok': False, 'error': str(info)[:120]})
                continue
            with open(p, 'rb') as f:
                b64 = base64.b64encode(f.read()).decode('ascii')
            frames.append({'sec': sec, 'ok': True, 'kb': round(len(b64) * 3 / 4 / 1024, 1), 'b64': b64})
        return {'frames': frames, 'count': len([f for f in frames if f.get('ok')]), 'width': width}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def task_asr(payload):
    """远程语音识别（SenseVoice / sherpa-onnx）。

    为什么放在 worker 上算：腾讯云只有 4 核、cgroup 1.5G，
    本地跑 ASR 会挤占主服务内存；放到这边算完只回文本，腾讯云不背这个负担。
    B站 cookie 不下发 —— 只接「带时效的音频直链」，节点拿门票去 CDN 取货。
    """
    url = payload.get('audioUrl') or ''
    max_sec = float(payload.get('maxSeconds') or 180)
    if not url:
        raise ValueError('缺少 audioUrl')

    model_dir = os.environ.get('SENSE_MODEL_DIR') or '/data/sensevoice'
    onnx = os.path.join(model_dir, 'model.int8.onnx')
    tokens = os.path.join(model_dir, 'tokens.txt')
    if not (os.path.exists(onnx) and os.path.exists(tokens)):
        raise ValueError('SenseVoice 模型缺失：%s' % model_dir)

    import urllib.request
    tmp = tempfile.mkdtemp(prefix='vpasr-')
    audio = os.path.join(tmp, 'a.m4s')
    wav = os.path.join(tmp, 'a.wav')
    try:
        req = urllib.request.Request(url, headers={
            'User-Agent': DEFAULT_UA,
            'Referer': 'https://www.bilibili.com/'
        })
        with urllib.request.urlopen(req, timeout=60) as r, open(audio, 'wb') as f:
            shutil.copyfileobj(r, f)

        # 用容器里的 ffmpeg 转 16k 单声道 wav（sherpa 要 float32，wave 再读）
        p = subprocess.run(
            [FFMPEG, '-hide_banner', '-loglevel', 'error', '-nostdin', '-rw_timeout', '15000000',
             '-i', audio, '-t', str(max_sec), '-ar', '16000', '-ac', '1', '-f', 'wav', '-y', wav],
            capture_output=True, text=True, timeout=180)
        if p.returncode != 0 or not os.path.exists(wav):
            raise ValueError('音频转码失败：%s' % (p.stderr or '')[:160])

        import wave
        import numpy as np
        import sherpa_onnx
        with wave.open(wav, 'rb') as wf:
            frames = wf.readframes(wf.getnframes())
            rate = wf.getframerate()
        samples = np.frombuffer(frames, dtype=np.int16).astype('float32') / 32768.0
        dur = samples.shape[0] / float(rate or 16000)

        rec = sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=onnx, tokens=tokens,
            num_threads=int(os.environ.get('ASR_THREADS') or (os.cpu_count() or 2)),
            use_itn=True, debug=False,
            language=str(payload.get('lang') or 'zh'))
        st = rec.create_stream()
        st.accept_waveform(16000, samples)
        rec.decode_stream(st)
        text = (st.result.text or '').strip()
        return {
            'engine': 'sensevoice',
            'node': AGENT,
            'text': text,
            'chars': len(text),
            'durationSec': round(dur, 1),
            'coveredSec': round(dur, 1),
            'partial': bool(max_sec < dur + 0.5)
        }
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


HANDLERS = {'probe': task_probe, 'frames': task_frames, 'asr': task_asr}


# ------------------------------------------------------------------ 主循环

def run_once():
    task = http(f'/api/worker/next?agent={urllib.parse.quote(AGENT)}', timeout=30)
    if not task:
        return False
    tid, ttype = task['id'], task['type']
    log('领到任务', ttype, tid[:8])
    t0 = time.time()
    try:
        fn = HANDLERS.get(ttype)
        if not fn:
            raise ValueError(f'本节点不支持任务类型 {ttype}')
        result = fn(task.get('payload') or {})
        ms = int((time.time() - t0) * 1000)
        log('完成', ttype, f'{ms}ms')
        http('/api/worker/result', 'POST', {'id': tid, 'ok': True, 'result': result, 'agent': AGENT}, timeout=60)
    except Exception as e:
        log('失败', ttype, str(e)[:160])
        try:
            http('/api/worker/result', 'POST', {'id': tid, 'ok': False, 'error': str(e)[:300], 'agent': AGENT}, timeout=30)
        except Exception as e2:
            log('回传失败', str(e2)[:120])
    return True


def main():
    endpoint = urllib.parse.urlparse(BASE)
    if endpoint.scheme not in ('http', 'https') or not endpoint.netloc:
        print('请设置 CORE_BASE 为主服务的完整 HTTP(S) 地址', file=sys.stderr)
        return 1
    if not TOKEN:
        print('缺少 WORKER_TOKEN 环境变量，退出', file=sys.stderr)
        return 1
    log(f'启动：{AGENT} → {BASE}（每 {POLL_SEC}s 拉一次）')
    while True:
        try:
            busy = run_once()
            if not busy:
                time.sleep(POLL_SEC)
        except KeyboardInterrupt:
            log('手动停止')
            return 0
        except Exception as e:
            log('循环异常', str(e)[:160])
            time.sleep(POLL_SEC * 2)


if __name__ == '__main__':
    sys.exit(main())
