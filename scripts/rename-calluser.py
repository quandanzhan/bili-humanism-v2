#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把人格里对用户的称呼从「鱼片」改成「老大」（带时间戳备份）"""
import json
import os
import shutil
import time

P = os.environ.get('PERSONA_DIR', '').strip()
if not P:
    raise SystemExit('请设置 PERSONA_DIR 指向待修改的人格目录')
TS = time.strftime('%Y%m%d-%H%M%S')
agents = os.path.join(P, 'AGENTS.md')
meta = os.path.join(P, 'PERSONA.json')

for f in (agents, meta):
    bak = f + '.bak-' + TS
    shutil.copy2(f, bak)
    print('备份 →', bak)

# ---- 1) AGENTS.md：正文里的称呼 ----
s = open(agents, encoding='utf-8').read()
before = s.count('鱼片')
s = s.replace('管用户叫「**鱼片**」', '管用户叫「**老大**」')
s = s.replace('必须先问鱼片', '必须先问老大')
# 示例对话里的「鱼片，」也一并改（否则示例会继续教它叫鱼片）
s = s.replace('> 鱼片，', '> 老大，')
open(agents, 'w', encoding='utf-8').write(s)
after = s.count('鱼片')
print('AGENTS.md：「鱼片」%d 处 → %d 处' % (before, after))

# ---- 2) PERSONA.json：只改 whale（当前启用），maojiang 保持原样 ----
d = json.load(open(meta, encoding='utf-8'))
for p in d.get('personas', []):
    if p.get('id') == 'whale':
        old = p.get('callUser')
        p['callUser'] = '老大'
        print('PERSONA.json：whale.callUser %s → 老大' % old)
json.dump(d, open(meta, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)

print('\n--- 校验 ---')
for l in open(agents, encoding='utf-8'):
    if '老大' in l or '鱼片' in l:
        print(' ', l.rstrip())
print('callUser:', [p.get('callUser') for p in json.load(open(meta, encoding='utf-8'))['personas']])
