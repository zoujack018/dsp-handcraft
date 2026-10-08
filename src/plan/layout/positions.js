// 横向位置：把块排进各行，确定每台工厂的中心列、能竖直穿行的空列和出入口所在的列
import { STATION_COLS, STATION_SIZE, TRUNK } from './shared.js';

// 每行被工厂占的列（位图 busyBits：每行 NW 个 32 位字），以及备用的按行累计表（busyAcc）和算它时一行的占用（busyRow），
// 都按线程复用：只在 route() 里用，不跨调用
let busyBitsBuf = new Int32Array(0);
let busyAccBuf = new Int32Array(0);
let busyRowBuf = new Uint8Array(0);

/** route() 的一步：读写共享的布局上下文 c */
export function placeBlocks(c) {
  const { blocks, graph, opt, pads, rows, side, streets } = c;
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
    const centers = [];
    for (let i = 0; i < b.n; i++) centers.push(x + i * g.pitch + g.center);
    const w = b.n * g.pitch + g.trailing;
    const p = { bid, gid: b.gid, g, n: b.n, row: r, x0: x, x1: x + w - 1, centers, tmin: centers[0] + (g.tap ?? 0) - 1, tmax: centers[b.n - 1] + (g.tap ?? 0) + 1 };
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
  // 主干走廊（物流站右侧那一列）：原料从这里出站、成品从这里进站
  const corridor = TRUNK;
  const stationX = (STATION_SIZE - 1) / 2; // 物流站中心列
  // 每行本体在中心下方、上方各占几行：化工厂上方多一行，同一行里混着制造台时，制造台上侧的分拣器要多伸 1 格
  // （和 Math.max(1, ...各块) 一样：逐个取大，有 NaN 时同样得 NaN）
  const rowBelow = [];
  const rowAbove = [];
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    let below = 1;
    let above = 1;
    for (let i = 0; i < row.length; i++) below = Math.max(below, pos.get(row[i]).g.bodyBelow);
    for (let i = 0; i < row.length; i++) above = Math.max(above, pos.get(row[i]).g.bodyAbove);
    rowBelow.push(below);
    rowAbove.push(above);
  }
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
  /** 一种物品的生产者和消费者所在的块（每条惩罚都要问一次，块排好以后不变：每种物品只算一次，每次给一份副本） */
  const bidsMemo = new Map();
  const itemBids = (itemId) => {
    let bids = bidsMemo.get(itemId);
    if (!bids) {
      const f = graph.items.get(itemId);
      const gids = [f.producer, ...f.consumers.map((c) => c.to)].filter((g) => blocksOf.has(g));
      bids = gids.flatMap((g) => blocksOf.get(g).map((p) => p.bid));
      bidsMemo.set(itemId, bids);
    }
    return bids.slice();
  };
  const xL = 0; // 左边缘
  const xR = opt.leftMargin + rowWidth; // 右边缘：工厂右侧第一列
  // 每行被工厂占位的列（含制造台之间 1 格的窄缝，窄缝里放不下带子）；物流站那 7 列一律不让竖直走线。
  // 原来的表：每行一张 0..WB−1 的占用表（Uint8Array(WB)，表外的列写不进去），按行累计成 busyAcc（第 r 行之前占了几行），
  // bestColumn 判断一列能不能在通道 c1、c2 之间竖直穿行时查 busyAcc[hi][x] − busyAcc[lo][x] === 0。
  // 现在每行的占用记成位图（第 r 行第 x 列是 busyBits[r × NW + (x >> 5)] 的第 (x & 31) 位，只记 0..WB−1 的整数列，
  // 和原来的表记下的一样）：通道 lo..hi 之间穿过的行把位图按字或起来，空着的列就是 0 位，挑列时只看这些列。
  // 参数不是这样的整数（几乎不会）时退回原来的逐列查表，那张表用到才建
  const WB = xR + 3;
  const R = rows.length;
  const NW = (WB + 31) >>> 5;
  const bitsOk = Number.isInteger(WB) && WB >= 0;
  // 原来这里每次都按 WB 建定长表：WB 是负数时（左边距给了负数之类）在这里就报 RangeError，照样报
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
  }
  const busyBits = busyBitsBuf;
  // 备用的按行累计表（按线程复用的缓冲）：表里只有前 NB 格是这一次的（第 0 行清零，后面每行整行写过）；
  // 一行的占用先清掉前 WB 格再标，标到 WB 以外的格子（原来的定长表会丢掉）不会被读到
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
  // 选列时把「这列已经挤了几条」算进代价，车流就会分到外圈、主干走廊和内部的辅路上，而不是全叠在一列里
  // 按列号下标的数组（列号都在 xL..xR+1 之间），每列存一串 [下端, 上端, 下端, 上端, …]
  const colLoad = [];
  const crowd = (x, c1, c2) => {
    const lo = Math.min(c1, c2);
    const hi = Math.max(c1, c2);
    const list = colLoad[x];
    if (!list) return 0;
    let n = 0;
    for (let i = 0; i < list.length; i += 2) if (list[i] <= hi && lo <= list[i + 1]) n++;
    return n;
  };
  const addLoad = (x, c1, c2) => {
    if (!colLoad[x]) colLoad[x] = [];
    colLoad[x].push(Math.min(c1, c2), Math.max(c1, c2));
  };
  const isInt = (v, lo, hi) => (v | 0) === v && v >= lo && v < hi;
  // 同样的参数在 colLoad 没变时结果一样：重复的调用由 layout/belts.js 的 column 按参数记住（这里原来也记一份，
  // 前面那份记住以后这里一次都没再碰上，去掉了）
  // crowd 不小于 0：crowdWeight 不为负时，不算拥挤已经不比当前最好的便宜的列不用再数（浮点加非负数不会变小，NaN 照常算）
  const crowdSkip = opt.crowdWeight >= 0;
  const bestColumn = (xs, d0, xd, d1, c1, c2) => {
    // 两头各至少隔 1 格（g0、g1 ≥ 1）：流向是 ±1 的整数时，只有 xs、xd 之间那一段列可能合格，不用从 xL 扫到 xR + 1
    let x0 = xL;
    let x1 = xR + 1;
    if (isInt(xs, -1e9, 1e9) && isInt(xd, -1e9, 1e9) && (d0 === 1 || d0 === -1) && (d1 === 1 || d1 === -1)) {
      if (d0 > 0) x0 = Math.max(x0, xs + 1);
      else x1 = Math.min(x1, xs - 1);
      if (d1 > 0) x1 = Math.min(x1, xd - 1);
      else x0 = Math.max(x0, xd + 1);
    }
    const lo = Math.min(c1, c2);
    const hi = Math.max(c1, c2);
    let bx = 0;
    let bc = 0;
    let found = false;
    // 下面两条路都按列号从小到大看能用的列（穿过的各行在这一列都没有工厂），和原来逐列扫的先后一样；比代价的几行两边一样
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
          if (g0 < 1 || g1 < 1) continue;
          const base = Math.abs(x - xs) + Math.abs(xd - x) + (g0 < 2 ? 3 : 0) + (g1 < 2 ? 3 : 0);
          if (found && crowdSkip && base >= bc) continue;
          const cost = base + crowd(x, c1, c2) * opt.crowdWeight;
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
        if (g0 < 1 || g1 < 1) continue;
        // 在通道 c1、c2 之间竖直穿行的高架带能用的列：穿过的各行在这一列都没有工厂（表外的列当空着）。
        // 复用的缓冲比这一次的表长：下标到了 NB 就和原来的定长表一样当读不到（undefined 相减是 NaN，这一列不能用）
        if (!(x < 0 || x >= WB || (rHi + x < NB && acc[rHi + x] - acc[rLo + x] === 0))) continue;
        const base = Math.abs(x - xs) + Math.abs(xd - x) + (g0 < 2 ? 3 : 0) + (g1 < 2 ? 3 : 0);
        if (found && crowdSkip && base >= bc) continue;
        const cost = base + crowd(x, c1, c2) * opt.crowdWeight;
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

  // 逐个写回（和 Object.assign(c, { addLoad, atPort, … }) 按同样的先后写同样的字段，不用先拼一个对象）
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
  c.rowAbove = rowAbove;
  c.rowBelow = rowBelow;
  c.stationX = stationX;
  c.streetX = streetX;
  c.xL = xL;
  c.xR = xR;
}
