// 每种物品的路线：挂通道（贪心集合覆盖）、定访问顺序和流向、落实成地面段和高架段
import { BELT_SPEED } from '../../gamedata.js';
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

/** route() 的一步：读写共享的布局上下文 c */
export function routeItems(c) {
  const { P, R, addLoad, addPenalty, atPort, bestColumn, blocksOf, entryCol, exitCol, graph, itemBids, opt, pos, rows, side, xL, xR } = c;
  // 喷增产剂（所有原料和中间产物）：走线给每条要进工厂的带留出喷涂机的空当，见 SPRAY_GAP 和下面标 sprayAll 的几处
  const sprayAll = !!opt.sprayAll;
  const legSpray = sprayAll && opt.sprayOnLegs !== false; // 中间产物的喷涂机骑在段尾那截高架上（见 LEG_WINDOW）
  // 实验开关（考卷量上界用，网页不暴露）：opt.sprayGapOff 写 'in' / 'mid'（可用 + 连），那种地面空当不留、喷涂机也不放（配合 routeOptions.allowMissed）
  const gapOff = new Set(String(opt.sprayGapOff ?? '').split(/[+,]/).filter(Boolean));
  const offIn = gapOff.has('in');
  const offMid = gapOff.has('mid');
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

  const chSegs = []; // 通道 -> 已排下的地面段范围 a0, b0, a1, b1, …（两个数一段，估算轨道占用）
  const rowBlocks = [];
  for (const row of rows) {
    const bl = [];
    for (const bid of row) bl.push(pos.get(bid));
    rowBlocks.push(bl);
  }
  /** 第 fr 行里和块 p 横向重叠的块，朝着 p 那一侧（fside）的 sides 表 */
  const near = (p, fr, fside) => {
    const out = [];
    if (fr >= 0 && fr < R) for (const q of rowBlocks[fr]) if (q.x0 <= p.x1 && q.x1 >= p.x0) out.push(sides.get(q.bid)[fside]);
    return out;
  };
  // 每个块两侧的 sides 表，和对面一行里横向重叠的块朝着这边那一侧的表：布局定了就不变，按需各算一次（colDemand 是热点）
  const faceMemo = new Map();
  const faceOf = (p) => {
    let fc = faceMemo.get(p.bid);
    if (fc) return fc;
    const sd = sides.get(p.bid);
    fc = { bottom: sd.bottom, top: sd.top, below: near(p, p.row - 1, 'top'), above: near(p, p.row + 1, 'bottom') };
    faceMemo.set(p.bid, fc);
    return fc;
  };
  /** 块 p 挂到通道 ch 时，这一列附近已经要用的分拣器种数：本侧已接的物品数 + 对面一行重叠块里最多的物品数（fc：faceOf(p)） */
  const colDemand = (p, ch, fc) => {
    const low = ch === p.row;
    const own = (low ? fc.bottom : fc.top).size;
    let face = 0;
    for (const m of low ? fc.below : fc.above) face = Math.max(face, m.size);
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
  const column = (xs, d0, xd, d1, c1, c2, g0min = 1) => {
    let lo = xL;
    let hi = xR + 1;
    if (d0 > 0) lo = Math.max(lo, xs + g0min);
    else if (d0 < 0) hi = Math.min(hi, xs - g0min);
    else return null;
    if (d1 > 0) hi = Math.min(hi, xd - 1);
    else if (d1 < 0) lo = Math.max(lo, xd + 1);
    else return null;
    if (lo > hi) return null;
    if (!(xs + XO >= 0 && xs + XO < XW && xd + XO >= 0 && xd + XO < XW && c1 >= 0 && c1 < CHN && c2 >= 0 && c2 < CHN)) return bestColumn(xs, d0, xd, d1, c1, c2, g0min);
    const key = (((((xs + XO) * XW + xd + XO) * 3 + d0 + 1) * 3 + d1 + 1) * CHN * CHN + c1 * CHN + c2) * 2 + (g0min > 1 ? 1 : 0);
    let r = colMemo.get(key);
    if (r === undefined) colMemo.set(key, (r = bestColumn(xs, d0, xd, d1, c1, c2, g0min)));
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
    const segs = chSegs[k];
    if (!segs) return 0;
    const hi = sHi[k] + 1;
    const lo = sLo[k] - 1;
    for (let j = 0; j < segs.length; j += 2) if (segs[j] <= hi && segs[j + 1] >= lo) load++;
    return load;
  };
  const beltCap = BELT_SPEED[opt.belt] * opt.stack * 60;
  // 物流站输出原料时可以集装（科技解锁后 1~4 层），原料带的运力随之翻倍；成品由分拣器放上带，不集装
  const rawCap = beltCap * Math.max(1, opt.station?.stack ?? opt.externalStack ?? 1);
  // 排物品的顺序：只能走某一个通道的先排，能二选一的后排（让它们去轨道少的那边）；原料入口随时可以多开，最后排
  const flex = (f) => {
    if (f.producer === 'RAW') return 3;
    // 生产者、消费者所在行的跨度：都在同一行时上下两个通道都行（both = 2），跨两行时只有中间那个（1），更远一个也没有（0）
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of blocksOf.get(f.producer)) {
      lo = Math.min(lo, p.row);
      hi = Math.max(hi, p.row);
    }
    for (const c of f.consumers) {
      if (c.to === 'OUT') continue;
      for (const p of blocksOf.get(c.to)) {
        lo = Math.min(lo, p.row);
        hi = Math.max(hi, p.row);
      }
    }
    const both = hi === lo ? 2 : hi - lo === 1 ? 1 : 0;
    return both === 1 ? 0 : both === 0 ? 1 : 2;
  };
  /**
   * 产物流量超过单条带运力（比如 2070/分 的铁块）：按位置把生产者分成几组，每组一条带，
   * 消费者就近挂到还有余量的那一组；成品出口分到有富余的组。
   */
  const splitFlow = (prods, cons, out, per) => {
    const k = Math.ceil((prods.reduce((a, p) => a + p.n * per, 0) - TOL) / beltCap);
    const total = prods.reduce((a, p) => a + p.n * per, 0);
    const bins = [];
    let cur = null;
    for (const p of prods.slice().sort((a, b) => a.row - b.row || a.x0 - b.x0)) {
      const o = p.n * per;
      if (!cur || (cur.P.length && (cur.prod + o > beltCap + TOL || (cur.prod >= total / k - TOL && bins.length < k)))) bins.push((cur = { P: [], C: [], prod: 0, need: 0, out: 0 }));
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
    let left = out;
    for (const b of bins.slice().sort((x, y) => y.prod - y.need - (x.prod - x.need))) {
      b.out = Math.min(left, Math.max(0, b.prod - b.need));
      left -= b.out;
    }
    if (left > TOL) bins[0].out += left;
    return bins.map((b) => ({ P: b.P, C: b.C, out: b.out, rate: b.prod }));
  };

  // 当前这条带：物品 f、是不是原料、送到成品出口的量、带上的流量（产物）。
  // 下面 routeFlow、planChain、commitChain 各物品、各条带共用，读这几个量，不必每种物品重建一遍闭包
  let f = null;
  let isRaw = false;
  let outRate = 0;
  let rate = 0;
  let selfLoop = false; // 这种物品的生产者自己也消耗它（同一个块又产又耗）
  /** 一个访问（挂在通道 ch 上的一组生产者 Ps、消费者 Cs）：取放事件按 Ps、Cs 的先后 */
  const makeVisit = (ch, Ps, Cs) => {
    const e0 = nEv;
    let tmin = Infinity;
    let tmax = -Infinity;
    for (const p of Ps) {
      const tap = p.g.tap ?? 0; // 中间那列（见文件开头）
      for (const x of p.centers) pushEv(x + tap, f.perFactory);
      tmin = Math.min(tmin, p.tmin);
      tmax = Math.max(tmax, p.tmax);
    }
    for (const cc of Cs) {
      const tap = cc.p.g.tap ?? 0;
      for (const x of cc.p.centers) pushEv(x + tap, -cc.d);
      tmin = Math.min(tmin, cc.p.tmin);
      tmax = Math.max(tmax, cc.p.tmax);
    }
    return { ch, key: ch, P: Ps, C: Cs, e0, e1: nEv, s: -1, tmin, tmax, total: 0, cuts: null };
  };
  // 挂通道时第 i 个块（i < nP 是生产者，否则是消费者 cons[i − nP]）的位置和 faceOf：各条带共用，用到多长算多长
  const EB = [];
  const EF = [];
  // 拼数组用的临时数组（访问、生产者、消费者、取放口、链的各部分、方案的各段）：先逐个写进来，再按刚好的长度切出去，免得每个小数组都留出 17 格
  const TV = [];
  const TP = [];
  const TC = [];
  const TT = [];
  const TQ = [];
  const TG = [];
  // 还没挂上的块（下标升序，前 nl 个有效）；这一轮里块 i 挂到下方（2i）、上方（2i + 1）通道时的 colDemand；
  // 这一轮 left 里第 t 个块：0 够不着选中的通道，1 够得着但挂过来会挤爆分拣器列（另一侧还有余地），2 够得着。
  // 临时数组按块数取够长的，这一步里只在块数变多时重取
  let capN = 0;
  let left = null;
  let dem = null;
  let sel = null;

  /** 一条带（一种物品的一组生产者和消费者）：挂通道、定访问顺序和流向、落实成段和高架段 */
  const routeFlow = (prodBlocks, cons, nCons, out, r) => {
    outRate = out;
    rate = r;
    nEv = 0; // 上一条带的访问用完了，事件池从头用
    nSv = 0;
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
        for (let ch = r; ch <= r + 1; ch++) {
          sN[ch]++;
          if (i < nP) sProd[ch]++;
          sLo[ch] = Math.min(sLo[ch], p.tmin);
          sHi[ch] = Math.max(sHi[ch], p.tmax);
        }
        // 这一轮挂上之前 sides 不变，每个块两侧各算一次，下面挑通道、判断挂不挂都用它
        dem[2 * i] = colDemand(p, r, EF[i]);
        dem[2 * i + 1] = colDemand(p, r + 1, EF[i]);
        sCols[r] += Math.max(0, dem[2 * i] + 1 - p.g.colCap);
        sCols[r + 1] += Math.max(0, dem[2 * i + 1] + 1 - p.g.colCap);
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
        if (p.row !== ch && p.row + 1 !== ch) {
          sel[t] = 0;
          continue;
        }
        const low = p.row === ch;
        const other = low ? p.row + 1 : p.row;
        const fit = !((low ? dem[2 * i] : dem[2 * i + 1]) + 1 > p.g.colCap && (low ? dem[2 * i + 1] : dem[2 * i]) + 1 <= p.g.colCap && sN[other]);
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
          for (const x of p.centers) pushEv(x + tap, f.perFactory);
        } else {
          const cc = cons[i - nP];
          TC[nc++] = cc;
          for (const x of p.centers) pushEv(x + tap, -cc.d);
        }
        tmin = Math.min(tmin, p.tmin);
        tmax = Math.max(tmax, p.tmax);
      }
      nl = nl2;
      const v = { ch, key: ch, P: TP.slice(0, np), C: TC.slice(0, nc), e0, e1: nEv, s: -1, tmin, tmax, total: 0, cuts: null };
      // 开喷增产剂时一个访问里不能生产者、消费者交错（喷涂机要在全部放料之后、全部取料之前，
      // 而段内取放的先后由工厂位置定，保证不了）：拆成先 P 后 C 两个访问，中间走一截高架，
      // 喷涂机骑在 P 访问段尾的空当上（见 planChain 里的 SPRAY_GAP）
      if (sprayAll && !isRaw && v.P.length && v.C.length) {
        TV[nv++] = makeVisit(ch, v.P, []);
        TV[nv++] = makeVisit(ch, [], v.C);
      } else TV[nv++] = v;
    }
    const visits = TV.slice(0, nv);

    // 原料：默认每个通道各开一个入口（入口随时可以多开，路线最短、单条带的流量也小）；产物：一条带串起所有通道
    if (!isRaw) {
      commitChain(planChain(visits));
      return;
    }
    // 一个通道里原料需求超过单条带运力时，按位置切成几段，各开一个入口
    const units = [];
    for (const v of visits) {
      let total = 0;
      for (const c of v.C) total += c.d * c.p.n;
      if (total <= rawCap + TOL) {
        v.total = total;
        units.push(v);
        continue;
      }
      let cur = null;
      for (const c of v.C.slice().sort((p, q) => p.p.tmin - q.p.tmin)) {
        const need = c.d * c.p.n;
        if (!cur || cur.total + need > rawCap + TOL) units.push((cur = { ch: v.ch, key: v.key, P: [], C: [], e0: nEv, e1: nEv, s: -1, tmin: undefined, tmax: undefined, total: 0, cuts: null }));
        cur.C.push(c);
        cur.total += need;
        const tap = c.p.g.tap ?? 0; // 中间那列（见文件开头）
        for (const x of c.p.centers) pushEv(x + tap, -c.d);
        cur.e1 = nEv;
      }
    }
    for (const u of units) {
      u.tmin ??= Math.min(...u.C.map((c) => c.p.tmin));
      u.tmax ??= Math.max(...u.C.map((c) => c.p.tmax));
    }
    // 串通道（rawChain > 1）：同一种原料的一条带依次经过相邻的几个通道（合计不超过单条带运力），入口就少了。
    // 串与不串都先试算一遍（入口按 entryWeight 计价），取便宜的那种
    // 试算过的方案：之后没调过 addLoad、colLoad 没变，就和重算的一样，直接用
    const tried = new Map();
    const plan = (vs) => {
      const t = tried.get(vs);
      if (t && t.ver === loadVer) return t.best;
      const best = planChain(vs);
      tried.set(vs, { ver: loadVer, best });
      return best;
    };
    let groups = units.map((u) => [u]);
    if (opt.rawChain > 1 && units.length > 1) {
      const merged = [];
      let g = null;
      let tot = 0;
      for (const u of units.slice().sort((a, b) => a.ch - b.ch || a.tmin - b.tmin)) {
        if (!g || g.length >= opt.rawChain || tot + u.total > rawCap + TOL) {
          merged.push((g = []));
          tot = 0;
        }
        g.push(u);
        tot += u.total;
      }
      if (merged.length < units.length) {
        const price = (gs) => gs.reduce((a, x) => a + plan(x).cost + opt.entryWeight, 0);
        if (price(merged) < price(groups)) groups = merged;
      }
    }
    for (const g of groups) commitChain(plan(g));
  };

  // 2. 访问顺序与每段流向：枚举，取供给缺口最小、带子最短的方案。
  // 下面 segOf、consider 读写 planChain 这一次的状态（planChain 不会重入，各次共用这些变量和临时数组，不必每次重建闭包）
  let vis = null; // 这一次的各个访问
  let capK = 0; // 下面的临时数组够几个访问用
  let vk = 0; // 访问个数
  let gapAt = -1; // 喷涂机的空当留在第几段的段尾（−1：不留）
  // segOf 的结果（见 segOf）：段的两端、空当被站列截短没有、算过没有。
  // 段的两端和下面的进口、出口 x 会写进段对象、传给 bestColumn，用普通数组存（整数仍是小整数，不变成浮点数）
  const GA = [];
  const GB = [];
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
  const mIn = [];
  const mOut = [];
  let mD = null;
  let mDout = null;
  const cols = []; // 当前方案各段之间竖直列的 x
  const lk = [];
  // 目前最好的方案（has 为假时还没有）：找到更好的就照抄过来，最后才建 best
  let has = false;
  let bCost = 0;
  let bShortfall = 0;
  let bBad = 0;
  let bSpray = 0;
  let bGs = null; // 第 0 段是劈开的那一段时就是它
  let bAt = null; // 各段 segOf 的下标（劈开的是 −1）、第几个访问
  let bJ = null;
  const bCols = [];
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
    let gIn = sprayAll && isRaw && i === 0 && !offIn ? SPRAY_GAP : 0;
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
  /** 顺序 ix 下枚举各段流向，逐个和最好的比；split：第 0 段从 m 劈开（和流向无关，mask 第 0 位恒为 0） */
  const consider = (ix, split) => {
    const k = vk;
    const visits = vis;
    const step = split ? 2 : 1;
    let gs = null;
    // 这个顺序下第 i 截高架（第 i、i + 1 段的流向各两种）找到的竖直列：lk[i * 4 + 两段的方向位]，没找过是 undefined
    for (let i = 0; i < 4 * k; i++) lk[i] = undefined;
    if (split) {
      // 劈开：左半 [a, m-1] 向左流，右半 [m, b] 向右流；cont 是继续往下走的那一半，另一半是死胡同
      const v = visits[ix[0]];
      const exit = 0 < k - 1 || outRate > 0;
      let acc = isRaw ? Infinity : 0;
      let worst = 0;
      let len = 0;
      let a = v.tmin;
      let b = v.tmax;
      const { m, cont } = split;
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
      gs = { v, a, b, d: 0, split: m, cont, entryX: null, exitX: dout > 0 ? b : dout < 0 ? a : null, dout, gap: null };
      len += b - a + 1;
      sAcc[0] = acc;
      sWorst[0] = worst;
      sLen[0] = len;
      sShort[0] = 0;
      mAt[0] = -1;
      mCh[0] = v.ch;
      mIn[0] = 0; // 劈开的段没有进口（只有原料带才看进口，原料带不劈）
      mOut[0] = dout ? gs.exitX : 0; // 没有出口时（只有一段、不接成品出口）不看
      mD[0] = 0;
      mDout[0] = dout;
    }
    // 枚举流向时 mask 的低位变得最快，同一个前缀只算一次；每个量的加法先后和逐个方案从头算时一样，结果逐位相同
    for (let i = split ? 1 : 0; i < k; i++) {
      const off = (2 << i) - 2;
      const prev = (1 << i) - 2;
      const low = (1 << i) - 1;
      const v = visits[ix[i]];
      const n = v.e1 - v.e0;
      for (let p = 0; p < 2 << i; p += step) {
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
        const back = (p >> i) & 1;
        const at = segOf(ix[i], i, back);
        // 这一段按流向排好的取放事件（segOf 里排过）
        const es = back ? v.s + n : v.s;
        for (let t = es; t < es + n; t++) {
          acc += SV[t];
          worst = Math.min(worst, acc);
        }
        sh += GH[at] & 1;
        len += GB[at] - GA[at] + 1;
        sAcc[off + p] = acc;
        sWorst[off + p] = worst;
        sLen[off + p] = len;
        sShort[off + p] = sh;
      }
    }
    const top = (1 << k) - 2;
    for (let mask = 0; mask < 1 << k; mask += step) {
      const acc = sAcc[top + mask];
      const worst = sWorst[top + mask];
      let len = sLen[top + mask];
      const sprayShort = sShort[top + mask];
      // 这个方案的各段（前缀里都算过了）
      for (let i = split ? 1 : 0; i < k; i++) {
        const back = (mask >> i) & 1;
        const at = segOf(ix[i], i, back);
        mAt[i] = at;
        mCh[i] = visits[ix[i]].ch;
        mIn[i] = back ? GB[at] : GA[at];
        mOut[i] = back ? GA[at] : GB[at];
        mD[i] = back ? -1 : 1;
        mDout[i] = back ? -1 : 1;
      }
      let bad = 0;
      // 高架段长度（竖直部分按跨过的通道数估）
      const c0 = entryCol(mD[0]);
      if (isRaw && !opt.freeEnds && !atPort(mIn[0], c0)) len += Math.abs(mIn[0] - c0) + 2;
      // 接物流站：原料从左边的主干走廊进来，段要朝右流；成品要朝左流回走廊，否则带子得掉头
      if (side && isRaw && mD[0] !== 1) bad++;
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
          if (side && dl !== -1) outBad++;
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
      rest[k - 1] = 0;
      for (let i = k - 2; i >= 0; i--) {
        if (canJoin && i === gapAt) {
          rest[i] = rest[i + 1] + joinCost;
          continue;
        }
        const bc = lk[i * 4 + ((mask >> i) & 3)];
        const dy = Math.abs(mCh[i] - mCh[i + 1]) * CH_PITCH + 2;
        rest[i] = rest[i + 1] + (bc === undefined ? Math.min(5000, Math.max(2, Math.abs(mIn[i + 1] - mOut[i])) + dy) : bc === null ? 5000 : Math.min(5000, bc.cost + dy));
      }
      let cut = false;
      for (let i = 0; i < k - 1; i++) {
        // 下界剪枝：已经算出的代价加上后面至少还要的，比最好的好不到 TOL（再留 1 格的余量盖住浮点误差）就不再找竖直列，
        // 这个方案按原来的比法也不会被选上
        if (canPrune && has && !(shortfall * 1000 + (bad + outBad) * 5000 + sprayShort * 5000 + len + (outLen >= 0 ? outLen : 0) + rest[i] < bCost - TOL + 1)) {
          cut = true;
          break;
        }
        if (canJoin && i === gapAt) {
          cols[i] = JOIN;
          len += joinCost;
          continue;
        }
        const li = i * 4 + ((mask >> i) & 3);
        let bc = lk[li];
        // 段尾骑喷涂机的那截高架（legSpray 的 gapAt）：竖直列离段尾至少 LEG_WINDOW 格，窗口的 5 格直带才放得下
        if (bc === undefined) bc = lk[li] = column(mOut[i], mDout[i], mIn[i + 1], mD[i + 1], mCh[i], mCh[i + 1], legSpray && i === gapAt ? LEG_WINDOW : 1);
        const x = bc?.x ?? null;
        cols[i] = x;
        if (x === null) bad++;
        else len += bc.cost + Math.abs(mCh[i] - mCh[i + 1]) * CH_PITCH + 2;
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
        bGs = gs;
        for (let i = 0; i < k; i++) {
          bAt[i] = mAt[i];
          bJ[i] = ix[i];
        }
        for (let i = 0; i < k - 1; i++) bCols[i] = cols[i];
      }
    }
  };
  /** 劈开第一段的位置：生产者分拣器所在的各列（去重、从小到大），去掉最左一列；每个访问只算一次 */
  const cutsOf = (v) => {
    if (v.cuts) return v.cuts;
    const xs = [];
    for (const p of v.P) {
      const tap = p.g.tap ?? 0; // 中间那列（见文件开头）
      for (const x of p.centers) xs.push(x + tap);
    }
    xs.sort((p, q) => p - q);
    const cuts = [];
    for (let i = 1; i < xs.length; i++) if (xs[i] !== xs[i - 1] && xs[i] !== xs[0]) cuts.push(xs[i]);
    return (v.cuts = cuts);
  };
  /** 访问多于 4 个时不全排列，只试两种：有生产者的在前，按通道号从小到大或从大到小 */
  const bigOrders = (visits) => {
    const byCh = (dir) => (a, b) => (b.P.length > 0) - (a.P.length > 0) || dir * (a.ch - b.ch);
    return [byCh(1), byCh(-1)].map((cmp) => visits.map((_, i) => i).sort((i, j) => cmp(visits[i], visits[j])));
  };
  const planChain = (visits) => {
    const k = visits.length;
    let flow = rate;
    if (isRaw) {
      flow = 0;
      for (const v of visits) {
        let t = 0;
        for (let e = v.e0; e < v.e1; e++) t += EV[e];
        flow -= t;
      }
    }
    // 顺序用访问的下标表示（和直接排列访问一一对应、先后相同）
    const orders = k <= 4 ? permIdx(k) : bigOrders(visits);
    // 喷增产剂：生产的访问都要排在消费的访问之前（喷涂机放在两者之间才能喷到全部的料），
    // 空当留在最后一个生产访问（第 nP−1 个）的段尾；原料带的空当留在入口那头
    let nP = 0;
    let anyC = false;
    for (const v of visits) {
      if (v.P.length) nP++;
      if (v.C.length) anyC = true;
    }
    vis = visits;
    vk = k;
    gapAt = sprayAll && !isRaw && anyC ? nP - 1 : -1;
    has = false;
    bGs = null;
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
    }
    GD.fill(0, 0, 2 * k * k);
    for (const ix of orders) {
      if (!isRaw && !visits[ix[0]].P.length) continue;
      if (gapAt >= 0) {
        let ok = true;
        for (let i = 0; i < k; i++) if ((visits[ix[i]].P.length > 0) !== i < nP) ok = false;
        if (!ok) continue;
      }
      consider(ix, null);
    }
    // 喷增产剂时不劈段：先 P 后 C 的顺序下供给缺口恒为 0，用不上；劈开的死胡同那一半也没法喷
    if (!sprayAll && !isRaw && has && bShortfall > TOL) {
      // 两个方向都不够时，试试把第一段从生产者中间劈开、两半背向而流
      for (const ix of orders) {
        const v0 = visits[ix[0]];
        if (!v0.P.length) continue;
        const cuts = cutsOf(v0);
        const conts = k > 1 || outRate > 0 ? ['L', 'R'] : [null];
        for (const m of cuts) {
          for (const cont of conts) consider(ix, { m, cont });
        }
      }
    }
    if (!has) return null;
    // 最好的方案的各段：劈开的那段就是 consider 里建的，其余照 segOf 的结果建出来
    for (let i = 0; i < k; i++) {
      const at = bAt[i];
      if (at < 0) {
        TG[i] = bGs;
        continue;
      }
      const d = at & 1 ? -1 : 1;
      const a = GA[at];
      const b = GB[at];
      // gap：喷涂机的空当在哪头；'mid' 是这一段和下一个访问在地面接成一条（bCols 里是 JOIN），空当在中间
      TG[i] = { v: visits[bJ[i]], a, b, d, split: null, cont: null, entryX: d > 0 ? a : b, exitX: d > 0 ? b : a, dout: d, gap: sprayAll && isRaw && i === 0 ? (offIn ? null : GH[at] & 2 ? 'legIn' : GH[at] & 4 ? 'edgeIn' : 'in') : i === gapAt ? (bCols[i] === JOIN ? (offMid ? 'join' : 'mid') : 'out') : null };
    }
    return { cost: bCost, shortfall: bShortfall, bad: bBad, sprayShort: bSpray, geo: TG.slice(0, k), cols: bCols.slice(0, k - 1), flow };
  };
  /** 把方案落实：记惩罚、加地面段和高架段 */
  const commitChain = (best) => {
    const flow = best.flow;
    if (best.shortfall > TOL) addPenalty('shortfall', P.shortfall, `${f.name} 带上供给顺序不足 ${best.shortfall.toFixed(1)}/分`, itemBids(f.itemId));
    if (best.bad) addPenalty('route', P.route * best.bad, `${f.name} 找不到能竖直穿过的空列`, itemBids(f.itemId));
    if (best.sprayShort) addPenalty('spray', P.spray * best.sprayShort, `${f.name} 的带子贴着站列，留不出喷涂机的直带空当`, itemBids(f.itemId));

    // 3. 落实：地面段、高架段、出入口
    const geo = best.geo;
    for (let i = 0; i < best.cols.length; i++) if (typeof best.cols[i] === 'number') addLoadM(best.cols[i], geo[i].v.ch, geo[i + 1].v.ch);
    let nq = 0; // 链的各部分先放在 TQ 里
    let pending = null; // 等待接到下一段的高架段
    if (isRaw) {
      const g0 = geo[0];
      pending = addLeg({ itemId: f.itemId, kind: 'in', edge: entryCol(g0.d), rate: flow, id: legs.length, cells: [], to: -1 });
      TQ[nq++] = { leg: pending.id };
    }
    for (let i = 0; i < geo.length; i++) {
      const g = geo[i];
      const v = g.v;
      // 喷涂时在地面接成一条的放料段 + 取料段（gap 'mid'）：和下一个访问合成一段，取放口先放后取，空当在最后一个放料口（gapX）下游
      const g2 = g.gap === 'mid' || g.gap === 'join' ? geo[i + 1] : null; // 'join'：实验开关 offMid 下接成一条但不留空当
      let nt = 0;
      for (const p of v.P) TT[nt++] = { bid: p.bid, io: 'out', rate: f.perFactory };
      for (const c of v.C) TT[nt++] = { bid: c.p.bid, io: 'in', rate: c.d };
      if (g2) for (const c of g2.v.C) TT[nt++] = { bid: c.p.bid, io: 'in', rate: c.d };
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
      (chSegs[v.key] ||= []).push(a, b);
      // 挂通道时已经按同一侧记过；只有同一个块又产又耗这种物品时（selfLoop）两次记的值可能不同，要按这里的先后再记一遍，
      // 否则这里记的和原来的一样，Map 里已有的键再 set 同样的值什么也不变
      if (selfLoop) {
        for (const p of v.P) sides.get(p.bid)[sideOf(p, v.ch)].set(f.itemId, 'out');
        for (const c of v.C) sides.get(c.p.bid)[sideOf(c.p, v.ch)].set(f.itemId, 'in');
        if (g2) for (const c of g2.v.C) sides.get(c.p.bid)[sideOf(c.p, v.ch)].set(f.itemId, 'in');
      }
      if (pending) {
        pending.to = seg.id; // 高架段的 to 先占好位置（-1），这里填上
        if (pending.kind === 'in' && seg.sprayGap === 'legIn') pending.spray = { seg: seg.id, side: 'in' }; // 入口那截高架紧挨段头的 5 格骑喷涂机
        // 同一个通道里前后两段（喷涂时拆开的放料段、取料段，没在地面接成一条）：两段不能同轨——同轨时高架从取料段进口的上空
        // 走过去、再折回来落进进口，会压到自己那格（layout/tracks.js 据此分轨；不喷时一个通道只有一个访问，用不到）
        if (sprayAll && pending.kind === 'link' && segments[pending.from].ch === seg.ch) {
          const from = segments[pending.from];
          (from.noTrackWith ||= []).push(seg.id);
          (seg.noTrackWith ||= []).push(from.id);
        }
      }
      TQ[nq++] = { seg: seg.id };
      pending = null;
      if (g2) i++; // 下一个访问已经并进这一段
      if (i < geo.length - 1) {
        pending = addLeg({ itemId: f.itemId, kind: 'link', from: seg.id, xv: best.cols[i] ?? (g.dout > 0 ? xR + 1 : xL), rate: flow, id: legs.length, cells: [], to: -1 });
        if (seg.sprayGap === 'legOut') pending.spray = { seg: seg.id, side: 'out' }; // 这截高架紧挨段尾的 5 格骑喷涂机（elevation.js 的 legWindow）
        TQ[nq++] = { leg: pending.id };
      } else if (outRate > 0) {
        const l = addLeg({ itemId: f.itemId, kind: 'out', from: seg.id, edge: exitCol(g.dout), rate: outRate, id: legs.length, cells: [] });
        TQ[nq++] = { leg: l.id };
      }
    }
    chains.push({ itemId: f.itemId, parts: TQ.slice(0, nq) });
  };

  // 物品按 flex 从小到大排（同一档保持原来的先后，和稳定排序一样）
  const CA = [];
  const items = [];
  const flexOf = [];
  for (const it of graph.items.values()) {
    items.push(it);
    flexOf.push(flex(it));
  }
  for (let k = 0; k <= 3; k++) {
    for (let t = 0; t < items.length; t++) {
      if (flexOf[t] !== k) continue;
      f = items[t];
      isRaw = f.producer === 'RAW';
      selfLoop = false;
      for (const c of f.consumers) if (c.to === f.producer) selfLoop = true;
      const prodAll = isRaw ? [] : blocksOf.get(f.producer);
      let nCons = 0; // 消费者的块先放在 CA 里（各物品共用）
      let outAll = 0;
      for (const c of f.consumers) {
        if (c.to === 'OUT') {
          outAll += c.rate;
          continue;
        }
        const g = graph.byId.get(c.to);
        for (const p of blocksOf.get(c.to)) CA[nCons++] = { p, d: c.rate / g.count };
      }
      if (isRaw || f.rate <= beltCap + TOL) routeFlow(prodAll, CA, nCons, outAll, f.rate);
      else for (const part of splitFlow(prodAll, CA.slice(0, nCons), outAll, f.perFactory)) routeFlow(part.P, part.C, part.C.length, part.out, part.rate);
    }
  }

  Object.assign(c, { beltCap, chains, legs, rawCap, segments, sides });
}
