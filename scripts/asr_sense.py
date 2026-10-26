#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
asr_sense.py —— SenseVoice 语音识别（sherpa-onnx，ONNX 运行时）
============================================================================
为什么换掉 faster-whisper：
  实测 faster-whisper small 在 4 核 CPU 上跑 3 分钟音频要 **75 秒**（0.4x 实时），
  值班一轮 150 秒超时根本等不到，所以之前只能在 prompt 里禁止用它。
  SenseVoice-Small 是非自回归架构，官方标称 CPU **17.2x 实时**，
  3 分钟音频理论上 10 秒左右；中文准确率更高，还**自带标点**（whisper 没有）。

依赖：sherpa-onnx（ONNX Runtime，不装 torch）、PyAV（解码 m4s）、numpy
模型：models/sensevoice/model.int8.onnx + tokens.txt

用法：
  python asr_sense.py /tmp/x.m4s --lang zh --max-seconds 180
输出口径与 asr_v2.py 完全一致（上层不用改判断逻辑）。
"""
import argparse
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
MODEL_DIR = os.environ.get('SENSE_MODEL_DIR') or os.path.join(ROOT, 'models', 'sensevoice')
MODEL_ONNX = os.path.join(MODEL_DIR, 'model.int8.onnx')
TOKENS = os.path.join(MODEL_DIR, 'tokens.txt')


def log(msg):
    print('[sense] %s' % msg, flush=True)


def decode_audio(path, max_seconds=0):
    """用 PyAV 解出 16kHz 单声道 float32。不依赖系统 ffmpeg。"""
    import av
    import numpy as np

    container = av.open(path)
    if not container.streams.audio:
        raise ValueError('文件里没有音频轨')
    stream = container.streams.audio[0]
    resampler = av.AudioResampler(format='flt', layout='mono', rate=16000)
    chunks = []
    total = 0
    limit = int(max_seconds * 16000) if max_seconds and max_seconds > 0 else 0
    for frame in container.decode(stream):
        for rf in resampler.resample(frame):
            arr = rf.to_ndarray().reshape(-1).astype('float32')
            chunks.append(arr)
            total += arr.shape[0]
        if limit and total >= limit:
            break
    container.close()
    if not chunks:
        raise ValueError('解码后没有采样数据')
    samples = np.concatenate(chunks)
    if limit and samples.shape[0] > limit:
        samples = samples[:limit]
    return samples, samples.shape[0] / 16000.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('audio')
    ap.add_argument('--lang', default='zh', help='zh / en / ja / ko / yue / auto')
    ap.add_argument('--max-seconds', type=float, default=0)
    ap.add_argument('--threads', type=int, default=0, help='0=按 CPU 核数自动')
    args = ap.parse_args()

    t0 = time.time()
    if not os.path.exists(args.audio):
        print(json.dumps({'ok': False, 'error': '找不到文件：%s' % args.audio}, ensure_ascii=False))
        return 2
    if not (os.path.exists(MODEL_ONNX) and os.path.exists(TOKENS)):
        print(json.dumps({'ok': False, 'error': 'SenseVoice 模型缺失：%s' % MODEL_DIR,
                          'hint': '需要 model.int8.onnx 与 tokens.txt'}, ensure_ascii=False))
        return 3

    try:
        import sherpa_onnx
    except Exception as e:
        print(json.dumps({'ok': False, 'error': 'sherpa-onnx 不可用：%s' % e}, ensure_ascii=False))
        return 4

    samples, covered = decode_audio(args.audio, args.max_seconds)
    log('音频 %.1fs，开始识别…' % covered)

    threads = args.threads or max(1, (os.cpu_count() or 4))
    lang = '' if args.lang == 'auto' else args.lang
    recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
        model=MODEL_ONNX,
        tokens=TOKENS,
        num_threads=threads,
        use_itn=True,        # 逆文本归一化：数字/日期/标点自动修
        debug=False,
        language=lang or 'zh',
    )

    stream = recognizer.create_stream()
    stream.accept_waveform(16000, samples)
    recognizer.decode_stream(stream)
    text = (stream.result.text or '').strip()

    print(json.dumps({
        'ok': True,
        'engine': 'sensevoice',
        'model': 'SenseVoiceSmall.int8',
        'lang': lang or 'zh',
        'durationSec': round(covered, 1),
        'coveredSec': round(covered, 1),
        'partial': bool(args.max_seconds and args.max_seconds > 0 and covered >= args.max_seconds - 0.5),
        'chars': len(text),
        'elapsedMs': int((time.time() - t0) * 1000),
        'text': text,
    }, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
