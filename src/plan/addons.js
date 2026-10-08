// 增产剂与自动集装机：照用户 2026-10-04 给的分馏阵列（src/fractionate/template.js）学来的摆法，作为后处理加到普通产线上。
//
//   自动集装机：放在一节直带上。那一格拆成两节带子：进集装机的一节往来路方向偏 0.2 格（接集装机 1 号口），
//     出来的一节往去路方向偏 0.2 格（从集装机 0 号口出）；集装机朝向 = 流向。用在产物出线（进物流站或出边缘）之前，
//     把产物叠成几层再送走（层数看「货物集装」科技）。
//   喷涂机：骑在一节直带上（压着的 3 格不转弯、不升降，再往外各一格也顺着进出，见 coaterFits），朝向沿着带子；它「背后」那一格（朝向的反方向）正上方第 1 层要有一条增产剂带横穿过去，
//     喷涂机从那里取增产剂。增产剂带是一条死路：从物流站的一个空口（或边缘的一个入口）出来，按顺序横穿若干台喷涂机背后那格，
//     最后一台之后再多走一节。原图里 5 号口出增产剂，沿 y=41、x=26 这样的高架经过 6 台喷涂机。
//   喷什么（用户 2026/10/08）：所有原料和中间产物——每条有取料分拣器把料送进工厂的带，都要在最后一个放料口之后、
//     第一个取料口之前过一台喷涂机（工厂产出的东西不带增产，进下一台工厂前要再喷；一个访问里生产者消费者交错就喷不到，
//     走线已经保证不交错并留出直带空当，见 layout/belts.js 的 sprayAll / SPRAY_GAP）。喷涂机几十台时一条增产剂带串不完，
//     开几条（L.proLines），尽量都从同一座站出来（整张存增产剂只占一个物流站格，keepFreeSlot 留的那格）。
import { chainTiles } from '../emit/blueprint.js';
import { translateLayout } from './coordinates.js';
import { obstacles, obstacleGrid, pathfind, dirIndex, STATION_PORTS, CUT } from './stations.js';
import { sprayGapCells } from './layout/elevation.js';
import { SPRAY_LEVELS, ITEMS, realItem } from '../gamedata.js';

const key = (x, y) => `${x},${y}`;
const cell = (x, y, z) => `${x},${y},${z}`;
/** 喷涂机朝向 → 取增产剂那一格相对它的偏移（背后）：朝北（0）取南边那格，朝东（90）取西边，以此类推 */
export const COATER_BEHIND = { 0: [0, -1], 90: [-1, 0], 180: [0, 1], 270: [1, 0] };
export const coaterYaw = (dx, dy) => Number(Object.keys(COATER_BEHIND).find((k) => COATER_BEHIND[k][0] === dx && COATER_BEHIND[k][1] === dy));

/** 第 k 格和前后两格在一条直线上、都在地面 */
const straight = (t, k) => {
  const a = t[k - 1], b = t[k], c = t[k + 1];
  if (!a || !b || !c || a[2] || b[2] || c[2]) return false;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  return Math.abs(dx) + Math.abs(dy) === 1 && c[0] - b[0] === dx && c[1] - b[1] === dy;
};
/**
 * 喷涂机能不能骑在第 k 格（用户 2026/10/07 两张实测蓝图）：它压着的 3 格（k−1、k、k+1）不能转弯、不能升降，
 * 所以这 3 格在地面一条直线上，而且再往外各一格（k−2、k+2）也在地面、顺着同一方向进出——转弯、坡道、竖直升降最近只能在 k±2 那格。
 * 带子从 k−1 开头（边缘入口，没有来路）可以；从物流站出来的带子 k−1 是第一格时，站口的朝向说不准，不放。
 */
const coaterFits = (t, k, openStart = false) => {
  if (!straight(t, k)) return false;
  const dx = t[k][0] - t[k - 1][0], dy = t[k][1] - t[k - 1][1];
  const a = t[k - 2], c = t[k + 2];
  if (a ? a[2] || t[k - 1][0] - a[0] !== dx || t[k - 1][1] - a[1] !== dy : !openStart) return false;
  return !c || (!c[2] && c[0] - t[k + 1][0] === dx && c[1] - t[k + 1][1] === dy);
};

/**
 * 喷涂机对齐（用户 2026/10/07：喷涂机最好保持整齐）。每条要喷的带上能骑喷涂机的位置一般有好几个，这里挑尽量少的几列，
 * 让各台喷涂机的取料格对成一条线：横带上的取料格同一列（增产剂带竖着一路穿过去），竖带上的同一行。
 * 贪心集合覆盖：每次挑能覆盖最多条带的那一列；一样多时先挑这几台之间整段第 1 层都空着（增产剂带能直着走，blocked 判挡不挡）的，
 * 再挑离已经选中的列近的。每条带的候选按「在选中的列上」排前面、其余按离选中的列多远排，最多留 6 个给找路（找路按顺序试）。
 */
/** 喷涂机取料格所在的线：横带上是取料格那一列（增产剂带竖着穿），竖带上是那一行 */
const lineOf = (o) => (o.y === o.iy ? `x${o.ix}` : `y${o.iy}`);
function alignCoaters(wants, blocked) {
  const left = new Set(wants);
  const chosen = []; // [{ key, at: 列或行的坐标, vertical }]
  while (left.size) {
    const cover = new Map(); // key → { wants: Set, at, vertical, cells: [取料格的另一坐标] }
    for (const w of left) for (const o of w.options) {
      const k = lineOf(o);
      if (!cover.has(k)) cover.set(k, { wants: new Set(), at: o.y === o.iy ? o.ix : o.iy, vertical: o.y === o.iy, cells: [] });
      const c = cover.get(k);
      if (!c.wants.has(w)) c.cells.push(c.vertical ? o.iy : o.ix);
      c.wants.add(w);
    }
    if (!cover.size) break;
    const straightOk = (c) => {
      if (c.wants.size < 2) return false;
      const lo = Math.min(...c.cells), hi = Math.max(...c.cells);
      for (let v = lo + 1; v < hi; v++) if (!c.cells.includes(v) && (c.vertical ? blocked(c.at, v) : blocked(v, c.at))) return false;
      return true;
    };
    const near = (c) => (chosen.length ? Math.min(...chosen.filter((q) => q.vertical === c.vertical).map((q) => Math.abs(q.at - c.at)), 99) : 0);
    let best = null;
    for (const [k, c] of cover) {
      const score = [c.wants.size, straightOk(c) ? 1 : 0, -near(c)];
      if (!best || score[0] > best.score[0] || (score[0] === best.score[0] && (score[1] > best.score[1] || (score[1] === best.score[1] && score[2] > best.score[2])))) best = { k, c, score };
    }
    chosen.push({ key: best.k, at: best.c.at, vertical: best.c.vertical });
    for (const w of best.c.wants) left.delete(w);
  }
  const rank = new Map(chosen.map((q, i) => [q.key, i]));
  const dist = (o) => Math.min(99, ...chosen.filter((q) => q.vertical === (o.y === o.iy)).map((q) => Math.abs(q.at - (o.y === o.iy ? o.ix : o.iy))));
  for (const w of wants) {
    w.options.sort((a, b) => (rank.get(lineOf(a)) ?? 1e9) - (rank.get(lineOf(b)) ?? 1e9) || dist(a) - dist(b));
    w.options = w.options.slice(0, 6);
  }
}

/**
 * 在布局上加自动集装机（pile）和喷涂机 + 增产剂带（spray 1~3）。改写 L：
 *   L.pilers   [{chain, x, y, dx, dy, itemId}]   集装机所在格和流向
 *   L.coaters  [{chain, x, y, ix, iy, itemId}]   喷涂机所在格、取料格
 *   L.proLines [{cells, station: {k, slot} | null, edge, itemId, rate}]  增产剂带（逐格，从源头起），可能有几条
 *   L.addonNotes 放不下的说明；L.sprayMissed 没喷上的带数（应为 0，finishOne 据此判不可行）
 */
export function addAddons(L, { spray = 0, pile = false, sprayRate = 0 } = {}) {
  L.pilers = [];
  L.coaters = [];
  L.proLines = [];
  L.addonNotes = [];
  L.sprayMissed = 0;
  if (!spray && !pile) return L;
  const eff = SPRAY_LEVELS[spray] ?? null;
  if (eff) {
    // 四周各留两格给增产剂带绕路、给边缘入口往外接（最后裁掉没用到的）。
    // 不接站的布局里，原料入口的直带空当可能伸到负坐标（layout/belts.js 的 SPRAY_GAP），一并挪回正数
    let mnx = 0, mny = 0;
    for (const ch of L.chains) {
      const t = chainTiles(L, ch);
      for (const [x, y] of [...t.main, ...t.extra.flat()]) {
        if (x < mnx) mnx = x;
        if (y < mny) mny = y;
      }
    }
    translateLayout(L, 2 - mnx, 2 - mny);
    L.width += 4 - mnx;
    L.height += 4 - mny;
  }
  const tiles = L.chains.map((ch) => chainTiles(L, ch));
  const sorterCells = new Set(L.sorterList.map((s) => key(s.col, L.segments[s.segId].y)));
  const overhead = new Set(); // 头顶有高架的格子（任何层）：集装机不放
  const overheadZ = new Map(); // 头顶高架的最低层：喷涂机两层高，第 3 层以上的高架不碍事（走线的保护区也只占 1~2 层）
  for (const t of tiles) for (const [x, y, z] of [...t.main, ...t.extra.flat()]) if (z > 0) {
    overhead.add(key(x, y));
    const k = key(x, y);
    if (!(overheadZ.get(k) <= z)) overheadZ.set(k, z);
  }
  const lowOverhead = (x, y) => (overheadZ.get(key(x, y)) ?? 9) <= 2;
  const nearStation = (x, y) => (L.stations || []).some((st) => Math.abs(st.x - x) <= 3 && Math.abs(st.y - y) <= 3);
  const used = new Set();
  // 喷涂机的空当（layout/belts.js 留的直带）：集装机不去占
  const gapGuard = new Set();
  if (eff) for (const s of L.segments) if (s.sprayGap) for (const x of sprayGapCells(s)) gapGuard.add(key(x, s.y));
  const free = (x, y) => !sorterCells.has(key(x, y)) && !overhead.has(key(x, y)) && !nearStation(x, y) && !used.has(key(x, y)) && !gapGuard.has(key(x, y));
  const name = (id) => ITEMS.get(realItem(id))?.name ?? String(id);

  if (pile) {
    const missed = [];
    tiles.forEach((t, ci) => {
      if (!t.outStation && !t.outPort) return;
      if (L.chains[ci].parts.some((q) => q.leg != null && L.legs[q.leg].burn != null)) return; // 送去火力发电厂烧掉的副产物不集装
      const m = t.main;
      for (let k = m.length - 2; k >= 1; k--) {
        if (!straight(m, k) || !free(m[k][0], m[k][1])) continue;
        L.pilers.push({ chain: ci, x: m[k][0], y: m[k][1], dx: m[k + 1][0] - m[k][0], dy: m[k + 1][1] - m[k][1], itemId: L.chains[ci].itemId });
        used.add(key(m[k][0], m[k][1]));
        return;
      }
      missed.push(name(L.chains[ci].itemId));
    });
    if (missed.length) L.addonNotes.push(`产物「${missed.join('、')}」出线前没有能放自动集装机的直带，没集装`);
  }

  if (eff) {
    // 1. 每条要进工厂的带（有取料分拣器的链）挑几个能骑喷涂机的位置：要在这条带最后一个放料口之后、
    //    第一个取料口之前（放在放料口上游的话，后放上来的料没喷到；走线留的直带空当保证这里有地方，
    //    见 layout/belts.js 的 SPRAY_GAP）。喷涂机压着的 3 格上不能有分拣器横穿、头顶不能有高架；
    //    取料格是它上游相邻的一格（也在这条带上），增产剂带要在取料格正上方第 1 层横穿过去（和这条带垂直），
    //    所以取料格两侧第 1 层至少有一个方向是空的。
    //    （2026/10/07 以前上游那格不能用时会改用下游那格，喷涂机就倒过来、机身伸向上游，接物流站时撞到站，用户进游戏发现的）
    const O0 = obstacles(L);
    // 保护区（obstacles 里替接站的线、翘曲器带挡着的那几格）在这里放开：增产剂带就是要从这里横穿
    for (const [x, y] of O0.sprayGuard.guard2) for (const z of [1, 2]) O0.belts.delete(cell(x, y, z));
    for (const [x, y] of O0.sprayGuard.guard1) O0.belts.delete(cell(x, y, 1));
    for (const st of L.stations || []) for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) O0.solid.add(key(st.x + dx, st.y + dy));
    const W = L.width, H = L.height;
    const inside = (x, y) => x >= 0 && y >= 0 && x < W && y < H;
    const air = (x, y) => inside(x, y) && !O0.belts.has(cell(x, y, 1)) && !O0.solid.has(key(x, y)) && !nearStation(x, y);
    const perpsOf = (ix, iy, ax, ay) => [[ay, ax], [-ay, -ax]].filter(([px, py]) => air(ix - px, iy - py) && air(ix + px, iy + py));
    // 分拣器横穿的格子（整根，从工厂边缘到所接的轨道）：喷涂机压着的 3 格、取料格都不能被横穿
    const sorterSpan = new Set();
    for (const s of L.sorterList) {
      const p = L.pos.get(s.bid);
      const y0 = L.rowCy[p.row] + (s.side === 'top' ? p.g.edgeAbove : -p.g.edgeBelow);
      const y1 = L.segments[s.segId].y;
      for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) sorterSpan.add(key(s.col, y));
    }
    // 每条链上的取放口在主链第几格
    const segChain = new Map();
    L.chains.forEach((ch, ci) => { for (const q of ch.parts) if (q.seg != null) segChain.set(q.seg, ci); });
    const tapsByChain = new Map(); // ci -> [{x, y, io}]
    for (const s of L.sorterList) {
      const ci = segChain.get(s.segId);
      if (ci == null) continue;
      if (!tapsByChain.has(ci)) tapsByChain.set(ci, []);
      tapsByChain.get(ci).push({ x: s.col, y: L.segments[s.segId].y, io: s.io });
    }
    const chainRate = (ch) => Math.max(0, ...ch.parts.filter((q) => q.seg != null).map((q) => L.segments[q.seg].rate));
    const wants = []; // 每条要喷的带：{chain, itemId, rate, options: [...]}
    const missed = [];
    tiles.forEach((t, ci) => {
      const taps = tapsByChain.get(ci) || [];
      if (!taps.some((q) => q.io === 'in')) return; // 没有取料口：不进工厂（成品、副产物），不用喷
      const m = t.main;
      const idxOf = new Map();
      m.forEach(([x, y, z], i) => { if (!z && !idxOf.has(key(x, y))) idxOf.set(key(x, y), i); });
      let firstIn = Infinity;
      let lastOut = -1;
      let offMain = false; // 劈开的死胡同那一半（extra）上的取料口：主链上喷不到它
      for (const q of taps) {
        const i = idxOf.get(key(q.x, q.y));
        if (i == null) {
          if (q.io === 'in') offMain = true;
          continue; // 死胡同那一半上的放料口：那些料到不了主链，不影响主链的喷涂位置
        }
        if (q.io === 'in') firstIn = Math.min(firstIn, i);
        else lastOut = Math.max(lastOut, i);
      }
      if (offMain || lastOut >= firstIn) {
        // 取料口在劈开的死胡同上，或放料口排在取料口下游（交错）：喷不到。开喷增产剂的走线不会出这种链
        missed.push(name(L.chains[ci].itemId));
        return;
      }
      const openStart = !t.inStation;
      const options = [];
      if (firstIn < Infinity) for (let k = Math.max(1, lastOut + 2); k < firstIn - 1 && options.length < 40; k++) {
        if (!coaterFits(m, k, openStart)) continue;
        const three = [m[k - 1], m[k], m[k + 1]]; // 压着的 3 格
        if (three.some(([x, y]) => sorterSpan.has(key(x, y)) || lowOverhead(x, y) || used.has(key(x, y)) || nearStation(x, y))) continue;
        const ax = m[k + 1][0] - m[k][0], ay = m[k + 1][1] - m[k][1];
        const [ix, iy] = m[k - 1];
        if (!air(ix, iy)) continue;
        const perps = perpsOf(ix, iy, ax, ay);
        // 半边也算：另一侧贴着工厂过不去时，增产剂带可以从空的那一侧进来、在取料格上终止（死胡同；
        // 参考蓝图里都是横穿过去的，终点落在取料格上待游戏里验证）
        const halfPerps = [[ay, ax], [-ay, -ax]].filter(([px, py]) => air(ix - px, iy - py));
        if (halfPerps.length) options.push({ x: m[k][0], y: m[k][1], ix, iy, perps, halfPerps });
      }
      // 边缘入口一进来就有分拣器取料：把入口往外接出两节（入口原地升起时三节），喷涂机骑在外面，取料格在最外面
      if (!options.length && t.inPort && !t.inStation) {
        const part = L.chains[ci].parts.find((q) => q.leg != null && L.legs[q.leg].kind === 'in');
        const leg = part && L.legs[part.leg];
        const port = L.ports.find((q) => q.leg === part?.leg && q.kind === 'in');
        if (leg && port && !leg.pre) {
          const [x0, y0] = m[0];
          const dx = x0 < W / 2 ? -1 : 1; // 往外
          for (const n of [2, 3]) {
            const pre = Array.from({ length: n }, (_, i) => [x0 + (n - i) * dx, y0, 0]);
            // 往外接的 n 节 + 原来的头两格：喷涂机骑在 pre[1]，压着的 3 格到带头，再往里一格也得顺着同一方向、在地面
            const clear = pre.every(([x, y]) => inside(x, y) && !O0.belts.has(cell(x, y, 0)) && !O0.solid.has(key(x, y)) && !O0.ground.has(key(x, y)) && air(x, y)) && coaterFits([...pre, ...m.slice(0, 2)], 1, true);
            if (!clear) continue;
            const perps = perpsOf(pre[0][0], y0, -dx, 0);
            const halfPerps = [[0, -dx], [0, dx]].filter(([px, py]) => air(pre[0][0] - px, y0 - py));
            if (halfPerps.length) {
              options.push({ x: pre[1][0], y: y0, ix: pre[0][0], iy: y0, perps, halfPerps, pre: { leg, port, cells: pre } });
              break;
            }
          }
        }
      }
      if (options.length) wants.push({ chain: ci, itemId: L.chains[ci].itemId, rate: chainRate(L.chains[ci]) / eff.sprays, options });
      else missed.push(name(L.chains[ci].itemId));
    });
    alignCoaters(wants, (x, y) => !air(x, y));
    // 2. 增产剂带：喷涂机多（所有原料和中间产物都喷）时一条死路串不完，开几条，每条从一个源头
    //    （物流站空口，或边缘的一个入口）出来，依次横穿就近的喷涂机背后那格。障碍是工厂、物流站、已有的带子
    //    （各层）、分拣器（地面）、已开的增产剂带；集装机和选定的喷涂机头顶两层让开，往外接的入口那几节地面也让开。
    //    整张蓝图存增产剂仍然只占一个物流站格：先用已经存了增产剂的站的空口，没有了才在有空格的别的站再开一格。
    const O = { ...O0, belts: new Set(O0.belts) };
    for (const w of wants) for (const o of w.options) for (const c of o.pre?.cells ?? []) O.belts.add(cell(...c));
    for (const p of L.pilers) for (const z of [1, 2]) O.belts.add(cell(p.x, p.y, z));
    // 障碍的格子版（寻路直接查数组，不再每格拼字符串查集合）：带子集合每增删一格，网格的 belts 层跟着改（put / drop）
    O.grid = obstacleGrid(O, W, H, 4);
    const mark = (T, x, y, z, b) => {
      if (Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(z) && x >= 0 && y >= 0 && z >= 0 && x < W && y < H && z <= 4) T.grid.belts[(z * H + y) * W + x] = b;
    };
    const put = (T, [x, y, z]) => {
      T.belts.add(cell(x, y, z));
      mark(T, x, y, z, 1);
    };
    // 试串一个源头时只改网格（tput / tdrop，记下改前的值），串完照 undo 改回去；试串时问带子也只问网格（hasB）。
    // 试串里问到、改到的格子都在网格里（取料格、出口格、喷涂机头顶都先判过 inside / air，路上的格子是寻路给的），
    // 网格在这些格上和原来每个源头复制一份的带子集合逐格一致
    const GB = O.grid.belts;
    const undo = [];
    const inGrid = (x, y, z) => Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(z) && x >= 0 && y >= 0 && z >= 0 && x < W && y < H && z <= 4;
    const tset = ([x, y, z], b) => {
      if (!inGrid(x, y, z)) return;
      const i = (z * H + y) * W + x;
      undo.push(i, GB[i]);
      GB[i] = b;
    };
    const tput = (c) => tset(c, 1);
    const tdrop = (c) => tset(c, 0);
    const hasB = (x, y, z) => (inGrid(x, y, z) ? GB[(z * H + y) * W + x] === 1 : O.belts.has(cell(x, y, z)));
    const unserved = [];
    let todoAll = wants.slice();
    while (todoAll.length) {
      const all = todoAll.flatMap((w) => w.options);
      const cx = all.reduce((a, c) => a + c.ix, 0) / Math.max(1, all.length);
      const cy = all.reduce((a, c) => a + c.iy, 0) / Math.max(1, all.length);
      // 源头：有站就用站的空口（优先已经存了增产剂的站；没存的站要有空的物品格才行），否则从左右边缘进来
      const sources = [];
      (L.stations || []).forEach((st, k) => {
        const hasPro = st.items.some((it) => realItem(it.itemId) === eff.item);
        if (!hasPro && st.items.length >= 5) return;
        const usedSlots = new Set(st.ports.map((p) => p.slot));
        for (const q of STATION_PORTS) {
          if (usedSlots.has(q.slot)) continue;
          const stub = [0, 1, 2].map((d) => [st.x + q.dx + q.nx * d, st.y + q.dy + q.ny * d, 0]);
          if (stub.some(([x, y]) => !inside(x, y) || O.belts.has(cell(x, y, 0)))) continue;
          const s = stub[2];
          if (O.solid.has(key(s[0], s[1])) || O.ground.has(key(s[0], s[1]))) continue;
          sources.push({ start: s, dir: dirIndex(q.nx, q.ny), lead: stub.slice(0, 2), station: { k, slot: q.slot }, needsItem: !hasPro, d: Math.abs(s[0] - cx) + Math.abs(s[1] - cy) });
        }
      });
      if (!L.stations?.length) {
        for (const [x, nx] of [[0, 1], [W - 1, -1]]) for (let y = 0; y < H; y++) {
          if (O.belts.has(cell(x, y, 0)) || O.solid.has(key(x, y)) || O.ground.has(key(x, y)) || O.belts.has(cell(x + nx, y, 0))) continue;
          sources.push({ start: [x, y, 0], dir: dirIndex(nx, 0), lead: [], station: null, needsItem: false, d: Math.abs(x - cx) + Math.abs(y - cy) });
        }
      }
      sources.sort((a, b) => (a.needsItem ? 1 : 0) - (b.needsItem ? 1 : 0) || a.d - b.d);
      let best = null;
      for (const src of sources.slice(0, 8)) {
        const cells = [...src.lead, src.start];
        for (const c of cells) tput(c);
        // 还没接到的取料格先当障碍，免得增产剂带顺路压过去（方向不对）
        for (const o of all) tput([o.ix, o.iy, 1]);
        let cur = src.start;
        let dir = src.dir;
        const todo = todoAll.slice();
        const done = [];
        let hopeless = false;
        while (todo.length) {
          // 剩下的全串上也比不过已有的最好那条（串的台数少，或者一样多但带子已经不比它短）：这个源头不用再串下去，结果一样
          if (best && (done.length + todo.length < best.done.length || (done.length + todo.length === best.done.length && cells.length >= best.cells.length))) {
            hopeless = true;
            break;
          }
          const dist = (w) => Math.min(...w.options.map((o) => Math.abs(o.ix - cur[0]) + Math.abs(o.iy - cur[1])));
          todo.sort((a, b) => dist(a) - dist(b));
          const w = todo.shift();
          let got = null;
          for (const o of w.options) {
            // 取料格一直当障碍（找的是到它前面那格 a 的路）：2026/10/07 以前这里先把它拿掉，路会先穿过取料格走到 a、
            // 再掉头横穿回来，增产剂带压回自己（引力矩阵 30 接站喷 Mk.II 六个种子里两三个出现）
            const head = [1, 2].filter((z) => !hasB(o.x, o.y, z)).map((z) => [o.x, o.y, z]);
            for (const c of head) tput(c);
            for (const [px, py] of o.perps) {
              const a = [o.ix - px, o.iy - py, 1];
              const b = [o.ix + px, o.iy + py, 1];
              // 出口那格正好是另一条要喷的带的取料格、而且也是横穿：可以接着穿过去（一条增产剂带顺路喂两台喷涂机）
              const serves = (x, y) => todo.some((w2) => w2.options.some((o2) => o2.ix === x && o2.iy === y && o2.perps.some(([qx, qy]) => Math.abs(qx) === Math.abs(px) && Math.abs(qy) === Math.abs(py))));
              if (hasB(...a) || (hasB(...b) && !serves(b[0], b[1]))) continue;
              // 出口那格找路时也不许经过（不然先路过出口、再从 a 横穿回来，同样压回自己）
              const bFree = !hasB(...b);
              if (bFree) tput(b);
              // 已经有一条了：只要更短的（pathfind 的 cut，返回 CUT 时原来找到的也不比它短）
              const path = pathfind(cur, a, O, W, H, 4, dir, null, dirIndex(px, py), got ? got.cost : Infinity);
              if (bFree) tdrop(b);
              if (path && path !== CUT && (!got || path.cost < got.cost)) got = { o, cells: [...path.cells.slice(1), [o.ix, o.iy, 1], b], cost: path.cost, dir: dirIndex(px, py) };
            }
            tput([o.ix, o.iy, 1]);
            if (got) break;
            for (const c of head) tdrop(c);
          }
          // 退路：横穿不过去（比如另一侧贴着工厂）时，带子从空的那一侧进来、在取料格上终止。
          // 死胡同终点落在取料格上，这条增产剂带到此为止，剩下的喷涂机让下一条线管
          if (!got) for (const o of w.options) {
            const head = [1, 2].filter((z) => !hasB(o.x, o.y, z)).map((z) => [o.x, o.y, z]);
            for (const c of head) tput(c);
            for (const [px, py] of o.halfPerps) {
              const a = [o.ix - px, o.iy - py, 1]; // 空的那一侧：先到它，再横着迈进取料格
              if (hasB(...a)) continue;
              const path = pathfind(cur, a, O, W, H, 4, dir, null, dirIndex(px, py), got ? got.cost : Infinity);
              if (path && path !== CUT && (!got || path.cost < got.cost)) got = { o, cells: [...path.cells.slice(1), [o.ix, o.iy, 1]], cost: path.cost, dir: dirIndex(px, py), dead: true };
            }
            tput([o.ix, o.iy, 1]);
            if (got) break;
            for (const c of head) tdrop(c);
          }
          if (!got) continue;
          for (const p of got.cells) tput(p);
          cells.push(...got.cells);
          cur = got.cells.at(-1);
          dir = got.dir;
          done.push({ w, o: got.o });
          if (got.dead) break; // 死胡同终点：这条线到头了
          // 顺路：现在停在别的要喷的带的取料格上（方向横穿），再往前走一格就把那台也喂上
          for (;;) {
            const [dx, dy] = [[1, 0], [-1, 0], [0, 1], [0, -1]][dir];
            const hit = todo.findIndex((w2) => w2.options.some((o2) => o2.ix === cur[0] && o2.iy === cur[1] && o2.perps.some(([qx, qy]) => Math.abs(qx) === Math.abs(dx) && Math.abs(qy) === Math.abs(dy))));
            const nxt = [cur[0] + dx, cur[1] + dy, 1];
            if (hit < 0 || !inside(nxt[0], nxt[1]) || hasB(...nxt) || O.solid.has(key(nxt[0], nxt[1]))) break;
            const w2 = todo.splice(hit, 1)[0];
            const o2 = w2.options.find((q) => q.ix === cur[0] && q.iy === cur[1]);
            for (const z of [1, 2]) tput([o2.x, o2.y, z]);
            tput(nxt);
            cells.push(nxt);
            cur = nxt;
            done.push({ w: w2, o: o2 });
          }
        }
        // 网格改回试串这个源头之前
        for (let u = undo.length - 2; u >= 0; u -= 2) GB[undo[u]] = undo[u + 1];
        undo.length = 0;
        if (!hopeless && done.length && (!best || done.length > best.done.length || (done.length === best.done.length && cells.length < best.cells.length))) {
          best = { done, cells, src };
          if (done.length === todoAll.length) break;
        }
      }
      if (!best) break; // 没有源头或一台都串不上：剩下的记为接不上
      // 把这条线落到实处
      for (const { w, o } of best.done) {
        L.coaters.push({ chain: w.chain, x: o.x, y: o.y, ix: o.ix, iy: o.iy, itemId: w.itemId });
        used.add(key(o.x, o.y));
        for (const z of [1, 2]) put(O, [o.x, o.y, z]); // 后开的线让开这台喷涂机的头顶
        if (o.pre) {
          o.pre.leg.pre = o.pre.cells;
          o.pre.port.x = o.pre.cells[0][0];
          L.belts += o.pre.cells.length;
        }
      }
      for (const c of best.cells) put(O, c);
      const rate = best.done.reduce((a, { w }) => a + w.rate, 0);
      L.proLines.push({ cells: best.cells, station: best.src.station, itemId: eff.item, rate, edge: best.src.station ? null : best.src.start.slice(0, 2) });
      if (best.src.station) {
        const st = L.stations[best.src.station.k];
        if (!st.items.some((it) => realItem(it.itemId) === eff.item)) st.items.push({ itemId: eff.item, role: 'demand' });
        st.ports.push({ slot: best.src.station.slot, itemId: eff.item, dir: 'out', spray: true });
      } else {
        L.ports.push({ kind: 'in', itemId: eff.item, x: best.src.start[0], y: best.src.start[1], rate, spray: true });
      }
      L.belts += best.cells.length;
      L.airBelts += best.cells.filter((c) => c[2] > 0).length;
      const served = new Set(best.done.map((d) => d.w));
      todoAll = todoAll.filter((w) => !served.has(w));
    }
    for (const w of todoAll) unserved.push(name(w.itemId));
    L.sprayMissed = missed.length + unserved.length;
    if (missed.length) L.addonNotes.push(`「${[...new Set(missed)].join('、')}」那条带没地方放喷涂机，没喷`);
    if (unserved.length) L.addonNotes.push(`「${[...new Set(unserved)].join('、')}」的喷涂机接不上增产剂带（${L.stations?.length ? '物流站的空口、空的物品格不够用，或绕不过去' : '边缘没有空位'}），没喷`);
    // 3. 裁掉没用到的边
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const include = (x, y) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
    for (const p of L.pos.values()) {
      const hw = (p.g.bodyWidth - 1) / 2;
      for (const c of p.centers) { include(c - hw, L.rowCy[p.row] - p.g.bodyBelow); include(c + hw, L.rowCy[p.row] + p.g.bodyAbove); }
    }
    for (const st of L.stations || []) { include(st.x - 3, st.y - 3); include(st.x + 3, st.y + 3); }
    for (const ch of L.chains) {
      const t = chainTiles(L, ch);
      for (const [x, y] of [...t.main, ...t.extra.flat()]) include(x, y);
    }
    for (const p of L.ports) include(p.x, p.y);
    for (const pl of L.proLines) for (const [x, y] of pl.cells) include(x, y);
    for (const b of L.burners || []) { include(b.rect[0], b.rect[1]); include(b.rect[2], b.rect[3]); } // 火力发电厂（plan/burn.js）
    translateLayout(L, -x0, -y0);
    L.width = x1 - x0 + 1;
    L.height = y1 - y0 + 1;
  }
  L.belts += L.pilers.length; // 集装机那一格拆成两节带子
  L.area = L.width * L.height;
  return L;
}
