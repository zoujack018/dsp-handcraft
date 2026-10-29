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
  const opts = PERMS_BY_MASK[k][masks];
  return opts !== undefined ? opts : (PERMS_BY_MASK[k][masks] = permsBuild(k, masks));
}
/**
 * permsFor 第一次见到这个 (k, masks) 时算。单独写成函数：过滤函数要读 masks，写在 permsFor 里时 permsFor 每次调用（多数是查表命中）
 * 都要先建一个放 masks 的作用域对象（40 字节，2026/10/25 量过）
 */
function permsBuild(k, masks) {
  const opts = PERMS[k].filter((offs) => offs.every((off, i) => (masks >> (3 * i + off + 1)) & 1));
  return opts.length ? opts : [zeros(k)];
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
/**
 * 收集工厂（assignSorters 每个通道开头那段）复用的东西，每个线程一份（同一线程里 assignSorters 不会重入）。以前每个通道、每块每侧都新建，
 * 退火里每次评估都要跑一遍，是多线程时内存流量的大头之一（2026/10/25）：
 *   unit：每台工厂一个，want：每块每侧每种物品一个，都只在本通道里用（往 sorters、slow、starved、tooLong 里填的是它们的字段值，不是它们本身），
 *     按本通道里的序号从池子里取、每个字段都重写（建对象时字段的先后和原来的字面量一样），所以读不到上一个通道留下的东西；
 *   units、merged：本通道的 unit 按收集的先后放进 units，两行要归并时放进 merged，都只读前 nU 项；
 *   need：拼 needs 用的临时数组，拼好再按刚好的长度切出去（needs 照旧每块每侧一个新数组，各处按 needs.length 读）；
 *   segStart、segAt：段按通道分桶，通道 ch 的段是 segAt[segStart[ch] .. segStart[ch + 1])（L.segments 的下标，按 segments 的先后），
 *     代替原来每次新建的 Map 套 Map（通道号在 belts.js 里本来就当数组下标用，是 0..R 的整数）
 */
const POOL = { units: [], merged: [], unit: [], want: [], need: [], segStart: new Int32Array(64), segAt: new Int32Array(256) };
const unitAt = (j) => (POOL.unit[j] ??= { g: null, gid: null, bid: null, bi: 0, cx: 0, fcx: 0, side: null, from: null, needs: null, slotMask: 0, options: null, pick: null });
// slow：这根速度够不够（原来 slowW 那个 filter 的条件），收集时算好
const wantAt = (j) => (POOL.want[j] ??= { itemId: 0, dir: null, seg: null, track: 0, length: 0, rate: 0, k: 0, stubOk: false, slow: false });

/**
 * 按通道记住算过的落位（assignSorters 的 cache 开关，默认开）。各通道是分开算的，退火评估邻居时多数通道和之前某次一模一样
 * （2026/10/24 量过：一轮里 60%~77% 的通道最近 8192 次以内出现过），一样的就不再做动态规划。模块级，每个线程一份。
 *
 * 键（chanKey，Int32 数组，几样小整数按位拼成一项）只放动态规划（solve、validCols）、断料（upstreamOut、starvedIn）、碰撞统计真正读到的：
 *   开头一项：工厂台数、bits、wide（cmask、AB、NT 都由 bits、wide 定；chan.n 别处只用来算分拣器长度，这几步不读长度）；
 *   每台一项（按排好的先后）：cx、根数 k、slotMask、from（只看是不是 'below'）；
 *   每根一项：所接段在本通道里的局部编号（按第一次出现从 1 排，没接段记 0）、track、dir（'out' / 'in' / 别的，三种在各处分得开）；
 *   段第一次出现时后面再跟三项：a、b，和 split、dir、fed（只看真假）拼的一项（split 是 null、undefined、数三种分开记：
 *   段的 dir 为 0 时 flowDir、halfIdx 里 cx < null 和 cx < undefined 不一样）。
 *   每样先查是不是拼得下的整数（cx 0 ~ 2^18−1、track 0~15、段的 dir −1/0/1、split 0 ~ 2^24−1、a/b 32 位整数……），不是就不缓存这个通道
 *   （照原来算），所以拼法是一一对应的：按开头的台数、每台的 k、每根的局部编号（等于已见段数 + 1 就是新段，后面跟三项）能原样拆回去。
 * 为什么够：validCols 读 cx、slotMask 和各根所接段的 a/b/split；flowDir、halfIdx 读段的 dir/split 和 cx；halfIdx 里的段号只用来分辨
 * 「同一段带的同一半」，局部编号和段号一一对应（同一个段号再次出现时 a、b 和拼的那项要和第一次一样，不一样就不缓存），分组也一样；
 * upstreamOut、starvedIn 再读 dir、fed；solve 再读 from、track 和 bits 那几个；碰撞统计读 cx、pick、from、track。
 * 别的（g、gid、bid、bi、fcx、side、itemId、rate、length、tank……）只用来往 sorters、starved 里填字段，命中时照样用这一次的 units 现填。
 * 段只属于一个通道（segFor 按通道查），UP、COL 每个通道换轮次号，所以通道之间互不影响，换了线、换了 graph 也一样：键相同，结果就相同。
 *
 * 记下的值：每台选中的排列、断料（全通了不记，否则每台的断料根数）、本通道的碰撞数。排列只可能是 PERMS[0..3] 里的或者 zeros(k)
 * （permsFor 的兜底、多于 3 根时），都是共享的只读数组，只读它的内容：k ≤ 3 时按 k 和各根偏移拼成 0~255 的编号，第一次见到时记下
 * 那个数组，命中时拿回它（内容一样）；k > 3 时只能是 zeros(k)，记 256 + k。
 * 为什么逐字一样：DP、UP、COL 这些复用的缓冲区每层、每轮都按轮次号重来，不读上一次留下的东西，同样的输入算出同样的 pick、断料根数、
 * 碰撞数（solve 里按 ref 整组跳过的那一步本身就不改结果）；命中时照原来的先后往 starved、sorters 推这一次新建的对象，clashes 加
 * 记下的整数（原来逐列加的也是整数，和一样）。slow、tooLong 收集工厂时就推好了，不经过这里。
 *
 * 存放：键、排列编号、断料根数首尾相接放在一条 Int32 的环形区（arena，按需翻倍，最大 SC_ARENA 项）里；每条的哈希、位置、长度、碰撞数
 * 按槽号放在定长数组里，map 从哈希到槽号，放进去、拿出来都不新建对象。槽和 arena 都按放进去的先后用：条数到 SC_CAP，或者 arena
 * 要写的那截还被占着（写到头了从 0 再来），就挤掉最早的。查找：先按哈希找到槽，再逐项比完整的键（长度也比），一样才算命中；
 * 同一个哈希只留最新的一条（撞了的旧条目还在环里，轮到挤掉它时不从 map 里删别人的）。
 */
let SC_CAP = 4096; // 最多这么多条（setSorterCacheLimits 只给检查脚本改小了试挤掉的那几条路）
let SC_ARENA = 1 << 20; // arena 最多这么多项（4 MB）
const SC = {
  arena: new Int32Array(1 << 16),
  top: 0, // arena 里下一条从这里写
  // 按槽号（0 ~ SC_CAP−1，按放进去的先后循环用）：哈希、在 arena 里的起点、键长、台数、记没记断料（0/1）、碰撞数
  h: new Int32Array(SC_CAP),
  off: new Int32Array(SC_CAP),
  len: new Int32Array(SC_CAP),
  nu: new Int32Array(SC_CAP),
  sv: new Uint8Array(SC_CAP),
  clash: new Int32Array(SC_CAP),
  first: 0, // 最早那条的槽号
  count: 0,
  map: new Map(), // 哈希 → 槽号
  key: new Int32Array(1024), // 算键用的缓冲区
  kh: 0, // chanKey 算出的哈希
  ids: new Int32Array(256), // scPut 用：各台排列的编号
  starve: new Int32Array(256), // assignSorters 没命中时：各台的断料根数
  // 段的局部编号：stamp 是本轮的才算见过，local 是编号，pos 是它那三项在键里的起点（再次出现时拿来比）
  segStamp: new Uint32Array(256),
  segLocal: new Int32Array(256),
  segPos: new Int32Array(256),
  epoch: 0,
  // 计数（只给工具看）：命中、没命中、不缓存的通道数，命中、没命中的通道里一共几台
  hits: 0,
  misses: 0,
  skips: 0,
  hitUnits: 0,
  missUnits: 0,
};
/** 排列编号 → 那个共享数组（k ≤ 3，第一次编号时记下） */
const PICK_OF = [];
/** 排列的编号：k ≤ 3 时 k 和各根偏移 +1 拼成 0~255，k > 3 时（只能是 zeros(k)）256 + k；都不是时 −1（不缓存） */
function pickId(p) {
  const k = p.length;
  if (k <= 3) {
    let id = k;
    for (let i = 0; i < k; i++) {
      const o = p[i];
      if (o !== -1 && o !== 0 && o !== 1) return -1;
      id |= (o + 1) << (2 + 2 * i);
    }
    if (PICK_OF[id] === undefined) PICK_OF[id] = p;
    return id;
  }
  for (let i = 0; i < k; i++) if (p[i] !== 0) return -1;
  return 256 + k;
}
const pickOf = (id) => (id < 256 ? PICK_OF[id] : zeros(id - 256));
/** 一个通道的键写进 SC.key、哈希放 SC.kh，返回长度；有拼不下的值（见 SC 的说明）时返回 −1，不缓存 */
function chanKey(units, nU, bits, wide) {
  if (nU >= 1 << 24) return -1;
  let cap = 1 + nU;
  for (let ui = 0; ui < nU; ui++) cap += 4 * units[ui].needs.length;
  if (SC.key.length < cap) SC.key = grown(SC.key, cap);
  const key = SC.key;
  const ep = nextEpoch(SC, 'segStamp');
  const segStamp = SC.segStamp;
  const segLocal = SC.segLocal;
  const segPos = SC.segPos;
  let nLocal = 0;
  let v = (nU << 5) | (wide ? 16 : 0) | bits;
  key[0] = v;
  let n = 1;
  let h = Math.imul(0x811c9dc5 ^ v, 0x01000193);
  for (let ui = 0; ui < nU; ui++) {
    const u = units[ui];
    const needs = u.needs;
    const k = needs.length;
    const cx = u.cx;
    const sm = u.slotMask;
    if (!(cx >= 0 && cx < 0x40000 && cx === (cx | 0)) || !(sm >= 0 && sm < 8 && sm === (sm | 0)) || k >= 256) return -1;
    v = (cx << 12) | (k << 4) | (sm << 1) | (u.from === 'below' ? 1 : 0);
    key[n++] = v;
    h = Math.imul(h ^ v, 0x01000193);
    for (let i = 0; i < k; i++) {
      const nd = needs[i];
      const t = nd.track;
      if (!(t >= 0 && t < 16 && t === (t | 0))) return -1;
      const dc = nd.dir === 'out' ? 1 : nd.dir === 'in' ? 0 : 2;
      const s = nd.seg;
      if (!s) {
        v = (t << 2) | dc;
        key[n++] = v;
        h = Math.imul(h ^ v, 0x01000193);
        continue;
      }
      const id = s.id;
      if (!(id >= 0 && id < segStamp.length && id === (id | 0))) return -1;
      const a = s.a;
      const b = s.b;
      const sd = s.dir;
      const sp = s.split;
      const spT = sp === null ? 0 : sp === undefined ? 1 : 2;
      if (spT === 2 && !(sp >= 0 && sp < 1 << 24 && sp === (sp | 0))) return -1;
      if (a !== (a | 0) || b !== (b | 0) || !(sd === -1 || sd === 0 || sd === 1)) return -1;
      const f = ((spT === 2 ? sp : 0) << 6) | ((sd + 1) << 3) | (s.fed ? 4 : 0) | spT;
      if (segStamp[id] !== ep) {
        if (nLocal + 1 >= 1 << 24) return -1;
        segStamp[id] = ep;
        segLocal[id] = ++nLocal;
        v = (nLocal << 6) | (t << 2) | dc;
        key[n++] = v;
        h = Math.imul(h ^ v, 0x01000193);
        segPos[id] = n;
        key[n++] = a;
        h = Math.imul(h ^ a, 0x01000193);
        key[n++] = b;
        h = Math.imul(h ^ b, 0x01000193);
        key[n++] = f;
        h = Math.imul(h ^ f, 0x01000193);
      } else {
        v = (segLocal[id] << 6) | (t << 2) | dc;
        key[n++] = v;
        h = Math.imul(h ^ v, 0x01000193);
        const p = segPos[id];
        if (key[p] !== a || key[p + 1] !== b || key[p + 2] !== f) return -1;
      }
    }
  }
  SC.kh = (h ^ (h >>> 15)) & 0x3fffffff;
  return n;
}
/** SC.key 前 n 项的键（哈希 SC.kh）：缓存里有一模一样的就返回它的槽号，否则 −1 */
function scGet(n) {
  const slot = SC.map.get(SC.kh);
  if (slot === undefined || SC.len[slot] !== n) return -1;
  const arena = SC.arena;
  const key = SC.key;
  const o = SC.off[slot];
  for (let i = 0; i < n; i++) if (arena[o + i] !== key[i]) return -1;
  return slot;
}
/** 挤掉最早的一条 */
function scEvict() {
  const s = SC.first;
  if (SC.map.get(SC.h[s]) === s) SC.map.delete(SC.h[s]);
  SC.first = s + 1 === SC_CAP ? 0 : s + 1;
  SC.count--;
}
/** 放进缓存：键是 SC.key 前 n 项，units 已有 pick；starve 是各台的断料根数（全通了是 null） */
function scPut(n, units, nU, starve, clashes) {
  const need = n + nU + (starve !== null ? nU : 0);
  if (need > SC_ARENA || clashes !== (clashes | 0)) return;
  if (SC.ids.length < nU) SC.ids = grown(SC.ids, nU);
  const ids = SC.ids;
  for (let ui = 0; ui < nU; ui++) if ((ids[ui] = pickId(units[ui].pick)) < 0) return;
  let top = SC.top;
  let arena = SC.arena;
  if (top + need > arena.length && arena.length < SC_ARENA) {
    // 还没到上限：翻倍（位置不变，只有第一次写到头之前会走到这里）
    let m = arena.length;
    while (m < top + need) m *= 2;
    const b = new Int32Array(Math.min(m, SC_ARENA));
    b.set(arena);
    SC.arena = arena = b;
  }
  if (top + need > arena.length) {
    // 写到头了从 0 再来：后面那截里还在的都是最早放进去的，先挤掉
    while (SC.count && SC.off[SC.first] >= top) scEvict();
    top = 0;
  }
  // 要写的那截 [top, top + need) 里还在的（都在上一圈、按位置排就是按先后排）挤掉；条数满了也挤掉最早的
  while (SC.count && (SC.count === SC_CAP || (SC.off[SC.first] >= top && SC.off[SC.first] < top + need))) scEvict();
  const slot = SC.first + SC.count < SC_CAP ? SC.first + SC.count : SC.first + SC.count - SC_CAP;
  const key = SC.key;
  let p = top;
  for (let i = 0; i < n; i++) arena[p++] = key[i];
  for (let ui = 0; ui < nU; ui++) arena[p++] = ids[ui];
  if (starve !== null) for (let ui = 0; ui < nU; ui++) arena[p++] = starve[ui];
  SC.h[slot] = SC.kh;
  SC.off[slot] = top;
  SC.len[slot] = n;
  SC.nu[slot] = nU;
  SC.sv[slot] = starve !== null ? 1 : 0;
  SC.clash[slot] = clashes;
  SC.top = p;
  SC.count++;
  SC.map.set(SC.kh, slot);
}
/** 只给工具和测试用：清空缓存和计数 */
export function clearSorterCache() {
  SC.map.clear();
  SC.first = 0;
  SC.count = 0;
  SC.top = 0;
  SC.hits = SC.misses = SC.skips = SC.hitUnits = SC.missUnits = 0;
}
/** 只给检查脚本用：改条数、arena 的上限（清空缓存），不传恢复默认；改小了能走到挤掉、绕回的各条路 */
export function setSorterCacheLimits(cap = 4096, arena = 1 << 20) {
  SC_CAP = cap;
  SC_ARENA = arena;
  for (const k of ['h', 'off', 'len', 'nu', 'clash']) SC[k] = new Int32Array(cap);
  SC.sv = new Uint8Array(cap);
  SC.arena = new Int32Array(Math.min(arena, 1 << 16));
  clearSorterCache();
}
/** 只给检查脚本用：查缓存的结构对不对（还在的各条在 arena 里不重叠、按先后排、map 指的都是还在的那条），不对时返回说明，对时 null */
export function sorterCacheCheck() {
  const live = new Set();
  let prevEnd = -1;
  let wrapped = false;
  for (let i = 0; i < SC.count; i++) {
    const s = (SC.first + i) % SC_CAP;
    live.add(s);
    const o = SC.off[s];
    const e = o + SC.len[s] + SC.nu[s] * (1 + SC.sv[s]);
    if (o < 0 || e > SC.arena.length) return `槽 ${s} 超出 arena`;
    if (i > 0 && o < prevEnd) {
      // 按先后排位置只能往后走，最多绕回一次，绕回之后的都在最早那条之前
      if (wrapped) return `槽 ${s} 和前一条重叠`;
      wrapped = true;
    }
    if (wrapped && e > SC.off[SC.first]) return `槽 ${s} 和最早那条重叠`;
    prevEnd = e;
  }
  if (SC.count && prevEnd !== SC.top) return `top ${SC.top} 不在最新那条的末尾 ${prevEnd}`;
  for (const [h, s] of SC.map) {
    if (!live.has(s)) return `map 指向不在的槽 ${s}`;
    if (SC.h[s] !== h) return `map 的哈希 ${h} 和槽 ${s} 的 ${SC.h[s]} 不一样`;
  }
  return null;
}
/** 只给工具和测试用：计数，现有条数，键一共多少项、记了多少台、arena 用了多少项 */
export function sorterCacheStats() {
  let keyItems = 0;
  let units = 0;
  let used = 0;
  for (let i = 0; i < SC.count; i++) {
    const s = (SC.first + i) % SC_CAP;
    keyItems += SC.len[s];
    units += SC.nu[s];
    used += SC.len[s] + SC.nu[s] * (1 + SC.sv[s]);
  }
  const { hits, misses, skips, hitUnits, missUnits, count } = SC;
  return { hits, misses, skips, hitUnits, missUnits, entries: count, keyItems, units, arenaUsed: used, arenaLen: SC.arena.length, cap: SC_CAP };
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
 * cache：按通道复用算过的落位（见 SC），开关结果逐字一样；关掉只给测试和量速度用（route.js 的 DEFAULTS.sorterCache）
 * countOnly：只走收集工厂那一段，数够不着（tooLong）和太慢（slow）各有几条，返回 { nTooLong, nSlow }，不排落位、不做动态规划、不碰缓存
 * （layout/score.js 的 preLegWantFloor：高架之前的代价下限）。条数和不带它时 tooLong、slow 的长度一样：同一段代码、同样的输入
 */
export function assignSorters(graph, L, sideIo, { sorter = 2013, headroom = 1.15, fourthTrack = false, wideTracks = false, cache = true, countOnly = false } = {}) {
  const speed = SORTER_SPEED[sorter];
  if (!speed) throw new Error(`未知分拣器 ID ${sorter}`);
  const sorters = [];
  let clashes = 0;
  const slow = [];
  const starved = [];
  const tooLong = [];
  let nTooLong = 0; // countOnly 时数的
  let nSlow = 0;
  // 段按通道分桶（见 POOL）：通道 ch 里的段按 segments 的先后，segFor 再按物品挑，和原来按 通道 -> 物品 -> 各段 的 Map 查出来的先后一样
  const segs = L.segments;
  let nSeg = 0;
  let maxCh = -1;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s.ch > maxCh) maxCh = s.ch;
    if (s.id + 1 > nSeg) nSeg = s.id + 1;
  }
  if (POOL.segStart.length < maxCh + 3) POOL.segStart = grown(POOL.segStart, maxCh + 3);
  if (POOL.segAt.length < segs.length) POOL.segAt = grown(POOL.segAt, segs.length);
  const segStart = POOL.segStart;
  const segAt = POOL.segAt;
  // 计数放在 ch + 2、累加之后 segStart[ch + 1] 是通道 ch 的起点，逐个放进去时把它推到终点（= 通道 ch + 1 的起点）
  segStart.fill(0, 0, maxCh + 3);
  for (let i = 0; i < segs.length; i++) segStart[segs[i].ch + 2]++;
  for (let ch = 2; ch < maxCh + 3; ch++) segStart[ch] += segStart[ch - 1];
  for (let i = 0; i < segs.length; i++) segAt[segStart[segs[i].ch + 1]++] = i;
  if (UP.col.length < 3 * nSeg) {
    UP.col = grown(UP.col, 3 * nSeg);
    UP.stamp = grown(UP.stamp, 3 * nSeg);
  }
  if (cache && SC.segStamp.length < nSeg) {
    SC.segStamp = grown(SC.segStamp, nSeg);
    SC.segLocal = grown(SC.segLocal, nSeg);
    SC.segPos = grown(SC.segPos, nSeg);
  }
  // 同一通道里同一物品可能有几段（比如原料按运力切开、各开一个入口），优先用把这个块列为接口的那一段
  const segFor = (itemId, ch, cx, bid) => {
    if (!(ch >= 0 && ch <= maxCh)) return undefined;
    const j0 = segStart[ch];
    const j1 = segStart[ch + 1];
    for (let j = j0; j < j1; j++) {
      const s = segs[segAt[j]];
      if (s.itemId !== itemId || !(s.a <= cx + 1 && s.b >= cx - 1) || !s.taps) continue;
      const taps = s.taps;
      for (let t = 0; t < taps.length; t++) if (taps[t].bid === bid) return s;
    }
    for (let j = j0; j < j1; j++) {
      const s = segs[segAt[j]];
      if (s.itemId === itemId && s.a <= cx + 1 && s.b >= cx - 1) return s;
    }
    return undefined;
  };
  // 收集工厂时当前这一块这一侧（wantOf 读）：io.forEach 的回调整个 assignSorters 只建这一个，不再每块每侧建一个闭包
  let fc = 0; // 通道号
  let fn = 0; // 通道的轨道数
  let fBelow = false; // 来自下方行
  let fg = null;
  let fgid = null;
  let fbid = null;
  let fcx0 = 0;
  let ftank = false;
  let fextra = 0;
  let nW = 0; // 本通道用了 POOL.want 的前几个
  const wantOf = (dir, itemId) => {
    const seg = segFor(itemId, fc, fcx0, fbid);
    const track = seg ? seg.track : 0;
    const length = (fBelow ? track + 1 : fn - track) + fextra;
    // 取料按这一组的消费量（consumers 里第一个是这一组的，没有记 0）：原来是 find 加闭包，换成循环，挑中的同一个
    const it = graph.items.get(itemId);
    let total = 0;
    if (dir === 'out') total = it.rate;
    else {
      const cons = it.consumers;
      for (let j = 0; j < cons.length; j++) {
        if (cons[j].to === fgid) {
          total = cons[j].rate ?? 0;
          break;
        }
      }
    }
    const rate = total / fg.count;
    // 留余量：分拣器按平均需求刚好够用时，带上的空隙和取放节奏会让工厂间歇断料
    const k = ftank ? 1 : Math.max(1, Math.ceil((rate * headroom) / (speed[length] ?? Infinity) - 1e-9));
    const w = wantAt(nW++);
    w.itemId = itemId;
    w.dir = dir;
    w.seg = seg;
    w.track = track;
    w.length = length;
    w.rate = rate;
    w.k = k;
    // 罐口那截只在储液罐时才读（原来只给储液罐的 want 加这一项）
    w.stubOk = ftank && length === 1 && !!seg && seg.split == null && (seg.dir > 0 ? seg.a : seg.b) === fcx0;
    w.slow = false;
  };

  // 这里和下面的循环都写成下标循环：for…of 在这个大函数里没被优化掉，每个循环建一个迭代器、每一步一个 {value, done}
  for (let ci = 0; ci < L.channels.length; ci++) {
    const chan = L.channels[ci];
    const c = chan.c;
    // 碰撞规则的编码宽度（见下面 solve）：通道里 4 条轨道（route.js 的 fourthTrack，喷涂时开）每列 4 位，3 条以内照旧 3 位
    // 宽通道（wideTracks，5~6 条轨）也是每列 4 位：1+t 下方（1~6）、7+t 上方（7~12）、15 已满
    const wide = wideTracks && chan.n > 4;
    const bits = (fourthTrack || wideTracks) && chan.n > 3 ? 4 : 3;
    const cmask = (1 << bits) - 1;
    const AB = wide ? 7 : bits === 4 ? 6 : 4; // 上方来的分拣器接第 t 条：编码 AB + t
    const NT = wide ? 6 : bits === 4 ? 4 : 3; // 编码里分得清几条轨道
    // 收集与该通道相邻的工厂侧：下方行 c-1 的上侧（h = 0），上方行 c 的下侧（h = 1）。
    // unit、want 从池子里取（见 POOL），units 只用前 nU 项
    let units = POOL.units;
    let nU = 0;
    let nBelow = 0; // 前 nBelow 台来自下方行
    nW = 0;
    for (let h = 0; h < 2; h++) {
      const rowIdx = h === 0 ? c - 1 : c;
      const side = h === 0 ? 'top' : 'bottom';
      const from = h === 0 ? 'below' : 'above';
      if (from === 'above') nBelow = nU;
      if (rowIdx < 0 || rowIdx >= L.rows.length) continue;
      const row = L.rows[rowIdx];
      for (let ri = 0; ri < row.length; ri++) {
        const bid = row[ri];
        const p = L.pos.get(bid);
        const g = p.g;
        const gid = p.gid;
        const io = sideIo.get(bid)[side];
        if (!io.size) continue;
        // 每种物品需要几根分拣器：单根速度不够时，在同一条带上并排加一根（每侧最多 3 列）。
        // 同一块里每台工厂接的是同一段带、同样的需求，算一次就够
        const tap = g.tap ?? 0;
        const cx0 = p.centers[0] + tap;
        // 排进行里的储液罐（箱子供货）：罐口那截带子当一根分拣器记（出蓝图换成两节带子），只能拐进紧贴的那条带的头一格，
        // 所以要长 1、那条带不劈开、罐在带子的上游头上（从侧面汇进带子的接法没实测过，不用）
        const tank = !!g.store?.tank;
        // 这一块这一侧的各种物品：按 io 的先后放进 POOL.want[w0 .. w1)（wantOf，原来的 wants 数组）
        fc = c;
        fn = chan.n;
        fBelow = from === 'below';
        fg = g;
        fgid = gid;
        fbid = bid;
        fcx0 = cx0;
        ftank = tank;
        // 工厂落点到所接轨道的格数：同一行里化工厂比制造台高一行时，制造台上侧要多伸 1 格（只看块和通道，各种物品一样）
        fextra = from === 'below' ? L.rowAbove[c - 1] - g.edgeAbove : L.rowBelow[c] - g.edgeBelow;
        const w0 = nW;
        io.forEach(wantOf);
        const w1 = nW;
        const W = POOL.want;
        let total = 0;
        for (let j = w0; j < w1; j++) total += W[j].k;
        const cap = sideCap(g, side);
        while (total > cap) {
          // k 最大（> 1）的里面排在最前的那个：和原来 filter 再按 k 从大到小稳定排序取第一个一样
          let w = null;
          for (let j = w0; j < w1; j++) if (W[j].k > 1 && (w === null || W[j].k > w.k)) w = W[j];
          if (!w) break;
          w.k--;
          total--;
        }
        // 速度不够的物品和工厂中心无关，每台工厂各记一遍（顺序和原来一样：按工厂、再按物品）。
        // 这一圈挪到建 needs 之前（countOnly 也要用）：两边读写的字段不相干，先后换了结果一样
        for (let j = w0; j < w1; j++) {
          const w = W[j];
          w.slow = tank ? !w.stubOk : w.rate * headroom > w.k * (speed[w.length] ?? 0) + 1e-9;
        }
        // 只数：够不着每种物品一条、太慢每台工厂一条，和下面往 tooLong、slow 里推的条件和条数一样；不建 needs、unit
        if (countOnly) {
          for (let j = w0; j < w1; j++) {
            const w = W[j];
            if (w.length > 3) nTooLong++;
            if (w.slow) nSlow += p.centers.length;
          }
          continue;
        }
        const tmp = POOL.need;
        let nn = 0;
        for (let j = w0; j < w1; j++) for (let t = 0; t < W[j].k; t++) tmp[nn++] = W[j];
        const needs = tmp.slice(0, nn);
        for (let j = w0; j < w1; j++) {
          const w = W[j];
          if (w.length > 3) tooLong.push({ group: g.item, item: graph.items.get(w.itemId).name, length: w.length, bid });
        }
        const slotMask = slotMaskOf(g, side, tap);
        const centers = p.centers;
        for (let bi = 0; bi < centers.length; bi++) {
          const cx = centers[bi];
          for (let j = w0; j < w1; j++) {
            const w = W[j];
            if (w.slow) slow.push({ group: g.item, item: graph.items.get(w.itemId).name, rate: w.rate, length: w.length, k: w.k, bid, ...(tank ? { tank: true } : null) });
          }
          // cx：分拣器那三列的中间一列（下面的排列、动态规划都按它算）；fcx：工厂中心（出蓝图查槽位用）
          // options：合法排列（偏移数组），pick：选中的那个；列号 = cx + 偏移。每个字段都重写（options、pick 回到 null）
          const u = unitAt(nU);
          u.g = g;
          u.gid = gid;
          u.bid = bid;
          u.bi = bi;
          u.cx = cx + tap;
          u.fcx = cx;
          u.side = side;
          u.from = from;
          u.needs = needs;
          u.slotMask = slotMask;
          u.options = null;
          u.pick = null;
          units[nU++] = u;
        }
      }
    }
    if (countOnly) continue; // 只数的话这个通道到此为止：后面的排序、缓存、动态规划、碰撞统计都不做
    // 按 cx 排序，同一列下方行的在前。两行各自的 cx 都严格递增时（实际总是这样）直接归并：这时任意两台的先后都由 (cx, 下方在前) 唯一确定，
    // 和稳定排序的结果一样；否则照原样排序
    let ascending = true;
    for (let i = 1; i < nU && ascending; i++) if (i !== nBelow && !(units[i - 1].cx < units[i].cx)) ascending = false;
    if (ascending) {
      if (nBelow > 0 && nBelow < nU && !(units[nBelow - 1].cx < units[nBelow].cx)) {
        const merged = POOL.merged; // 复用的数组，只写前 nU 项（见 POOL）
        let i = 0;
        let j = nBelow;
        for (let m = 0; m < nU; m++) merged[m] = j >= nU || (i < nBelow && units[i].cx <= units[j].cx) ? units[i++] : units[j++];
        units = merged;
      }
    } else {
      // units 比 nU 长（复用的数组），只排前 nU 项：切出来排好再写回（稳定排序，和原来对整个数组排一样；实际走不到这里）
      const sorted = units.slice(0, nU).sort((p, q) => p.cx - q.cx || (p.from === 'below' ? -1 : 1));
      for (let i = 0; i < nU; i++) units[i] = sorted[i];
    }
    // 按通道的缓存（见 SC）：排好序之后算键，命中就照记下的设 pick、记断料和碰撞数，跳过下面的动态规划、断料和碰撞统计
    let kn = -1; // 键的长度；-1 不缓存（关着、通道里没有工厂、或者输入里有拼不下的值）
    let hit = -1; // 命中的槽号
    if (cache && nU) {
      kn = chanKey(units, nU, bits, wide);
      if (kn >= 0) {
        hit = scGet(kn);
        if (hit >= 0) {
          SC.hits++;
          SC.hitUnits += nU;
        } else {
          SC.misses++;
          SC.missUnits += nU;
        }
      } else SC.skips++;
    }
    if (hit >= 0) {
      // arena 里键后面是各台的排列编号，记了断料的再跟各台的断料根数
      const arena = SC.arena;
      let p = SC.off[hit] + kn;
      for (let ui = 0; ui < nU; ui++) units[ui].pick = pickOf(arena[p++]);
      if (SC.sv[hit]) {
        for (let ui = 0; ui < nU; ui++) {
          const n = arena[p++];
          if (n) {
            const u = units[ui];
            starved.push({ group: u.g.item, building: u.bi, count: n, bid: u.bid });
          }
        }
      }
      clashes += SC.clash[hit];
    } else {
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
      let sv = null; // 要放进缓存时：每台的断料根数（全通了是 null；借 SC.starve 的地方）
      if (!clean) {
        if (kn >= 0) {
          if (SC.starve.length < nU) SC.starve = grown(SC.starve, nU);
          sv = SC.starve;
        }
        for (let ui = 0; ui < nU; ui++) {
          const u = units[ui];
          const n = starvedIn(u, u.pick);
          if (sv !== null) sv[ui] = n;
          if (n) starved.push({ group: u.g.item, building: u.bi, count: n, bid: u.bid });
        }
      }
      // 统计碰撞：同一列里同一侧多于一根，或者上下两根的轨道没有错开（下方的轨道号必须小于上方的）。
      // 每列只要两侧的根数和轨道号的最小、最大值（Math.min/max 逐个取，和对整列一起取一样）
      const clashes0 = clashes;
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
      if (kn >= 0) scPut(kn, units, nU, sv, clashes - clashes0);
    }
    for (let ui = 0; ui < nU; ui++) {
      const u = units[ui];
      const needs = u.needs;
      for (let i = 0; i < needs.length; i++) {
        const nd = needs[i];
        // 储液罐的那根最后补上 stub（字段和先后和原来对象展开的写法一样；不带对象展开的字面量每个小一点）
        const so = { gid: u.gid, bid: u.bid, building: u.bi, cx: u.fcx, side: u.side, io: nd.dir, itemId: nd.itemId, segId: nd.seg?.id ?? null, col: u.cx + u.pick[i], length: nd.length };
        if (u.g.store?.tank) so.stub = true;
        sorters.push(so);
      }
    }
  }
  if (countOnly) return { nTooLong, nSlow };
  return { sorters, clashes, slow, starved, tooLong };
}
