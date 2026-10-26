#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
asr_v2.py —— V2 的本地语音识别（faster-whisper，离线）
============================================================================
为什么不在 V1 的 asr.py 上改：
  ① V1 的 asr.py 内部用 yt-dlp 拉音频，2026-10-22 实测被 B 站挡成 HTTP 412；
     V2 侧已经能从 playurl 拿到带 Cookie 的 DASH audio 直链，音频由 Node 下好再喂进来。
  ② 全片转写太贵：6 分钟视频在 4 核机器上跑 small/int8 要 153 秒，
     而「判断这条视频在讲什么」看前 2~3 分钟就够。所以支持 --max-seconds。
  ③ V1 输出的是裸文本，调用方没法知道转了多长、是不是被截断。这里输出 JSON。

约定：
  · stdout 只吐一行 JSON（给 Node 解析），进度/日志全部走 stderr
  · 模型只读本地缓存，绝不联网下模型（这台机器到 HuggingFace 是断的）
  · 全局文件锁串行化：同时跑两路 whisper 会把 4 核打满，两边都变慢

用法：
  .venv-asr/bin/python asr_v2.py /tmp/x.m4s --model small --lang zh --max-seconds 180
"""
import argparse
import json
import os
import sys
import time

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# 模型缓存在 V1 的 bili-duty 目录下（464MB，只有 small），复用不重下
HF_HOME = os.environ.get('BILI_ASR_HF_HOME') or os.environ.get('HF_HOME') or os.path.join(os.path.expanduser('~'), '.cache', 'huggingface')
os.environ.setdefault('HF_HOME', HF_HOME)
os.environ.setdefault('HF_HUB_DISABLE_XET', '1')
os.environ.setdefault('HF_HUB_OFFLINE', '1')      # 只读本地，缺模型立刻报错而不是白等 80 秒
os.environ.setdefault('OMP_NUM_THREADS', str(max(1, (os.cpu_count() or 2) - 1)))

LOCK = os.path.join(HOME, '.tmp', 'asr.lock')


def log(*a):
    print('[asr_v2]', *a, file=sys.stderr)


def resolve_model(size):
    """优先用本地快照目录（离线可靠），找不到就退回模型名让 faster-whisper 自己找"""
    hub = os.path.join(HF_HOME, 'hub')
    snap = os.path.join(hub, 'models--Systran--faster-whisper-%s' % size, 'snapshots')
    if os.path.isdir(snap):
        for h in sorted(os.listdir(snap)):
            p = os.path.join(snap, h)
            if os.path.exists(os.path.join(p, 'model.bin')):
                return p
    return size


def cached_sizes():
    hub = os.path.join(HF_HOME, 'hub')
    out = []
    try:
        for d in os.listdir(hub):
            if d.startswith('models--') and 'faster-whisper-' in d:
                out.append(d.split('faster-whisper-')[-1])
    except Exception:
        pass
    return out


class FileLock:
    """跨进程互斥：ASR 是整轮任务里最吃 CPU 的一步，不能并行"""

    def __init__(self, path):
        self.path = path
        self.fh = None

    def __enter__(self):
        try:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            self.fh = open(self.path, 'w')
            import fcntl
            fcntl.flock(self.fh, fcntl.LOCK_EX)
        except Exception as e:
            log('拿锁失败（继续跑）：%s' % e)
        return self

    def __exit__(self, *a):
        try:
            if self.fh:
                self.fh.close()
        except Exception:
            pass


def main():
    ap = argparse.ArgumentParser(description='本地语音识别，输出 JSON')
    ap.add_argument('audio', help='本地音频/视频文件（不接 URL，音频由调用方下好）')
    ap.add_argument('--model', default='small')
    ap.add_argument('--lang', default='zh')
    ap.add_argument('--max-seconds', type=float, default=0,
                    help='只转前 N 秒（0=全片）。长视频用它省时间')
    ap.add_argument('--lock', default='1', help='1=串行化（默认），0=不拿锁')
    args = ap.parse_args()

    t0 = time.time()
    if not os.path.exists(args.audio):
        print(json.dumps({'ok': False, 'error': '找不到文件：%s' % args.audio}, ensure_ascii=False))
        return 2
    if os.path.getsize(args.audio) < 1024:
        print(json.dumps({'ok': False, 'error': '音频文件过小（%d 字节），下载可能失败'
                          % os.path.getsize(args.audio)}, ensure_ascii=False))
        return 2

    have = cached_sizes()
    model_arg = args.model
    fallback = None
    if have and args.model not in have:
        model_arg = 'small' if 'small' in have else have[0]
        fallback = {'requested': args.model, 'used': model_arg}
    path = resolve_model(model_arg)

    log('模型=%s（可用：%s）文件=%.1fMB 上限=%ss'
        % (model_arg, ','.join(have) or '未知', os.path.getsize(args.audio) / 1048576.0,
           args.max_seconds or '全片'))

    from faster_whisper import WhisperModel

    model = WhisperModel(path, device='cpu', compute_type='int8',
                         local_files_only=not os.path.isdir(path))
    log('模型就绪，开始转写…')

    kw = dict(language=None if args.lang == 'auto' else args.lang, vad_filter=True)
    if args.max_seconds and args.max_seconds > 0:
        kw['clip_timestamps'] = '0,%d' % int(args.max_seconds)

    lock = FileLock(LOCK) if args.lock == '1' else None
    if lock:
        lock.__enter__()
    try:
        segments, info = model.transcribe(args.audio, **kw)
        parts = []
        for seg in segments:
            parts.append(seg.text)
        text = ''.join(parts).strip()
    finally:
        if lock:
            lock.__exit__()

    duration = float(getattr(info, 'duration', 0) or 0)
    covered = min(duration, args.max_seconds) if args.max_seconds else duration
    print(json.dumps({
        'ok': True,
        'model': model_arg,
        'modelFallback': fallback,
        'lang': getattr(info, 'language', args.lang),
        'durationSec': round(duration, 1),
        'coveredSec': round(covered, 1),
        'partial': bool(args.max_seconds and args.max_seconds < duration),
        'segments': len(parts),
        'chars': len(text),
        'elapsedMs': int((time.time() - t0) * 1000),
        'text': text,
    }, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
