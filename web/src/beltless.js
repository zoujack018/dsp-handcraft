// 无带蓝图的平面图：量产计算器「生成无带蓝图」带过来的输入（handoff.js 的 beltless），src/beltless 出整张、重新摆放的那张。
// 画法同布线图（drawing.js）：深蓝底白线，网格 1 格细线、5 格粗线；机器画碰撞体那么大（src/gamedata.js），样子、标号同布线图（factoryShape）：
// 每组工厂（同一种设备做同一样）一个字母，熔炉小写 a、b、c…，别的大写 A、B、C…（同 model.js 的 groupLabels），每台再按看图的顺序编号；
// 传送带顺着下游连成一条条，按运的物品上色（颜色表同布线图），运什么看带头带尾的标签或接在上面的分拣器筛的物品。带子、分拣器、物流站（T1、T2…）、
// 供电、喷涂机的样子同布线图（runShape、sorterShape、stationShape、powerShape、deviceShape），带子区叠着的几层画在一起，高架的画虚线（同布线图的总览）。
// 带头、带尾有标签又不接物流站的是进出口：原料入口虚线圈、产物出口实线圈，顺着带往外一格框着放物品图标（同布线图的原料入口）。
// 无带流的分拣器摆在机器边上，和带子区里的带子隔空连着（蓝图里记的上下游，要原地重建一次才连上），连线不画（几百根太费）。研究站叠几层只画一个框、写 ×层数。
// 带子区（传送带、喷涂机，两头都不接机器的分拣器）画在一组里（.bl-zone），外面一圈虚线框，整块能围着机器拖（app.js），进出口的图标和框上那行字
// 另放一组（.bl-zone-marks），拖的时候跟着挪、不跟着转。接了物流站时每块（站连它的带子、中间产物带，repack.js 的 parts）各一组（.bl-part），各自拖。
import { COLORS, LINE, FINE, factoryShape, stationShape, powerShape, deviceShape, sorterShape, runShape, viaShape, portShape, sliceRoutes, runPoints } from './drawing.js';

const PAPER = '#112f52';
const FAINT = '#6f90b3';
const ARM = '#dbe8f7';
const FRAME = '#82a2c3'; // 图框线，同布线图
const SANS = '"DIN Alternate", "Bahnschrift", "PingFang SC", "Microsoft YaHei", sans-serif'; // 同布线图的字
const KIND = { 2302: 'smelter', 2315: 'smelter', 2319: 'smelter', 2303: 'assembler', 2304: 'assembler', 2305: 'assembler', 2318: 'assembler', 2309: 'chemical', 2317: 'chemical', 2308: 'refinery', 2310: 'collider', 2901: 'lab', 2902: 'lab' };
/** 机器的框（格，朝北时）：宽、高、中心偏移；量子化工厂 8 宽（同 src/gamedata.js），研究站同布线图收到 4.3 */
const FOOT = { smelter: [2.4, 2.4], assembler: [3.2, 3.2], lab: [4.3, 4.3], chemical: [6.8, 4, 0, 0.5], refinery: [2.8, 5.6, 0, -0.4], collider: [9, 5, -0.3, 0] };
const BELTS = new Set([2001, 2002, 2003]);
const SORTERS = new Set([2011, 2012, 2013, 2014]);
const STATION = 2104;
const COATER = 2313;
const F3 = (v) => Math.round(v * 1000) / 1000;
const LATIN = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const SMALL = 'abcdefghijkmnpqrstuvwxyz'; // 不用 l、o，和数字 1、0 分不清（同 model.js）
// 标号和字（同 drawing.js 的 tag、text，不转方向）
const tag = (x, y, letter, num, size) => `<text x="${x}" y="${F3(y + size * 0.35)}" fill="${LINE}" font-size="${size}" font-family='${SANS}' font-weight="500" text-anchor="middle">${letter}${num ? `<tspan dx="${F3(size * 0.12)}">${num}</tspan>` : ''}</text>`;
const text = (x, y, value, size = 0.8, color = LINE, weight = 400, extra = '') => `<text x="${x}" y="${y}" fill="${color}" font-size="${size}" font-family='${SANS}' font-weight="${weight}" text-anchor="middle" dominant-baseline="central"${extra}>${value}</text>`;
const yawOf = (b) => ((Math.round(b.yaw) % 360) + 360) % 360;

/**
 * buildings：worker.js 的 inspectBlueprint 给的；icon(物品 ID)：以 (0, 0) 为中心、0.8 格见方的图标（app.js 的 drawIcon），没有给 null；
 * parts：接了物流站时各块 [{ kind: 'station' | 'mid', members 建筑编号 }]（repack.js 的 zone.parts），没有就是一整块带子区。
 * 返回 svg（带 viewBox，看图工具按它适配）、items（带子运的物品和颜色，按第一次出现）、ends（带头有标签的是原料、带尾的是产物）、
 * groups（工厂图例：标号、产物、设备、几叠、叠几层）、几样数
 */
export function beltlessSvg(buildings, icon = () => null, parts = null) {
  const byIdx = new Map(buildings.map((b) => [b.index, b]));
  const isBelt = (b) => !!b && BELTS.has(b.itemId);
  const isMachine = (b) => !!b && !!KIND[b.itemId];
  const isStation = (b) => !!b && b.itemId === STATION;
  // 带子区：机器、供电以外，除了接着机器的分拣器（同 src/beltless/repack.js 整块挪的那些）；接了站时按块分
  const inZone = (b) => !isMachine(b) && b.itemId !== 2201 && b.itemId !== 2212 && !(SORTERS.has(b.itemId) && (isMachine(byIdx.get(b.in)) || isMachine(byIdx.get(b.out))));
  const partOf = new Map((parts ?? []).flatMap((p, k) => p.members.map((i) => [i, k])));
  const groupOf = (b) => (parts ? partOf.get(b.index) ?? null : inZone(b) ? 0 : null);
  const at = (p) => [p[0], -p[1]]; // 游戏里 y 朝北，图上朝上
  const cellOf = (b) => [Math.round(b.at[0][0]), -Math.round(b.at[0][1])]; // 带子那一格（原地升降那一叠错开了一点，画回整格）
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const grow = (x, y) => {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  };
  // 带子区（接了站时每块）一组：站身、带子、分拣器、喷涂机、进出口的圈、图标，外沿
  const groups = (parts ?? [null]).map(() => ({ base: [], routes: [], arms: [], devices: [], ports: [], icons: [], x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }));
  const free = []; // 不归哪一块的带子（站和站之间的翘曲器带：拖过以后要重接，app.js 先藏起来）
  const zgrow = (g, x, y, hw, hh) => {
    g.x0 = Math.min(g.x0, x - hw);
    g.y0 = Math.min(g.y0, y - hh);
    g.x1 = Math.max(g.x1, x + hw);
    g.y1 = Math.max(g.y1, y + hh);
  };
  // 每节带运什么：带头、带尾那节的标签，或者接在上面的分拣器筛的物品
  const itemOf = new Map();
  for (const b of buildings) {
    if (isBelt(b) && b.label) itemOf.set(b.index, b.label);
    if (SORTERS.has(b.itemId) && b.filter) for (const k of [b.in, b.out]) if (isBelt(byIdx.get(k)) && !itemOf.has(k)) itemOf.set(k, b.filter);
  }
  const fed = new Set();
  for (const b of buildings) if (isBelt(b) && isBelt(byIdx.get(b.out))) fed.add(b.out);
  const seen = new Set();
  const chains = [];
  for (const b of buildings) {
    if (!isBelt(b) || fed.has(b.index) || seen.has(b.index)) continue;
    const nodes = [];
    for (let n = b; isBelt(n); n = byIdx.get(n.out)) {
      nodes.push(n);
      if (seen.has(n.index)) break; // 并进别的带：画到汇合那节为止
      seen.add(n.index);
    }
    const item = nodes.map((n) => itemOf.get(n.index)).find(Boolean) || 0;
    chains.push({ nodes, item });
  }
  const items = [...new Set(chains.map((c) => c.item).filter(Boolean))];
  const colorOf = (item) => (item ? COLORS[items.indexOf(item) % COLORS.length] : FAINT);
  // 进出口图标放的那格不压别的带子、分拣器、喷涂机和别的图标：顺着带往外一格有东西就换到口的两旁、斜对角，再不行往外 2、3 格
  const taken = new Set();
  for (const b of buildings) {
    if (isBelt(b)) taken.add(cellOf(b).join());
    if (SORTERS.has(b.itemId)) for (const p of b.at) taken.add(at(p).map(Math.round).join());
    if (b.itemId === COATER) {
      const [x, y] = at(b.at[0]);
      for (const k of [-1, 0, 1]) taken.add((yawOf(b) % 180 ? [x + k, y] : [x, y + k]).map(Math.round).join()); // 喷涂机 3 格长，顺着带子
    }
  }
  const ends = { in: [], out: [] };
  const port = (g, end, next, input, color) => {
    const [x, y] = cellOf(end);
    const [u, v] = next ? cellOf(next) : [x, y + 1]; // 只有一节：图标放上面
    const [dx, dy] = [x - u, y - v];
    const sides = [[-dy, dx], [dy, -dx]];
    const spots = [[x + dx, y + dy], ...sides.map(([a, b]) => [x + a, y + b]), ...sides.map(([a, b]) => [x + dx + a, y + dy + b]), [x + 2 * dx, y + 2 * dy], [x + 3 * dx, y + 3 * dy]];
    const [ix, iy] = spots.find((p) => !taken.has(p.join())) ?? spots[0];
    taken.add(`${ix},${iy}`);
    g.ports.push(portShape(x, y, color, input));
    const pic = icon(end.label);
    if (pic) g.icons.push(`<g transform="translate(${F3(ix)} ${F3(iy)})"><rect x="-0.5" y="-0.5" width="1" height="1" fill="${PAPER}" stroke="${FINE}" stroke-width="0.04"/>${pic}</g>`);
    zgrow(g, ix, iy, 0.5, 0.5);
  };
  for (const c of chains) {
    const g = groups[groupOf(c.nodes[0])] ?? null;
    const cells = c.nodes.map((n) => [...cellOf(n), n.at[0][2]]);
    for (const [x, y] of cells) {
      grow(x, y);
      if (g) zgrow(g, x, y, 0.5, 0.5);
    }
    (g ? g.routes : free).push({ itemId: c.item, cells });
    // 从外面进来的原料、送出去的产物：接物流站的不算口（同布线图）
    const head = c.nodes[0], tail = c.nodes[c.nodes.length - 1];
    if (head.label) {
      if (!ends.in.includes(head.label)) ends.in.push(head.label);
      if (g && !isStation(byIdx.get(head.in))) port(g, head, c.nodes[1], true, colorOf(c.item));
    }
    if (tail !== head && tail.label) {
      if (!ends.out.includes(tail.label)) ends.out.push(tail.label);
      if (g && !isStation(byIdx.get(tail.out))) port(g, tail, c.nodes[c.nodes.length - 2], false, colorOf(c.item));
    }
  }
  // 机器：研究站叠了几层只画一个框；每组（同一种设备做同一样，按出现的先后）一个标号，每台按看图的顺序（从上往下、每行从左往右）编号
  const machines = new Map();
  for (const b of buildings) {
    const kind = KIND[b.itemId];
    if (!kind) continue;
    const key = `${b.at[0][0]},${b.at[0][1]}`;
    if (machines.has(key)) machines.get(key).levels++;
    else machines.set(key, { b, kind, levels: 1 });
  }
  const groups0 = new Map();
  let latin = 0, small = 0;
  const placed = [];
  for (const m of machines.values()) {
    const { b, kind } = m;
    const k = `${b.product}:${b.itemId}`;
    if (!groups0.has(k)) groups0.set(k, { letter: kind === 'smelter' ? SMALL[small++] ?? '?' : LATIN[latin++] ?? '?', product: b.product, factoryId: b.itemId, count: 0, levels: 1 });
    const g = groups0.get(k);
    g.count++;
    g.levels = Math.max(g.levels, m.levels);
    let [w, h, sx = 0, sy = 0] = b.itemId === 2317 ? [8, 4, 0, 0.5] : FOOT[kind];
    const yaw = yawOf(b);
    if (yaw === 90) [w, h, sx, sy] = [h, w, sy, -sx];
    else if (yaw === 180) [sx, sy] = [-sx, -sy];
    else if (yaw === 270) [w, h, sx, sy] = [h, w, -sy, sx];
    const [cx, cy] = at([b.at[0][0] + sx, b.at[0][1] + sy]);
    grow(cx - w / 2, cy - h / 2);
    grow(cx + w / 2, cy + h / 2);
    placed.push({ ...m, g, cx, cy, w, h });
  }
  placed.sort((a, b) => a.cy - b.cy || a.cx - b.cx);
  const nth = new Map();
  const boxes = placed.map((m) => {
    const num = (nth.get(m.g) ?? 0) + 1;
    nth.set(m.g, num);
    return factoryShape(m.kind, m.cx, m.cy, m.w, m.h, { letter: m.g.letter, num, text, tag, hatch: 'bl-hatch', levels: m.levels });
  });
  // 分拣器、喷涂机、供电；带子区里的放进那一组，物流站（站身垫在接站口的带子下面）放进那一组的 base
  const arms = [];
  let sorters = 0, power = 0, stations = 0;
  for (const b of buildings) {
    const [ax, ay] = at(b.at[0]);
    const g = groups[groupOf(b)] ?? null;
    if (SORTERS.has(b.itemId)) {
      // 转轴圈画在接机器的那头（往机器里送的在终点，从机器取的、两头都不接机器的在起点），爪在另一头
      const [bx, by] = at(b.at[1] ?? b.at[0]);
      const into = isMachine(byIdx.get(b.out)) && !isMachine(byIdx.get(b.in));
      const [fx, fy, ex, ey] = into ? [bx, by, ax, ay] : [ax, ay, bx, by];
      sorters++;
      (g ? g.arms : arms).push(sorterShape(fx, fy, ex, ey, !into, ARM, Math.abs(ey - fy) > Math.abs(ex - fx)));
      if (g) for (const [x, y] of [[ax, ay], [bx, by]]) zgrow(g, x, y, 0.25, 0.25);
    } else if (b.itemId === COATER) {
      (g ? g.devices : arms).push(deviceShape('coater', ax, ay));
      if (g) zgrow(g, ax, ay, yawOf(b) % 180 ? 1.5 : 0.5, yawOf(b) % 180 ? 0.5 : 1.5);
    } else if (b.itemId === STATION) {
      (g ? g.base : arms).push(stationShape(ax, ay, `T${++stations}`, { hatch: 'bl-hatch', text }));
      grow(ax - 3.5, ay - 3.5);
      grow(ax + 3.5, ay + 3.5);
      if (g) zgrow(g, ax, ay, 3.5, 3.5);
    } else if (b.itemId === 2201 || b.itemId === 2212) {
      power++;
      const h = b.itemId === 2212 ? 1.5 : 0.5; // 卫星配电站 3×3
      grow(ax - h, ay - h);
      grow(ax + h, ay + h);
      arms.push(powerShape(ax, ay, b.itemId === 2212 ? 3 : 1));
    }
  }
  // 带子同布线图的总览：几层按 z 从低到高画，地面那层画完接分拣器，高架的虚线压在上面；同一格里换高度的画升降点（每格一个）
  const drawRoutes = (routes, sorterParts = []) => {
    let s = '';
    const vias = new Set();
    for (const floor of sliceRoutes(routes)) {
      if (floor.z > 0) s += sorterParts.splice(0).join('');
      for (const run of floor.runs) s += runShape(runPoints(run), run.cells, colorOf(run.itemId), { dashed: floor.z > 0 });
      for (const v of floor.vias) {
        const key = `${v.x},${v.y},${v.itemId}`;
        if (vias.has(key)) continue;
        vias.add(key);
        s += viaShape(v.x, v.y, colorOf(v.itemId));
      }
    }
    return s + sorterParts.join('');
  };
  // 每一组：底下一块透明的好按住，外面虚线框（比外沿宽半格），框上面写一行字。一整块带子区时图标和字另放一组（拖的时候不跟着转）
  let zone = '';
  let nStation = 0;
  groups.forEach((g, k) => {
    if (!Number.isFinite(g.x0)) return;
    const f = { x: g.x0 - 0.5, y: g.y0 - 0.5, w: g.x1 - g.x0 + 1, h: g.y1 - g.y0 + 1 };
    const r = `x="${F3(f.x)}" y="${F3(f.y)}" width="${F3(f.w)}" height="${F3(f.h)}"`;
    grow(f.x, f.y - 1.1);
    grow(f.x + f.w, f.y + f.h);
    const name = !parts ? '带子区 · 拖动换位置' : parts[k].kind === 'station' ? `物流站 ${++nStation}` : '中间产物带';
    const label = `<text x="${F3(f.x)}" y="${F3(f.y - 0.35)}" font-size="0.6" fill="${FINE}" font-family='${SANS}'>${name}</text>`;
    const body = `<rect ${r} fill="transparent"/>${g.base.join('')}${drawRoutes(g.routes, g.arms)}${g.devices.join('')}${g.ports.join('')}`;
    const frame = `<rect ${r} fill="none" stroke="${FRAME}" stroke-width="0.07" stroke-dasharray="0.45 0.3"/>`;
    zone += parts ? `<g class="bl-part" data-part="${k}">${body}${g.icons.join('')}${frame}${label}</g>` : `<g class="bl-zone">${body}${frame}</g><g class="bl-zone-marks">${g.icons.join('')}${label}</g>`;
  });
  if (!Number.isFinite(x0)) [x0, y0, x1, y1] = [0, 0, 1, 1]; // 空蓝图
  // 同布线图：坐标纸只铺在图框里，框外一圈是纸色。框比建筑外沿各宽 1 格，贴边的带子、分拣器不压框线；
  // 框外再留 1 格（整张比建筑外沿各宽 2 格）
  const sheet = { x: x0 - 1, y: y0 - 1, w: x1 - x0 + 2, h: y1 - y0 + 2 };
  const box = { x: sheet.x - 1, y: sheet.y - 1, w: sheet.w + 2, h: sheet.h + 2 };
  const rect = (fill, more = '') => `<rect x="${F3(sheet.x)}" y="${F3(sheet.y)}" width="${F3(sheet.w)}" height="${F3(sheet.h)}" fill="${fill}"${more}/>`;
  // 网格、工厂和物流站的手打阴影同布线图（drawing.js）：1 格细线、5 格粗线
  const grid = `<defs><pattern id="bl-grid" width="1" height="1" patternUnits="userSpaceOnUse"><path d="M1 0H0V1" fill="none" stroke="#1b3d60" stroke-width="0.035"/></pattern><pattern id="bl-major" width="5" height="5" patternUnits="userSpaceOnUse"><rect width="5" height="5" fill="url(#bl-grid)"/><path d="M5 0H0V5" fill="none" stroke="#294c70" stroke-width="0.055"/></pattern><pattern id="bl-hatch" width="0.2" height="0.2" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><path d="M0.1 0V0.2" stroke="${FINE}" stroke-width="0.03"/></pattern></defs>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${F3(box.x)} ${F3(box.y)} ${F3(box.w)} ${F3(box.h)}" role="img" aria-label="无带蓝图平面图">${grid}${rect(PAPER)}${rect('url(#bl-major)')}${rect('none', ` stroke="${FRAME}" stroke-width="0.07"`)}${boxes.join('')}${arms.join('')}${zone}<g class="bl-free">${drawRoutes(free)}</g></svg>`;
  const factories = [...machines.values()].reduce((a, m) => a + m.levels, 0);
  return { svg, items: items.map((id) => ({ id, color: colorOf(id) })), ends, groups: [...groups0.values()], stats: { width: Math.round(x1 - x0), height: Math.round(y1 - y0), factories, sorters, belts: seen.size, power } };
}
