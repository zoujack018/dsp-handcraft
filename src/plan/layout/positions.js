// 横向位置：把块排进各行，确定每台工厂的中心列、能竖直穿行的空列和出入口所在的列
import { STATION_COLS, STATION_SIZE, TRUNK } from './shared.js';

// 每行被工厂占的列（位图 busyBits：每行 NW 个 32 位字），以及备用的按行累计表（busyAcc）和算它时一行的占用（busyRow），
// 都按线程复用：只在 route() 里用，不跨调用
let busyBitsBuf = new Int32Array(0);
let busyAccBuf = new Int32Array(0);
let busyRowBuf = new Uint8Array(0);
// 每列已有的竖直高架段（下面 addLoad 记的）也按线程复用：0..WB−1 的整数列各一个持久的数组 LOAD[x]，这一次记了几条在 loadN[x]，
// loadGen[x] 不是这一次的代际就当这列还空着（不用清零；每次 placeBlocks 换一个代际）
const LOAD = [];
let loadN = new Int32Array(0);
let loadGen = new Int32Array(0);
let loadStamp = 0;
// 拼对外数组用的共用数组（块的 centers、rowBelow 用 TMP，rowAbove 用 TMP2）：先写进前 n 项，再切一份刚好长度的出去
const TMP = [];
const TMP2 = [];

/** v 是 [lo, hi) 里的整数（-0 也算 0） */
const isInt = (v, lo, hi) => (v | 0) === v && v >= lo && v < hi;

/** route() 的一步：读写共享的布局上下文 c */
export function placeBlocks(c) {
  const { blocks, graph, holePlan, opt, pads, rows, side, streets } = c;
  // ---------- A. 横向位置 ----------
  const pos = new Map(); // 块 ID -> 位置
  const blocksOf = new Map(); // 组 ID -> 块位置[]
  let rowWidth = 0;
  const blockOf = (bid) => blocks?.[bid] ?? { gid: bid, n: graph.byId.get(bid).count };
  // 辅路：生产区里预留的整列空地（相对生产区第一列的偏移），每一行的块都让开它，竖直走的高架带就能从内部穿过，
  // 不必都绕到外圈。由退火决定加不加（默认关，见 place.js）。
  const streetX = [];
  /** 把块放在 x 处（含左边空列），返回下一块的起点 */
  const put = (bid, r, x) => {
    const b = blockOf(bid);
    const g = graph.byId.get(b.gid);
    x += pads[bid] || 0;
    const w0 = b.n * g.pitch + g.trailing;
    for (let i = 0; i < streetX.length; i++) {
      const sx = streetX[i];
      if (sx >= x && sx <= x + w0 - 1) x = sx + 1; // 块压在辅路上：整块挪到辅路右边
    }
    // 一台工厂中心在其占位内的偏移：熔炉 3 格占位取中间，制造台 4 格占位取第 3 格，化工厂 7 格取第 4 格，对撞机左边空 1 列取第 6 格
    let nc = 0;
    for (let i = 0; i < b.n; i++) TMP[nc++] = x + i * g.pitch + g.center;
    const centers = TMP.slice(0, nc);
    const w = b.n * g.pitch + g.trailing;
    // 取放料的列：中心左右各 1 列（三个槽位）；储液罐（箱子供货）只有中间那一列
    const reach = g.store?.tank ? 0 : 1;
    const p = { bid, gid: b.gid, g, n: b.n, row: r, x0: x, x1: x + w - 1, centers, tmin: centers[0] + (g.tap ?? 0) - reach, tmax: centers[b.n - 1] + (g.tap ?? 0) + reach };
    pos.set(bid, p);
    const list = blocksOf.get(b.gid);
    if (list) list.push(p);
    else blocksOf.set(b.gid, [p]);
    return x + w;
  };
  const x0 = side ? STATION_COLS : opt.leftMargin; // 生产区第一列
  // 没有辅路（退火里最常见）时不用去重排序
  if (!(Array.isArray(streets) && streets.length === 0)) for (const o of [...new Set(streets)].sort((a, b) => a - b)) streetX.push(x0 + o);
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    let x = x0;
    for (let i = 0; i < row.length; i++) x = put(row[i], r, x);
    rowWidth = Math.max(rowWidth, x - opt.leftMargin);
  }
  // 卫星配电站的空位（第二遍，route.js 按第一遍挖好的 layout/powerholes.js）：照挖的先后把缝右边的工厂往右挪（同一块里缝右边那几台，
  // 块的右沿跟着挪；后面的块整块挪）。只挖比最宽那行短的行，图的宽不变
  const holes = holePlan ?? [];
  if (holes.length) {
    const F = rows.map((row) => row.flatMap((bid) => pos.get(bid).centers.map((_, i) => ({ p: pos.get(bid), i }))));
    for (const h of holes) {
      let last = null;
      for (let j = h.k; h.shift > 0 && j < F[h.row].length; j++) {
        const { p, i } = F[h.row][j];
        p.centers[i] += h.shift;
        if (p === last) continue;
        last = p;
        if (i === 0) {
          p.x0 += h.shift;
          p.tmin += h.shift;
        }
        p.x1 += h.shift;
        p.tmax += h.shift;
      }
    }
    for (const row of rows) if (row.length) rowWidth = Math.max(rowWidth, Math.max(...row.map((bid) => pos.get(bid).x1)) + 1 - opt.leftMargin);
  }
  // 主干走廊（物流站右侧那一列）：原料从这里出站、成品从这里进站
  const corridor = TRUNK;
  const stationX = (STATION_SIZE - 1) / 2; // 物流站中心列
  // 每行本体在中心下方、上方各占几行：化工厂上方多一行，同一行里混着制造台时，制造台上侧的分拣器要多伸 1 格
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    let below = 1;
    let above = 1;
    for (let i = 0; i < row.length; i++) below = Math.max(below, pos.get(row[i]).g.bodyBelow);
    for (let i = 0; i < row.length; i++) above = Math.max(above, pos.get(row[i]).g.bodyAbove);
    TMP[r] = below;
    TMP2[r] = above;
  }
  const rowBelow = TMP.slice(0, rows.length);
  const rowAbove = TMP2.slice(0, rows.length);
  /** 块的分拣器从工厂落点到通道第一条轨道还要多伸几格 */
  const extraTop = (p) => rowAbove[p.row] - p.g.edgeAbove;
  const extraBottom = (p) => rowBelow[p.row] - p.g.edgeBelow;
  for (let gi = 0; gi < graph.groups.length; gi++) {
    const g = graph.groups[gi];
    const list = blocksOf.get(g.id);
    let n = 0;
    if (list) for (let i = 0; i < list.length; i++) n += list[i].n;
    if (n !== g.count) throw new Error(`${g.item} 的块合计 ${n} 台，应为 ${g.count} 台`);
  }
  /** 一种物品的生产者和消费者所在的块（每条惩罚都要问一次，块排好以后不变：每种物品只算一次，每次给一份副本；表到第一次问才建） */
  let bidsMemo = null;
  const itemBids = (itemId) => {
    let bids = (bidsMemo ??= new Map()).get(itemId);
    if (!bids) {
      const f = graph.items.get(itemId);
      bids = [];
      for (let j = -1; j < f.consumers.length; j++) {
        const list = blocksOf.get(j < 0 ? f.producer : f.consumers[j].to);
        if (list) for (let i = 0; i < list.length; i++) bids.push(list[i].bid);
      }
      bidsMemo.set(itemId, bids);
    }
    return bids.slice();
  };
  const xL = 0; // 左边缘
  const xR = opt.leftMargin + rowWidth; // 右边缘：工厂右侧第一列
  // 每行被工厂占位的列（含制造台之间 1 格的窄缝，窄缝里放不下带子）；物流站那 7 列一律不让竖直走线。
  // 每行的占用记成位图（第 r 行第 x 列是 busyBits[r × NW + (x >> 5)] 的第 (x & 31) 位，只记 0..WB−1 的整数列）：
  // 通道 lo..hi 之间穿过的行把位图按字或起来，空着的列就是 0 位，挑列时只看这些列。
  // 参数不是这样的整数（几乎不会）时退回逐列查按行累计的占用表 busyAcc（第 r 行之前占了几行），那张表用到才建
  const WB = xR + 3;
  const R = rows.length;
  const NW = (WB + 31) >>> 5;
  const bitsOk = Number.isInteger(WB) && WB >= 0;
  // WB 是负数时（左边距给了负数之类）在这里报 RangeError
  if (!bitsOk) new Uint8Array(WB);
  if (bitsOk) {
    if (busyBitsBuf.length < R * NW) busyBitsBuf = new Int32Array(Math.max(R * NW, Math.ceil(busyBitsBuf.length * 1.5)));
    busyBitsBuf.fill(0, 0, R * NW);
    for (let r = 0; r < R; r++) {
      const row = rows[r];
      const base = r * NW;
      for (let i = 0; i < row.length; i++) {
        const p = pos.get(row[i]);
        for (let x = p.x0; x <= p.x1; x++) if (x >= 0 && x < WB && Number.isInteger(x)) busyBitsBuf[base + (x >> 5)] |= 1 << (x & 31);
      }
      if (side) for (let x = 0; x < STATION_SIZE && x < WB; x++) busyBitsBuf[base + (x >> 5)] |= 1 << (x & 31);
    }
    // 配电站的空位：竖着走的高架带不从这里穿（行尾、块与块之间的空位不在块的范围里，单独记上）
    for (const h of holes) for (let x = h.x - 1; x <= h.x + 1; x++) if (x >= 0 && x < WB) busyBitsBuf[h.row * NW + (x >> 5)] |= 1 << (x & 31);
  }
  const busyBits = busyBitsBuf;
  // 备用的按行累计表（按线程复用的缓冲）：表里只有前 NB 格是这一次的（第 0 行清零，后面每行整行写过）；
  // 一行的占用先清掉前 WB 格再标，标到 WB 以外的格子不会被读到
  const NB = (R + 1) * WB;
  let busyAcc = null;
  const accTable = () => {
    if (busyAcc) return busyAcc;
    if (busyAccBuf.length < NB) busyAccBuf = new Int32Array(Math.max(NB, Math.ceil(busyAccBuf.length * 1.5)));
    if (busyRowBuf.length < WB + STATION_SIZE) busyRowBuf = new Uint8Array(Math.max(WB + STATION_SIZE, Math.ceil(busyRowBuf.length * 1.5)));
    const acc = busyAccBuf;
    const busy = busyRowBuf;
    acc.fill(0, 0, WB);
    for (let r = 0; r < R; r++) {
      const row = rows[r];
      busy.fill(0, 0, WB);
      for (let i = 0; i < row.length; i++) {
        const p = pos.get(row[i]);
        for (let x = p.x0; x <= p.x1; x++) busy[x] = 1;
      }
      if (side) for (let x = 0; x < STATION_SIZE; x++) busy[x] = 1;
      for (const h of holes) if (h.row === r) for (let x = h.x - 1; x <= h.x + 1; x++) busy[x] = 1;
      for (let x = 0; x < WB; x++) acc[(r + 1) * WB + x] = acc[r * WB + x] + busy[x];
    }
    busyAcc = acc;
    return acc;
  };
  /**
   * 两段之间的竖直列：出段沿 d0 方向离开、进段沿 d1 方向进入。升降在段尾、段首那一格原地竖直升落，
   * 两头最好都隔 2 格以上：升上去先直走一格再拐，拐完先直走一格再落下（不在升降处拐弯，好看也合手动建造的规矩）；
   * 只隔 1 格的列也能用，但要多付 3 格的代价。取代价最小的一列。
   */
  // 每列已经有哪些竖直高架段（按通道号的区间记）：同一列上区间相交的两段只能叠在不同层。
  // 选列时把「这列已经挤了几条」算进代价，车流就会分到外圈、主干走廊和内部的辅路上，而不是全叠在一列里。
  // 每列存一串 [下端, 上端, 下端, 上端, …]（列号都在 xL..xR+1 之间）：0..WB−1 的整数列记在 LOAD[x] 里（前 2 × loadN[x] 项是这一次的，loadGen[x] 是这一次的代际才算有），
  // 别的列号（几乎不会）记在按列号下标的 farLoad 里（用到才建；isInt 也把 -0 当 0，两边不会撞上同一列）
  const LW = bitsOk ? WB : 0;
  if (loadN.length < LW || loadStamp >= 1e9) {
    const n = Math.max(LW, 64, Math.ceil(loadN.length * 1.5));
    loadN = new Int32Array(n);
    loadGen = new Int32Array(n);
    loadStamp = 0;
  }
  const lst = ++loadStamp;
  let farLoad = null;
  /** 第 x 列已有的竖直段里和 [lo, hi] 相交的有几条（first：碰到一条就返回 1） */
  const hits = (x, lo, hi, first) => {
    let list;
    let len;
    if (isInt(x, 0, LW)) {
      if (loadGen[x] !== lst) return 0;
      list = LOAD[x];
      len = 2 * loadN[x];
    } else {
      list = farLoad === null ? undefined : farLoad[x];
      if (!list) return 0;
      len = list.length;
    }
    let n = 0;
    for (let i = 0; i < len; i += 2) {
      if (list[i] <= hi && lo <= list[i + 1]) {
        if (first) return 1;
        n++;
      }
    }
    return n;
  };
  const crowd = (x, c1, c2) => hits(x, Math.min(c1, c2), Math.max(c1, c2), false);
  const addLoad = (x, c1, c2) => {
    const lo = Math.min(c1, c2);
    const hi = Math.max(c1, c2);
    if (isInt(x, 0, LW)) {
      const n = loadGen[x] === lst ? loadN[x] : 0;
      loadGen[x] = lst;
      loadN[x] = n + 1;
      const list = (LOAD[x] ??= []);
      list[2 * n] = lo;
      list[2 * n + 1] = hi;
    } else {
      farLoad ??= [];
      if (!farLoad[x]) farLoad[x] = [];
      farLoad[x].push(lo, hi);
    }
  };
  // 同样的参数在没再 addLoad 时结果一样：重复的调用由 layout/belts.js 的 column 按参数记住
  // crowd 不小于 0：crowdWeight 不为负时，不算拥挤已经不比当前最好的便宜的列不用再数（浮点加非负数不会变小，NaN 照常算）
  const crowdSkip = opt.crowdWeight >= 0;
  const bestColumn = (xs, d0, xd, d1, c1, c2, g0min = 1) => {
    // 两头各至少隔 1 格（g0、g1 ≥ 1）：流向是 ±1 的整数时，只有 xs、xd 之间那一段列可能合格，不用从 xL 扫到 xR + 1。
    // g0min：出段那头至少隔几格（喷涂机骑在这截高架上时要 5 格直带，见 layout/belts.js 的 legOut）
    let x0 = xL;
    let x1 = xR + 1;
    if (isInt(xs, -1e9, 1e9) && isInt(xd, -1e9, 1e9) && (d0 === 1 || d0 === -1) && (d1 === 1 || d1 === -1)) {
      if (d0 > 0) x0 = Math.max(x0, xs + g0min);
      else x1 = Math.min(x1, xs - g0min);
      if (d1 > 0) x1 = Math.min(x1, xd - 1);
      else x0 = Math.max(x0, xd + 1);
    }
    const lo = Math.min(c1, c2);
    const hi = Math.max(c1, c2);
    let bx = 0;
    let bc = 0;
    let found = false;
    // 下面两条路都按列号从小到大看能用的列（穿过的各行在这一列都没有工厂），比代价的几行两边一样
    if (bitsOk && isInt(lo, 0, R + 1) && isInt(hi, 0, R + 1) && isInt(x0, 0, WB) && isInt(x1, -1, WB)) {
      // 位图：穿过的行（lo..hi−1）在 x0..x1 这几个字里按位或起来，没被占的位就是能用的列，从低位往高位挨个取
      for (let w = x0 >> 5; w <= x1 >> 5 && x1 >= x0; w++) {
        let m = 0;
        for (let r = lo; r < hi; r++) m |= busyBits[r * NW + w];
        const b0 = Math.max(0, x0 - (w << 5));
        const b1 = Math.min(31, x1 - (w << 5));
        const range = (b1 === 31 ? -1 : (1 << (b1 + 1)) - 1) & ~(b0 === 0 ? 0 : (1 << b0) - 1);
        let free = ~m & range;
        while (free !== 0) {
          const low = free & -free;
          free ^= low;
          const x = (w << 5) + 31 - Math.clz32(low);
          const g0 = (x - xs) * d0;
          const g1 = (xd - x) * d1;
          if (g0 < g0min || g1 < 1) continue;
          const base = Math.abs(x - xs) + Math.abs(xd - x) + (g0 < 2 ? 3 : 0) + (g1 < 2 ? 3 : 0);
          if (found && crowdSkip && base >= bc) continue;
          let cost = base + crowd(x, c1, c2) * opt.crowdWeight;
          if (!found || cost < bc) {
            found = true;
            bx = x;
            bc = cost;
          }
        }
      }
    } else {
      const acc = accTable();
      const rLo = lo * WB;
      const rHi = hi * WB;
      for (let x = x0; x <= x1; x++) {
        const g0 = (x - xs) * d0;
        const g1 = (xd - x) * d1;
        if (g0 < g0min || g1 < 1) continue;
        // 在通道 c1、c2 之间竖直穿行的高架带能用的列：穿过的各行在这一列都没有工厂（表外的列当空着）。
        // 复用的缓冲比这一次的表长：下标到了 NB 的当读不到，这一列不能用
        if (!(x < 0 || x >= WB || (rHi + x < NB && acc[rHi + x] - acc[rLo + x] === 0))) continue;
        const base = Math.abs(x - xs) + Math.abs(xd - x) + (g0 < 2 ? 3 : 0) + (g1 < 2 ? 3 : 0);
        if (found && crowdSkip && base >= bc) continue;
        let cost = base + crowd(x, c1, c2) * opt.crowdWeight;
        if (!found || cost < bc) {
          found = true;
          bx = x;
          bc = cost;
        }
      }
    }
    return found ? { x: bx, cost: bc } : null;
  };
  /** 原料入口所在的列（d 是段的流向，原料从背后进来）：普通布局在左右边缘，接物流站时在主干走廊 */
  const entryCol = (d) => (side ? corridor : d > 0 ? xL : xR);
  /** 成品出口所在的列 */
  const exitCol = (dout) => (side ? corridor : dout > 0 ? xR : xL);
  /** 段的端头是否已经在出入口那一列（这时出入口就是段的端头，不用高架） */
  const atPort = (x, col) => (col === xL ? x <= xL : col === xR ? x >= xR : x === col);

  // 逐个写回 c，不用先拼一个对象
  c.addLoad = addLoad;
  c.atPort = atPort;
  c.bestColumn = bestColumn;
  c.blocksOf = blocksOf;
  c.corridor = corridor;
  c.entryCol = entryCol;
  c.exitCol = exitCol;
  c.extraBottom = extraBottom;
  c.extraTop = extraTop;
  c.itemBids = itemBids;
  c.pos = pos;
  c.powerHoles = holes;
  c.rowAbove = rowAbove;
  c.rowBelow = rowBelow;
  c.stationX = stationX;
  c.streetX = streetX;
  c.xL = xL;
  c.xR = xR;
}
