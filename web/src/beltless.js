// 无带蓝图的平面图：量产计算器「生成无带蓝图」排好带过来的（DSQ 的无带流生成器出的，handoff.js 的 beltless），这边只画、不改。
// 画法同布线图（drawing.js）：深蓝底白线，网格 1 格细线、5 格粗线；机器画碰撞体那么大的框（src/gamedata.js），中间放产物图标；
// 传送带顺着下游连成一条条，按运的物品上色（颜色表同布线图），运什么看带头带尾的标签或接在上面的分拣器筛的物品，最后一节画箭头，
// 有标签的带头、带尾放物品图标（原料从带头进、产物从带尾出）；分拣器细线，供电黄圈。无带流的分拣器摆在机器边上，和带子区里的带子
// 隔空连着（蓝图里记的上下游，要原地重建一次才连上）：从分拣器那头到那节带子画成那条带颜色的虚线。研究站叠几层只画一个框、写 ×层数；
// 不分楼层（带子区叠着的几层画在一起）。
import { COLORS, LINE, FINE } from './drawing.js';

const PAPER = '#112f52';
const FAINT = '#6f90b3';
const ARM = '#dbe8f7';
const POWER = '#ffd666';
const FRAME = '#82a2c3'; // 图框线，同布线图
const SANS = '"DIN Alternate", "Bahnschrift", "PingFang SC", "Microsoft YaHei", sans-serif'; // 同布线图的字
const KIND = { 2302: 'smelter', 2315: 'smelter', 2319: 'smelter', 2303: 'assembler', 2304: 'assembler', 2305: 'assembler', 2318: 'assembler', 2309: 'chemical', 2317: 'chemical', 2308: 'refinery', 2310: 'collider', 2901: 'lab', 2902: 'lab' };
/** 机器的框（格，朝北时）：宽、高、中心偏移；量子化工厂 8 宽（同 src/gamedata.js），研究站同布线图收到 4.3 */
const FOOT = { smelter: [2.4, 2.4], assembler: [3.2, 3.2], lab: [4.3, 4.3], chemical: [6.8, 4, 0, 0.5], refinery: [2.8, 5.6, 0, -0.4], collider: [9, 5, -0.3, 0] };
const BELTS = new Set([2001, 2002, 2003]);
const SORTERS = new Set([2011, 2012, 2013, 2014]);
const F3 = (v) => Math.round(v * 1000) / 1000;

/**
 * buildings：worker.js 的 inspectBlueprint 给的；icon(物品 ID)：以 (0, 0) 为中心、0.8 格见方的图标（app.js 的 drawIcon），没有给 null。
 * 返回 svg（带 viewBox，看图工具按它适配）、items（带子运的物品和颜色，按第一次出现）、ends（带头有标签的是原料、带尾的是产物）、几样数
 */
export function beltlessSvg(buildings, icon = () => null) {
  const byIdx = new Map(buildings.map((b) => [b.index, b]));
  const isBelt = (b) => !!b && BELTS.has(b.itemId);
  const at = (p) => [p[0], -p[1]]; // 游戏里 y 朝北，图上朝上
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const grow = (x, y) => {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  };
  const iconAt = (id, x, y, s) => {
    const g = id ? icon(id) : null;
    return g ? `<g transform="translate(${F3(x)} ${F3(y)}) scale(${F3(s / 0.8)})">${g}</g>` : '';
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
  const chainItem = new Map(); // 每节带 → 它那条带运的
  for (const b of buildings) {
    if (!isBelt(b) || fed.has(b.index) || seen.has(b.index)) continue;
    const nodes = [];
    for (let n = b; isBelt(n); n = byIdx.get(n.out)) {
      nodes.push(n);
      if (seen.has(n.index)) break; // 并进别的带：画到汇合那节为止
      seen.add(n.index);
    }
    const item = nodes.map((n) => itemOf.get(n.index)).find(Boolean) || 0;
    for (const n of nodes) if (!chainItem.has(n.index)) chainItem.set(n.index, item);
    chains.push({ nodes, item });
  }
  const items = [...new Set(chains.map((c) => c.item).filter(Boolean))];
  const colorOf = (item) => (item ? COLORS[items.indexOf(item) % COLORS.length] : FAINT);
  const belts = [];
  const ends = { in: [], out: [] };
  const endIcons = [];
  for (const c of chains) {
    const pts = c.nodes.map((n) => at(n.at[0]));
    for (const [x, y] of pts) grow(x, y);
    const color = colorOf(c.item);
    if (pts.length > 1) {
      belts.push(`<polyline points="${pts.map(([x, y]) => `${F3(x)},${F3(y)}`).join(' ')}" fill="none" stroke="${color}" stroke-width="0.34" stroke-linecap="round" stroke-linejoin="round"/>`);
      // 流向：最后一节画个小箭头
      const [ax, ay] = pts[pts.length - 1];
      const [bx, by] = pts[pts.length - 2];
      const len = Math.hypot(ax - bx, ay - by) || 1;
      const ux = (ax - bx) / len, uy = (ay - by) / len;
      belts.push(`<path d="M${F3(ax + ux * 0.45)} ${F3(ay + uy * 0.45)}L${F3(ax - uy * 0.32)} ${F3(ay + ux * 0.32)}L${F3(ax + uy * 0.32)} ${F3(ay - ux * 0.32)}Z" fill="${color}"/>`);
    }
    // 从外面进来的原料、送出去的产物：带头 / 带尾放物品图标
    const head = c.nodes[0], tail = c.nodes[c.nodes.length - 1];
    if (head.label) {
      endIcons.push(iconAt(head.label, ...at(head.at[0]), 1.1));
      if (!ends.in.includes(head.label)) ends.in.push(head.label);
    }
    if (tail !== head && tail.label) {
      endIcons.push(iconAt(tail.label, ...at(tail.at[0]), 1.1));
      if (!ends.out.includes(tail.label)) ends.out.push(tail.label);
    }
  }
  // 分拣器和它隔空连着的带子：从分拣器取货 / 放货那头到那节带子，虚线
  const links = [];
  for (const b of buildings) {
    if (!SORTERS.has(b.itemId)) continue;
    for (const [k, end] of [[b.in, 0], [b.out, 1]]) {
      const belt = byIdx.get(k);
      if (!isBelt(belt)) continue;
      const [ax, ay] = at(b.at[end] ?? b.at[0]);
      const [bx, by] = at(belt.at[0]);
      links.push(`<line x1="${F3(ax)}" y1="${F3(ay)}" x2="${F3(bx)}" y2="${F3(by)}" stroke="${colorOf(chainItem.get(belt.index))}" stroke-width="0.05" stroke-dasharray="0.3 0.22" opacity="0.45"/>`);
    }
  }
  // 机器：研究站叠了几层只画一个框，写 ×层数
  const machines = new Map();
  for (const b of buildings) {
    const kind = KIND[b.itemId];
    if (!kind) continue;
    const key = `${b.at[0][0]},${b.at[0][1]}`;
    if (machines.has(key)) machines.get(key).levels++;
    else machines.set(key, { b, kind, levels: 1 });
  }
  const boxes = [];
  for (const { b, kind, levels } of machines.values()) {
    let [w, h, sx = 0, sy = 0] = b.itemId === 2317 ? [8, 4, 0, 0.5] : FOOT[kind];
    const yaw = ((Math.round(b.yaw) % 360) + 360) % 360;
    if (yaw === 90) [w, h, sx, sy] = [h, w, sy, -sx];
    else if (yaw === 180) [sx, sy] = [-sx, -sy];
    else if (yaw === 270) [w, h, sx, sy] = [h, w, -sy, sx];
    const [cx, cy] = at([b.at[0][0] + sx, b.at[0][1] + sy]);
    const l = cx - w / 2, t = cy - h / 2;
    grow(l, t);
    grow(l + w, t + h);
    let s = `<rect x="${F3(l)}" y="${F3(t)}" width="${F3(w)}" height="${F3(h)}" fill="${PAPER}" stroke="${LINE}" stroke-width="0.085"/>`;
    if (kind === 'smelter') s += `<circle cx="${F3(cx)}" cy="${F3(cy)}" r="${F3(w * 0.31)}" fill="none" stroke="${FINE}" stroke-width="0.05"/>`;
    else if (kind === 'lab') s += `<circle cx="${F3(cx)}" cy="${F3(cy)}" r="${F3(w * 0.36)}" fill="none" stroke="${FINE}" stroke-width="0.05"/><circle cx="${F3(cx)}" cy="${F3(cy)}" r="${F3(w * 0.25)}" fill="none" stroke="${FINE}" stroke-width="0.03"/>`;
    else s += `<rect x="${F3(l + 0.42)}" y="${F3(t + 0.42)}" width="${F3(w - 0.84)}" height="${F3(h - 0.84)}" fill="none" stroke="${FINE}" stroke-width="0.03"/>`;
    s += iconAt(b.product, cx, cy, Math.min(1.8, Math.min(w, h) * (kind === 'smelter' ? 0.5 : 0.55)));
    // 叠几层写在两圈之间的下半（位置、字号、字体同布线图的研究站）
    if (levels > 1) s += `<text x="${F3(cx)}" y="${F3(cy + w * 0.305)}" font-size="0.42" font-weight="500" fill="${FINE}" text-anchor="middle" dominant-baseline="central" font-family='${SANS}'>×${levels}</text>`;
    boxes.push(s);
  }
  // 分拣器、喷涂机、供电
  const arms = [];
  let sorters = 0, power = 0;
  for (const b of buildings) {
    const [ax, ay] = at(b.at[0]);
    if (SORTERS.has(b.itemId)) {
      const [bx, by] = at(b.at[1] ?? b.at[0]);
      sorters++;
      arms.push(`<line x1="${F3(ax)}" y1="${F3(ay)}" x2="${F3(bx)}" y2="${F3(by)}" stroke="${ARM}" stroke-width="0.07" stroke-linecap="round"/><circle cx="${F3(bx)}" cy="${F3(by)}" r="0.1" fill="${ARM}"/>`);
    } else if (b.itemId === 2313) arms.push(`<rect x="${F3(ax - 0.4)}" y="${F3(ay - 0.25)}" width="0.8" height="0.5" fill="${PAPER}" stroke="${FINE}" stroke-width="0.05"/>`);
    else if (b.itemId === 2201 || b.itemId === 2212) {
      power++;
      grow(ax, ay);
      arms.push(`<circle cx="${F3(ax)}" cy="${F3(ay)}" r="${b.itemId === 2212 ? 0.8 : 0.32}" fill="none" stroke="${POWER}" stroke-width="0.07"/><circle cx="${F3(ax)}" cy="${F3(ay)}" r="0.08" fill="${POWER}"/>`);
    }
  }
  if (!Number.isFinite(x0)) [x0, y0, x1, y1] = [0, 0, 1, 1]; // 空蓝图
  // 同布线图：坐标纸只铺在图框里，框外一圈是纸色。框比建筑外沿各宽 1 格，贴边的带子、分拣器不压框线；
  // 框外再留 1 格（整张比建筑外沿各宽 2 格）
  const sheet = { x: x0 - 1, y: y0 - 1, w: x1 - x0 + 2, h: y1 - y0 + 2 };
  const box = { x: sheet.x - 1, y: sheet.y - 1, w: sheet.w + 2, h: sheet.h + 2 };
  const rect = (fill, more = '') => `<rect x="${F3(sheet.x)}" y="${F3(sheet.y)}" width="${F3(sheet.w)}" height="${F3(sheet.h)}" fill="${fill}"${more}/>`;
  // 网格同布线图（drawing.js）：1 格细线、5 格粗线
  const grid = `<defs><pattern id="bl-grid" width="1" height="1" patternUnits="userSpaceOnUse"><path d="M1 0H0V1" fill="none" stroke="#1b3d60" stroke-width="0.035"/></pattern><pattern id="bl-major" width="5" height="5" patternUnits="userSpaceOnUse"><rect width="5" height="5" fill="url(#bl-grid)"/><path d="M5 0H0V5" fill="none" stroke="#294c70" stroke-width="0.055"/></pattern></defs>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${F3(box.x)} ${F3(box.y)} ${F3(box.w)} ${F3(box.h)}" role="img" aria-label="无带蓝图平面图">${grid}${rect(PAPER)}${rect('url(#bl-major)')}${rect('none', ` stroke="${FRAME}" stroke-width="0.07"`)}${links.join('')}${belts.join('')}${boxes.join('')}${arms.join('')}${endIcons.join('')}</svg>`;
  const factories = [...machines.values()].reduce((a, m) => a + m.levels, 0);
  return { svg, items: items.map((id) => ({ id, color: colorOf(id) })), ends, stats: { width: Math.round(x1 - x0), height: Math.round(y1 - y0), factories, sorters, belts: seen.size, power } };
}
