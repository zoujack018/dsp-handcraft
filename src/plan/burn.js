// 多余副产物就地烧掉（用户 2026/10/07：左侧加一个「多余副产物就地燃烧」的选项，有副产物的都可以烧掉）。
// 副产物（生产图里编号 BYPRODUCT + 真实编号，比如石墨烯高效配方、质能储存多出来的氢）那条带不送出去，接到一排火力发电厂。
// 发电厂的摆法照用户贴来的蓝图原样（gamedata.js 的 THERMAL_BANK）：竖着隔 4 格，列与列隔 8 格，
// 进料带横在顶上，两根集装分拣器送进最上面一台，往下一台传一台。一列能串几台看集装分拣器的速度（用户 2026/10/07：每列不止五个，
// 看分拣器速度，延伸性很强）：两根每秒 20 个，氢每台满负荷每秒 0.3 个，一列六十多台都喂得上；形状挑和产线拼起来外框最省的。
// 接电力感应塔时塔放进列与列之间的缝（THERMAL_BANK.laneDx，推断），多深都供得上；接卫星配电站时配电站只能在这一块外面，一列最多 5 台。
// 接线照接物流站的做法（stations.js）：从进料带的入口往那条带的段尾找路，原来通到边缘的出口和高架作废。
// 摆在产线右边、左边或下边，挑外框面积最小、又接得上的那种；宽、长上限内放不下就不烧，照旧送出并写明。
// 在接站、高架落地之后，翘曲器、增产剂、供电之前做：后面的都把发电厂那块地当障碍（stations.js 的 obstacles）。
import { BYPRODUCT, ITEMS, realItem, burnPerMinute, THERMAL_BANK as T, THERMAL_MW } from '../gamedata.js';
import { obstacles, pathfind, dirIndex, cropToContent } from './stations.js';
import { translateLayout } from './coordinates.js';
import { chainTiles } from '../emit/blueprint.js';

const key = (x, y) => `${x},${y}`;
const cell = (x, y, z) => `${x},${y},${z}`;

/** 布局实际占的外框 [x0, y0, x1, y1]：工厂、物流站、带子、出入口、已有的发电厂 */
function contentBox(L) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const inc = (x, y) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
  for (const p of L.pos.values()) {
    const hw = (p.g.bodyWidth - 1) / 2;
    for (const c of p.centers) { inc(c - hw, L.rowCy[p.row] - p.g.bodyBelow); inc(c + hw, L.rowCy[p.row] + p.g.bodyAbove); }
  }
  for (const st of L.stations || []) { inc(st.x - 3, st.y - 3); inc(st.x + 3, st.y + 3); }
  for (const ch of L.chains) for (const [x, y] of [...chainTiles(L, ch).main, ...chainTiles(L, ch).extra.flat()]) inc(x, y);
  for (const p of L.ports) inc(p.x, p.y);
  for (const b of L.burners || []) { inc(b.rect[0], b.rect[1]); inc(b.rect[2], b.rect[3]); }
  inc(0, 0);
  inc(L.width - 1, L.height - 1);
  return [x0, y0, x1, y1];
}

/** 这个物品能不能在火力发电厂里烧（有燃料值的副产物） */
export const burnable = (itemId) => itemId >= BYPRODUCT && burnPerMinute(itemId) > 0;
/** 一列最多串几台：最上面那两根集装分拣器要把整列的燃料都送进去（满负荷算）；接卫星配电站时另有覆盖限制 */
export function maxDepthFor(itemId, power) {
  const byRate = Math.max(1, Math.floor((2 * T.sorterRate * 60) / burnPerMinute(itemId) + 1e-9));
  return power === 'substation' ? Math.min(T.substationDepth, byRate) : byRate;
}
/** 列与列之间放电力感应塔的缝：每列发电厂中心右边 laneDx 那一列，加上第一列左边那一列 */
export function bankLanes(b) {
  const xs = [...new Set(b.plants.map(([x]) => x))].sort((p, q) => p - q);
  return [xs[0] - T.laneDx, ...xs.map((x) => x + T.laneDx)];
}

/**
 * 一排发电厂：x0 是第一列的起点，yF 是进料带那一行；cols 列、每列 depth 台，一共 n 台。
 * entry 'right'：进料带从右头进（往左流到死胡同），'left' 反过来。返回各台中心、占的长方形、进料带（从死胡同到入口那一格之前）、
 * 入口格（长方形外面紧挨着的那一格，接线从这里出发）和出发方向。
 */
export function bankAt(x0, yF, cols, depth, n, entry) {
  const plants = [];
  for (let i = 0; i < cols; i++) for (let j = 0; j < depth && plants.length < n; j++) plants.push([x0 + T.pitchX * i + T.plantDx, yF - T.feedDy - T.pitchY * j]);
  const deepest = Math.min(depth, n);
  const rect = [x0, yF - T.feedDy - T.pitchY * (deepest - 1) - 2, x0 + T.pitchX * cols - 1, yF];
  const xs = [];
  for (let x = rect[0]; x <= rect[2]; x++) xs.push(x);
  if (entry === 'left') xs.reverse();
  return {
    plants,
    rect,
    feed: xs.map((x) => [x, yF, 0]),
    gate: entry === 'right' ? [rect[2] + 1, yF, 0] : [rect[0] - 1, yF, 0],
    dir: entry === 'right' ? dirIndex(1, 0) : dirIndex(-1, 0),
    feedY: yF,
  };
}

/**
 * 发电厂上的分拣器（照蓝图）：进料带 → 最上面一台的 1、0 号口；上面一台的 3、4 号口 → 下面一台的 1、0 号口。
 * 每根 { from: 'belt' | 台号, fromSlot, to: 台号, toSlot, p0: [x, y], p1: [x, y], beltX }，坐标是落点（不取整）。
 */
export function bankSorters(b) {
  const out = [];
  const byCol = new Map();
  b.plants.forEach(([x, y], i) => {
    if (!byCol.has(x)) byCol.set(x, []);
    byCol.get(x).push({ i, y });
  });
  for (const [x, col] of byCol) {
    col.sort((a, c) => c.y - a.y);
    const top = col[0];
    out.push({ from: 'belt', to: top.i, toSlot: 1, p0: [x, b.feedY], p1: [x + T.slot[1][0], top.y + T.slot[1][1]], beltX: x });
    out.push({ from: 'belt', to: top.i, toSlot: 0, p0: [x + 0.8572, b.feedY], p1: [x + T.slot[0][0], top.y + T.slot[0][1]], beltX: x + 1 });
    for (let k = 0; k + 1 < col.length; k++) {
      const up = col[k], dn = col[k + 1];
      out.push({ from: up.i, fromSlot: 3, to: dn.i, toSlot: 1, p0: [x + T.slot[3][0], up.y + T.slot[3][1]], p1: [x + T.slot[1][0], dn.y + T.slot[1][1]] });
      out.push({ from: up.i, fromSlot: 4, to: dn.i, toSlot: 0, p0: [x + T.slot[4][0], up.y + T.slot[4][1]], p1: [x + T.slot[0][0], dn.y + T.slot[0][1]] });
    }
  }
  return out;
}

/**
 * 把标了 burn 的副产物出口接到发电厂上，返回新布局（接上的那条腿改成直接接段尾，stub 是从死胡同到段尾前一格的整条带）。
 * L.burners 记每一排，L.burnNotes 记没烧成的原因；没烧成的出口去掉 burn 标记，照旧送出（接物流站时进站）。
 * 在接物流站之前做（stationGroups 跳过烧掉的出口）。power：供电方式，决定一列最多几台（maxDepthFor）、塔放不放进缝。
 */
export function addBurners(source, { power = null, maxWidth = null, maxHeight = null, maxLevel = 6 } = {}) {
  let L = source;
  L.burners = L.burners || [];
  L.burnNotes = L.burnNotes || [];
  const name = (id) => ITEMS.get(realItem(id))?.name ?? String(id);
  for (const leg0 of L.ports.filter((p) => p.burn && p.kind === 'out' && p.station == null).map((p) => p.leg)) {
    const p0 = L.ports.find((q) => q.leg === leg0);
    const rate = p0.rate ?? 0;
    const n = Math.max(1, Math.ceil(rate / burnPerMinute(p0.itemId) - 1e-9));
    // 产线实际占的外框（带子、出入口可能伸出 0..宽−1 之外），发电厂摆在它外面
    const [cx0, cy0, cx1, cy1] = contentBox(L);
    const W = cx1 + 1, H = cy1 + 1;
    // 候选：每列 1~maxDepth 台 × 摆在右、左、下（下边时入口在左头或右头）
    const cands = [];
    const maxDepth = maxDepthFor(p0.itemId, power);
    // 发电厂和产线之间空几行（列）：放供电设施用。产线原来靠外沿加地供电的那一边被发电厂占了，这条缝要放得下设施：
    // 电力感应塔 1 格，卫星配电站 3×3 再加离化工厂下沿那 1 行，留 4
    const gap = power === 'substation' ? 4 : 1;
    for (let d = 1; d <= Math.min(maxDepth, n); d++) {
      const c = Math.ceil(n / d);
      const tall = T.feedDy + T.pitchY * (d - 1) + 3; // 这一块的高
      const wide = T.pitchX * c;
      // 摆在右边、左边时进料带尽量和出口同一行
      const yR = Math.min(Math.max(p0.y, cy0 + tall - 1), Math.max(cy1, cy0 + tall - 1));
      cands.push({ d, c, at: 'right', bank: bankAt(cx1 + 1 + gap, yR, c, d, n, 'left') });
      cands.push({ d, c, at: 'left', bank: bankAt(cx0 - gap - wide, yR, c, d, n, 'right') });
      cands.push({ d, c, at: 'below', bank: bankAt(cx0 + 1, cy0 - 1 - gap, c, d, n, 'left') });
      cands.push({ d, c, at: 'below', bank: bankAt(Math.max(cx0 + 1, cx1 - wide), cy0 - 1 - gap, c, d, n, 'right') });
    }
    const boxOf = (b) => [Math.min(cx0, b.rect[0], b.gate[0]), Math.min(cy0, b.rect[1]), Math.max(cx1, b.rect[2], b.gate[0]), Math.max(cy1, b.rect[3])];
    const fits = (bx) => (!maxWidth || bx[2] - bx[0] + 1 <= maxWidth) && (!maxHeight || bx[3] - bx[1] + 1 <= maxHeight);
    // 挑形状：外框面积，拼完比 3:1 还扁（还瘦）的按比例的平方加罚（用户 2026/10/07：形状最好 2:1~3:1，别超过 4:1）
    for (const c of cands) {
      const bx = boxOf(c.bank);
      const w = bx[2] - bx[0] + 1, h = bx[3] - bx[1] + 1;
      c.area = w * h * Math.max(1, Math.max(w, h) / Math.min(w, h) / 3) ** 2;
      c.ok = fits(bx);
    }
    const order = cands.filter((c) => c.ok).sort((a, b) => a.area - b.area || a.d - b.d).slice(0, 8);
    let done = null;
    for (const c of order) {
      // 平移到正坐标再找路；四周多留几格给接线绕
      const bx = boxOf(c.bank);
      const tx = 2 - bx[0], ty = 2 - bx[1];
      const trial = structuredClone(L);
      translateLayout(trial, tx, ty);
      const bank = structuredClone(c.bank);
      for (const pt of bank.plants) { pt[0] += tx; pt[1] += ty; }
      for (const f of bank.feed) { f[0] += tx; f[1] += ty; }
      bank.gate[0] += tx;
      bank.gate[1] += ty;
      bank.rect = [bank.rect[0] + tx, bank.rect[1] + ty, bank.rect[2] + tx, bank.rect[3] + ty];
      bank.feedY += ty;
      const TW = bx[2] - bx[0] + 5, TH = bx[3] - bx[1] + 5;
      const O = obstacles(trial);
      // 保险：这一块地（连入口格）上不能已经有东西
      let clash = O.solid.has(key(bank.gate[0], bank.gate[1])) || O.projection.has(key(bank.gate[0], bank.gate[1]));
      for (let x = bank.rect[0]; x <= bank.rect[2] && !clash; x++) for (let y = bank.rect[1]; y <= bank.rect[3]; y++) if (O.solid.has(key(x, y)) || O.ground.has(key(x, y)) || O.projection.has(key(x, y))) clash = true;
      if (clash) continue;
      for (let x = bank.rect[0]; x <= bank.rect[2]; x++) for (let y = bank.rect[1]; y <= bank.rect[3]; y++) O.solid.add(key(x, y));
      // 进料带上面那几行留给供电设施（最上面一台、产线挨着发电厂那一边都靠这里的设施供电），接线不走这里
      for (let x = bank.rect[0]; x <= bank.rect[2]; x++) for (let k = 1; k <= gap; k++) O.solid.add(key(x, bank.feedY + k));
      const port = trial.ports.find((q) => q.leg === p0.leg);
      const leg = trial.legs[port.leg];
      const seg = trial.segments[leg.from];
      const target = [seg.exitX, seg.y, 0];
      const own = [...leg.cells.map((q) => cell(...q)), ...(leg.direct ? [] : [cell(leg.edge, leg.py, 0)])];
      const path = pathfind(bank.gate, target, O, TW, TH, maxLevel, bank.dir, new Set(own), dirIndex(-seg.dout, 0));
      if (!path) continue;
      // 面积一样（比如摆在下边、入口在左头还是右头）时挑接线短的：每个候选都试，按「外框面积 + 接线代价」挑最小的
      const score = c.area + path.cost;
      if (done && done.score <= score) continue;
      leg.stub = [...bank.feed, ...path.cells.slice(0, -1)].map((c) => c.slice()); // 拷一份：和 bank.feed 共用数组的话平移时会挪两遍
      leg.cells = [];
      leg.shadow = [];
      leg.level = 0;
      leg.direct = true;
      [leg.edge, leg.py] = target;
      [port.x, port.y] = target;
      port.direct = true;
      leg.burn = trial.burners.length;
      trial.width = TW;
      trial.height = TH;
      trial.burners.push({ itemId: realItem(p0.itemId), rate, plants: bank.plants, feed: bank.feed, gate: bank.gate, rect: bank.rect, feedY: bank.feedY, depth: c.d, cols: c.c, mw: bank.plants.length * THERMAL_MW });
      cropToContent(trial);
      done = { L: trial, score };
    }
    if (done) L = done.L;
    else {
      p0.burn = false;
      L.burnNotes.push(`多余的${name(p0.itemId)}没地方放火力发电厂（${maxWidth || maxHeight ? '宽、长上限内放不下，或' : ''}接不上），照旧送出`);
    }
  }
  return L;
}
