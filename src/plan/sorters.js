// 分拣器落位：给每台工厂每一侧的每种物品分配一列（工厂中心 -1/0/+1），算出长度，检查冲突和速度。
//
// 冲突（玩家实测，2026/10/03 规则测试图）：上下两侧伸进同一通道、落在同一列的两根分拣器，
// 只有接到同一格带子（或者交叉）时才碰撞；各接各的、哪怕端点上下紧挨也没问题。
// 所以同一列最多一上一下两根，并且下方那根接的轨道必须比上方那根低。

/**
 * 各类分拣器按长度（1/2/3 格）的速度，个/分钟，来源 BWIKI「分拣器」词条。
 * 不考虑货物堆叠科技（按未升级计算）。
 */
export const SORTER_SPEED = {
  2011: { 1: 90, 2: 45, 3: 30 }, // 分拣器
  2012: { 1: 180, 2: 90, 3: 60 }, // 高速分拣器
  2013: { 1: 360, 2: 180, 3: 120 }, // 极速分拣器
  2014: { 1: 600, 2: 300, 3: 150 }, // 集装分拣器
};

/** 工厂一侧能接几根分拣器：有槽位的列数（一般 3，对撞机 2）。槽位表是 gamedata 里的常量对象，按对象记住数出来的列数 */
const CAP = new WeakMap();
export const sideCap = (g, side) => {
  const o = g.slots?.[side];
  if (o == null) return 3; // 没有槽位表的按 3 列算
  if (typeof o !== 'object') return Object.keys(o).length;
  let n = CAP.get(o);
  if (n === undefined) CAP.set(o, (n = Object.keys(o).length));
  return n;
};
/**
 * 工厂这一侧 -1/0/+1 三列（相对分拣器中间一列）有没有槽位，按位记（第 o+1 位）；列号减工厂中心 = tap + 偏移（都是整数）。
 * 和 sideCap 一样按槽位表对象（再按 tap）记住
 */
const SLOT_MASK = new WeakMap();
function slotBits(o, tap) {
  let m = 0;
  for (let off = -1; off <= 1; off++) if (o[tap + off] != null) m |= 1 << (off + 1);
  return m;
}
function slotMaskOf(g, side, tap) {
  const o = g.slots?.[side];
  if (o == null) return 0;
  if (typeof o !== 'object') return slotBits(o, tap);
  let byTap = SLOT_MASK.get(o);
  if (!byTap) SLOT_MASK.set(o, (byTap = new Map()));
  let m = byTap.get(tap);
  if (m === undefined) byTap.set(tap, (m = slotBits(o, tap)));
  return m;
}

// 3 列里挑 k 列的全部排列（相对工厂中心的偏移），预先算好
/** 带在某台工厂处的流向：+1 向右，-1 向左（劈开的带看工厂中心落在哪半边） */
const flowDir = (seg, cx) => (!seg ? 0 : seg.dir !== 0 ? seg.dir : cx < seg.split ? -1 : 1);
/**
 * 同一段带（劈开的带按两半分别算）的编号：段号 × 3，劈开的左半 +1、右半 +2。段号是 segments 里的下标（整数），
 * 和原来拼成字符串的键（`${id}`、`${id}L`、`${id}R`）一一对应，但不用造字符串、可以直接当数组下标
 */
const halfIdx = (seg, cx) => seg.id * 3 + (seg.dir !== 0 ? 0 : cx < seg.split ? 1 : 2);

const PERMS = { 0: [[]], 1: [], 2: [], 3: [] };
/** 没有合法排列时的兜底：k 根全放在中间一列（偏移全 0），按 k 缓存 */
const ZEROS = [];
const zeros = (k) => ZEROS[k] ?? (ZEROS[k] = new Array(k).fill(0));
/**
 * k 根（1～3）各自能放哪几列（每根 3 位，-1/0/+1）→ 按 PERMS 顺序、每根都能放的排列；一个也没有时是兜底的全 0。
 * 只和 k、这 3k 位有关，第一次用到时算好存起来，各台工厂共用（数组只读）
 */
const PERMS_BY_MASK = [null, [], [], []];
function permsFor(k, masks) {
  let opts = PERMS_BY_MASK[k][masks];
  if (opts) return opts;
  opts = PERMS[k].filter((offs) => offs.every((off, i) => (masks >> (3 * i + off + 1)) & 1));
  if (!opts.length) opts = [zeros(k)];
  PERMS_BY_MASK[k][masks] = opts;
  return opts;
}
/**
 * 分拣器动态规划复用的缓冲区（见 assignSorters 里的 solve），按状态值下标。状态正常是 9 位，但通道里轨道多于 3 条时（违规的布局，
 * 搜索中途会走到）编码会溢出到更高位，所以按实际出现的最大状态值扩容，任何状态值都和原来的 Map 一样合并。
 * keys/back：各层「按第一次出现排的状态表」和回溯指针首尾相接放在一条数组里，layer[ui] 是第 ui 台那层的起点；不够时翻倍。
 * base：一台工厂各排列的基础代价（排列最多 6 种）。
 * memo/slot/tns/tcl：一层里同一个（移位后的）状态走各排列得到的新状态和碰撞数只算一次。相邻两台隔开 3 列以上时上一层所有状态都移成 0，
 * 一层平均 6～7 个状态只有 1.5 个不同的移位结果；memo[st] 是本层轮次号时，slot[st] 指向已算好的那一组（每组 8 格，按排列序号）。
 * ref：每组已经比过的上一层状态里最小的代价（不比它小的状态整组跳过，见 solve）。fd：一台工厂每根的流向。
 */
const DP = {
  size: 512,
  costA: new Float64Array(512),
  costB: new Float64Array(512),
  seen: new Uint32Array(512),
  pos: new Int32Array(512),
  memo: new Uint32Array(512),
  slot: new Int32Array(512),
  epoch: 0,
  keys: new Int32Array(4096),
  back: new Int32Array(4096),
  layer: new Int32Array(256),
  base: new Float64Array(8),
  fd: new Float64Array(8),
  tns: new Int32Array(256),
  tcl: new Int32Array(256),
  ref: new Float64Array(256),
};
function dpGrow(ns) {
  let n = DP.size;
  while (n <= ns) n *= 2;
  const grow = (a, T) => {
    const b = new T(n);
    b.set(a);
    return b;
  };
  DP.costA = grow(DP.costA, Float64Array);
  DP.costB = grow(DP.costB, Float64Array);
  DP.seen = grow(DP.seen, Uint32Array);
  DP.pos = grow(DP.pos, Int32Array);
  DP.memo = grow(DP.memo, Uint32Array);
  DP.slot = grow(DP.slot, Int32Array);
  DP.size = n;
}
/** 动态规划每层的轮次号；用满 32 位时把 seen、memo 清零重来（实际跑不到，防止回绕后把旧标记当成本层的） */
function dpEpoch() {
  if (DP.epoch >= 0xfffffffe) {
    DP.seen.fill(0);
    DP.memo.fill(0);
    DP.epoch = 0;
  }
  return ++DP.epoch;
}
/** 把定长数组扩到至少 n（翻倍，保留原内容） */
function grown(a, n) {
  let m = a.length;
  while (m < n) m *= 2;
  if (m === a.length) return a;
  const b = new a.constructor(m);
  b.set(a);
  return b;
}
/** 轮次号用满 32 位时清零重来（实际跑不到，防止回绕后把旧标记当成本轮的） */
function nextEpoch(o, stampKey) {
  if (o.epoch >= 0xfffffffe) {
    o[stampKey].fill(0);
    o.epoch = 0;
  }
  return ++o.epoch;
}
/** 每段带（两半分开）最上游的出料列：stamp 是本轮的才算有，代替原来每次新建的 Map */
const UP = { col: new Float64Array(256), stamp: new Uint32Array(256), epoch: 0 };
/** 统计碰撞用的逐列计数：下标是列号减去本通道最左一列，stamp 是本轮的才算有，list 记本轮碰到的列 */
const COL = {
  stamp: new Uint32Array(256),
  nb: new Int32Array(256),
  na: new Int32Array(256),
  minB: new Float64Array(256),
  maxB: new Float64Array(256),
  minA: new Float64Array(256),
  maxA: new Float64Array(256),
  list: new Int32Array(256),
  epoch: 0,
};
function colGrow(n) {
  if (COL.stamp.length >= n) return;
  for (const k of ['stamp', 'nb', 'na', 'minB', 'maxB', 'minA', 'maxA', 'list']) COL[k] = grown(COL[k], n);
}
for (const a of [-1, 0, 1]) {
  PERMS[1].push([a]);
  for (const b of [-1, 0, 1]) {
    if (b === a) continue;
    PERMS[2].push([a, b]);
    for (const c of [-1, 0, 1]) if (c !== a && c !== b) PERMS[3].push([a, b, c]);
  }
}

/**
 * @param graph 生产图
 * @param L route() 的中间结果（需已有 pos、rowCy、channels、segments、sides）
 * @param sideIo Map<gid, {bottom: Map<itemId,'in'|'out'>, top: ...}>
 */
export function assignSorters(graph, L, sideIo, { sorter = 2013, headroom = 1.15, fourthTrack = false } = {}) {
  const speed = SORTER_SPEED[sorter];
  if (!speed) throw new Error(`未知分拣器 ID ${sorter}`);
  const sorters = [];
  let clashes = 0;
  const slow = [];
  const starved = [];
  const tooLong = [];
  // 通道号 -> 物品 -> 该通道里这种物品的各段（按 segments 的顺序）。通道号、物品 ID 都是数，和原来拼成 `${itemId}|${ch}` 的键一一对应
  const segIndex = new Map();
  let nSeg = 0;
  for (const s of L.segments) {
    let m = segIndex.get(s.ch);
    if (!m) segIndex.set(s.ch, (m = new Map()));
    let list = m.get(s.itemId);
    if (!list) m.set(s.itemId, (list = []));
    list.push(s);
    if (s.id + 1 > nSeg) nSeg = s.id + 1;
  }
  if (UP.col.length < 3 * nSeg) {
    UP.col = grown(UP.col, 3 * nSeg);
    UP.stamp = grown(UP.stamp, 3 * nSeg);
  }
  // 同一通道里同一物品可能有几段（比如原料按运力切开、各开一个入口），优先用把这个块列为接口的那一段
  const segFor = (itemId, ch, cx, bid) => {
    const list = segIndex.get(ch)?.get(itemId);
    if (!list) return undefined;
    for (const s of list) {
      if (!(s.a <= cx + 1 && s.b >= cx - 1) || !s.taps) continue;
      for (const t of s.taps) if (t.bid === bid) return s;
    }
    for (const s of list) if (s.a <= cx + 1 && s.b >= cx - 1) return s;
    return undefined;
  };

  for (const chan of L.channels) {
    const c = chan.c;
    // 碰撞规则的编码宽度（见下面 solve）：通道里 4 条轨道（route.js 的 fourthTrack，喷涂时开）每列 4 位，3 条以内照旧 3 位
    const bits = fourthTrack && chan.n > 3 ? 4 : 3;
    const cmask = (1 << bits) - 1;
    const AB = bits === 4 ? 6 : 4; // 上方来的分拣器接第 t 条：编码 AB + t
    const NT = bits === 4 ? 4 : 3; // 编码里分得清几条轨道
    // 收集与该通道相邻的工厂侧：下方行 c-1 的上侧，上方行 c 的下侧
    let units = [];
    let nBelow = 0; // 前 nBelow 台来自下方行
    for (const [rowIdx, side, from] of [[c - 1, 'top', 'below'], [c, 'bottom', 'above']]) {
      if (from === 'above') nBelow = units.length;
      if (rowIdx < 0 || rowIdx >= L.rows.length) continue;
      for (const bid of L.rows[rowIdx]) {
        const p = L.pos.get(bid);
        const g = p.g;
        const gid = p.gid;
        const io = sideIo.get(bid)[side];
        if (!io.size) continue;
        // 每种物品需要几根分拣器：单根速度不够时，在同一条带上并排加一根（每侧最多 3 列）。
        // 同一块里每台工厂接的是同一段带、同样的需求，算一次就够
        const tap = g.tap ?? 0;
        const cx0 = p.centers[0] + tap;
        const wants = [];
        io.forEach((dir, itemId) => {
          const seg = segFor(itemId, c, cx0, bid);
          const track = seg ? seg.track : 0;
          // 工厂落点到所接轨道的格数：同一行里化工厂比制造台高一行时，制造台上侧要多伸 1 格
          const extra = from === 'below' ? L.rowAbove[c - 1] - g.edgeAbove : L.rowBelow[c] - g.edgeBelow;
          const length = (from === 'below' ? track + 1 : chan.n - track) + extra;
          const total = dir === 'out' ? graph.items.get(itemId).rate : graph.items.get(itemId).consumers.find((x) => x.to === gid)?.rate ?? 0;
          const rate = total / g.count;
          // 留余量：分拣器按平均需求刚好够用时，带上的空隙和取放节奏会让工厂间歇断料
          const k = Math.max(1, Math.ceil((rate * headroom) / (speed[length] ?? Infinity) - 1e-9));
          wants.push({ itemId, dir, seg, track, length, rate, k });
        });
        let total = wants.reduce((a, w) => a + w.k, 0);
        const cap = sideCap(g, side);
        while (total > cap) {
          const w = wants.filter((x) => x.k > 1).sort((p, q) => q.k - p.k)[0];
          if (!w) break;
          w.k--;
          total--;
        }
        const needs = [];
        for (const w of wants) for (let j = 0; j < w.k; j++) needs.push(w);
        for (const w of wants) if (w.length > 3) tooLong.push({ group: g.item, item: graph.items.get(w.itemId).name, length: w.length, bid });
        // 速度不够的物品和工厂中心无关，每台工厂各记一遍（顺序和原来一样：按工厂、再按物品）
        const slowW = wants.filter((w) => w.rate * headroom > w.k * (speed[w.length] ?? 0) + 1e-9);
        const slotMask = slotMaskOf(g, side, tap);
        const centers = p.centers;
        for (let bi = 0; bi < centers.length; bi++) {
          const cx = centers[bi];
          for (const w of slowW) slow.push({ group: g.item, item: graph.items.get(w.itemId).name, rate: w.rate, length: w.length, k: w.k, bid });
          // cx：分拣器那三列的中间一列（下面的排列、动态规划都按它算）；fcx：工厂中心（出蓝图查槽位用）
          // options：合法排列（偏移数组），pick：选中的那个；列号 = cx + 偏移
          units.push({ g, gid, bid, bi, cx: cx + tap, fcx: cx, side, from, needs, slotMask, options: null, pick: null });
        }
      }
    }
    const nU = units.length;
    // 按 cx 排序，同一列下方行的在前。两行各自的 cx 都严格递增时（实际总是这样）直接归并：这时任意两台的先后都由 (cx, 下方在前) 唯一确定，
    // 和稳定排序的结果一样；否则照原样排序
    let ascending = true;
    for (let i = 1; i < nU && ascending; i++) if (i !== nBelow && !(units[i - 1].cx < units[i].cx)) ascending = false;
    if (ascending) {
      if (nBelow > 0 && nBelow < nU && !(units[nBelow - 1].cx < units[nBelow].cx)) {
        const merged = new Array(nU);
        let i = 0;
        let j = nBelow;
        for (let m = 0; m < nU; m++) merged[m] = j >= nU || (i < nBelow && units[i].cx <= units[j].cx) ? units[i++] : units[j++];
        units = merged;
      }
    } else units.sort((p, q) => p.cx - q.cx || (p.from === 'below' ? -1 : 1));
    // 合法排列：每根都要落在有槽位的列上、在所接那段带的范围里（劈开的带还要在所属的半段）。
    // 先按每根需求记下 -1/0/+1 三列能不能放（每根 3 位），再查表得到按 PERMS 顺序、每根都能放的排列（见 permsFor）
    const validCols = (u) => {
      if (u.options) return u.options;
      const needs = u.needs;
      const k = needs.length;
      let opts;
      if (k >= 1 && k <= 3) {
        let masks = 0;
        for (let i = 0; i < k; i++) {
          const s = needs[i].seg;
          let m = u.slotMask; // 这一列没有槽位（对撞机只有中心左边两列）
          if (s) {
            for (let o = -1; o <= 1; o++) {
              const col = u.cx + o;
              if (col < s.a || col > s.b) m &= ~(1 << (o + 1));
              // 劈开的带：左半向左流、右半向右流，取料/出料列要和所属半段一致（工厂中心在哪半边就用哪半边）
              else if (s.split != null && !(u.cx < s.split ? col < s.split : col >= s.split)) m &= ~(1 << (o + 1));
            }
          }
          masks |= m << (3 * i);
        }
        opts = permsFor(k, masks);
      } else opts = k === 0 ? PERMS[0] : [zeros(k)]; // 多于 3 根时没有合法排列，走兜底，后面会记为冲突
      u.options = opts;
      return opts;
    };
    // 取料列不能在同一段带（劈开的带按两半分别算）所有出料列的上游，否则拿不到货。
    // 每段带最上游的出料列记在 UP 里（本轮 stamp），代替原来的 Map
    const upstreamOut = () => {
      const ep = nextEpoch(UP, 'stamp');
      const upCol = UP.col;
      const upStamp = UP.stamp;
      for (let ui = 0; ui < nU; ui++) {
        const u = units[ui];
        const needs = u.needs;
        for (let i = 0; i < needs.length; i++) {
          const nd = needs[i];
          if (nd.dir !== 'out' || !nd.seg || nd.seg.fed) continue;
          const d = flowDir(nd.seg, u.cx);
          const h = halfIdx(nd.seg, u.cx);
          const col = u.cx + u.pick[i];
          if (upStamp[h] !== ep) {
            upStamp[h] = ep;
            upCol[h] = col;
          } else if (d > 0 ? col < upCol[h] : col > upCol[h]) upCol[h] = col;
        }
      }
    };
    const starvedIn = (u, offs) => {
      const needs = u.needs;
      const ep = UP.epoch;
      let n = 0;
      for (let i = 0; i < needs.length; i++) {
        const nd = needs[i];
        if (nd.dir !== 'in' || !nd.seg || nd.seg.fed) continue; // 段首就有上游送来的料，不会断
        const h = halfIdx(nd.seg, u.cx);
        if (UP.stamp[h] !== ep) continue; // 供给来自别的通道（同一段带的生产者在另一侧时由那一侧的单元给出）
        const U = UP.col[h];
        const d = flowDir(nd.seg, u.cx);
        const col = u.cx + offs[i];
        n += (d > 0 ? col < U : col > U) ? 1 : 0;
      }
      return n;
    };

    // 碰撞规则：同一列最多一上一下两根，且下方那根的轨道号 < 上方那根。按列从左到右做动态规划：
    // 每台工厂只用自己中心 -1/0/+1 三列，处理到某台时只有 [cx-1, cx+1] 三列的占用会影响后面。
    // 每列 3 位编码：0 空，1+t 下方来的分拣器接第 t 条，4+t 上方来的接第 t 条，7 已满（上下各一根）。
    // 状态是三列编码拼成的 9 位整数，可达状态很少，用稀疏表。
    // 4 条轨道（bits = 4）时每列 4 位：1+t 下方（1~4）、6+t 上方（6~9）、15 已满，状态 12 位，同一套逻辑
    const WCLASH = 100;
    const WSTARVE = 1000;
    // 状态只有 9 位（512 种），实际走到的只有十来种：每层存「按第一次出现排的状态表」和对应的回溯指针（上一状态 × 64 + 排列序号，
    // 排列最多 6 种），查重和取代价用复用的定长数组（轮次号代替清空）。遍历顺序和原来 Map 的插入顺序一样，平局时选中的排列也一样。
    // withUps：按当前 UP（upstreamOut 的结果）加断料代价
    const solve = (withUps) => {
      let cost = DP.costA;
      cost[0] = 0;
      if (DP.layer.length < nU + 1) DP.layer = grown(DP.layer, nU + 1);
      let keys = DP.keys;
      let back = DP.back;
      const layer = DP.layer;
      const base = DP.base;
      keys[0] = 0;
      let ks = 0; // 上一层的状态在 keys 里的范围 [ks, ke)
      let ke = 1;
      let top = 1;
      let prevCx = nU ? units[0].cx : 0;
      for (let ui = 0; ui < nU; ui++) {
        const u = units[ui];
        const d = u.cx - prevCx;
        prevCx = u.cx;
        const opts = validCols(u);
        const nO = opts.length;
        const below = u.from === 'below';
        const needs = u.needs;
        const k = needs.length;
        // 每种排列的基础代价：顺序偏好 + 断料 + 离中心的距离；加法的先后和原来一样（顺序偏好、距离都是整数和，先加断料再加距离）
        if (DP.fd.length < k) DP.fd = grown(DP.fd, k);
        const fds = DP.fd; // 每根的流向，各排列共用
        for (let i = 0; i < k; i++) fds[i] = flowDir(needs[i].seg, u.cx);
        for (let oi = 0; oi < nO; oi++) {
          const offs = opts[oi];
          // 顺序偏好：出料分拣器放在工厂靠上游的一列，取料放在靠下游的一列，让每个取料点之前尽量已有供给
          let oc = 0;
          let dist = 0;
          for (let i = 0; i < k; i++) {
            const off = offs[i]; // -1/0/1
            dist += Math.abs(off);
            const fd = fds[i];
            if (!fd) continue;
            oc += needs[i].dir === 'out' ? off * fd + 1 : 1 - off * fd; // 0 最好，2 最差
          }
          base[oi] = oc + (withUps ? starvedIn(u, offs) * WSTARVE : 0) + 1e-3 * dist;
        }
        let nextCost = cost === DP.costA ? DP.costB : DP.costA;
        const stamp = dpEpoch();
        const start = top;
        layer[ui] = start;
        let size = DP.size;
        let seen = DP.seen;
        let pos = DP.pos;
        let memo = DP.memo;
        let slotOf = DP.slot;
        let tns = DP.tns;
        let tcl = DP.tcl;
        let ref = DP.ref;
        let nSlot = 0;
        for (let ki = ks; ki < ke; ki++) {
          const st0 = keys[ki];
          const c0 = cost[st0];
          const st = d >= 3 ? 0 : st0 >> (bits * d);
          // 移位后的状态走各排列得到的新状态和碰撞数，本层算过就直接用
          let b8;
          if (st >= 0 && st < size && memo[st] === stamp) {
            // 算过的这一组：得到的新状态在本层第一次算它时都已登记过（也已扩容），只剩比代价，和下面走到 else 分支一样。
            // ref 是这一组已经比过的状态里最小的代价：本状态代价不比它小时，同一排列算出的新代价也不比它的小（浮点加法保序），
            // 而它比过之后新状态的代价最多比它大 1e-9 以内、只会再变小，所以一个都换不下来，整组跳过
            b8 = slotOf[st];
            if (!(c0 < ref[b8])) continue;
            ref[b8] = c0;
            for (let oi = 0; oi < nO; oi++) {
              const ns = tns[b8 + oi];
              const c = c0 + tcl[b8 + oi] * WCLASH + base[oi];
              if (c < nextCost[ns] - 1e-9) {
                nextCost[ns] = c;
                back[pos[ns]] = st0 * 64 + oi;
              }
            }
            continue;
          } else {
            b8 = 8 * nSlot++;
            if (b8 + 8 > tns.length) {
              DP.tns = tns = grown(tns, b8 + 8);
              DP.tcl = tcl = grown(tcl, b8 + 8);
              DP.ref = ref = grown(ref, b8 + 8);
            }
            ref[b8] = c0;
            for (let oi = 0; oi < nO; oi++) {
              let ns = st;
              let clash = 0;
              const offs = opts[oi];
              for (let i = 0; i < k; i++) {
                const sh = bits * (offs[i] + 1);
                const cur = (ns >> sh) & cmask;
                const t = needs[i].track;
                let code;
                if (cur === 0) code = below ? 1 + t : AB + t;
                else {
                  code = cmask;
                  const ok = below ? cur >= AB && cur < AB + NT && t < cur - AB : cur >= 1 && cur < 1 + NT && cur - 1 < t;
                  if (!ok) clash++;
                }
                ns = (ns & ~(cmask << sh)) | (code << sh);
              }
              tns[b8 + oi] = ns;
              tcl[b8 + oi] = clash;
            }
            if (st >= 0 && st < size) {
              memo[st] = stamp;
              slotOf[st] = b8;
            }
          }
          for (let oi = 0; oi < nO; oi++) {
            const ns = tns[b8 + oi];
            const c = c0 + tcl[b8 + oi] * WCLASH + base[oi];
            if (ns >= size) {
              const wasA = cost === DP.costA;
              const wasNextA = nextCost === DP.costA;
              dpGrow(ns);
              cost = wasA ? DP.costA : DP.costB;
              nextCost = wasNextA ? DP.costA : DP.costB;
              size = DP.size;
              seen = DP.seen;
              pos = DP.pos;
              memo = DP.memo;
              slotOf = DP.slot;
            }
            if (seen[ns] !== stamp) {
              seen[ns] = stamp;
              pos[ns] = top;
              nextCost[ns] = c;
              if (top >= keys.length) {
                DP.keys = keys = grown(keys, top + 1);
                DP.back = back = grown(back, top + 1);
              }
              keys[top] = ns;
              back[top] = st0 * 64 + oi;
              top++;
            } else if (c < nextCost[ns] - 1e-9) {
              nextCost[ns] = c;
              back[pos[ns]] = st0 * 64 + oi;
            }
          }
        }
        ks = start;
        ke = top;
        cost = nextCost;
      }
      layer[nU] = top;
      // 回溯
      let bs = 0;
      let bc = Infinity;
      for (let j = ks; j < ke; j++) {
        const st = keys[j];
        if (cost[st] < bc) {
          bs = st;
          bc = cost[st];
        }
      }
      for (let ui = nU - 1; ui >= 0; ui--) {
        const s1 = layer[ui + 1];
        let j = layer[ui];
        while (j < s1 && keys[j] !== bs) j++;
        const v = j < s1 ? back[j] : undefined; // 找不到时和原来 back[-1] 一样
        units[ui].pick = validCols(units[ui])[v & 63];
        bs = v >> 6;
      }
    };
    solve(false);
    upstreamOut();
    let clean = false; // 没有断料的就不用再逐台数一遍（数出来全是 0）
    for (let it = 0; it < 3; it++) {
      let any = false;
      for (let ui = 0; ui < nU; ui++) {
        const u = units[ui];
        if (starvedIn(u, u.pick)) {
          any = true;
          break;
        }
      }
      if (!any) {
        clean = true;
        break;
      }
      solve(true);
      upstreamOut();
    }
    if (!clean) {
      for (let ui = 0; ui < nU; ui++) {
        const u = units[ui];
        const n = starvedIn(u, u.pick);
        if (n) starved.push({ group: u.g.item, building: u.bi, count: n, bid: u.bid });
      }
    }
    // 统计碰撞：同一列里同一侧多于一根，或者上下两根的轨道没有错开（下方的轨道号必须小于上方的）。
    // 每列只要两侧的根数和轨道号的最小、最大值（Math.min/max 逐个取，和对整列一起取一样）
    let lo = Infinity;
    let hi = -Infinity;
    for (let ui = 0; ui < nU; ui++) {
      const x = units[ui].cx;
      if (x - 1 < lo) lo = x - 1;
      if (x + 1 > hi) hi = x + 1;
    }
    if (nU) {
      colGrow(hi - lo + 1);
      const ep = nextEpoch(COL, 'stamp');
      const { stamp, nb, na, minB, maxB, minA, maxA, list } = COL;
      let nList = 0;
      for (let ui = 0; ui < nU; ui++) {
        const u = units[ui];
        const below = u.from === 'below';
        const needs = u.needs;
        for (let i = 0; i < needs.length; i++) {
          const j = u.cx + u.pick[i] - lo;
          const t = needs[i].track;
          if (stamp[j] !== ep) {
            stamp[j] = ep;
            nb[j] = 0;
            na[j] = 0;
            minB[j] = Infinity;
            maxB[j] = -Infinity;
            minA[j] = Infinity;
            maxA[j] = -Infinity;
            list[nList++] = j;
          }
          if (below) {
            nb[j]++;
            minB[j] = Math.min(minB[j], t);
            maxB[j] = Math.max(maxB[j], t);
          } else {
            na[j]++;
            minA[j] = Math.min(minA[j], t);
            maxA[j] = Math.max(maxA[j], t);
          }
        }
      }
      for (let li = 0; li < nList; li++) {
        const j = list[li];
        clashes += Math.max(0, nb[j] - 1) + Math.max(0, na[j] - 1);
        if (nb[j] && na[j] && !(minB[j] < maxA[j] && maxB[j] < minA[j])) clashes++;
      }
    }
    for (let ui = 0; ui < nU; ui++) {
      const u = units[ui];
      const needs = u.needs;
      for (let i = 0; i < needs.length; i++) {
        const nd = needs[i];
        sorters.push({ gid: u.gid, bid: u.bid, building: u.bi, cx: u.fcx, side: u.side, io: nd.dir, itemId: nd.itemId, segId: nd.seg?.id ?? null, col: u.cx + u.pick[i], length: nd.length });
      }
    }
  }
  return { sorters, clashes, slow, starved, tooLong };
}
