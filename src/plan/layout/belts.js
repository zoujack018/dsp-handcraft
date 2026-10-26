// 每种物品的路线：挂通道（贪心集合覆盖）、定访问顺序和流向、落实成地面段和高架段
import { BELT_SPEED, baseItem } from '../../gamedata.js';
import { CH_PITCH, STATION_COLS, TOL, permutations } from './shared.js';

/**
 * 喷增产剂（opt.sprayAll）时给喷涂机留的直带空当：入口（原料）或最后一个生产访问的段尾，
 * 在原来 1 格出入口之外再多留这么多格地面直带。空当连着原来那格一共 1 + SPRAY_GAP 格直带：
 * 喷涂机压着的 3 格 + 前后各 1 格都不转弯不升降（coaterFits），取料格（上游那格）上没有分拣器，
 * 留 4 格刚好有两个能骑的位置（头顶被别的高架压住一个还有备胎）。
 */
const SPRAY_GAP = 4;
/**
 * 喷涂机骑在高架上（用户 2026/10/08 实测：喷涂机能骑在高架带上，增产剂带在它上一层横穿）：最后一个生产访问的段尾不再在地面
 * 多留 4 格空当，喷涂机骑在接下去那截高架段紧挨段尾的 5 格水平走行上（layout/elevation.js 的 legWindow），
 * 所以那截高架的竖直列离段尾至少 LEG_WINDOW 格。opt.sprayOnLegs 关掉时回到地面空当
 */
const LEG_WINDOW = 5;
/** 喷涂时放料段和取料段在地面接成一条（见 consider 里的 joinCost）：cols 里这一截不是竖直列，用这个标记 */
const JOIN = 'join';
/** 劈开第一段时继续往下走的那一半：有下一段或成品出口时左右各试，否则只有一种（各次共用，只读） */
const CONT_LR = ['L', 'R'];
const CONT_NONE = [null];
/** 原料带没有生产者（各次共用，只读） */
const NO_BLOCKS = [];
/** 原料带按位置切段、串通道时排序用的比较函数（各次共用，不必每条带建一个） */
const byTmin = (p, q) => p.p.tmin - q.p.tmin;
const byChTmin = (a, b) => a.ch - b.ch || a.tmin - b.tmin;

// 热路径里的循环都写成下标循环：for…of 在 routeFlow、planChain、commitChain 这几个大函数里没被优化掉，
// 每个循环都建一个迭代器、每一步一个 {value, done}（2026/10/25 量过：光挂通道时那两处就占每次 route() 约 10 KB）

// 每台工厂分拣器那三列的中间一列是 x + (p.g.tap ?? 0)，x 是 p.centers 里工厂的中心（一般就是工厂中心；对撞机偏在左边）。
// 下面标「中间那列」的几处都按这个算，不另建数组

/** 0..k-1 的全排列（顺序和 permutations 一样），按 k 只算一次：访问顺序用下标表示，各次试算共用 */
const PERM_IDX = [];
const permIdx = (k) => (PERM_IDX[k] ??= permutations(Array.from({ length: k }, (_, i) => i)));

/**
 * 一条带里各访问的取放事件，放在池子里（不必每个事件建一个对象；访问只在这一条带里用，每条带开头清空）：
 * 访问 v 的事件是 [v.e0, v.e1) 这一段，EX 是分拣器所在的列、EV 是放（+）取（−）的量，先后是挂上的先后
 */
let EX = new Float64Array(256);
let EV = new Float64Array(256);
let nEv = 0;
const pushEv = (x, val) => {
  if (nEv === EX.length) {
    const nx = new Float64Array(2 * nEv);
    nx.set(EX);
    EX = nx;
    const nv = new Float64Array(2 * nEv);
    nv.set(EV);
    EV = nv;
  }
  EX[nEv] = x;
  EV[nEv++] = val;
};
/** 块 p 每台工厂的中间那列（x + tap，见下面「中间那列」）各记一个事件，量都是 val */
const pushCenters = (p, tap, val) => {
  const cs = p.centers;
  for (let i = 0; i < cs.length; i++) pushEv(cs[i] + tap, val);
};
// 排好的事件（见 sortEv）：访问 v 向右流是 [v.s, v.s + n)，向左流是 [v.s + n, v.s + 2n)（n = v.e1 − v.e0），SX 是列、SV 是量
let SX = new Float64Array(512);
let SV = new Float64Array(512);
let nSv = 0;
/**
 * 访问 v 的取放事件按流向排好：顺流 x 从小到大、同一列先放后取（v 从大到小），每个访问只排一次（退火里这里是热点）。
 * 向右流：事件是一块块按 x 递增的小段拼起来的，几乎有序，直接插入排序（稳定，和 sort 的结果一样）；
 * 向左流：把向右流的按 x 分组倒过来、组内次序不变，就是 x 从大到小、同一列仍 v 从大到小
 */
const sortEv = (v) => {
  const n = v.e1 - v.e0;
  if (nSv + 2 * n > SX.length) {
    const len = 2 * (nSv + 2 * n);
    const nx = new Float64Array(len);
    nx.set(SX.subarray(0, nSv));
    SX = nx;
    const nv = new Float64Array(len);
    nv.set(SV.subarray(0, nSv));
    SV = nv;
  }
  const s = nSv;
  nSv += 2 * n;
  v.s = s;
  for (let t = 0; t < n; t++) {
    const x = EX[v.e0 + t];
    const val = EV[v.e0 + t];
    let j = s + t - 1;
    while (j >= s && (SX[j] > x || (SX[j] === x && SV[j] < val))) {
      SX[j + 1] = SX[j];
      SV[j + 1] = SV[j];
      j--;
    }
    SX[j + 1] = x;
    SV[j + 1] = val;
  }
  let o = s + n;
  for (let i = s + n; i > s; ) {
    let j = i - 1;
    while (j > s && SX[j - 1] === SX[i - 1]) j--;
    for (let t = j; t < i; t++) {
      SX[o] = SX[t];
      SV[o] = SV[t];
      o++;
    }
    i = j;
  }
};

/** 热点里反复用的临时数组：长度不够时换一块更长的，各次调用共用（同一线程里 route() 不会重入，用完即弃） */
const SCRATCH = [];
const scratch = (slot, Type, n) => {
  let a = SCRATCH[slot];
  if (!a || a.length < n) a = SCRATCH[slot] = new Type(Math.max(n, 64));
  return a;
};
/**
 * 同样各次调用共用的普通数组（放对象，或者要保持小整数的数）：以前每次 route() 都新建二十来个、再一格格长大（2026/10/25 压分配）。
 * 用到的都是先写后读（按个数或下标，只读这一次写过的那几项），上一次留下的东西读不到
 */
const LISTS = [];
const list = (slot) => (LISTS[slot] ??= []);

/**
 * 访问（挂在一个通道上的一组生产者、消费者）放在池子里：只在这一条带（routeFlow）里用——planChain、commitChain 读它的字段，
 * 段、高架段里存的是抄过去的值，原料带试算过的方案也只存到这条带结束——所以每条带开头从头复用（nVisit 归零），每个字段都重写
 */
const VISITS = [];
let nVisit = 0;
const visitAt = (ch, key, P, C, e0, e1, tmin, tmax) => {
  const v = (VISITS[nVisit++] ??= { ch: 0, key: 0, P: null, C: null, e0: 0, e1: 0, s: -1, tmin: 0, tmax: 0, total: 0, cuts: null });
  v.ch = ch;
  v.key = key;
  v.P = P;
  v.C = C;
  v.e0 = e0;
  v.e1 = e1;
  v.s = -1;
  v.tmin = tmin;
  v.tmax = tmax;
  v.total = 0;
  v.cuts = null;
  return v;
};
/**
 * planChain 的结果（一条带的方案）也放在池子里，和访问一样每条带开头从头复用（nPlan 归零）：方案、它的各段（geo）、cols、br 都不再每次新建。
 * 各段、cols、br 只有前 k、k − 1、k − 1 项是这个方案的（k 是段数；commitChain 原来按数组长度读的地方改按 k 读），每个字段都在 planChain 里重写
 */
const PLANS = [];
let nPlan = 0;
/** routeItems 里 faceOf 的结果（见那里），每次 routeItems 从头复用 */
const FACES = [];
let nFace = 0;

/** route() 的一步：读写共享的布局上下文 c */
export function routeItems(c) {
  const { P, R, addLoad, addPenalty, atPort, bestColumn, blocksOf, entryCol, exitCol, graph, itemBids, opt, pos, rows, side, xL, xR } = c;
  // 喷增产剂：走线给要喷的带留出喷涂机的空当，见 SPRAY_GAP 和下面标 sprayHere 的几处。opt.sprayItems 给了时只喷这几种物品
  // （最终产物的直接原料），而且喷涂机要放在 opt.sprayTo 那几组（最终产物）取料之前、别的消费者都取完之后（用户 2026/10/18：
  // 上游吃到喷过的料不起作用，增产剂白耗）：这种带的访问排成「生产 → 别的消费者 → 最终那几组」，空当留在最终那几组前面；
  // 原料带给最终那几组单开入口，只喷那条。没给时每条进工厂的带都喷（sprayScope 'all'）
  const sprayAll = !!opt.sprayAll;
  const bridges = !!opt.bridges; // 桥：竖直列能穿过熔炉、制造台的块（positions.js 的 bestColumn），桥段记 leg.bridge
  const leftEnds = side || !!opt.leftPorts; // 原料段要朝右流、成品段要朝左流：靠左侧站列，或出入口都在左边（route.js 的 leftPorts）
  const sprayItems = sprayAll && opt.sprayItems ? new Set(opt.sprayItems) : null;
  const sprayTo = sprayItems ? new Set(opt.sprayTo ?? []) : null;
  const toFinal = (cc) => sprayTo.has(cc.p.gid); // 这个消费者是最终那几组（吃喷过的料）
  let sprayHere = false; // 当前这条带喷不喷（routeFlow 开头定）
  let legSpray = false; // 当前这条带的中间产物喷涂机骑在段尾那截高架上（见 LEG_WINDOW）
  let rawSpray = false; // 当前这条原料带的入口留喷涂机空当（planChain 里定：只喷最终那几组时，只有全是最终那几组取料的原料带喷）
  // 实验开关（考卷量上界用，网页不暴露）：opt.sprayGapOff 写 'in' / 'mid'（可用 + 连），那种地面空当不留、喷涂机也不放（配合 routeOptions.allowMissed）
  // （没给时两样都不关，不用每次拆一遍空字符串）
  const gapOff = opt.sprayGapOff ? new Set(String(opt.sprayGapOff).split(/[+,]/).filter(Boolean)) : null;
  const offIn = gapOff !== null && gapOff.has('in');
  const offMid = gapOff !== null && gapOff.has('mid');
  // ---------- B. 每种物品的路线 ----------
  const sides = new Map(); // 块 ID -> { bottom, top }，各是 itemId -> 'in' | 'out'
  for (const bid of pos.keys()) sides.set(bid, { bottom: new Map(), top: new Map() });
  const sideOf = (p, ch) => (ch === p.row ? 'bottom' : 'top');
  const segments = []; // 地面取放段
  const legs = []; // 高架段：in 原料入口→段，link 段→段，out 段→成品出口
  const chains = []; // 每种物品按流向排列的 [{leg}|{seg}]
  // 地面段、高架段的 id 是它在 segments、legs 里的下标，高架段另有 cells（落实高度时填）：都写在对象字面量的末尾
  // （属性的先后和建好以后再逐个加上时一样，免得每个对象再长一块属性表）
  const addSeg = (s) => {
    segments.push(s);
    return s;
  };
  const addLeg = (l) => {
    legs.push(l);
    return l;
  };

  // 通道 k -> 已排下的地面段范围 a0, b0, a1, b1, …（两个数一段，估算轨道占用）：chSegs[k] 的前 2 × chSegN[k] 项是这一次的
  // （各次调用共用这些数组，每次开头把段数清零）
  const chSegs = list(0);
  const chSegN = scratch(13, Int32Array, R + 1);
  chSegN.fill(0, 0, R + 1);
  /** 第 fr 行里和块 p 横向重叠的块，朝着 p 那一侧（fside）的 sides 表：依次写进 out，返回几个 */
  const near = (p, fr, fside, out) => {
    let n = 0;
    if (fr >= 0 && fr < R) {
      const row = rows[fr];
      for (let i = 0; i < row.length; i++) {
        const q = pos.get(row[i]);
        if (q.x0 <= p.x1 && q.x1 >= p.x0) out[n++] = sides.get(q.bid)[fside];
      }
    }
    return n;
  };
  // 每个块两侧的 sides 表，和对面一行里横向重叠的块朝着这边那一侧的表（below、above 的前 nBelow、nAbove 项）：
  // 布局定了就不变，按需各算一次（colDemand 是热点）。这些对象和数组放在池子里（FACES，每次 routeItems 从头用），只在这一步里用
  const faceMemo = new Map();
  nFace = 0;
  const faceOf = (p) => {
    let fc = faceMemo.get(p.bid);
    if (fc) return fc;
    const sd = sides.get(p.bid);
    fc = FACES[nFace++] ??= { bottom: null, top: null, below: [], above: [], nBelow: 0, nAbove: 0 };
    fc.bottom = sd.bottom;
    fc.top = sd.top;
    fc.nBelow = near(p, p.row - 1, 'top', fc.below);
    fc.nAbove = near(p, p.row + 1, 'bottom', fc.above);
    faceMemo.set(p.bid, fc);
    return fc;
  };
  /** 块 p 挂到通道 ch 时，这一列附近已经要用的分拣器种数：本侧已接的物品数 + 对面一行重叠块里最多的物品数（fc：faceOf(p)） */
  const colDemand = (p, ch, fc) => {
    const low = ch === p.row;
    const own = (low ? fc.bottom : fc.top).size;
    let face = 0;
    const ms = low ? fc.below : fc.above;
    const nm = low ? fc.nBelow : fc.nAbove;
    for (let i = 0; i < nm; i++) face = Math.max(face, ms[i].size);
    // 新碰撞规则下上下两侧可以共用一列（只要轨道错开），列数主要受多的那一侧限制。
    // 三个种子的基准均值：own + face 面积 5882、带 2142；max 面积 5757、带 2033；own + face/2 更差。
    return Math.max(own, face);
  };
  // 两段之间的竖直列（c.bestColumn）：本步里同样的参数大量重复，用数字键记下来，colLoad 一变（addLoad）就清空。
  // bestColumn0 只在 xL..xR+1 里找两头各隔至少 1 格的列：出段、进段的方向把这个范围夹空了时，不用扫列也知道是 null
  const XO = 16;
  const XW = xR + 2 * XO + 2;
  const CHN = R + 1;
  const colMemo = new Map();
  let loadVer = 0; // addLoad 调过几次：试算过的方案在这之后没变过 colLoad 就还能直接用
  // noBridge：这一截不走桥（opt.bridges 打开时才有区别，见 positions.js 的 bestColumn）
  const column = (xs, d0, xd, d1, c1, c2, g0min = 1, noBridge = false) => {
    let lo = xL;
    let hi = xR + 1;
    if (d0 > 0) lo = Math.max(lo, xs + g0min);
    else if (d0 < 0) hi = Math.min(hi, xs - g0min);
    else return null;
    if (d1 > 0) hi = Math.min(hi, xd - 1);
    else if (d1 < 0) lo = Math.max(lo, xd + 1);
    else return null;
    if (lo > hi) return null;
    if (!(xs + XO >= 0 && xs + XO < XW && xd + XO >= 0 && xd + XO < XW && c1 >= 0 && c1 < CHN && c2 >= 0 && c2 < CHN)) return bestColumn(xs, d0, xd, d1, c1, c2, g0min, noBridge);
    const key = ((((((xs + XO) * XW + xd + XO) * 3 + d0 + 1) * 3 + d1 + 1) * CHN * CHN + c1 * CHN + c2) * 2 + (g0min > 1 ? 1 : 0)) * 2 + (noBridge ? 1 : 0);
    let r = colMemo.get(key);
    if (r === undefined) colMemo.set(key, (r = bestColumn(xs, d0, xd, d1, c1, c2, g0min, noBridge)));
    return r;
  };
  const addLoadM = (x, c1, c2) => {
    addLoad(x, c1, c2);
    colMemo.clear();
    loadVer++;
  };
  // 竖直列的代价（positions.js 的 bestColumn0）是两头的横向距离（各至少 1 格）、离得太近的 +3，加上 crowd × crowdWeight：
  // crowdWeight 不为负时它不小于 max(2, 两头的距离)，试算可以按下界提前放弃（见 planChain 的 consider）
  const canPrune = opt.crowdWeight >= 0;
  // 挂通道时每个通道的统计（通道号 0..R），各种物品、各轮共用
  const sN = scratch(0, Int32Array, R + 1);
  const sProd = scratch(1, Int32Array, R + 1);
  const sLo = scratch(2, Float64Array, R + 1);
  const sHi = scratch(3, Float64Array, R + 1);
  const sCols = scratch(4, Float64Array, R + 1);
  /** 通道 k 里已排下的地面段有几段落在这一轮要挂的范围（sLo..sHi 各放宽 1 格）里 */
  const loadOf = (k) => {
    let load = 0;
    const n = 2 * chSegN[k];
    if (!n) return 0;
    const segs = chSegs[k];
    const hi = sHi[k] + 1;
    const lo = sLo[k] - 1;
    for (let j = 0; j < n; j += 2) if (segs[j] <= hi && segs[j + 1] >= lo) load++;
    return load;
  };
  const beltCap = BELT_SPEED[opt.belt] * opt.stack * 60;
  // 物流站输出原料时可以集装（科技解锁后 1~4 层），原料带的运力随之翻倍；成品由分拣器放上带，不集装
  const rawCap = beltCap * Math.max(1, opt.station?.stack ?? opt.externalStack ?? 1);
  // 自动集装机（opt.pilers，用户 2026/10/26）：分拣器放上带的是单个物品，带上每放约 1700/分过一台集装机叠成 4 层，
  // 产物带一条最多运单条带的 4 倍，不到这个量不拆带（集装机放在哪儿是后处理，plan/addons.js 的 stackPilers）。关掉时和单条带一样
  const pileCap = opt.pilers ? Math.max(beltCap, BELT_SPEED[opt.belt] * 4 * 60) : beltCap;
  // 排物品的顺序：只能走某一个通道的先排，能二选一的后排（让它们去轨道少的那边）；原料入口随时可以多开，最后排
  const flex = (f) => {
    if (f.producer === 'RAW') return 3;
    // 生产者、消费者所在行的跨度：都在同一行时上下两个通道都行（both = 2），跨两行时只有中间那个（1），更远一个也没有（0）
    let lo = Infinity;
    let hi = -Infinity;
    const ps = blocksOf.get(f.producer);
    for (let i = 0; i < ps.length; i++) {
      lo = Math.min(lo, ps[i].row);
      hi = Math.max(hi, ps[i].row);
    }
    const cons = f.consumers;
    for (let j = 0; j < cons.length; j++) {
      if (cons[j].to === 'OUT') continue;
      const bs = blocksOf.get(cons[j].to);
      for (let i = 0; i < bs.length; i++) {
        lo = Math.min(lo, bs[i].row);
        hi = Math.max(hi, bs[i].row);
      }
    }
    const both = hi === lo ? 2 : hi - lo === 1 ? 1 : 0;
    return both === 1 ? 0 : both === 0 ? 1 : 2;
  };
  /**
   * 产物流量超过一条带的运力（pileCap；比如关掉集装机时 2070/分 的铁块）：按位置把生产者分成几组，每组一条带，
   * 消费者就近挂到还有余量的那一组；成品出口分到有富余的组。
   */
  const splitFlow = (prods, cons, out, per) => {
    const k = Math.ceil((prods.reduce((a, p) => a + p.n * per, 0) - TOL) / pileCap);
    const total = prods.reduce((a, p) => a + p.n * per, 0);
    const bins = [];
    let cur = null;
    for (const p of prods.slice().sort((a, b) => a.row - b.row || a.x0 - b.x0)) {
      const o = p.n * per;
      if (!cur || (cur.P.length && (cur.prod + o > pileCap + TOL || (cur.prod >= total / k - TOL && bins.length < k)))) bins.push((cur = { P: [], C: [], prod: 0, need: 0, out: 0 }));
      cur.P.push(p);
      cur.prod += o;
    }
    const rowOf = (b) => b.P.reduce((a, p) => a + p.row, 0) / b.P.length;
    for (const c of cons.slice().sort((a, b) => b.d * b.p.n - a.d * a.p.n)) {
      const dem = c.d * c.p.n;
      const fit = bins.filter((b) => b.need + dem <= b.prod + TOL);
      const pool = fit.length ? fit : bins;
      const b = pool.reduce((m, x) => {
        const sx = fit.length ? Math.abs(rowOf(x) - c.p.row) : -(x.prod - x.need);
        const sm = fit.length ? Math.abs(rowOf(m) - c.p.row) : -(m.prod - m.need);
        return sx < sm ? x : m;
      });
      b.C.push(c);
      b.need += dem;
    }
    // 精确分带（opt.exactSplit）：按块分带凑不齐（某条带消费比生产多）时，换生产者的切法、消费者的分法再找一遍
    if (opt.exactSplit && bins.some((b) => b.need > b.prod + TOL)) {
      const gap0 = bins.reduce((a, b) => a + Math.max(0, b.need - b.prod), 0);
      const better = exactBins(prods, cons, per, k);
      if (better && better.gap < gap0 - TOL) {
        bins.length = 0;
        bins.push(...better);
      }
    }
    let left = out;
    for (const b of bins.slice().sort((x, y) => y.prod - y.need - (x.prod - x.need))) {
      b.out = Math.min(left, Math.max(0, b.prod - b.need));
      left -= b.out;
    }
    if (left > TOL) bins[0].out += left;
    return bins.map((b) => ({ P: b.P, C: b.C, out: b.out, rate: b.prod }));
  };
  /**
   * 精确分带：生产者按位置排好，切成连续的 k 段（每段不超过一条带），切点在等分点附近各试前后两块；每种切法把消费者按需求从大到小
   * 放进「放得下里剩得最少」的带（放不下就放剩得最多的），再一步一步挪一个、换两个，压各条带的缺口合计。取缺口最小的切法
   * （一样时离得近的），比原来的缺口小才用。整台工厂取整，生产 60/分一台、消费 45/分一台时，等分常常凑不齐（引力矩阵 180 铁块 23 + 22
   * 台差 15~60/分），换成 21 + 24 台就正好
   */
  const exactBins = (prods, cons, per, k) => {
    const P = prods.slice().sort((a, b) => a.row - b.row || a.x0 - b.x0);
    const o = P.map((p) => p.n * per);
    const m = P.length;
    if (m < k) return null;
    const pre = [0];
    for (const x of o) pre.push(pre[pre.length - 1] + x);
    const total = pre[m];
    // 每个切点（第 j 段从第几个生产块起）的候选：前缀和跨过 j·total/k 的位置前后两块
    const opts = [];
    for (let j = 1; j < k; j++) {
      let at = 1;
      while (at < m && pre[at] < (j * total) / k) at++;
      const list = [];
      for (let d = -2; d <= 2; d++) if (at + d >= 1 && at + d <= m - 1) list.push(at + d);
      opts.push(list);
    }
    const C = cons.slice().sort((a, b) => b.d * b.p.n - a.d * a.p.n);
    const dem = C.map((c) => c.d * c.p.n);
    let best = null;
    const cutsNow = [];
    const tryCuts = () => {
      const bounds = [0, ...cutsNow, m];
      const prod = [];
      for (let j = 0; j < k; j++) {
        const v = pre[bounds[j + 1]] - pre[bounds[j]];
        if (!(v > 0) || v > pileCap + TOL) return;
        prod.push(v);
      }
      const rowAt = [];
      for (let j = 0; j < k; j++) {
        let r = 0;
        for (let i = bounds[j]; i < bounds[j + 1]; i++) r += P[i].row;
        rowAt.push(r / (bounds[j + 1] - bounds[j]));
      }
      const need = new Array(k).fill(0);
      const at = new Int32Array(C.length);
      for (let i = 0; i < C.length; i++) {
        let pick = -1;
        for (let j = 0; j < k; j++) if (need[j] + dem[i] <= prod[j] + TOL && (pick < 0 || prod[j] - need[j] < prod[pick] - need[pick])) pick = j;
        if (pick < 0) for (let j = 0; j < k; j++) if (pick < 0 || prod[j] - need[j] > prod[pick] - need[pick]) pick = j;
        at[i] = pick;
        need[pick] += dem[i];
      }
      const gapOf = () => need.reduce((a, v, j) => a + Math.max(0, v - prod[j]), 0);
      // 两条带、消费块不多时把各种分法都试一遍（2^n 种，n ≤ 12）
      if (k === 2 && C.length <= 12) {
        let bm = -1;
        let bg = Infinity;
        const tot = dem.reduce((a, v) => a + v, 0);
        for (let mask = 0; mask < 1 << C.length; mask++) {
          let a = 0;
          for (let i = 0; i < C.length; i++) if (mask & (1 << i)) a += dem[i];
          const g = Math.max(0, a - prod[0]) + Math.max(0, tot - a - prod[1]);
          if (g < bg - TOL) {
            bg = g;
            bm = mask;
          }
        }
        need[0] = 0;
        need[1] = 0;
        for (let i = 0; i < C.length; i++) {
          at[i] = bm & (1 << i) ? 0 : 1;
          need[at[i]] += dem[i];
        }
      }
      let gap = gapOf();
      // 挪一个、换两个，压缺口（最多 40 步）
      for (let it = 0; it < 40 && gap > TOL; it++) {
        let bestGain = TOL;
        let move = null;
        for (let i = 0; i < C.length; i++)
          for (let j = 0; j < k; j++) {
            if (j === at[i]) continue;
            const a = at[i];
            const before = Math.max(0, need[a] - prod[a]) + Math.max(0, need[j] - prod[j]);
            const after = Math.max(0, need[a] - dem[i] - prod[a]) + Math.max(0, need[j] + dem[i] - prod[j]);
            if (before - after > bestGain) {
              bestGain = before - after;
              move = [i, j, -1];
            }
            for (let i2 = 0; i2 < C.length; i2++) {
              if (at[i2] !== j) continue;
              const after2 = Math.max(0, need[a] - dem[i] + dem[i2] - prod[a]) + Math.max(0, need[j] + dem[i] - dem[i2] - prod[j]);
              if (before - after2 > bestGain) {
                bestGain = before - after2;
                move = [i, j, i2];
              }
            }
          }
        // 两条带整个对调（各自的消费换过来）：带的生产不一样大时常常就差这一下
        let swapAll = null;
        for (let a = 0; a < k; a++)
          for (let b = a + 1; b < k; b++) {
            const before = Math.max(0, need[a] - prod[a]) + Math.max(0, need[b] - prod[b]);
            const after = Math.max(0, need[b] - prod[a]) + Math.max(0, need[a] - prod[b]);
            if (before - after > bestGain) {
              bestGain = before - after;
              swapAll = [a, b];
            }
          }
        if (swapAll) {
          const [a, b] = swapAll;
          for (let i = 0; i < C.length; i++) at[i] = at[i] === a ? b : at[i] === b ? a : at[i];
          [need[a], need[b]] = [need[b], need[a]];
          gap = gapOf();
          continue;
        }
        if (!move) break;
        const [i, j, i2] = move;
        const a = at[i];
        need[a] -= dem[i];
        need[j] += dem[i];
        at[i] = j;
        if (i2 >= 0) {
          need[j] -= dem[i2];
          need[a] += dem[i2];
          at[i2] = a;
        }
        gap = gapOf();
      }
      let dist = 0;
      for (let i = 0; i < C.length; i++) dist += Math.abs(rowAt[at[i]] - C[i].p.row);
      if (!best || gap < best.gap - TOL || (Math.abs(gap - best.gap) <= TOL && dist < best.dist)) best = { gap, dist, bounds, prod, at: Array.from(at) };
    };
    const rec = (j, lo) => {
      if (j === k - 1) return tryCuts();
      for (const c of opts[j]) {
        if (c <= lo) continue;
        cutsNow.push(c);
        rec(j + 1, c);
        cutsNow.pop();
      }
    };
    rec(0, 0);
    if (!best) return null;
    const bins = [];
    for (let j = 0; j < k; j++) bins.push({ P: P.slice(best.bounds[j], best.bounds[j + 1]), C: [], prod: best.prod[j], need: 0, out: 0 });
    for (let i = 0; i < C.length; i++) {
      bins[best.at[i]].C.push(C[i]);
      bins[best.at[i]].need += dem[i];
    }
    bins.gap = best.gap;
    return bins;
  };

  // 当前这条带：物品 f、是不是原料、送到成品出口的量、带上的流量（产物）。
  // 下面 routeFlow、planChain、commitChain 各物品、各条带共用，读这几个量，不必每种物品重建一遍闭包
  let f = null;
  let isRaw = false;
  // 原料带的入口只许在哪一边（−1 左、1 右、0 不限）：一种原料有几条带时都从同一边进（用户 2026/10/24，routeFlow 里定）
  let rawSide = 0;
  let outRate = 0;
  let rate = 0;
  let selfLoop = false; // 这种物品的生产者自己也消耗它（同一个块又产又耗）
  /** 一个访问（挂在通道 ch 上的一组生产者 Ps、消费者 Cs）：取放事件按 Ps、Cs 的先后 */
  const makeVisit = (ch, Ps, Cs) => {
    const e0 = nEv;
    let tmin = Infinity;
    let tmax = -Infinity;
    for (let i = 0; i < Ps.length; i++) {
      const p = Ps[i];
      const tap = p.g.tap ?? 0; // 中间那列（见文件开头）
      pushCenters(p, tap, f.perFactory);
      tmin = Math.min(tmin, p.tmin);
      tmax = Math.max(tmax, p.tmax);
    }
    for (let i = 0; i < Cs.length; i++) {
      const cc = Cs[i];
      const tap = cc.p.g.tap ?? 0;
      pushCenters(cc.p, tap, -cc.d);
      tmin = Math.min(tmin, cc.p.tmin);
      tmax = Math.max(tmax, cc.p.tmax);
    }
    return visitAt(ch, ch, Ps, Cs, e0, nEv, tmin, tmax);
  };
  // 挂通道时第 i 个块（i < nP 是生产者，否则是消费者 cons[i − nP]）的位置和 faceOf：各条带共用，用到多长算多长
  const EB = list(2);
  const EF = list(3);
  // 拼数组用的临时数组（访问、生产者、消费者、取放口、链的各部分）：先逐个写进来，再按刚好的长度切出去，免得每个小数组都留出 17 格
  const TV = list(4);
  const TP = list(5);
  const TC = list(6);
  const TT = list(7);
  const TQ = list(8);
  // 还没挂上的块（下标升序，前 nl 个有效）；这一轮里块 i 挂到下方（2i）、上方（2i + 1）通道时的 colDemand；
  // 这一轮 left 里第 t 个块：0 够不着选中的通道，1 够得着但挂过来会挤爆分拣器列（另一侧还有余地），2 够得着。
  // 临时数组按块数取够长的，这一步里只在块数变多时重取
  let capN = 0;
  let left = null;
  let dem = null;
  let sel = null;

  /**
   * 按侧拆段的判断：访问里上下两行都有块，且整段比两行里横向范围短的那一行长出 SIDE_SPLIT 格以上
   * （铺一整段时整段都得两边够得着；拆开后长的那段只占一侧够得着的轨）
   */
  const SIDE_SPLIT = 24;
  const sideApart = (v) => {
    let bLo = Infinity;
    let bHi = -Infinity;
    let aLo = Infinity;
    let aHi = -Infinity;
    const add = (p) => {
      if (p.row !== v.ch) {
        bLo = Math.min(bLo, p.tmin);
        bHi = Math.max(bHi, p.tmax);
      } else {
        aLo = Math.min(aLo, p.tmin);
        aHi = Math.max(aHi, p.tmax);
      }
    };
    for (const p of v.P) add(p);
    for (const c of v.C) add(c.p);
    if (bLo === Infinity || aLo === Infinity) return false;
    return Math.max(aHi, bHi) - Math.min(aLo, bLo) - Math.min(aHi - aLo, bHi - bLo) >= SIDE_SPLIT;
  };
  /**
   * 按侧拆开的一半：访问 v 里下方那行（row ≠ v.ch，lower 为真）或上方那行接的生产者、消费者，先后不变。
   * 单独写成函数：原来的过滤函数直接写在 routeFlow 的循环里、读循环里的 ch，那一层循环每转一圈都要建一个作用域对象（不拆段时也建）
   */
  const sideHalf = (v, lower) =>
    makeVisit(
      v.ch,
      v.P.filter((p) => (p.row !== v.ch) === lower),
      v.C.filter((c) => (c.p.row !== v.ch) === lower),
    );

  // 原料带试算过的方案（plan）：之后没调过 addLoad、colLoad 没变，就和重算的一样，直接用。按（哪一组访问——groups 里的那个数组本身，rawSide）找，
  // 第 j 条记在 TRV、TRS、TRL（算的时候的 loadVer）、TRB 的第 j 项；只在一条原料带里用，routeFlow 里每条开头 nTr 归零
  // （原来每条原料带建三个 Map、每条记录一个 {ver, best}；同一个键再算一遍时原地改写，和 Map 的 set 一样）
  const TRV = list(18);
  const TRS = list(19);
  const TRL = list(20);
  const TRB = list(21);
  let nTr = 0;
  const plan = (vs) => {
    let j = 0;
    while (j < nTr && !(TRV[j] === vs && TRS[j] === rawSide)) j++;
    if (j < nTr && TRL[j] === loadVer) return TRB[j];
    const best = planChain(vs, vs.length);
    if (j === nTr) {
      TRV[j] = vs;
      TRS[j] = rawSide;
      nTr++;
    }
    TRL[j] = loadVer;
    TRB[j] = best;
    return best;
  };
  /** 几组原料带试算的代价合计，每组再加一个入口（串不串通道时比；加法的先后和原来 reduce 的一样） */
  const price = (gs) => {
    let a = 0;
    for (let i = 0; i < gs.length; i++) a = a + plan(gs[i]).cost + opt.entryWeight;
    return a;
  };
  // 原料带的各个单元（RU，只用前 nUnits 项）、每个单元自成一组时拼 groups 用的临时数组（RG）
  const RU = list(25);
  const RG = list(26);

  /** 一条带（一种物品的一组生产者和消费者）：挂通道、定访问顺序和流向、落实成段和高架段 */
  const routeFlow = (prodBlocks, cons, nCons, out, r) => {
    outRate = out;
    rate = r;
    // 这条带喷不喷：全喷时都喷；只喷最终那几组时，要喷的物品、而且这条带上有最终那几组取料
    sprayHere = sprayAll;
    if (sprayItems) {
      sprayHere = false;
      if (sprayItems.has(baseItem(f.itemId))) for (let i = 0; i < nCons; i++) if (toFinal(cons[i])) sprayHere = true;
    }
    legSpray = sprayHere && opt.sprayOnLegs !== false;
    nEv = 0; // 上一条带的访问用完了，事件池从头用
    nSv = 0;
    nVisit = 0; // 访问、方案的池子也从头用（见 VISITS、PLANS）
    nPlan = 0;
    // 1. 每个块挂到上方或下方通道：贪心集合覆盖，让一种物品经过的通道尽量少
    const nP = prodBlocks.length;
    const n = nP + nCons; // cons 只看前 nCons 个
    for (let i = 0; i < n; i++) {
      const p = i < nP ? prodBlocks[i] : cons[i - nP].p;
      EB[i] = p;
      EF[i] = faceOf(p);
    }
    if (n > capN) {
      capN = n;
      left = scratch(12, Int32Array, n);
      dem = scratch(5, Int32Array, 2 * n);
      sel = scratch(6, Uint8Array, n);
    }
    let nl = n;
    for (let i = 0; i < n; i++) left[i] = i;
    let nv = 0; // 访问先放在 TV 里
    while (nl) {
      // 每个通道（按通道号）：能覆盖几个块、其中几个生产者、横向范围，以及挂过来会挤爆几处分拣器列
      for (let k = 0; k <= R; k++) {
        sN[k] = 0;
        sProd[k] = 0;
        sLo[k] = Infinity;
        sHi[k] = -Infinity;
        sCols[k] = 0;
      }
      for (let t = 0; t < nl; t++) {
        const i = left[t];
        const p = EB[i];
        const r = p.row;
        // 上侧没有口的工厂（精炼厂）只挂下面那条通道
        for (let ch = r, top = p.g.noTop ? r : r + 1; ch <= top; ch++) {
          sN[ch]++;
          if (i < nP) sProd[ch]++;
          sLo[ch] = Math.min(sLo[ch], p.tmin);
          sHi[ch] = Math.max(sHi[ch], p.tmax);
        }
        // 这一轮挂上之前 sides 不变，每个块两侧各算一次，下面挑通道、判断挂不挂都用它
        dem[2 * i] = colDemand(p, r, EF[i]);
        dem[2 * i + 1] = colDemand(p, r + 1, EF[i]);
        sCols[r] += Math.max(0, dem[2 * i] + 1 - p.g.colCap);
        if (!p.g.noTop) sCols[r + 1] += Math.max(0, dem[2 * i + 1] + 1 - p.g.colCap);
      }
      // 覆盖得多的通道优先；一样多时，先挑分拣器列更宽裕的通道（每台工厂一侧只有 3 列，
      // 这一侧和对面那一行在这里接的物品数，多的那一侧超过列数就排不开），
      // 再挑这一段范围内已有地面段更少的通道（少占轨道），再挑有生产者的，最后挑通道号大的（全序，和遍历先后无关）
      // （地面段数只在前两项打平时才用得上，用到才数；pl 为 −1 是还没数）
      let ch = -1;
      let pv = 0;
      let pc = 0;
      let pl = -1;
      let pp = 0;
      for (let k = 0; k <= R; k++) {
        if (!sN[k]) continue;
        const cols = sCols[k];
        // 会挤爆分拣器列的挂法，宁可多经过一个通道：每挤爆一处按少覆盖两个块算
        const sv = sN[k] - 2 * cols;
        let load = -1;
        let better;
        if (ch < 0 || sv > pv) better = true;
        else if (sv !== pv) better = false;
        else if (cols !== pc) better = cols < pc;
        else {
          if (pl < 0) pl = loadOf(ch);
          load = loadOf(k);
          better = load < pl || (load === pl && (sProd[k] > pp || (sProd[k] === pp && k > ch)));
        }
        if (better) {
          ch = k;
          pv = sv;
          pc = cols;
          pl = load;
          pp = sProd[k];
        }
      }
      // 这个块挂过来会挤爆分拣器列、而另一侧还有余地时，先不挂，留给下一轮（一个都挂不上时就不挑了）
      let nFit = 0;
      for (let t = 0; t < nl; t++) {
        const i = left[t];
        const p = EB[i];
        if ((p.row !== ch && p.row + 1 !== ch) || (p.g.noTop && p.row !== ch)) {
          sel[t] = 0;
          continue;
        }
        const low = p.row === ch;
        const other = low ? p.row + 1 : p.row;
        const fit = p.g.noTop || !((low ? dem[2 * i] : dem[2 * i + 1]) + 1 > p.g.colCap && (low ? dem[2 * i + 1] : dem[2 * i]) + 1 <= p.g.colCap && sN[other]);
        sel[t] = fit ? 2 : 1;
        if (fit) nFit++;
      }
      const need = nFit ? 2 : 1;
      const e0 = nEv;
      let tmin = Infinity;
      let tmax = -Infinity;
      let np = 0; // 这一轮挂上的生产者、消费者先放在 TP、TC 里，最后建成刚好长的数组
      let nc = 0;
      let nl2 = 0; // 没挂上的留在 left 里（原地压紧，先后不变）
      for (let t = 0; t < nl; t++) {
        const i = left[t];
        if (sel[t] < need) {
          left[nl2++] = i;
          continue;
        }
        const p = EB[i];
        const prod = i < nP;
        // 立刻记上，后面的块据此判断列是否够用（EF[i] 的 bottom、top 就是 sides 里这个块的两张表）
        (ch === p.row ? EF[i].bottom : EF[i].top).set(f.itemId, prod ? 'out' : 'in');
        const tap = p.g.tap ?? 0; // 中间那列（见文件开头）
        if (prod) {
          TP[np++] = p;
          pushCenters(p, tap, f.perFactory);
        } else {
          const cc = cons[i - nP];
          TC[nc++] = cc;
          pushCenters(p, tap, -cc.d);
        }
        tmin = Math.min(tmin, p.tmin);
        tmax = Math.max(tmax, p.tmax);
      }
      nl = nl2;
      const v = visitAt(ch, ch, TP.slice(0, np), TC.slice(0, nc), e0, nEv, tmin, tmax);
      // 开喷增产剂时一个访问里不能生产者、消费者交错（喷涂机要在全部放料之后、全部取料之前，
      // 而段内取放的先后由工厂位置定，保证不了）：拆成先 P 后 C 两个访问，中间走一截高架，
      // 喷涂机骑在 P 访问段尾的空当上（见 planChain 里的 SPRAY_GAP）。
      // 只喷最终那几组时消费者也不能和最终那几组交错：再拆成别的消费者、最终那几组两个访问（原料带就是两个入口）
      if (sprayHere && v.C.length) {
        let nF = 0;
        if (sprayTo) for (let i = 0; i < v.C.length; i++) if (toFinal(v.C[i])) nF++;
        const mixC = sprayTo !== null && nF > 0 && nF < v.C.length;
        if ((!isRaw && v.P.length) || mixC) {
          if (v.P.length) TV[nv++] = makeVisit(ch, v.P, []);
          if (mixC) {
            TV[nv++] = makeVisit(ch, [], v.C.filter((cc) => !toFinal(cc)));
            TV[nv++] = makeVisit(ch, [], v.C.filter(toFinal));
          } else TV[nv++] = makeVisit(ch, [], v.C);
        } else TV[nv++] = v;
      } else if (opt.sideSplit && !(isRaw && (opt.stationHoles || opt.station)) && sideApart(v)) {
        // 接物流站时原料不拆：每多一段原料就多一个站口（引力矩阵 360、黄棒 30 站+塔：站口不够用、2 条带没接上站）
        // 按侧拆段（opt.sideSplit）：下方那行（row = ch − 1）接的一段、上方那行接的一段，中间走高架
        TV[nv++] = sideHalf(v, true);
        TV[nv++] = sideHalf(v, false);
      } else TV[nv++] = v;
    }
    // 这条带的访问就是 TV 的前 nv 个（planChain 按个数读，不必再切出一个数组）
    const visits = TV;

    // 原料：默认每个通道各开一个入口（入口随时可以多开，路线最短、单条带的流量也小）；产物：一条带串起所有通道
    if (!isRaw) {
      commitChain(planChain(visits, nv));
      return;
    }
    // 一个通道里原料需求超过单条带运力时，按位置切成几段，各开一个入口。units 只用前 nUnits 项（各条带共用的数组）
    const units = RU;
    let nUnits = 0;
    for (let j = 0; j < nv; j++) {
      const v = visits[j];
      let total = 0;
      for (let i = 0; i < v.C.length; i++) total += v.C[i].d * v.C[i].p.n;
      if (total <= rawCap + TOL) {
        v.total = total;
        units[nUnits++] = v;
        continue;
      }
      let cur = null;
      const byX = v.C.slice().sort(byTmin);
      for (let i = 0; i < byX.length; i++) {
        const c = byX[i];
        const need = c.d * c.p.n;
        if (!cur || cur.total + need > rawCap + TOL) units[nUnits++] = cur = visitAt(v.ch, v.key, [], [], nEv, nEv, undefined, undefined);
        cur.C.push(c);
        cur.total += need;
        const tap = c.p.g.tap ?? 0; // 中间那列（见文件开头）
        pushCenters(c.p, tap, -c.d);
        cur.e1 = nEv;
      }
    }
    for (let j = 0; j < nUnits; j++) {
      const u = units[j];
      u.tmin ??= Math.min(...u.C.map((c) => c.p.tmin));
      u.tmax ??= Math.max(...u.C.map((c) => c.p.tmax));
    }
    // 串通道（rawChain > 1）：同一种原料的一条带依次经过相邻的几个通道（合计不超过单条带运力），入口就少了。
    // 串与不串都先试算一遍（入口按 entryWeight 计价），取便宜的那种。试算过的方案记在 plan 里（这一条带开头清空）
    nTr = 0;
    // 每个单元自成一组（组的数组本身是 plan 记方案的键）
    for (let j = 0; j < nUnits; j++) RG[j] = [units[j]];
    let groups = RG.slice(0, nUnits);
    if (opt.rawChain > 1 && nUnits > 1) {
      // 按通道、横向位置排好，依次装组（满 rawChain 个、超运力、喷涂时档不同就另起一组）；每组从排好的数组里按刚好的长度切出来
      const byCh = units.slice(0, nUnits).sort(byChTmin);
      const merged = [];
      let g0 = 0; // 当前这一组从 byCh 的第几个起
      let tot = 0;
      for (let i = 0; i < byCh.length; i++) {
        const u = byCh[i];
        if (i === 0 || i - g0 >= opt.rawChain || tot + u.total > rawCap + TOL || (sprayHere && sprayTo && rankOf(u) !== rankOf(byCh[g0]))) {
          if (i > 0) merged.push(byCh.slice(g0, i));
          g0 = i;
          tot = 0;
        }
        tot += u.total;
      }
      merged.push(byCh.slice(g0));
      if (merged.length < nUnits && price(merged) < price(groups)) groups = merged;
    }
    // 几条带（几个入口）时都从同一边进（用户 2026/10/24：一种原料不要从几个方向进，要在一处）：左右各试算一遍取便宜的那边。
    // 接物流站（站列、边缘放站）时入口不在左右边缘，不限
    // 开侧边总线（groupPorts，layout/ports.js）时一律从右边进：总线排在右边布局外，左边没有往外排的余地。
    // 总线可以排左边（busSide 'auto'，试验开关）时照样左右各试算一遍，总线排到这种原料进的那一边。
    // 出入口都在左边（leftPorts）时不限：下面的方向约束已经让原料都从左边进
    if ((opt.sameSide || opt.groupPorts) && groups.length > 1 && !side && !opt.freeEnds && !opt.leftPorts) {
      if (opt.groupPorts && opt.busSide !== 'auto') rawSide = 1;
      else {
        let best = null;
        for (const sd of [-1, 1]) {
          rawSide = sd;
          const cost = groups.reduce((a, g) => a + plan(g).cost, 0);
          if (!best || cost < best.cost - TOL) best = { sd, cost };
        }
        rawSide = best.sd;
      }
    }
    for (let j = 0; j < groups.length; j++) commitChain(plan(groups[j]));
    rawSide = 0;
  };

  // 2. 访问顺序与每段流向：枚举，取供给缺口最小、带子最短的方案。
  // 下面 segOf、consider 读写 planChain 这一次的状态（planChain 不会重入，各次共用这些变量和临时数组，不必每次重建闭包）
  let vis = null; // 这一次的各个访问
  let capK = 0; // 下面的临时数组够几个访问用
  let vk = 0; // 访问个数
  let gapAt = -1; // 喷涂机的空当留在第几段的段尾（−1：不留）
  // 原料带、这些访问的取放量都是有限数（planChain 里定）：前缀里 acc 从 Infinity 起，Infinity 加有限数还是 Infinity，
  // worst 取 min(worst, Infinity) 不变，逐个事件累加什么也不改，跳过。flow 是这些量的总和取负，它有限就说明没有 NaN、±Infinity
  // （有一个不是有限数，和就成了 NaN 或 ±Infinity，再加有限数也回不到有限）
  let rawSkip = false;
  // segOf 的结果（见 segOf）：段的两端、空当被站列截短没有、算过没有。
  // 段的两端和下面的进口、出口 x 会写进段对象、传给 bestColumn，用普通数组存（整数仍是小整数，不变成浮点数）
  const GA = list(9);
  const GB = list(10);
  let GH = null;
  let GD = null;
  // 前缀状态：前 i + 1 段的流向取 mask 的低 i + 1 位时累计的 acc、worst、len、sprayShort（第 i 层从下标 2^(i+1) − 2 起）
  let sAcc = null;
  let sWorst = null;
  let sLen = null;
  let sShort = null;
  let rest = null; // 当前方案从第 i 截起还没接的高架至少多长
  // 当前方案的第 i 段：segOf 的下标（劈开的第 0 段是 −1）、通道、进口和出口的 x、流向（劈开的是 0）、出口的方向
  let mAt = null;
  let mCh = null;
  const mIn = list(11);
  const mOut = list(12);
  let mD = null;
  let mDout = null;
  // 这个顺序下第 i 段、流向 back 时的 segOf 下标、进口、出口的 x（下标 2i + back）：只和 (ix[i], i, back) 有关、和整个 mask 无关，
  // consider 的前缀那一圈记下，mask 那一圈查表（进口、出口和 GA、GB 一样用普通数组存）
  let TA = null;
  const TI = list(27);
  const TO = list(28);
  let AP = null; // 这个顺序下第 i 截竖直列跨过的通道折成的长度：|mCh[i] − mCh[i + 1]| · CH_PITCH，和 mask 无关
  let RT = null; // rest 里第 i 截那一项（见 consider），按两段的方向位记在 RT[i * 4 + 方向位]，和 lk 一一对应
  const cols = list(13); // 当前方案各段之间竖直列的 x
  const colsBr = list(14); // 桥（opt.bridges 打开时才写）：当前方案第 i 截的竖直列是不是桥
  const lk = list(15);
  // 目前最好的方案（has 为假时还没有）：找到更好的就照抄过来，最后才建 best
  let has = false;
  let bCost = 0;
  let bShortfall = 0;
  let bBad = 0;
  let bSpray = 0;
  // 第 0 段是劈开的那一段时（bAt[0] 为 −1）它的两端、劈开的位置、继续往下走的那一半、出口的方向和 x（consider 里算，最后建段时用）
  let bSA = 0;
  let bSB = 0;
  let bSM = 0;
  let bSCont = null;
  let bSDout = 0;
  let bSExitX = null;
  let bAt = null; // 各段 segOf 的下标（劈开的是 −1）、第几个访问
  let bJ = null;
  const bCols = list(16);
  const bBr = list(17);
  /**
   * 访问 j 排在第 i 个、流向 d（back = d < 0）时的段只取决于 j、i、d：各种顺序、各种流向组合共用一份。
   * 返回下标 at = (j·k + i)·2 + back：段的两端是 GA[at]、GB[at]，GH[at] 第 0 位是喷涂机的空当被站列截短了、
   * 第 1 位是原料的喷涂机骑在入口那截高架上（legIn）、第 2 位是骑在入口往外接出的那几节上（edgeIn）
   */
  const segOf = (j, i, back) => {
    const at = (j * vk + i) * 2 + back;
    if (GD[at]) return at;
    GD[at] = 1;
    const v = vis[j];
    const d = back ? -1 : 1;
    const entry = isRaw || i > 0;
    const exit = i < vk - 1 || outRate > 0;
    let a = v.tmin;
    let b = v.tmax;
    // 喷涂机的空当：原料在入口那头、中间产物在最后一个生产访问的段尾，各多留 SPRAY_GAP 格直带；
    // 中间产物骑高架（legSpray）时段尾不留，窗口在接下去那截高架上
    let gIn = rawSpray && i === 0 && !offIn ? SPRAY_GAP : 0;
    const gOut = i === gapAt && !legSpray ? SPRAY_GAP : 0;
    // 原料的喷涂机骑在入口那截高架上（legIn）：不留地面空当时的段头离入口列至少 LEG_WINDOW + 1 格（高架在段头前水平走够 5 格），
    // 窗口就是紧挨段头的那 5 格；不够长时（段头贴着边缘 / 走廊）照旧留地面空当。
    // 边缘放站（freeEnds）时入口没有高架、站用 A* 直接接到段头，没处骑，照旧留地面空当。
    // 不接站时这一行地面到边缘都空着的话，layout/ports.js 会把段在地面一直接到边缘（高架作废）：窗口那几格就成了段里的地面直带，
    // 喷涂机落地骑在原来段头前的那几格上（sprayGuards 按地面空当护着）
    // 不接站（没有站列、也不是边缘放站）时原料入口的空当一律不留在地面：高架够长就骑高架（legIn），不够长时喷涂机骑在
    // 入口往外接出的两三节上（'edgeIn'，plan/addons.js 的 pre：那几格在图外的边距里，比段头多留 4 格便宜）
    let win = 0;
    if (gIn && legSpray && !opt.freeEnds) {
      const head = d > 0 ? (side ? Math.max(v.tmin - 1, STATION_COLS - 1) : v.tmin - 1) : v.tmax + 1;
      if (Math.abs(head - entryCol(d)) - 1 >= LEG_WINDOW) {
        gIn = 0;
        win = 2;
      } else if (!side) {
        gIn = 0;
        win = 4;
      }
    }
    if (entry) d > 0 ? (a -= 1 + gIn) : (b += 1 + gIn);
    if (exit) d > 0 ? (b += 1 + gOut) : (a -= 1 + gOut);
    // 物流站靠左侧时段不许伸进站列（站体、车道都在那边）；被截短的空当骑不了喷涂机，按走不通重罚
    let short = 0;
    if (side && a < STATION_COLS - 1) {
      a = STATION_COLS - 1;
      if ((d > 0 ? gIn : gOut) && v.tmin - a < 1 + SPRAY_GAP) short = 1;
    }
    if (v.s < 0) sortEv(v);
    GA[at] = a;
    GB[at] = b;
    GH[at] = short | win;
    return at;
  };
  /**
   * 顺序 ix 下枚举各段流向，逐个和最好的比；m 不是 null 时第 0 段从 m 劈开（和流向无关，mask 第 0 位恒为 0），cont 是继续往下走的那一半。
   * 劈开的那段只记几个数（sA … sExitX），成了最好的方案才抄进 bS*，最后建段时才建对象（原来每试一次劈法建一个段对象、一个 {m, cont}）
   */
  const consider = (ix, m, cont) => {
    const k = vk;
    const visits = vis;
    const split = m !== null;
    const step = split ? 2 : 1;
    const i0 = split ? 1 : 0; // 劈开时第 0 段在下面单算，其余各段从这里起
    let sA = 0;
    let sB = 0;
    let sDout = 0;
    let sExitX = null;
    // 这个顺序下第 i 截高架（第 i、i + 1 段的流向各两种）找到的竖直列：lk[i * 4 + 两段的方向位]，没找过是 undefined
    // （只有 k − 1 截，后面只读前 4(k − 1) 格，只清这几格）
    for (let i = 0; i < 4 * (k - 1); i++) lk[i] = undefined;
    if (split) {
      // 劈开：左半 [a, m-1] 向左流，右半 [m, b] 向右流；cont 是继续往下走的那一半，另一半是死胡同
      const v = visits[ix[0]];
      const exit = 0 < k - 1 || outRate > 0;
      let acc = isRaw ? Infinity : 0;
      let worst = 0;
      let len = 0;
      let a = v.tmin;
      let b = v.tmax;
      // 左半是 x < m 的事件按向左流排（x 从大到小），右半是 x ≥ m 的按向右流排：
      // 排好的整串里挑出来，先后和单独把这一半排一遍一样（同一个全序，稳定）
      if (v.s < 0) sortEv(v);
      const n = v.e1 - v.e0;
      let h = 0;
      for (let t = v.s + n; t < v.s + 2 * n; t++) {
        if (!(SX[t] < m)) continue;
        h += SV[t];
        worst = Math.min(worst, h);
      }
      if (cont === 'L') acc = h;
      h = 0;
      for (let t = v.s; t < v.s + n; t++) {
        if (!(SX[t] >= m)) continue;
        h += SV[t];
        worst = Math.min(worst, h);
      }
      if (cont === 'R') acc = h;
      if (exit && cont === 'R') b++;
      if (exit && cont === 'L') a--;
      const dout = cont === 'R' ? 1 : cont === 'L' ? -1 : 0;
      sA = a;
      sB = b;
      sDout = dout;
      sExitX = dout > 0 ? b : dout < 0 ? a : null;
      len += b - a + 1;
      sAcc[0] = acc;
      sWorst[0] = worst;
      sLen[0] = len;
      sShort[0] = 0;
      mAt[0] = -1;
      mCh[0] = v.ch;
      mIn[0] = 0; // 劈开的段没有进口（只有原料带才看进口，原料带不劈）
      mOut[0] = dout ? sExitX : 0; // 没有出口时（只有一段、不接成品出口）不看
      mD[0] = 0;
      mDout[0] = dout;
      // 下面按方向位查第 0 段出口的地方（rest 的初值）：劈开的段和流向无关，两格都是它
      TO[0] = TO[1] = mOut[0];
    }
    // 枚举流向时 mask 的低位变得最快，同一个前缀只算一次；每个量的加法先后和逐个方案从头算时一样，结果逐位相同。
    // 第 i 段两个流向的 segOf 在这一层开头各调一次：原来在 p = 0、p = 2^i 时第一次调（第一次排事件、写 GA/GB/GH/GD），
    // 两次之间没有别的 segOf，排事件只写这个访问自己那块 SX/SV，所以副作用的先后、读到的值都一样；结果记进 TA、TI、TO、mCh
    for (let i = i0; i < k; i++) {
      const off = (2 << i) - 2;
      const prev = (1 << i) - 2;
      const low = (1 << i) - 1;
      const j = ix[i];
      const at0 = segOf(j, i, 0);
      const at1 = segOf(j, i, 1);
      TA[2 * i] = at0;
      TA[2 * i + 1] = at1;
      TI[2 * i] = GA[at0];
      TO[2 * i] = GB[at0];
      TI[2 * i + 1] = GB[at1];
      TO[2 * i + 1] = GA[at1];
      const v = visits[j];
      mCh[i] = v.ch;
      const n = v.e1 - v.e0;
      const sv = SV; // 这一层的排事件都在上面，之后 SV 不会再换
      for (let back = 0; back < 2; back++) {
        const at = back ? at1 : at0;
        // 这一段按流向排好的取放事件（segOf 里排过）；sh、len 的增量和原来每个前缀现算的式子一样
        const es = back ? v.s + n : v.s;
        const dsh = GH[at] & 1;
        const dlen = GB[at] - GA[at] + 1;
        // p 从小到大，和原来一圈走完 [0, 2^(i+1)) 的先后一样（这一半的 p 第 i 位都是 back）
        for (let p = back << i; p < (back + 1) << i; p += step) {
          let acc = isRaw ? Infinity : 0;
          let worst = 0;
          let len = 0;
          let sh = 0;
          if (i > 0) {
            const q = prev + (p & low);
            acc = sAcc[q];
            worst = sWorst[q];
            len = sLen[q];
            sh = sShort[q];
          }
          if (!rawSkip) {
            for (let t = es; t < es + n; t++) {
              acc += sv[t];
              worst = Math.min(worst, acc);
            }
          }
          sh += dsh;
          len += dlen;
          sAcc[off + p] = acc;
          sWorst[off + p] = worst;
          sLen[off + p] = len;
          sShort[off + p] = sh;
        }
      }
    }
    // 第 i 截竖直列跨过的通道（rest、len 里都有这一项，式子一样）；rest 里第 i 截那一项在没找过竖直列时
    // 只看两段的方向（第 i 段出口、第 i + 1 段进口），按方向位先算好，找过以后在下面 column 处改成按实际的算
    for (let i = 0; i < k - 1; i++) {
      AP[i] = Math.abs(mCh[i] - mCh[i + 1]) * CH_PITCH;
      const dy = AP[i] + 2;
      for (let c = 0; c < 4; c++) RT[i * 4 + c] = Math.min(5000, Math.max(2, Math.abs(TI[2 * i + 2 + (c >> 1)] - TO[2 * i + (c & 1)])) + dy);
    }
    const top = (1 << k) - 2;
    let pm = -1; // 上一个填过各段的 mask（−1：还没填过）
    for (let mask = 0; mask < 1 << k; mask += step) {
      // 原料入口限定在一边（rawSide）：第一段朝右流（mask 最低位 0）的从左边进，朝左流的从右边进
      if (rawSide !== 0 && (mask & 1) !== (rawSide > 0 ? 1 : 0)) continue;
      const acc = sAcc[top + mask];
      const worst = sWorst[top + mask];
      let len = sLen[top + mask];
      const sprayShort = sShort[top + mask];
      // 这个方案的各段（前缀里都算过了，查表）：mask 每次只变低几位，只重写和上一个填过的 mask 流向不同的那几段，
      // 其余几段留着的就是这个 mask 的（mCh 和 mask 无关，上面写过；劈开的第 0 段不在这里写）
      const chg = pm < 0 ? (1 << k) - 1 : mask ^ pm;
      pm = mask;
      for (let i = i0; chg >> i; i++) {
        if (!((chg >> i) & 1)) continue;
        const back = (mask >> i) & 1;
        const t = 2 * i + back;
        mAt[i] = TA[t];
        mIn[i] = TI[t];
        mOut[i] = TO[t];
        mD[i] = back ? -1 : 1;
        mDout[i] = back ? -1 : 1;
      }
      let bad = 0;
      // 高架段长度（竖直部分按跨过的通道数估）
      const c0 = entryCol(mD[0]);
      if (isRaw && !opt.freeEnds && !atPort(mIn[0], c0)) len += Math.abs(mIn[0] - c0) + 2;
      // 接物流站：原料从左边的主干走廊进来，段要朝右流；成品要朝左流回走廊，否则带子得掉头（出入口都在左边时一样，见 leftEnds）
      if (leftEnds && isRaw && mD[0] !== 1) bad++;
      let shortfall = -worst;
      if (!isRaw && outRate > 0) shortfall += Math.max(0, outRate - acc);
      // 到成品出口那一截和中间的竖直列无关：先算出来给下界用，照原来的先后最后才加进 len
      let outBad = 0;
      let outLen = -1;
      if (outRate > 0) {
        const dl = mDout[k - 1];
        if (!dl) outBad++;
        else {
          const c1 = exitCol(dl);
          if (!opt.freeEnds && !atPort(mOut[k - 1], c1)) outLen = Math.abs(c1 - mOut[k - 1]) + 2;
          if (leftEnds && dl !== -1) outBad++;
        }
      }
      // 喷涂：最后一个生产访问（gapAt）和紧接着的第一个消费访问在同一个通道、同向，消费的第一个口在最后一个放料口下游
      // 至少 1 + SPRAY_GAP 格（空当留得下）时，两段在地面接成一条、喷涂机骑在中间，不升起绕高架、不占竖直列（用户 2026/10/08，待办 3 第一步）。
      // 这一截的代价就是中间补的直带（可能是 −1、−2：放料段尾留的空当和取料段的进口重叠），比任何竖直列都便宜，所以能接就接
      let canJoin = false;
      let joinCost = 0;
      if (gapAt >= 0 && gapAt < k - 1) {
        const vp = visits[ix[gapAt]];
        const vc = visits[ix[gapAt + 1]];
        if (vp.ch === vc.ch && mD[gapAt] === mD[gapAt + 1] && (mD[gapAt] > 0 ? vc.tmin - vp.tmax : vp.tmin - vc.tmax) >= (offMid ? 1 : 1 + SPRAY_GAP)) {
          const ap = mAt[gapAt];
          const ac = mAt[gapAt + 1];
          canJoin = true;
          joinCost = Math.max(GB[ap], GB[ac]) - Math.min(GA[ap], GA[ac]) + 1 - (GB[ap] - GA[ap] + 1) - (GB[ac] - GA[ac] + 1);
        }
      }
      // 还没接的各截高架至少多长（rest[i]：第 i 截起）：已经找过竖直列的按实际的算，没找过的
      // 两头各隔至少 1 格，横向不少于 2 格、不少于两头的距离，再加竖直跨过的通道；找不到列时按走不通（bad，5000）算，所以每截至多计 5000
      // （每截那一项就是 RT 里记的，见上面和下面 column 处；rest 只在剪枝时读，不剪枝时不算）
      const prune = canPrune && has;
      if (prune) {
        rest[k - 1] = 0;
        for (let i = k - 2; i >= 0; i--) {
          if (canJoin && i === gapAt) {
            rest[i] = rest[i + 1] + joinCost;
            continue;
          }
          rest[i] = rest[i + 1] + RT[i * 4 + ((mask >> i) & 3)];
        }
      }
      let cut = false;
      for (let i = 0; i < k - 1; i++) {
        // 下界剪枝：已经算出的代价加上后面至少还要的，比最好的好不到 TOL（再留 1 格的余量盖住浮点误差）就不再找竖直列，
        // 这个方案按原来的比法也不会被选上
        if (prune && !(shortfall * 1000 + (bad + outBad) * 5000 + sprayShort * 5000 + len + (outLen >= 0 ? outLen : 0) + rest[i] < bCost - TOL + 1)) {
          cut = true;
          break;
        }
        if (canJoin && i === gapAt) {
          cols[i] = JOIN;
          if (bridges) colsBr[i] = false;
          len += joinCost;
          continue;
        }
        const li = i * 4 + ((mask >> i) & 3);
        let bc = lk[li];
        // 段尾骑喷涂机的那截高架（legSpray 的 gapAt）：竖直列离段尾至少 LEG_WINDOW 格，窗口的 5 格直带才放得下；
        // 这截也不走桥（桥段在第 4 层以上，喷涂机的窗口和保护区都跟着抬高，规则没验证过）
        if (bc === undefined) {
          bc = lk[li] = column(mOut[i], mDout[i], mIn[i + 1], mD[i + 1], mCh[i], mCh[i + 1], legSpray && i === gapAt ? LEG_WINDOW : 1, legSpray && i === gapAt);
          // 之后的方案在 rest 里照找到的算：式子和原来每次读 lk 时一样（没找到 5000，找到了按竖直列的代价加 dy，至多 5000）
          if (bc !== undefined) RT[li] = bc === null ? 5000 : Math.min(5000, bc.cost + (AP[i] + 2));
        }
        const x = bc?.x ?? null;
        cols[i] = x;
        if (bridges) colsBr[i] = x !== null && bc.bridge === true;
        if (x === null) bad++;
        else len += bc.cost + AP[i] + 2;
      }
      if (cut) continue;
      if (outLen >= 0) len += outLen;
      bad += outBad;
      const cost = shortfall * 1000 + bad * 5000 + sprayShort * 5000 + len;
      if (!has || cost < bCost - TOL) {
        has = true;
        bCost = cost;
        bShortfall = shortfall;
        bBad = bad;
        bSpray = sprayShort;
        if (split) {
          bSA = sA;
          bSB = sB;
          bSM = m;
          bSCont = cont;
          bSDout = sDout;
          bSExitX = sExitX;
        }
        for (let i = 0; i < k; i++) {
          bAt[i] = mAt[i];
          bJ[i] = ix[i];
        }
        for (let i = 0; i < k - 1; i++) bCols[i] = cols[i];
        if (bridges) for (let i = 0; i < k - 1; i++) bBr[i] = colsBr[i];
      }
    }
  };
  /** 劈开第一段的位置：生产者分拣器所在的各列（去重、从小到大），去掉最左一列；每个访问只算一次 */
  const cutsOf = (v) => {
    if (v.cuts) return v.cuts;
    const xs = [];
    for (let i = 0; i < v.P.length; i++) {
      const p = v.P[i];
      const tap = p.g.tap ?? 0; // 中间那列（见文件开头）
      for (let q = 0; q < p.centers.length; q++) xs.push(p.centers[q] + tap);
    }
    xs.sort((p, q) => p - q);
    const cuts = [];
    for (let i = 1; i < xs.length; i++) if (xs[i] !== xs[i - 1] && xs[i] !== xs[0]) cuts.push(xs[i]);
    return (v.cuts = cuts);
  };
  /**
   * 访问排在第几档：0 有生产者，1 别的消费者（只喷最终那几组、这条带要喷时），2 其余的消费者（最终那几组）。
   * 喷涂时各访问按档排（喷涂机在第 1 档之后、第 2 档之前），不喷时只分有没有生产者
   */
  const rankOf = (v) => (v.P.length ? 0 : sprayHere && sprayTo && !v.C.every(toFinal) ? 1 : 2);
  /** 访问多于 4 个时不全排列，只试两种：按档（有生产者的在前），同一档按通道号从小到大或从大到小 */
  const bigOrders = (visits, k) => {
    const byCh = (dir) => (a, b) => rankOf(a) - rankOf(b) || dir * (a.ch - b.ch);
    return [byCh(1), byCh(-1)].map((cmp) => visits.slice(0, k).map((_, i) => i).sort((i, j) => cmp(visits[i], visits[j])));
  };
  /** 访问是 visits 的前 k 个（原料带传 groups 里的一组，产物带传 TV） */
  const planChain = (visits, k) => {
    let flow = rate;
    if (isRaw) {
      flow = 0;
      for (let j = 0; j < k; j++) {
        const v = visits[j];
        let t = 0;
        for (let e = v.e0; e < v.e1; e++) t += EV[e];
        flow -= t;
      }
    }
    // 顺序用访问的下标表示（和直接排列访问一一对应、先后相同）
    const orders = k <= 4 ? permIdx(k) : bigOrders(visits, k);
    // 喷增产剂：生产的访问都要排在消费的访问之前（喷涂机放在两者之间才能喷到全部的料），
    // 空当留在最后一个生产访问（第 nP−1 个）的段尾；原料带的空当留在入口那头。
    // 只喷最终那几组时，别的消费者的访问（nN 个）排在生产的之后、最终那几组之前，空当留在第 nP + nN − 1 个的段尾；
    // 原料带只有全是最终那几组取料的才喷
    let nP = 0;
    let anyC = false;
    for (let j = 0; j < k; j++) {
      if (visits[j].P.length) nP++;
      if (visits[j].C.length) anyC = true;
    }
    let nN = 0;
    if (sprayHere && sprayTo) {
      anyC = false;
      for (let j = 0; j < k; j++) {
        const v = visits[j];
        if (!v.P.length && v.C.length) rankOf(v) === 1 ? nN++ : (anyC = true);
      }
    }
    vis = visits;
    vk = k;
    rawSkip = isRaw && Number.isFinite(flow); // 见 rawSkip
    gapAt = sprayHere && !isRaw && anyC ? nP + nN - 1 : -1;
    rawSpray = sprayHere && isRaw && (!sprayTo || !nN);
    has = false;
    if (k > capK) {
      // 临时数组按访问个数取够长的（这一步里只在访问个数变多时重取）
      capK = k;
      while (GA.length < 2 * k * k) {
        GA.push(0);
        GB.push(0);
      }
      GH = scratch(15, Int32Array, 2 * k * k);
      GD = scratch(16, Uint8Array, 2 * k * k);
      const NS = (2 << k) - 2;
      sAcc = scratch(7, Float64Array, NS);
      sWorst = scratch(8, Float64Array, NS);
      sLen = scratch(9, Float64Array, NS);
      sShort = scratch(10, Int32Array, NS);
      rest = scratch(11, Float64Array, k);
      mAt = scratch(17, Int32Array, k);
      mCh = scratch(18, Int32Array, k);
      while (mIn.length < k) {
        mIn.push(0);
        mOut.push(0);
      }
      mD = scratch(21, Int32Array, k);
      mDout = scratch(22, Int32Array, k);
      bAt = scratch(23, Int32Array, k);
      bJ = scratch(24, Int32Array, k);
      TA = scratch(25, Int32Array, 2 * k);
      while (TI.length < 2 * k) {
        TI.push(0);
        TO.push(0);
      }
      AP = scratch(26, Float64Array, k);
      RT = scratch(27, Float64Array, 4 * k);
    }
    GD.fill(0, 0, 2 * k * k);
    for (let o = 0; o < orders.length; o++) {
      const ix = orders[o];
      if (!isRaw && !visits[ix[0]].P.length) continue;
      if (gapAt >= 0) {
        let ok = true;
        for (let i = 0; i < k; i++) if (rankOf(visits[ix[i]]) !== (i < nP ? 0 : i < nP + nN ? 1 : 2)) ok = false;
        if (!ok) continue;
      }
      consider(ix, null, null);
    }
    // 喷增产剂时不劈段：先 P 后 C 的顺序下供给缺口恒为 0，用不上；劈开的死胡同那一半也没法喷
    if (!sprayHere && !isRaw && has && bShortfall > TOL) {
      // 两个方向都不够时，试试把第一段从生产者中间劈开、两半背向而流
      for (let o = 0; o < orders.length; o++) {
        const ix = orders[o];
        const v0 = visits[ix[0]];
        if (!v0.P.length) continue;
        const cuts = cutsOf(v0);
        const conts = k > 1 || outRate > 0 ? CONT_LR : CONT_NONE;
        for (let i = 0; i < cuts.length; i++) {
          for (let j = 0; j < conts.length; j++) consider(ix, cuts[i], conts[j]);
        }
      }
    }
    if (!has) return null;
    // 最好的方案（从池子里取，见 PLANS）：k 段、k − 1 截竖直列（cols）、桥（br，opt.bridges 打开时才写）
    const res = (PLANS[nPlan++] ??= { cost: 0, shortfall: 0, bad: 0, sprayShort: 0, k: 0, geo: [], cols: [], br: [], flow: 0 });
    res.cost = bCost;
    res.shortfall = bShortfall;
    res.bad = bBad;
    res.sprayShort = bSpray;
    res.k = k;
    res.flow = flow;
    // 各段：劈开的那段照 consider 记下的 bS* 建，其余照 segOf 的结果建出来（每个字段都重写）
    const geo = res.geo;
    for (let i = 0; i < k; i++) {
      const g = (geo[i] ??= { v: null, a: 0, b: 0, d: 0, split: null, cont: null, entryX: null, exitX: null, dout: 0, gap: null });
      const at = bAt[i];
      g.v = visits[bJ[i]];
      if (at < 0) {
        g.a = bSA;
        g.b = bSB;
        g.d = 0;
        g.split = bSM;
        g.cont = bSCont;
        g.entryX = null;
        g.exitX = bSExitX;
        g.dout = bSDout;
        g.gap = null;
        continue;
      }
      const d = at & 1 ? -1 : 1;
      const a = GA[at];
      const b = GB[at];
      g.a = a;
      g.b = b;
      g.d = d;
      g.split = null;
      g.cont = null;
      g.entryX = d > 0 ? a : b;
      g.exitX = d > 0 ? b : a;
      g.dout = d;
      // gap：喷涂机的空当在哪头；'mid' 是这一段和下一个访问在地面接成一条（bCols 里是 JOIN），空当在中间
      g.gap = rawSpray && i === 0 ? (offIn ? null : GH[at] & 2 ? 'legIn' : GH[at] & 4 ? 'edgeIn' : 'in') : i === gapAt ? (bCols[i] === JOIN ? (offMid ? 'join' : 'mid') : 'out') : null;
    }
    for (let i = 0; i < k - 1; i++) res.cols[i] = bCols[i];
    if (bridges) for (let i = 0; i < k - 1; i++) res.br[i] = bBr[i]; // 各截竖直列是不是桥
    return res;
  };
  /** 把方案落实：记惩罚、加地面段和高架段 */
  const commitChain = (best) => {
    const flow = best.flow;
    if (best.shortfall > TOL) addPenalty('shortfall', P.shortfall, `${f.name} 带上供给顺序不足 ${best.shortfall.toFixed(1)}/分`, itemBids(f.itemId));
    if (best.bad) addPenalty('route', P.route * best.bad, `${f.name} 找不到能竖直穿过的空列`, itemBids(f.itemId));
    if (best.sprayShort) addPenalty('spray', P.spray * best.sprayShort, `${f.name} 的带子贴着站列，留不出喷涂机的直带空当`, itemBids(f.itemId));

    // 3. 落实：地面段、高架段、出入口。方案在池子里（见 PLANS）：段只有前 k 个、竖直列只有前 k − 1 截是它的
    const geo = best.geo;
    const k = best.k;
    for (let i = 0; i < k - 1; i++) if (typeof best.cols[i] === 'number') addLoadM(best.cols[i], geo[i].v.ch, geo[i + 1].v.ch);
    let nq = 0; // 链的各部分先放在 TQ 里
    let pending = null; // 等待接到下一段的高架段
    if (isRaw) {
      const g0 = geo[0];
      pending = addLeg({ itemId: f.itemId, kind: 'in', edge: entryCol(g0.d), rate: flow, id: legs.length, cells: [], to: -1 });
      TQ[nq++] = { leg: pending.id };
    }
    for (let i = 0; i < k; i++) {
      const g = geo[i];
      const v = g.v;
      // 喷涂时在地面接成一条的放料段 + 取料段（gap 'mid'）：和下一个访问合成一段，取放口先放后取，空当在最后一个放料口（gapX）下游
      const g2 = g.gap === 'mid' || g.gap === 'join' ? geo[i + 1] : null; // 'join'：实验开关 offMid 下接成一条但不留空当
      let nt = 0;
      for (let j = 0; j < v.P.length; j++) TT[nt++] = { bid: v.P[j].bid, io: 'out', rate: f.perFactory };
      for (let j = 0; j < v.C.length; j++) TT[nt++] = { bid: v.C[j].p.bid, io: 'in', rate: v.C[j].d };
      if (g2) for (let j = 0; j < g2.v.C.length; j++) TT[nt++] = { bid: g2.v.C[j].p.bid, io: 'in', rate: g2.v.C[j].d };
      const a = g2 ? Math.min(g.a, g2.a) : g.a;
      const b = g2 ? Math.max(g.b, g2.b) : g.b;
      const seg = addSeg({
        itemId: f.itemId,
        ch: v.ch,
        a,
        b,
        dir: g.d,
        dout: g2 ? g2.dout : g.dout,
        split: g.split,
        cont: g.cont ?? null,
        fed: isRaw || i > 0, // 段首有上游送来的料
        entryX: g.entryX,
        exitX: g2 ? g2.exitX : g.exitX,
        rate: flow,
        // 喷涂机的直带空当留在哪头：'in' 入口那头 / 'out' 段尾 / 'mid' 最后一个放料口之后 / 'legOut' 段尾接下去那截高架上 /
        // 'legIn' 段头前面入口那截高架上（都是 LEG_WINDOW 格）/ 'edgeIn' 边缘入口往外接出的几节上（plan/addons.js 放）
        sprayGap: g.gap === 'out' && legSpray && !g2 ? 'legOut' : g.gap === 'join' ? null : g.gap ?? null,
        // 'mid'：空当从哪一格的下游起（最后一个放料口所在的列）；'legOut'：段尾那格（窗口从它的下游一格起）；'legIn'：段头那格（窗口是它上游的格）
        gapX: g2 ? (g.d > 0 ? v.tmax : v.tmin) : g.gap === 'out' && legSpray ? g.exitX : g.gap === 'legIn' ? g.entryX : null,
        taps: TT.slice(0, nt),
        id: segments.length,
      });
      const cs = (chSegs[v.key] ??= []);
      const ns = 2 * chSegN[v.key]++;
      cs[ns] = a;
      cs[ns + 1] = b;
      // 挂通道时已经按同一侧记过；只有同一个块又产又耗这种物品时（selfLoop）两次记的值可能不同，要按这里的先后再记一遍，
      // 否则这里记的和原来的一样，Map 里已有的键再 set 同样的值什么也不变
      if (selfLoop) {
        for (let j = 0; j < v.P.length; j++) sides.get(v.P[j].bid)[sideOf(v.P[j], v.ch)].set(f.itemId, 'out');
        for (let j = 0; j < v.C.length; j++) sides.get(v.C[j].p.bid)[sideOf(v.C[j].p, v.ch)].set(f.itemId, 'in');
        if (g2) for (let j = 0; j < g2.v.C.length; j++) sides.get(g2.v.C[j].p.bid)[sideOf(g2.v.C[j].p, v.ch)].set(f.itemId, 'in');
      }
      if (pending) {
        pending.to = seg.id; // 高架段的 to 先占好位置（-1），这里填上
        if (pending.kind === 'in' && seg.sprayGap === 'legIn') pending.spray = { seg: seg.id, side: 'in' }; // 入口那截高架紧挨段头的 5 格骑喷涂机
        // 同一个通道里前后两段（喷涂时拆开的放料段、取料段，没在地面接成一条）：两段不能同轨——同轨时高架从取料段进口的上空
        // 走过去、再折回来落进进口，会压到自己那格（layout/tracks.js 据此分轨；不喷时一个通道只有一个访问，用不到）
        if (sprayHere && pending.kind === 'link' && segments[pending.from].ch === seg.ch) {
          const from = segments[pending.from];
          (from.noTrackWith ||= []).push(seg.id);
          (seg.noTrackWith ||= []).push(from.id);
        }
      }
      TQ[nq++] = { seg: seg.id };
      pending = null;
      if (g2) i++; // 下一个访问已经并进这一段
      if (i < k - 1) {
        pending = addLeg({ itemId: f.itemId, kind: 'link', from: seg.id, xv: best.cols[i] ?? (g.dout > 0 ? xR + 1 : xL), rate: flow, id: legs.length, cells: [], to: -1 });
        // 竖直那截穿过熔炉、制造台的块（桥）：分层时整段至少在第 bridgeLevel 层（layout/elevation.js）
        if (bridges && best.br[i]) pending.bridge = true;
        if (seg.sprayGap === 'legOut') pending.spray = { seg: seg.id, side: 'out' }; // 这截高架紧挨段尾的 5 格骑喷涂机（elevation.js 的 legWindow）
        TQ[nq++] = { leg: pending.id };
      } else if (outRate > 0) {
        const l = addLeg({ itemId: f.itemId, kind: 'out', from: seg.id, edge: exitCol(g.dout), rate: outRate, id: legs.length, cells: [] });
        TQ[nq++] = { leg: l.id };
      }
    }
    chains.push({ itemId: f.itemId, parts: TQ.slice(0, nq) });
  };

  // 物品按 flex 从小到大排（同一档保持原来的先后，和稳定排序一样）。items、flexOf 只用前 nItems 项
  const CA = list(22);
  const items = list(23);
  const flexOf = list(24);
  let nItems = 0;
  for (const it of graph.items.values()) {
    items[nItems] = it;
    flexOf[nItems++] = flex(it);
  }
  for (let k = 0; k <= 3; k++) {
    for (let t = 0; t < nItems; t++) {
      if (flexOf[t] !== k) continue;
      f = items[t];
      isRaw = f.producer === 'RAW';
      selfLoop = false;
      const fcons = f.consumers;
      for (let j = 0; j < fcons.length; j++) if (fcons[j].to === f.producer) selfLoop = true;
      const prodAll = isRaw ? NO_BLOCKS : blocksOf.get(f.producer);
      // 消费者的块先放在 CA 里：CA 和里面的 {p, d} 各物品共用（只在这一种物品里用，访问、方案里存的是它，段里抄的是它的字段值），逐项重写
      let nCons = 0;
      let outAll = 0;
      for (let j = 0; j < fcons.length; j++) {
        const c = fcons[j];
        if (c.to === 'OUT') {
          outAll += c.rate;
          continue;
        }
        const g = graph.byId.get(c.to);
        const bs = blocksOf.get(c.to);
        for (let i = 0; i < bs.length; i++) {
          const cc = (CA[nCons++] ??= { p: null, d: 0 });
          cc.p = bs[i];
          cc.d = c.rate / g.count;
        }
      }
      if (isRaw || f.rate <= pileCap + TOL) routeFlow(prodAll, CA, nCons, outAll, f.rate);
      else for (const part of splitFlow(prodAll, CA.slice(0, nCons), outAll, f.perFactory)) routeFlow(part.P, part.C, part.C.length, part.out, part.rate);
    }
  }

  Object.assign(c, { beltCap, chains, legs, pileCap, rawCap, segments, sides });
}
