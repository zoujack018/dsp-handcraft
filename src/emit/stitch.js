// 把分模块排出来的几张蓝图拼成一张（handoff 任务 2）。只在蓝图记录这一层做：每块的建筑整体平移、编号接着往下排、连接跟着改。
//
// 摆法：一行一行往右摆，每块挑满足规则的最近位置；行宽从最宽那块到所有块并排都试一遍（有宽度上限时不超过上限），
// 块的顺序试「原顺序」和「从高到矮」两种，挑外框面积最小、长宽比不超过 2.5 的那种。规则：
//   块与块的外框之间至少空 gap 格（默认 1）；
//   不同块的两座物流站中心直线距离 ≥ STATION_GAP（24.08）；
//   不同块的供电设施之间 ≥ powerGap（配电站之间 6，其余 2√2）；卫星配电站不进别的块物流站身外那一圈（9×9）。
// 拼完跑一遍独立检查：拼出来的整张图不能比各块自己多出任何报错，多了就把间距加大重拼。
// 各块的供电网是分开的（块与块之间不拉线），检查会提醒「没有连成一张网」，贴好后自己连上或各接电源。
import { fromStr, toStr } from '../codec/parser.js';
import { STATION_GAP, STATION_CLEAR, powerGap } from '../gamedata.js';
import { checkBlueprint } from './check.js';

const isStation = (id) => id === 2103 || id === 2104;
const isPower = (id) => id === 2201 || id === 2212;

/** 一块蓝图里要跨块检查的东西：外框、物流站、供电设施（坐标取整） */
function parsePart(str) {
  const bp = fromStr(str.trim());
  const at = (b) => ({ x: Math.round(b.localOffset[0].x), y: Math.round(b.localOffset[0].y), id: b.itemId });
  return {
    bp,
    w: bp.dragBoxSize.x,
    h: bp.dragBoxSize.y,
    stations: bp.buildings.filter((b) => isStation(b.itemId)).map(at),
    power: bp.buildings.filter((b) => isPower(b.itemId)).map(at),
  };
}

/** 两块（各自加上偏移）放在一起是否满足规则 */
function compatible(a, oa, b, ob, gap) {
  // 外框之间至少空 gap 格
  const apart = oa.x + a.w + gap <= ob.x || ob.x + b.w + gap <= oa.x || oa.y + a.h + gap <= ob.y || ob.y + b.h + gap <= oa.y;
  if (!apart) return false;
  for (const s of a.stations) for (const t of b.stations) if (Math.hypot(s.x + oa.x - t.x - ob.x, s.y + oa.y - t.y - ob.y) < STATION_GAP - 1e-9) return false;
  for (const p of a.power) for (const q of b.power) {
    const g = powerGap(p.id, q.id);
    if ((p.x + oa.x - q.x - ob.x) ** 2 + (p.y + oa.y - q.y - ob.y) ** 2 < g * g - 1e-9) return false;
  }
  // 卫星配电站（3×3）不进别的块物流站身外那一圈
  const ring = (P, op, S, os) => P.some((p) => p.id === 2212 && S.some((s) => Math.abs(p.x + op.x - s.x - os.x) <= STATION_CLEAR + 1 && Math.abs(p.y + op.y - s.y - os.y) <= STATION_CLEAR + 1));
  return !ring(a.power, oa, b.stations, ob) && !ring(b.power, ob, a.stations, oa);
}

/** 按顺序一行一行摆：每块在当前行里往右找第一个满足规则的位置，行太宽就换行 */
function place(parts, { gap, rowWidth }) {
  const offs = [];
  let rowY = 0;
  let rowTop = 0; // 已经摆好的块最高到哪
  let x = 0;
  for (const p of parts) {
    for (;;) {
      if (x > 0 && x + p.w > rowWidth) {
        // 这一行放不下了：换行，从已摆好的最高处往上；行里还空着也放不下（比如和下面一行的物流站隔不开）就一格一格往上挪
        rowY = rowTop + gap > rowY ? rowTop + gap : rowY + 1;
        x = 0;
      }
      const o = { x, y: rowY };
      if (offs.every((q, i) => compatible(p, o, parts[i], q, gap))) {
        offs.push(o);
        x += p.w + gap;
        rowTop = Math.max(rowTop, rowY + p.h);
        break;
      }
      x++;
    }
  }
  return offs;
}

/**
 * 拼成一张。parts：[{ str 蓝图字符串, name 块名 }]。
 * 返回 { str, offsets: [{x, y}]（每块左下角在整张图里的位置）, width, height, check }
 */
export function stitchBlueprints(parts, { gap = 1, maxWidth = null, title = '拼接', desc = '' } = {}) {
  const ps = parts.map((p) => parsePart(p.str));
  // 各块自己的报错条数：拼完以后不能更多
  const own = parts.map((p) => checkBlueprint(p.str).errors.length).reduce((a, b) => a + b, 0);
  const widest = Math.max(...ps.map((p) => p.w));
  const all = ps.reduce((n, p) => n + p.w + gap, 0);
  /** 挑摆法：返回每块的偏移（按 parts 的顺序） */
  const layout = (g) => {
    let best = null;
    const orders = [ps.map((_, i) => i), ps.map((_, i) => i).sort((a, b) => ps[b].h - ps[a].h || a - b)];
    for (const order of orders)
      for (let rw = widest; rw <= Math.max(widest, Math.min(all, maxWidth ?? all)); rw += 2) {
        if (maxWidth && rw > maxWidth && rw > widest) break;
        const offs = place(order.map((i) => ps[i]), { gap: g, rowWidth: rw });
        const W = Math.max(...order.map((i, k) => offs[k].x + ps[i].w));
        const H = Math.max(...order.map((i, k) => offs[k].y + ps[i].h));
        const bad = Math.max(W / H, H / W) > 2.5;
        const score = W * H * (bad ? 4 : 1);
        if (!best || score < best.score) {
          const back = [];
          order.forEach((i, k) => (back[i] = offs[k]));
          best = { score, offsets: back };
        }
      }
    return best.offsets;
  };
  for (let g = gap; ; g++) {
    const offsets = layout(g);
    const buildings = [];
    for (const [k, p] of ps.entries()) {
      const base = buildings.length;
      const { x: ox, y: oy } = offsets[k];
      for (const b of p.bp.buildings) {
        const n = structuredClone(b);
        n.index = b.index + base;
        if (n.outputObjIdx >= 0) n.outputObjIdx += base;
        if (n.inputObjIdx >= 0) n.inputObjIdx += base;
        for (const o of n.localOffset) {
          o.x += ox;
          o.y += oy;
        }
        buildings.push(n);
      }
    }
    const width = Math.max(...ps.map((p, k) => offsets[k].x + p.w));
    const height = Math.max(...ps.map((p, k) => offsets[k].y + p.h));
    const first = ps[0].bp;
    const icons = [...new Set(ps.flatMap((p) => p.bp.header.icons.filter(Boolean)))].slice(0, 5);
    const bp = {
      ...first,
      header: { ...first.header, icons: [...icons, 0, 0, 0, 0, 0].slice(0, 5), shortDesc: title, desc },
      cursorOffset: { x: Math.floor(width / 2), y: Math.floor(height / 2) },
      dragBoxSize: { x: width, y: height },
      areas: [{ ...first.areas[0], size: { x: width, y: height } }],
      buildings,
    };
    const str = toStr(bp);
    const check = checkBlueprint(str);
    if (check.errors.length <= own || g > gap + 30) return { str, offsets, width, height, check, gap: g };
  }
}
