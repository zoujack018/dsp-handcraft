// 物流站的空地估算（搜索时用）：边缘放站模式下，站是排完生产区之后才放进去的。
// 搜索阶段不真的接线（A* 太慢），只估两件事：把每座站放进布局里或贴在边上要多占多少面积，
// 以及站离它要接的出入口有多远。计入成本后，退火会主动在出入口附近留出 7×7 的空地。
import { STATION_GAP, realItem } from '../gamedata.js';
import { keepFreeSlot, stationItemCap } from './layout/shared.js';

const SIZE = 7;
const HALF = 3;

/** 按 stations.js 的装站规则估算要几座站、每座站接哪些出入口：每座站最多 5 种物品（翘曲器格占一格时 4 种）、12 条带 */
export function stationGroups(ports, axis = 'x', slots = null) {
  const cap = stationItemCap(slots);
  // 按真实物品分（同 stations.js）：副产物和产线自己要用的同种物品共用一个存储格
  const byItem = new Map();
  for (const p of ports) {
    const k = realItem(p.itemId);
    if (!byItem.has(k)) byItem.set(k, []);
    byItem.get(k).push(p);
  }
  const items = [...byItem.entries()]
    .flatMap(([itemId, ps]) => {
      const out = [];
      for (let i = 0; i < ps.length; i += 12) out.push({ itemId, ports: ps.slice(i, i + 12) });
      return out;
    })
    .sort((a, b) => {
      const mean = (it) => it.ports.reduce((n, p) => n + p[axis], 0) / it.ports.length;
      return mean(a) - mean(b) || b.ports.length - a.ports.length;
    });
  const groups = [];
  for (const it of items) {
    let g = groups.find((g) => g.length < cap && g.reduce((n, q) => n + q.ports.length, 0) + it.ports.length <= 12 && !g.some((q) => q.itemId === it.itemId));
    if (!g) groups.push((g = []));
    g.push(it);
  }
  keepFreeSlot(groups, slots);
  return groups.sort((a, b) => b.reduce((n, q) => n + q.ports.length, 0) - a.reduce((n, q) => n + q.ports.length, 0));
}

/**
 * @param {*} L route() 的中间结果：pos, rowCy, segments, legs, ports, sorterList, width, height
 * @returns {{cost: number, growth: number, dist: number, sites: {x: number, y: number}[]}}
 */
export function stationHoles(L, { pad = SIZE + 2, distWeight = 1, slots = null } = {}) {
  const W = L.width;
  const H = L.height;
  const X0 = -pad;
  const Y0 = -pad;
  const GW = W + 2 * pad;
  const GH = H + 2 * pad;
  // 占用按位存：每行 WPR 个 32 位字，网格第 gx 列在第 gx >> 5 个字的第 gx & 31 位（坐标都是整格）
  const WPR = (GW + 31) >> 5;
  const occ = new Int32Array(WPR * GH);
  const mark = (x, y) => {
    const gx = x - X0;
    const gy = y - Y0;
    if (gx >= 0 && gy >= 0 && gx < GW && gy < GH) occ[gy * WPR + (gx >> 5)] |= 1 << (gx & 31);
  };
  // 一行里 x 从 xa 到 xb 整段标上（先裁到网格里），一个字一次
  const markRun = (xa, xb, y) => {
    const gy = y - Y0;
    if (gy < 0 || gy >= GH) return;
    const row = gy * WPR;
    const b = Math.min(GW - 1, xb - X0);
    for (let a = Math.max(0, xa - X0); a <= b; ) {
      const e = Math.min(b, a | 31);
      occ[row + (a >> 5)] |= (-1 >>> (31 - (e & 31))) & (-1 << (a & 31));
      a = e + 1;
    }
  };
  for (const p of L.pos.values()) {
    const hw = (p.g.bodyWidth - 1) / 2;
    const cy = L.rowCy[p.row];
    // 工厂四周多留 1 格：站的碰撞体不能贴着工厂
    for (const cx of p.centers) for (let y = cy - p.g.bodyBelow - 1; y <= cy + p.g.bodyAbove + 1; y++) markRun(cx - hw - 1, cx + hw + 1, y);
  }
  for (const s of L.segments) markRun(s.a, s.b, s.y);
  for (const p of L.ports) mark(p.x, p.y);
  for (const l of L.legs) {
    for (const c of l.cells || []) mark(c[0], c[1]);
    for (const c of l.stub || []) mark(c[0], c[1]);
  }
  for (const s of L.sorterList) {
    const p = L.pos.get(s.bid);
    const e = s.side === 'bottom' ? L.rowCy[p.row] - p.g.edgeBelow : L.rowCy[p.row] + p.g.edgeAbove;
    const y1 = L.segments[s.segId].y;
    for (let y = Math.min(e, y1); y <= Math.max(e, y1); y++) mark(s.col, y);
  }
  // 7×7 全空的左上角，也按位存（行 gy 第 gx 位）：先把 gy 起往下 SIZE 行或起来取反，得到「这一列往下 SIZE 格都空」，
  // 再把右边 SIZE - 1 列移过来与上，得到「从这一列起往右 SIZE 列都是」。网格外的列当作占着
  const PH = Math.max(0, GH - SIZE + 1);
  const free = new Int32Array(PH * WPR);
  const tail = GW & 31 ? (1 << (GW & 31)) - 1 : -1;
  const col = new Int32Array(WPR + 1);
  for (let gy = 0; gy < PH; gy++) {
    for (let w = 0; w < WPR; w++) {
      let o = 0;
      for (let j = 0; j < SIZE; j++) o |= occ[(gy + j) * WPR + w];
      col[w] = ~o & (w === WPR - 1 ? tail : -1);
    }
    for (let w = 0; w < WPR; w++) {
      let f = col[w];
      for (let k = 1; k < SIZE; k++) f &= (col[w] >>> k) | (col[w + 1] << (32 - k));
      free[gy * WPR + w] = f;
    }
  }
  const taken = [];
  // 两座站至少隔 STATION_GAP 格（直线距离），自然也就不重叠
  const clash = (x, y) => taken.some((t) => Math.hypot(t.x - x, t.y - y) < STATION_GAP);
  let bx0 = 0;
  let by0 = 0;
  let bx1 = W - 1;
  let by1 = H - 1;
  let growth = 0;
  let dist = 0;
  const groups = stationGroups(L.ports, W >= H ? 'x' : 'y', slots);
  // 候选站心 (gx, gy) 一共 PW × PH 个。到出入口的距离能按横、竖拆开：d = DX[gx] + DY[gy]
  // （坐标都是整格，换个加法顺序结果不变）。一行里面积增量至少是只往竖向扩的那一份，
  // 于是每行有个便宜的成本下界 RL[gy]：从下界最小的行往两边扫，下界已经比当前最好还大的行整行跳过。
  // 选中的仍是「成本最小、同成本取逐行逐格扫描时最先遇到的」那一格，和逐格全扫一模一样；
  // 是否和已放的站太近只在它要当选时才查。
  const PW = Math.max(0, GW - SIZE + 1);
  const DX = new Float64Array(PW);
  const DY = new Float64Array(PH);
  const RL = new Float64Array(PH);
  const order = new Int32Array(PH);
  // 下界只在距离权重是有限非负数时成立；否则按原顺序逐行全扫
  const prune = Number.isFinite(distWeight) && distWeight >= 0;
  for (const g of groups) {
    const ports = g.flatMap((it) => it.ports);
    DX.fill(0);
    DY.fill(0);
    for (const p of ports) {
      // 站心 (gx + X0 + HALF, gy + Y0 + HALF) 到出入口：两个方向各自先扣掉站的半宽，再加站口那 2 格
      const px = p.x - X0 - HALF;
      const py = p.y - Y0 - HALF;
      for (let gx = 0; gx < PW; gx++) DX[gx] += Math.max(0, Math.abs(px - gx) - HALF);
      for (let gy = 0; gy < PH; gy++) DY[gy] += Math.max(0, Math.abs(py - gy) - HALF) + 2;
    }
    let minDX = Infinity;
    for (let gx = 0; gx < PW; gx++) if (DX[gx] < minDX) minDX = DX[gx];
    const bw = bx1 - bx0 + 1;
    const area = bw * (by1 - by0 + 1);
    if (prune) {
      let m = 0;
      for (let gy = 0; gy < PH; gy++) {
        const y = gy + Y0 + HALF;
        RL[gy] = bw * (Math.max(by1, y + HALF) - Math.min(by0, y - HALF) + 1) - area + distWeight * (DY[gy] + minDX);
        if (RL[gy] < RL[m]) m = gy;
      }
      // 下界随行号先降后升：从最低的那行起，每次往下界小的一边多扫一行（只管先后，早点碰到好位置好多跳几行；选谁不受影响）
      let lo = m - 1;
      let hi = m + 1;
      if (PH) order[0] = m;
      for (let k = 1; k < PH; k++) order[k] = hi >= PH || (lo >= 0 && RL[lo] <= RL[hi]) ? lo-- : hi++;
    } else for (let k = 0; k < PH; k++) order[k] = k;
    let best = null;
    for (let k = 0; k < PH; k++) {
      const gy = order[k];
      if (best && prune && RL[gy] > best.c) continue;
      const y = gy + Y0 + HALF;
      const ny0 = Math.min(by0, y - HALF);
      const ny1 = Math.max(by1, y + HALF);
      const dy = DY[gy];
      // 这一行全空的左上角按 gx 从小到大取（每次取最低的那一位）
      for (let w = 0; w < WPR; w++)
        for (let f = free[gy * WPR + w]; f; ) {
          const low = f & -f;
          f ^= low;
          const gx = (w << 5) + 31 - Math.clz32(low);
          const x = gx + X0 + HALF;
          const nx0 = Math.min(bx0, x - HALF);
          const nx1 = Math.max(bx1, x + HALF);
          const grow = (nx1 - nx0 + 1) * (ny1 - ny0 + 1) - (bx1 - bx0 + 1) * (by1 - by0 + 1);
          const d = DX[gx] + dy;
          const c = grow + distWeight * d;
          // 同成本时取行号小的（同一行里 gx 递增，先到的已经占着）
          if (best && !(c < best.c || (c === best.c && gy < best.gy))) continue;
          if (clash(x, y)) continue;
          best = { x, y, gy, c, grow, d, nx0, ny0, nx1, ny1 };
        }
    }
    if (!best) return { cost: 1e6, growth: 1e6, dist: 0, sites: taken };
    taken.push({ x: best.x, y: best.y });
    growth += best.grow;
    dist += best.d;
    [bx0, by0, bx1, by1] = [best.nx0, best.ny0, best.nx1, best.ny1];
  }
  return { cost: growth + distWeight * dist, growth, dist, sites: taken };
}
