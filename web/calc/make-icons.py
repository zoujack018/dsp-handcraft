#!/usr/bin/env python3
# 把 DSQ 的 Scripts/data.json 的图标（每个 80×80 的 base64 PNG，整个文件约 1.6 MB）拼成一张图集，计算器只下载这一张：
#   calc-icons.avif（约 180 KB）、calc-icons.webp（老浏览器用）、calc-icons.js（每个图标的名字和在游戏物品面板里的行列）。
# 行列照游戏 0.10.35 的物品面板（和蓝图生成器的面板一样）：DSQ 的物品名 → 游戏物品 ID（dsq-data.js 配方产物的 itemId，
# 同它的 GAME_ITEM_IDS）→ data/Vanilla.json 的 GridIndex（页×1000 + 行×100 + 列）。对不上 ID 的（木、沙子这几个）行列记 0，不进格子。
# DSQ 的 data.json 加了新图标后重跑一次：python3 web/calc/make-icons.py <DSQ 的目录>（要装 Pillow；不写目录就用 out/DSQ-calc），
# 再 npm run build:web 抄进 web/dist。
import base64, io, json, os, re, sys
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
DSQ = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, '..', '..', 'out', 'DSQ-calc')
SIZE = 64  # 一格的边长：页面上最大显示 32 像素，高清屏刚好一比一
COLS = 16

src = json.load(open(os.path.join(DSQ, 'Scripts', 'data.json'), encoding='utf-8'))
ids = {n: int(i) for n, i in re.findall(r'name:\s*"([^"]+)",\s*itemId:\s*(\d+)', open(os.path.join(HERE, 'dsq-data.js'), encoding='utf-8').read())}
grid = {x['ID']: x['GridIndex'] for x in json.load(open(os.path.join(HERE, '..', '..', 'data', 'Vanilla.json'), encoding='utf-8'))['items']}
icons = {}  # 名字 → (第几页 1 物品 / 2 建筑, 行, 列, PNG)；同名的后一个盖前一个，同 DSQ 的 data.js 的 f_initIcons
for tab, key in ((1, 'icons1'), (2, 'icons2')):
    for ic in src[key]:
        name = re.sub(r'^\d-\d{1,2}-', '', ic['name'])
        gi = grid.get(ids.get(name), 0)
        place = (gi // 1000, gi % 1000 // 100, gi % 100) if gi >= 1000 else (tab, 0, 0)
        icons[name] = (*place, base64.b64decode(ic['value']))

names = list(icons)
rows = (len(names) + COLS - 1) // COLS
sheet = Image.new('RGBA', (COLS * SIZE, rows * SIZE), (0, 0, 0, 0))
for i, name in enumerate(names):
    im = Image.open(io.BytesIO(icons[name][3])).convert('RGBA').resize((SIZE, SIZE), Image.LANCZOS)
    sheet.paste(im, ((i % COLS) * SIZE, (i // COLS) * SIZE))
sheet.save(os.path.join(HERE, 'calc-icons.avif'), 'AVIF', quality=50, speed=4)
sheet.save(os.path.join(HERE, 'calc-icons.webp'), 'WEBP', quality=80, method=6)

lines = ',\n'.join('    ' + json.dumps([n, *icons[n][:3]], ensure_ascii=False) for n in names)
with open(os.path.join(HERE, 'calc-icons.js'), 'w', encoding='utf-8') as f:
    # 普通脚本（不是模块）：网页直接双击打开（file://）也能载入
    f.write('// make-icons.py 生成，别手改。list 每项：[名字, 第几页（1 物品、2 建筑）, 行, 列]，下标就是在图集里的位置（一行 cols 个）\n')
    f.write(f'window.CALC_ICONS = {{\n  cols: {COLS},\n  list: [\n{lines},\n  ],\n}};\n')
print(len(names), 'icons,', 'avif', os.path.getsize(os.path.join(HERE, 'calc-icons.avif')), 'webp', os.path.getsize(os.path.join(HERE, 'calc-icons.webp')))
