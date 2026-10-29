// 排版内核（分支 explore/typeset，2026/10/13：用户要「核心不同于 master」的探索）。
//
// master 的搜索把配方组拆成块、在行里搬来搬去，各行长短不齐：行尾参差是空地的大头（引力矩阵 30 / 60 约 12%，tools/waste.js），
// 云上 64 次细搜最好 82%。这里换一个搜索状态：所有配方组排成一条队 seq，加一个行宽 W；布局由队「排版」出来——
// 像排文字一样从左往右铺，铺满一行就换行，组在行尾可以断开（像断字）。断在哪儿用动态规划求全局最好（Knuth–Plass 断行：
// 每行空出来的列数平方和 + 每断开一个组的罚分，合计最小），所以每行都差不多满，长宽比由 W 定（先定边界）。
// 奇数行反过来铺（蛇形）：断开的组两段上下挨着。搜索只改队的顺序和行宽，走线、打分、出蓝图、检查照旧用 master 的。
// 初始顺序用谱排序：按组之间的物品流建图，拉普拉斯矩阵第二小特征值的特征向量（Fiedler 向量）给每组一个坐标，上下游挨得近。
import { layers } from './graph.js';
import { BELT_SPEED } from '../gamedata.js';
import { DEFAULTS, STATION_SLOTS } from './route.js';

/** 断开一个组（一组分到两行）的罚分，和「一行空 4 列」相当 */
const SPLIT_COST = 16;

/**
 * 每组一块最多几台（运力断块）：同一块的产物只上一条带、每种吃料也只从一条带取（layout/belts.js），
 * 块的流量超过一条带的运力就记「超运力」。前沿大线一行几百列，整行同组的一段常常超（引力矩阵 180 的铁块 45 台 × 60/分）。
 * 排版时一行里同组的一段超过这个台数就在行内切成几块（台数尽量平均），各挂各的带
 */
export function blockCaps(graph, ro = {}) {
  const beltCap = BELT_SPEED[ro.belt ?? DEFAULTS.belt] * (ro.stack ?? DEFAULTS.stack) * 60;
  const rawCap = beltCap * Math.max(1, ro.station?.stack ?? ro.externalStack ?? DEFAULTS.externalStack);
  const caps = new Map();
  for (const g of graph.groups) {
    let n = Infinity;
    for (const o of g.outputs) if (o.perFactory > 0) n = Math.min(n, beltCap / o.perFactory);
    for (const it of graph.items.values())
      for (const c of it.consumers) if (c.to === g.id && c.rate > 0) n = Math.min(n, (it.producer === 'RAW' ? rawCap : beltCap) / (c.rate / g.count));
    caps.set(g.id, Math.max(1, Math.floor(n + 1e-9)));
  }
  caps.beltCap = beltCap; // 分身单元按带切（unitsOf）要用
  return caps;
}

/**
 * 分身单元：一组的台数超过一块的运力（caps）时拆成 k = ⌈台数 ÷ 一块最多几台⌉ 个单元（台数平均），队里各占一个位置、各自挪。
 * 要几条带的物品（黄棒 30 的磁铁 1920/分 = 2 条）分成几份生产单元，消费它的组（磁线圈）也一样拆开，退火能把一份生产、一份消费
 * 排在一起，两条带各走各的；不拆时同组几块挤在同一行，几条带并排走同一个通道（超轨、分拣器太慢、按块分带时供给顺序差几百）。
 * 没给 caps 或不超的组只有一个单元，单元 ID 就是组 ID（排版逐字不变）；多个单元的 ID 是 组ID#序号。同一个 caps 只算一次
 */
const UNITS = new WeakMap();
export function unitsOf(graph, caps = null) {
  const key = caps ?? graph;
  const hit = UNITS.get(key);
  if (hit?.graph === graph) return hit;
  // 按带对齐的切点（每组在第几台前切开）：要几条带的中间产物（k 条，每条 F ÷ k），消费者按出现的先后依次把带装满，
  // 跨过一条带的边界就在那台前切开；生产者每满一条带切一刀。这样每条带的消费正好凑成 F ÷ k（引力矩阵 360 的铁块 3 条 × 1800：
  // 电动机切成 16 / 40 / 8 台，720 + 360 + 720、1800、360 + 1440）；不切时按块分带要凑整，凑不齐就差几百（引力矩阵 360 塔差 360/分）。
  // 切点之间的每段再按运力平均切
  const cuts = new Map(graph.groups.map((g) => [g.id, new Set()]));
  const beltCap = caps?.beltCap;
  if (beltCap)
    for (const it of graph.items.values()) {
      if (it.producer === 'RAW' || !(it.rate > beltCap + 1e-6)) continue;
      const k = Math.ceil(it.rate / beltCap - 1e-9);
      const bin = it.rate / k;
      // 生产者每满一条带切一刀，各条带实际的流量累计到 edges，消费者按 edges 切（黄棒 30 的铁块 1230/分一条带，21 / 20 / 21 台）。
      // 切在第几台：等分点前后 4 台里，挑累计流量正好落在消费者整台边界上的（差最小；一样时离等分点近、台数少的）——
      // 引力矩阵 180 的铁块等分是 22.5 台，四舍五入 23 台（1380/分）时消费者凑不出（电动机 45/分一台），21 台（1260）正好
      const pg = graph.byId.get(it.producer);
      const p = it.perFactory;
      const consumerGap = (edge) => {
        let T = 0;
        for (const c of it.consumers) {
          if (c.to !== 'OUT' && c.rate > 0 && edge > T + 1e-6 && edge < T + c.rate - 1e-6) {
            const d = c.rate / graph.byId.get(c.to).count;
            const x = (edge - T) / d;
            return Math.abs(x - Math.round(x)) * d;
          }
          T += c.rate;
        }
        return 0;
      };
      const edges = [];
      let lastN = 0;
      for (let j = 1; j < k; j++) {
        const eq = (j * bin) / p;
        let pick = -1;
        let pickGap = Infinity;
        for (let n = Math.max(lastN + 1, Math.floor(eq) - 4); n <= Math.min(pg.count - 1, Math.ceil(eq) + 4); n++) {
          if ((n - lastN) * p > beltCap + 1e-6) continue;
          const gp = consumerGap(n * p);
          if (gp < pickGap - 1e-6 || (Math.abs(gp - pickGap) <= 1e-6 && Math.abs(n - eq) < Math.abs(pick - eq) - 1e-9)) {
            pick = n;
            pickGap = gp;
          }
        }
        if (pick < 0) pick = Math.round(eq);
        if (pick > lastN && pick < pg.count) {
          cuts.get(pg.id).add(pick);
          edges.push(pick * p);
          lastN = pick;
        }
      }
      let T = 0;
      for (const c of it.consumers) {
        if (c.to !== 'OUT' && c.rate > 0) {
          const g = graph.byId.get(c.to);
          const d = c.rate / g.count;
          for (const b of edges) {
            if (b <= T + 1e-6 || b >= T + c.rate - 1e-6) continue;
            const n = Math.round((b - T) / d);
            if (n > 0 && n < g.count) cuts.get(g.id).add(n);
          }
        }
        T += c.rate;
      }
    }
  const byId = new Map();
  const of = new Map();
  for (const g of graph.groups) {
    const cap = caps?.get(g.id) ?? Infinity;
    const sizes = [];
    let prev = 0;
    for (const c of [...[...cuts.get(g.id)].sort((a, b) => a - b), g.count]) {
      const m = c - prev;
      const k = Math.max(1, Math.ceil(m / cap));
      for (let i = 0; i < k; i++) sizes.push(Math.floor(m / k) + (i < m % k ? 1 : 0));
      prev = c;
    }
    const ids = sizes.map((count, i) => {
      const id = sizes.length === 1 ? g.id : `${g.id}#${i}`;
      byId.set(id, { id, gid: g.id, g, count });
      return id;
    });
    of.set(g.id, ids);
  }
  const u = { graph, byId, of, expand: (gids) => gids.flatMap((gid) => of.get(gid)) };
  UNITS.set(key, u);
  return u;
}

/**
 * 边缘放站时大概要几座站（给站位的初始解定个数）：进出站的物品（原料和送出的产物）每座最多 STATION_SLOTS 种、12 条带，
 * 留空格（喷增产剂、翘曲器）各占一种。只是估个数，站位多了少了退火自己加减
 */
export function stationEstimate(graph, ro = {}) {
  const beltCap = BELT_SPEED[ro.belt ?? DEFAULTS.belt] * (ro.stack ?? DEFAULTS.stack) * 60;
  const rawCap = beltCap * Math.max(1, ro.externalStack ?? DEFAULTS.externalStack);
  let items = (ro.stationSlots?.keepFree ? 1 : 0) + (ro.stationSlots?.warper ? 1 : 0);
  let belts = 0;
  for (const it of graph.items.values()) {
    const rate = it.producer === 'RAW' ? it.rate : it.consumers.reduce((a, c) => a + (c.to === 'OUT' ? c.rate : 0), 0);
    if (!(rate > 0)) continue;
    items++;
    belts += Math.ceil(rate / (it.producer === 'RAW' ? rawCap : beltCap) - 1e-9);
  }
  return Math.max(1, Math.ceil(items / STATION_SLOTS), Math.ceil(belts / 12));
}

/** 组之间的边权：有一股流就算 1，流量大的略多（一条极速带 1800/分） */
function adjacency(graph) {
  const ids = graph.groups.map((g) => g.id);
  const at = new Map(ids.map((id, i) => [id, i]));
  const n = ids.length;
  const A = Array.from({ length: n }, () => new Float64Array(n));
  for (const f of graph.items.values()) {
    if (f.producer === 'RAW' || !at.has(f.producer)) continue;
    const i = at.get(f.producer);
    for (const c of f.consumers) {
      if (!at.has(c.to)) continue;
      const j = at.get(c.to);
      if (i === j) continue;
      const w = 1 + c.rate / 1800;
      A[i][j] += w;
      A[j][i] += w;
    }
  }
  return { ids, A };
}

/** 对称矩阵的特征分解（循环 Jacobi 旋转）。返回特征值和特征向量（vectors[k][i]：第 i 个特征向量的第 k 个分量） */
export function jacobiEigen(M) {
  const n = M.length;
  const a = M.map((r) => Float64Array.from(r));
  const V = Array.from({ length: n }, (_, i) => {
    const r = new Float64Array(n);
    r[i] = 1;
    return r;
  });
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q];
    if (off < 1e-20) break;
    for (let p = 0; p < n; p++)
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-14) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k][p];
          const vkq = V[k][q];
          V[k][p] = c * vkp - s * vkq;
          V[k][q] = s * vkp + c * vkq;
        }
      }
  }
  return { values: a.map((r, i) => r[i]), vectors: V };
}

/** 生产图拉普拉斯矩阵的特征分解（按特征值从小到大的下标），同一张图只算一次 */
const EIGEN = new WeakMap();
function laplacianEigen(graph) {
  if (EIGEN.has(graph)) return EIGEN.get(graph);
  const { ids, A } = adjacency(graph);
  const Lap = A.map((row, i) => {
    const r = Float64Array.from(row, (v) => -v);
    r[i] = row.reduce((s, v) => s + v, 0);
    return r;
  });
  const { values, vectors } = jacobiEigen(Lap);
  const idx = values.map((v, i) => i).sort((x, y) => values[x] - values[y]);
  const e = { ids, vectors, idx };
  EIGEN.set(graph, e);
  return e;
}

/** 谱排序：组按 Fiedler 向量的分量从小到大（一样大按层、再按原来的先后） */
export function spectralOrder(graph) {
  const n = graph.groups.length;
  if (n <= 2) return graph.groups.map((g) => g.id);
  const { ids, vectors, idx } = laplacianEigen(graph);
  const f = idx[1];
  const L = layers(graph);
  return ids
    .map((id, i) => ({ id, v: vectors[i][f], l: L.get(id), i }))
    .sort((x, y) => x.v - y.v || x.l - y.l || x.i - y.i)
    .map((x) => x.id);
}

/**
 * 二维谱排序（蛇形读出）：一维的谱排序只管队里前后挨着（同一行左右相邻），蛇形排出来上下两行同一列的组在队里隔得远，
 * 上下游能不能上下挨着全凭运气。这里用第 2、3 小特征值的特征向量给每组一个平面坐标：第 2 个按组宽累计切成 R 条带（一条带约一行），
 * 带里按第 3 个从小到大、奇数带反过来（蛇形），连起来就是队。排版时每条带大致落在一行，平面上挨着的组上下左右都挨着
 */
export function spectralSnake(graph, R) {
  const n = graph.groups.length;
  if (n <= 3 || R <= 1) return spectralOrder(graph);
  const { ids, vectors, idx } = laplacianEigen(graph);
  const [f, h] = [idx[1], idx[2]];
  const L = layers(graph);
  const pts = ids.map((id, i) => ({ id, u: vectors[i][f], v: vectors[i][h], l: L.get(id), i, w: graph.byId.get(id).width }));
  pts.sort((x, y) => x.u - y.u || x.l - y.l || x.i - y.i);
  const total = pts.reduce((a, p) => a + p.w, 0);
  const bands = Array.from({ length: R }, () => []);
  let acc = 0;
  for (const p of pts) {
    bands[Math.min(R - 1, Math.floor(((acc + p.w / 2) * R) / total))].push(p);
    acc += p.w;
  }
  const seq = [];
  bands.forEach((b, k) => {
    b.sort((x, y) => x.v - y.v || x.i - y.i);
    if (k % 2) b.reverse();
    for (const p of b) seq.push(p.id);
  });
  return seq;
}

/** 按层排序（和 master 的折行初始解一样：最长路径分层，同层按原来的先后） */
export function layeredOrder(graph) {
  const L = layers(graph);
  return graph.groups
    .slice()
    .sort((a, b) => L.get(a.id) - L.get(b.id))
    .map((g) => g.id);
}

/**
 * 供电缝（电力感应塔时才有）：熔炉、化工厂、对撞机、研究站一台挨一台排时中间没有空列（制造台间距 4、本体 3，自带一列），
 * 长长一段排满，旁边通道又铺满了带，电塔没处放（引力矩阵 180 塔：41 处够不着电）。打开供电缝的组，行里每 G 台留 1 列空列，
 * 和相邻的块之间也留 1 列，塔放在缝里。G 取最大的「每台中心离两边的缝都不超过 6 格」（塔覆盖 7.96 格，留出分拣器上下的余量）：
 * 熔炉 4、化工厂 2、对撞机 2、研究站 2。自带空列的组返回 0（不用缝）
 */
export function gapChunk(g) {
  if (g.pitch > g.bodyWidth) return 0;
  let best = 1;
  for (let G = 1; G <= 64; G++) {
    let worst = 0;
    for (let i = 0; i < G; i++) {
      const c = g.center + i * g.pitch;
      worst = Math.max(worst, Math.min(c + 1, G * g.pitch + g.trailing - c));
    }
    if (worst > 6) break;
    best = G;
  }
  return best;
}

/** 站位（边缘放站时才有）：一个站位让第 r、r+1 两行在右端（left 时在左端）空出 BAY 列，给 7×7 的物流站（站离工厂至少隔 1 格） */
export const BAY = 8;

/**
 * 排版：seq 依次铺开（第 k 组 count 台、每台占 pitch 列，每段末尾多 trailing 列），每行宽不超过它的目标宽度，
 * 动态规划挑断行的位置：每行空出来的列数平方和 + 每断开一个组 SPLIT_COST，合计最小（只有一台都放不下时那一行照放）。
 * 目标宽度一般是 W；bays（站位，[{ r, left }]）盖到的行少 BAY 列，左端的站位再给那行最左一块加 BAY 列空列。
 * 返回 { rows, blocks, pads }：奇数行反过来铺（蛇形），奇数行最左那块右移半个工厂（上下两行的分拣器一开始就错开，同 master 的折行）。
 * prevDp：上一次断行的 dp（typeset 返回的，它记着自己是哪条队、行宽、站位、供电缝算的），有就给增量断行当缓存（dpCache）
 */
export function typeset(graph, seq, W, caps = null, bays = null, gaps = null, prevDp = null) {
  const I = seqInfo(graph, seq, caps, gaps);
  const cache = dpCache(I, W, bays, gaps, seq, prevDp);
  const { cuts, cost, prev: back, S } = breakRows(I, W, bays, cache);
  // dp：断行动态规划的数组（cost / prev）和它的规格，给下一步增量断行当缓存（dpCache / breakRows）。
  // cost / prev / N / S 可枚举：排版等价时（同一 seq、W、站位、供电缝）它们逐字一样，deepEqual 照样成立
  // （test/typeset.test.js 比 gaps=[] 和没 gaps）。缓存校验用的 W / bays / gaps 和算它的队 seq 设成不可枚举：deepEqual 不看、
  // keep() 不抄、stateMemo.key() 不读；可枚举才能跟着邻域里的 `...typeset(...)` 展开传下去
  const dp = { cost, prev: back, N: I.N, S };
  Object.defineProperties(dp, { W: { value: W }, bays: { value: bays }, gaps: { value: gaps }, seq: { value: seq } });
  return { ...buildRows(graph, I, cuts, bays, gaps), cuts, dp };
}

/**
 * 增量断行能不能抄前缀：全局动作（换两组、挪一组、反转一段、相邻对调）只改队 seq，改动点之前的单元一字不变，
 * 所以机器序 grp[0..P0) 不变（P0 = 第一个变了的单元 m 的起始台号 start[m]）。dp：上一次断行的 dp，拿它记着的队 dp.seq 比
 * （局部重排出来的状态带的是祖先的 dp，比的就是祖先的队；队都不原地改，见 typesetNeighbor）。
 * 只有行宽 W、站位 bays、供电缝 gaps 都没变（dp 记的和这次同引用——全局动作传的就是 st.bays / st.gaps 原引用，
 * 站位、供电缝动作新建了数组自然不同引用）、台数一致时才抄；返回 { cost, prev, P0 } 或 null（不满足从头算）。
 * 宽度动作改了 W → 不同引用 → null，照旧从头算
 */
function dpCache(I, W, bays, gaps, seq, dp) {
  if (!dp || dp.W !== W || dp.bays !== bays || dp.gaps !== gaps || dp.N !== I.N) return null;
  const a = dp.seq;
  const L = Math.min(a.length, seq.length);
  let m = 0;
  while (m < L && a[m] === seq[m]) m++;
  const P0 = m < I.start.length ? I.start[m] : I.N;
  return P0 > 0 ? { cost: dp.cost, prev: dp.prev, P0 } : null;
}

/**
 * 排版的准备：队里各单元（us，台数是单元的）、几何（gs，组的）、一块最多几台（cap）、开没开缝（gap）、各单元从第几台起（start）、每台属于第几个单元（grp）；
 * 断行扫描用的按单元下标的几何（pitch、trail、chunk）、各单元止于第几台（stop）和能不能倒数计数（steady），见 scanRow
 */
function seqInfo(graph, seq, caps, gaps) {
  // 队里是分身单元（unitsOf）：us[k] 的台数是单元的，几何（gs[k]）是组的
  const units = unitsOf(graph, caps);
  const us = seq.map((id) => units.byId.get(id));
  const gs = us.map((u) => u.g);
  // 一块最多几台：运力（caps）和供电缝（gaps 里的组每 G 台一块，块之间留 1 列）取小的
  const gap = gs.map((g) => (gaps?.includes(g.id) ? gapChunk(g) > 0 : false));
  const cap = gs.map((g, k) => Math.min(caps?.get(g.id) ?? Infinity, gap[k] ? gapChunk(g) : Infinity));
  // 断行扫描每台都要读的几何先按单元下标抄成数组（值就是原来每台现算的那几个式子，不取整），扫描里不再读 gs[k].pitch 这些属性。
  // chunk：行内另起一块时加的列数（trailing + 开缝的 1 列）。用 new Array 逐个填、不用 map：用 map 时断行的循环反复因 wrong map
  // 去优化（实测几百次，推断是 map 造出的数组元素种类不固定），这样和改前一样只有十几次；换成 Float64Array 实测更慢
  const n = gs.length;
  const pitch = new Array(n);
  const trail = new Array(n);
  const chunk = new Array(n);
  for (let k = 0; k < n; k++) {
    pitch[k] = gs[k].pitch;
    trail[k] = gs[k].trailing;
    chunk[k] = gs[k].trailing + (gap[k] ? 1 : 0);
  }
  // 倒数计数（scanRow / breakRows 代替每台一次 run % cap[k]）只在 cap 都是正整数（安全整数内，减一是精确的）或 +Infinity 时和取模逐字一致：
  // blockCaps 给的是 Math.max(1, Math.floor(·))、gapChunk 是 1~64、都不限时是 Infinity，正常就这两种；有别的值照旧取模
  const steady = cap.every((c) => c === Infinity || (Number.isSafeInteger(c) && c >= 1));
  const start = [];
  let N = 0;
  for (const u of us) {
    start.push(N);
    N += u.count;
  }
  const grp = new Int32Array(N);
  const stop = new Int32Array(us.length); // 第 k 个单元止于第几台（不含），breakRows 按单元扫
  for (let k = 0; k < us.length; k++) {
    grp.fill(k, start[k], start[k] + us[k].count);
    stop[k] = start[k] + us[k].count;
  }
  return { us, gs, gap, cap, start, stop, N, grp, pitch, trail, chunk, steady };
}

/** 第 r 行的目标宽度：站位盖到的行每个站位少 BAY 列 */
const rowTarget = (W, bays, r) => {
  let w = W;
  if (bays) for (const b of bays) if (r === b.r || r === b.r + 1) w -= BAY;
  return w;
};

/**
 * 从第 p 台起铺一行（目标宽 Wt），逐台调 visit(q, slack)（这一行铺到第 q 台为止），宽度规则见 typeset 的说明：
 * 换组加 trailing、开缝的组和邻块之间加 1 列、超过一块的运力或缝距行内另起一块。一台都放不下时只报那一台。
 * breakRows 为省掉每台一次闭包把这段扫描内联了进去（按单元分了两层，见那里），两处的宽度算法必须一致，改一处要同步改另一处；breakWindow 还在调这里。
 * 行内另起一块原来是 run % cap[k] === 0（run：这组在这一行已经排了几台，换组时归 0），每台一次取模。
 * steady（cap 都是正整数或 +Infinity）时改成倒数计数 left：换组时置成 cap[k]，同组每台先减一，减到 0 就另起一块、
 * 再置回 cap[k]。同组第 i 台（i ≥ 1，第 0 台走换组）减到 0 正好是 i = cap、2cap…，就是 i % cap === 0；cap = Infinity 时
 * Infinity − 1 还是 Infinity，永远不到 0，原来 i % Infinity = i 也只在 i = 0 时为 0（那台走的是换组），所以两边都从不另起
 */
function scanRow(I, p, end, Wt, visit) {
  const { pitch, trail, chunk, gap, cap, grp, steady } = I;
  let width = 0;
  let last = -1;
  let run = 0; // 这一行里当前这组已经排了几台（取模那条路用）
  let left = 0; // 倒数计数：当前这组再排几台就另起一块（steady 时用）
  for (let q = p + 1; q <= end; q++) {
    const k = grp[q - 1];
    width += pitch[k];
    if (k !== last) {
      width += trail[k] + (last >= 0 && (gap[k] || gap[last]) ? 1 : 0); // 供电缝：开缝的组和邻块之间留 1 列
      last = k;
      run = 0;
      left = cap[k];
    } else if (steady ? --left === 0 : run % cap[k] === 0) {
      width += chunk[k]; // 超过一块的运力或缝距：行内另起一块
      left = cap[k];
    }
    run++;
    if (width > Wt && q > p + 1) break;
    visit(q, Math.max(0, Wt - width));
    if (width > Wt) break;
  }
}

/**
 * 全局断行（动态规划）：返回每行的 [起, 止) 台号，连同 dp 的 cost / prev / S（给下一步当增量缓存）。
 * cache（dpCache 给的 { cost, prev, P0 } 或 null）：P0 之前的机器序没变 → cost / prev 对 q ≤ P0 和上次逐字一样，直接抄；
 * q > P0 重算。外层循环不从 p = 0 起，从 p_start 起：p < p_start 的那一行连 P0 都够不到，松弛不到 q > P0。
 * p_start = 最小的 p 使 width(p..P0) ≤ W——这里从 P0 往前累加 pitch（真宽度的下界，少算 trailing / 缝只会让 p_start 更小、
 * 多算几个 p，结果不变）一超过 W 就停。进入 q ≤ P0 的松弛重算出和缓存一样的值，严格小于不覆盖、prev 不变；进入 q > P0 的
 * 来自和原来同样的一批 p、同样的先后，所以 cost / prev 逐字一样，回溯出的 cuts 一样。scanRow 的扫描在这里内联（省掉每台一次闭包），
 * 用的是倒数计数（见 scanRow）；cap 不是 steady 时照旧调 scanRow 走取模。内联里只把不变的量提出来：几何读 I 的数组、
 * 同一单元的 pitch / cap 和止于第几台提到单元外、prev 要记的 p·S + r 提到行外、at = q·S + to 每台加 S（都是整数）；
 * width 的累加先后、slack、c0 + slack² + split 的加法先后、严格小于（一样的不覆盖）和两处 break 都照原样，所以每个 cost[at] / prev[at] 逐字一样
 */
function breakRows(I, W, bays, cache = null) {
  const { N, pitch, trail, chunk, gap, cap, grp, stop, steady } = I;
  // 行号状态：0..nb−1 是第几行，nb 是第 nb 行及以后（都按 W）。没有站位时只有一个状态，和不分行号一模一样
  const nb = bays?.length ? Math.max(...bays.map((b) => b.r)) + 2 : 0;
  const S = nb + 1;
  const Wr = new Float64Array(S).fill(W);
  if (bays) for (const b of bays) for (const r of [b.r, b.r + 1]) Wr[r] -= BAY;
  const cost = new Float64Array((N + 1) * S).fill(Infinity);
  const prev = new Int32Array((N + 1) * S).fill(-1);
  let pStart = 0;
  if (cache) {
    const { P0 } = cache;
    cost.set(cache.cost.subarray(0, (P0 + 1) * S));
    prev.set(cache.prev.subarray(0, (P0 + 1) * S));
    let acc = 0;
    pStart = P0;
    for (let p = P0 - 1; p >= 0; p--) {
      acc += pitch[grp[p]];
      if (acc > W) break;
      pStart = p;
    }
  } else cost[0] = 0;
  for (let p = pStart; p < N; p++) {
    const split = p > 0 && grp[p] === grp[p - 1] ? SPLIT_COST : 0;
    for (let r = 0; r < S; r++) {
      const c0 = cost[p * S + r];
      if (c0 === Infinity) continue;
      const to = Math.min(r + 1, nb);
      const Wt = Wr[r];
      const from = p * S + r;
      if (!steady) {
        relaxScan(I, p, Wt, c0, split, cost, prev, S, to, from);
        continue;
      }
      // 内联 scanRow（宽度规则和 scanRow 必须一致；一台都放不下时只报那一台），按单元分两层走：外层每个单元一次（换组：加 pitch、
      // trailing + 缝，倒数计数置成 cap[k]），内层同单元的后面几台（加 pitch，倒数到 0 再加 chunk）。逐台的先后、每台往 width 加的数
      // 和先后都和 scanRow 一样，只是单元内不再每台查 grp、比 k !== last；没有台的单元（stop[k] < q）跳过，不算换组（scanRow 里碰不到它）
      let width = 0;
      let last = -1;
      let at = p * S + to;
      let q = p + 1; // 这一行铺到第 q 台为止（第 q − 1 台刚加上）
      scan: for (let k = grp[p]; q <= N; k++) {
        const e = stop[k];
        if (e < q) continue;
        const pk = pitch[k];
        const ck = cap[k];
        width += pk;
        width += trail[k] + (last >= 0 && (gap[k] || gap[last]) ? 1 : 0);
        last = k;
        let left = ck;
        for (;;) {
          if (width > Wt && q > p + 1) break scan;
          const slack = Math.max(0, Wt - width);
          const c = c0 + slack * slack + split;
          at += S; // = q·S + to
          if (c < cost[at]) {
            cost[at] = c;
            prev[at] = from;
          }
          if (width > Wt) break scan;
          if (++q > e) break;
          width += pk;
          if (--left === 0) {
            width += chunk[k];
            left = ck;
          }
        }
      }
    }
  }
  // 终点：各行号状态里代价最小的（一样时取行号小的）
  let end = N * S;
  for (let r = 1; r < S; r++) if (cost[N * S + r] < cost[end]) end = N * S + r;
  const cuts = [];
  for (let at = end; at >= S; at = prev[at]) cuts.push([Math.floor(prev[at] / S), Math.floor(at / S)]);
  cuts.reverse();
  return { cuts, cost, prev, S };
}

/**
 * breakRows 的兜底：cap 里有正整数和 +Infinity 以外的值（blockCaps / gapChunk 给不出，防万一）时，从第 p 台起的一行照旧用 scanRow
 * 的取模扫，松弛和 breakRows 的内联一样。单独成函数：闭包写在 breakRows 里会把 cost、S 这些变量挪进上下文，内联的循环跟着变慢
 */
function relaxScan(I, p, Wt, c0, split, cost, prev, S, to, from) {
  scanRow(I, p, I.N, Wt, (q, slack) => {
    const c = c0 + slack * slack + split;
    const at = q * S + to;
    if (c < cost[at]) {
      cost[at] = c;
      prev[at] = from;
    }
  });
}

/**
 * 窗口里断行（局部重排用）：第 P0..P1 台正好排成 m 行（第 r0 行起，目标宽度按行号），代价同全局。排不下返回 null
 */
function breakWindow(I, W, bays, P0, P1, r0, m) {
  const { grp } = I;
  const L = P1 - P0;
  const cost = new Float64Array((L + 1) * (m + 1)).fill(Infinity);
  const prev = new Int32Array((L + 1) * (m + 1)).fill(-1);
  cost[0] = 0;
  for (let i = 0; i < L; i++) {
    const p = P0 + i;
    const split = p > 0 && grp[p] === grp[p - 1] ? SPLIT_COST : 0;
    for (let j = 0; j < m; j++) {
      const c0 = cost[i * (m + 1) + j];
      if (c0 === Infinity) continue;
      scanRow(I, p, P1, rowTarget(W, bays, r0 + j), (q, slack) => {
        const c = c0 + slack * slack + split;
        const at = (q - P0) * (m + 1) + j + 1;
        if (c < cost[at]) {
          cost[at] = c;
          prev[at] = i * (m + 1) + j;
        }
      });
    }
  }
  let at = L * (m + 1) + m;
  if (cost[at] === Infinity) return null;
  const cuts = [];
  for (; at > 0; at = prev[at]) cuts.push([P0 + Math.floor(prev[at] / (m + 1)), P0 + Math.floor(at / (m + 1))]);
  cuts.reverse();
  return cuts;
}

/** 由断点建行：每行按组分段，一段超过运力或缝距再平均切成几块；奇数行反过来，空列（错开、站位、供电缝） */
function buildRows(graph, I, cuts, bays, gaps) {
  const { us, gs, cap, grp } = I;
  // 每行按组分段，一段超过运力再平均切成几块（cap 没给时一段一块）
  const runs = cuts.map(([p, q]) => {
    const list = [];
    for (let i = p; i < q; ) {
      const k = grp[i];
      let j = i;
      while (j < q && grp[j] === k) j++;
      list.push([k, j - i]);
      i = j;
    }
    return list;
  });
  // 每组一共几块：只有一块的就用组 ID，否则 组ID~t块号
  const pieces = new Int32Array(gs.length);
  const nOf = (k, m) => Math.max(1, Math.ceil(m / cap[k]));
  for (const list of runs) for (const [k, m] of list) pieces[k] += nOf(k, m);
  const seen = new Int32Array(gs.length);
  const rows = [];
  const blocks = {};
  for (const list of runs) {
    const row = [];
    for (const [k, m] of list) {
      const g = gs[k];
      const nb = nOf(k, m);
      for (let b = 0; b < nb; b++) {
        const bid = pieces[k] === 1 ? us[k].id : `${us[k].id}~t${seen[k]}`;
        seen[k]++;
        blocks[bid] = { gid: g.id, n: Math.floor(m / nb) + (b < m % nb ? 1 : 0) };
        row.push(bid);
      }
    }
    rows.push(row);
  }
  rows.forEach((r, i) => {
    if (i % 2) r.reverse();
  });
  const pads = {};
  rows.forEach((r, i) => {
    if (i % 2 && r.length) pads[r[0]] = graph.byId.get(blocks[r[0]].gid).pitch === 4 ? 2 : 1;
  });
  if (bays) for (const b of bays) if (b.left) for (const r of [b.r, b.r + 1]) if (rows[r]?.length) pads[rows[r][0]] = (pads[rows[r][0]] || 0) + BAY;
  if (gaps?.length) {
    const on = (bid) => gaps.includes(blocks[bid].gid) && gapChunk(graph.byId.get(blocks[bid].gid)) > 0;
    for (const r of rows) for (let i = 1; i < r.length; i++) if (on(r[i]) || on(r[i - 1])) pads[r[i]] = (pads[r[i]] || 0) + 1;
  }
  return { rows, blocks, pads };
}

/** 行宽的范围：最宽那组两台放得下；限宽时不超过上限 */
/**
 * 行宽的范围：最宽那组两台放得下；限宽时不超过上限。
 * aspect（目标长宽比，routeOptions.aspectTarget，比如 3）：一行连通道约 6.5 格高，面积约 总宽 × 6.5，宽 ÷ 长 = aspect 时
 * 行宽 W* = √(aspect × 6.5 × 总宽)；范围收到 W* 的 0.85~1.2 倍（行高随行里的工厂、通道变，留点余地给搜索）
 */
function widthRange(graph, usable, aspect = null) {
  const total = graph.groups.reduce((a, g) => a + g.width, 0);
  let lo = Math.max(...graph.groups.map((g) => g.pitch * 2 + g.trailing));
  let hi = Math.max(lo, usable ?? total);
  let target = null;
  if (aspect > 0) {
    target = Math.round(Math.sqrt(aspect * 6.5 * total));
    lo = Math.min(hi, Math.max(lo, Math.round(target * 0.85)));
    hi = Math.max(lo, Math.min(hi, Math.round(target * 1.2)));
  }
  return { lo, hi, total, target };
}

/**
 * m 个站位均匀摆在 R 行的右端（alternate 时左右交替），相邻两个站位至少隔一行；行太少放不下就少放
 */
function spreadBays(R, m, alternate) {
  const bays = [];
  if (R < 2) return bays;
  const k = Math.min(m, Math.floor((R - 2) / 2) + 1);
  for (let i = 0; i < k; i++) bays.push({ r: k === 1 ? R - 2 : Math.round((i * (R - 2)) / (k - 1)), left: alternate && i % 2 === 1 });
  return bays;
}

/**
 * 初始解：谱排序（正反两个方向）、按层排序，各配一组行宽（1~12 行折开，大线多到 3:1 那么多行 + 4，每种宽度再多 4 列一份）；每种行宽再配一份二维谱排序。
 * gapsOn（电力感应塔时）：每个再多一份全开供电缝的；stations（估的站数，边缘放站时才有）：每个再多两份带站位的——站位都在右端、左右交替
 */
export function typesetStates(graph, usable = null, caps = null, stations = 0, gapsOn = false, aspect = null) {
  const { lo, hi, total, target } = widthRange(graph, usable, aspect);
  const { expand } = unitsOf(graph, caps);
  const spectral = expand(spectralOrder(graph));
  const seqs = [spectral, spectral.slice().reverse(), expand(layeredOrder(graph))];
  const widths = [];
  // 行数最多试到 12，大线再往上加到「3:1 时大约几行」+ 4（一行连通道约 6.5 格高：3:1 时 总宽 ÷ r = 3 × 6.5 × r）：
  // 引力矩阵 360 塔 12 行时行宽约 400、外框 6.6:1，试到 20 行才够得着 3:1。考卷 6 条、放大 3 倍都还是 12，初始解不变
  const rMax = Math.max(12, Math.ceil(Math.sqrt(total / 19.5)) + 4);
  for (let r = 1; r <= rMax; r++)
    for (const slack of [0, 4]) {
      const W = Math.min(hi, Math.max(lo, Math.ceil(total / r) + slack));
      if (!widths.includes(W)) widths.push(W);
    }
  // 有目标长宽比时再加几种围着 W* 的行宽
  if (target)
    for (const f of [0.9, 0.95, 1, 1.05, 1.1]) {
      const W = Math.min(hi, Math.max(lo, Math.round(target * f)));
      if (!widths.includes(W)) widths.push(W);
    }
  const states = [];
  for (const seq of seqs) for (const W of widths) states.push({ seq, W, ...typeset(graph, seq, W, caps) });
  // 二维谱排序：每种行宽按它大约排几行切带
  for (const W of widths) {
    const seq = expand(spectralSnake(graph, Math.max(1, Math.round(total / W))));
    states.push({ seq, W, ...typeset(graph, seq, W, caps) });
  }
  // 电力感应塔时每个初始解再多一份「没有自带空列的组全开供电缝」：大线行里一长串熔炉、化工厂没处放塔，从全开缝出发让搜索往回关
  if (gapsOn) {
    const all = graph.groups.filter((g) => gapChunk(g) > 0).map((g) => g.id).sort();
    if (all.length) for (const st of states.slice()) states.push({ seq: st.seq, W: st.W, gaps: all, ...typeset(graph, st.seq, st.W, caps, null, all) });
  }
  if (stations > 0)
    for (const st of states.slice())
      for (const alternate of [false, true]) {
        const bays = spreadBays(st.rows.length, stations, alternate);
        if (bays.length) states.push({ seq: st.seq, W: st.W, bays, ...(st.gaps ? { gaps: st.gaps } : {}), ...typeset(graph, st.seq, st.W, caps, bays, st.gaps) });
      }
  return states;
}

/** 站位的邻域：加一个（三成）、去一个（两成）、上下挪 1~2 行（三成半）、换到另一端；和别的站位挨着（隔不到一行）的不动 */
function bayNeighbor(graph, st, rand, caps) {
  const gaps = st.gaps;
  const R = st.rows.length;
  const bays = (st.bays || []).map((b) => ({ ...b }));
  const free = (r, skip = -1) => r >= 0 && r <= Math.max(0, R - 2) && bays.every((b, j) => j === skip || Math.abs(b.r - r) >= 2);
  const v = rand();
  if (!bays.length || v < 0.3) {
    const r = Math.floor(rand() * Math.max(1, R - 1));
    const left = rand() < 0.5;
    if (free(r)) bays.push({ r, left });
  } else if (v < 0.5) bays.splice(Math.floor(rand() * bays.length), 1);
  else if (v < 0.85) {
    const i = Math.floor(rand() * bays.length);
    const r = bays[i].r + (rand() < 0.5 ? -1 : 1) * (1 + Math.floor(rand() * 2));
    if (free(r, i)) bays[i].r = r;
  } else {
    const i = Math.floor(rand() * bays.length);
    bays[i].left = !bays[i].left;
  }
  bays.sort((a, b) => a.r - b.r);
  return { seq: st.seq, W: st.W, bays, ...(gaps ? { gaps } : {}), ...typeset(graph, st.seq, st.W, caps, bays, gaps) };
}

/** 供电缝的邻域：开或关一个组的缝。有惩罚时一半挑惩罚记下的组（hot），只在没有自带空列的组里挑 */
function gapNeighbor(graph, st, rand, hot, caps) {
  const pool = graph.groups.filter((g) => gapChunk(g) > 0).map((g) => g.id);
  const hotG = hot?.length ? [...new Set(hot.map((b) => st.blocks[b]?.gid).filter((gid) => gid && pool.includes(gid)))] : [];
  const list = hotG.length && rand() < 0.5 ? hotG : pool;
  const gaps = (st.gaps || []).slice();
  if (list.length) {
    const gid = list[Math.floor(rand() * list.length)];
    const i = gaps.indexOf(gid);
    if (i >= 0) gaps.splice(i, 1);
    else gaps.push(gid);
    gaps.sort();
  }
  return { seq: st.seq, W: st.W, ...(st.bays ? { bays: st.bays } : {}), gaps, ...typeset(graph, st.seq, st.W, caps, st.bays, gaps) };
}

/** 块 ID → 所在的分身单元（块 ID 是 单元ID 或 单元ID~t段号） */
const unitOfBlock = (bid) => bid.replace(/~t\d+$/, '');

/**
 * 竖着换的对象：块 bid 上面或下面那行里横向和它重叠的一块（按排版的横向位置算：行从左往右排、带空列）；
 * 那一侧没有行就看另一侧。通道挤（要 4~5 条轨）是上下两行同一段 x 各要几种物品，打乱队里随便两个位置很少正好换到上下挨着的那块
 */
function verticalPartner(graph, st, bid, rand) {
  let at = null;
  const spans = st.rows.map((row, r) => {
    let x = 0;
    return row.map((b) => {
      const bl = st.blocks[b];
      const g = graph.byId.get(bl.gid);
      x += st.pads[b] || 0;
      const sp = { b, r, x0: x, x1: x + bl.n * g.pitch + g.trailing - 1 };
      x = sp.x1 + 1;
      if (b === bid) at = sp;
      return sp;
    });
  });
  if (!at) return null;
  const up = rand() < 0.5;
  const row = spans[at.r + (up ? 1 : -1)] ?? spans[at.r + (up ? -1 : 1)];
  if (!row) return null;
  const over = row.filter((sp) => sp.x1 >= at.x0 && sp.x0 <= at.x1);
  return over.length ? over[Math.floor(rand() * over.length)].b : null;
}

/**
 * 局部重排：挑一行（一半挑惩罚记下的块所在的行），连上下各一行共 2~3 行当窗口，只重新排列整个落在窗口里的单元
 * （对调两个、挪一个、反转一段），再只在窗口里断行、行数不变——窗口外的行一字不动。全局的动作每一步都会让后面整张重新断行，
 * 大线上低温细修时几乎每步都把图搅乱；这个动作是真正的「局部」。窗口里排不下（总宽变了）或没有可动的单元时返回 null。
 * 排出来的不是这条队的全局断行，没有它自己的 dp；带上 st 的 dp（记着算它的那条祖先的队），下一个全局动作拿它抄前缀，不用整张重算
 */
function localMove(graph, st, rand, hot, caps) {
  const cuts = st.cuts;
  if (!cuts || cuts.length < 2) return null;
  const R = cuts.length;
  // 锚定的行：惩罚记下的块所在的行（按 rows 找）或随机一行
  let r = -1;
  if (hot?.length && rand() < 0.5) {
    const bid = hot[Math.floor(rand() * hot.length)];
    r = st.rows.findIndex((row) => row.includes(bid));
  }
  if (r < 0) r = Math.floor(rand() * R);
  const span = rand() < 0.5 ? 2 : 3;
  let ra = Math.max(0, r - (span === 3 ? 1 : Math.floor(rand() * 2)));
  const rb = Math.min(R - 1, ra + span - 1);
  ra = Math.max(0, rb - span + 1);
  const P0 = cuts[ra][0];
  const P1 = cuts[rb][1];
  const I = seqInfo(graph, st.seq, caps, st.gaps);
  let ka = -1;
  let kb = -1;
  for (let k = 0; k < I.us.length; k++) {
    if (I.start[k] >= P0 && I.start[k] + I.us[k].count <= P1) {
      if (ka < 0) ka = k;
      kb = k;
    }
  }
  if (ka < 0 || kb - ka < 1) return null;
  const seq = st.seq.slice();
  const n = kb - ka + 1;
  const v = rand();
  if (v < 0.4) {
    const i = ka + Math.floor(rand() * n);
    let j = ka + Math.floor(rand() * (n - 1));
    if (j >= i) j++;
    [seq[i], seq[j]] = [seq[j], seq[i]];
  } else if (v < 0.75) {
    const i = ka + Math.floor(rand() * n);
    const [x] = seq.splice(i, 1);
    seq.splice(ka + Math.floor(rand() * n), 0, x);
  } else {
    let i = ka + Math.floor(rand() * n);
    let j = ka + Math.floor(rand() * n);
    if (i > j) [i, j] = [j, i];
    if (i === j) return null;
    for (; i < j; i++, j--) [seq[i], seq[j]] = [seq[j], seq[i]];
  }
  const I2 = seqInfo(graph, seq, caps, st.gaps);
  const win = breakWindow(I2, st.W, st.bays, P0, P1, ra, rb - ra + 1);
  if (!win) return null;
  const cuts2 = [...cuts.slice(0, ra), ...win, ...cuts.slice(rb + 1)];
  return { seq, W: st.W, ...(st.bays ? { bays: st.bays } : {}), ...(st.gaps ? { gaps: st.gaps } : {}), ...buildRows(graph, I2, cuts2, st.bays, st.gaps), cuts: cuts2, ...(st.dp ? { dp: st.dp } : {}) };
}

/**
 * 排版状态的邻域：换两组（三成，其中一半是竖着换：和上下相邻那行里横向重叠的一块对调）、把一组挪到别处（三成）、反转一段（两成）、
 * 相邻两组对调（一成）、行宽加减 1~6 列（一成）。
 * 有惩罚时一半挑和惩罚有关的组下手（hot：惩罚记下的块，同 master）。
 * stations（边缘放站时）：先抽一个数，一成半的动作改站位（bayNeighbor）；gapsOn（电力感应塔时）：再抽一个数，5% 的动作开关供电缝
 * （gapNeighbor）；再抽一个数，一成到六成（随退火进度）先试局部重排（localMove，窗口外的行不动）；其余照上面的比例。站位、供电缝跟着状态走
 */
export function typesetNeighbor(graph, st, rand, hot = null, usable = null, caps = null, stations = 0, gapsOn = false, aspect = null, progress = null) {
  if (stations > 0 && rand() < 0.15) return bayNeighbor(graph, st, rand, caps);
  if (gapsOn && rand() < 0.05) return gapNeighbor(graph, st, rand, hot, caps);
  // 局部重排：窗口外的行一字不动；做不成（窗口里排不下、没有可动的单元）就照常走下面的全局动作。
  // 比例随退火进度从一成升到六成（progress：这一轮走到第几成，place.js 传；没有时四成）：高温时多全局搜，低温时多局部细修
  if (rand() < (progress == null ? 0.4 : 0.1 + 0.5 * progress)) {
    const loc = localMove(graph, st, rand, hot, caps);
    if (loc) return loc;
  }
  const seq = st.seq.slice();
  let W = st.W;
  const n = seq.length;
  const pick = () => {
    if (hot && hot.length && rand() < 0.5) {
      // 惩罚记下的块 → 它所在的单元（块 ID 是 单元ID 或 单元ID~t段号）
      const bid = hot[Math.floor(rand() * hot.length)];
      const i = st.blocks[bid] ? seq.indexOf(unitOfBlock(bid)) : -1;
      if (i >= 0) return i;
    }
    return Math.floor(rand() * n);
  };
  const u = rand();
  if (n >= 2 && u < 0.3) {
    let i = -1;
    let j = -1;
    if (rand() < 0.5) {
      // 竖着换（换两组的一半）：挑一块（一半挑惩罚记下的），和上下相邻那行里横向重叠的一块对调所在的单元
      const bids = Object.keys(st.blocks);
      const bid = hot?.length && rand() < 0.5 ? hot[Math.floor(rand() * hot.length)] : bids[Math.floor(rand() * bids.length)];
      const other = st.blocks[bid] ? verticalPartner(graph, st, bid, rand) : null;
      if (other) {
        i = seq.indexOf(unitOfBlock(bid));
        j = seq.indexOf(unitOfBlock(other));
      }
    }
    if (i < 0 || j < 0 || i === j) {
      i = pick();
      j = Math.floor(rand() * (n - 1));
      if (j >= i) j++;
    }
    [seq[i], seq[j]] = [seq[j], seq[i]];
  } else if (n >= 2 && u < 0.6) {
    const i = pick();
    const [g] = seq.splice(i, 1);
    seq.splice(Math.floor(rand() * n), 0, g);
  } else if (n >= 3 && u < 0.8) {
    let i = Math.floor(rand() * n);
    let j = Math.floor(rand() * n);
    if (i > j) [i, j] = [j, i];
    for (; i < j; i++, j--) [seq[i], seq[j]] = [seq[j], seq[i]];
  } else if (n >= 2 && u < 0.9) {
    const i = Math.floor(rand() * (n - 1));
    [seq[i], seq[i + 1]] = [seq[i + 1], seq[i]];
  } else {
    const { lo, hi } = widthRange(graph, usable, aspect);
    W = Math.min(hi, Math.max(lo, W + (rand() < 0.5 ? -1 : 1) * (1 + Math.floor(rand() * 6))));
  }
  // 增量断行：改动点之前的机器序不变，断行 DP 的前缀照抄（dpCache / breakRows）。st.dp 是上一次断行的 dp（局部重排出来的状态带的是祖先的，
  // dp 记着自己的队；队在这里、局部重排、精修里都是先 slice 再改，不原地改）；宽度动作改了 W、站位 / 供电缝动作换了引用时，dpCache 自己会判出不能用、从头算
  if (st.bays || st.gaps) return { seq, W, ...(st.bays ? { bays: st.bays } : {}), ...(st.gaps ? { gaps: st.gaps } : {}), ...typeset(graph, seq, W, caps, st.bays, st.gaps, st.dp) };
  return { seq, W, ...typeset(graph, seq, W, caps, null, null, st.dp) };
}

/**
 * 定点精修的候选（place.js 的 polish，接力的轮退火完以后）：退火每步只随机试一个动作、碰到更好的就收，最后一两条惩罚常常要正好
 * 某一步才解得开。这里围绕惩罚记下的单元（最多 4 个）把单步邻域挨个列出来：竖着换（上下相邻行里横向重叠的块）、
 * 和每个别的单元对调、挪到每个别的位置、开关供电缝（gapsOn）；再加行宽 ±1、±2、±4。一个一个排版（生成器，用多少排多少）
 */
export function* polishCandidates(graph, st, hot, caps, usable = null, gapsOn = false, aspect = null) {
  const seq = st.seq;
  const n = seq.length;
  // 候选大多是对同一条队 seq 的小扰动、行宽和供电缝不变：先算一份基准 dp（st 是 keep() 过的、没带 dp），各候选抄前缀。
  // 行宽变了（W2 ≠ st.W）、供电缝换了数组时，dpCache 自己判出不能用、从头算，结果逐字不变
  const base = typeset(graph, seq, st.W, caps, st.bays, st.gaps);
  const make = (s2, W2, gaps2 = st.gaps) => ({ seq: s2, W: W2, ...(st.bays ? { bays: st.bays } : {}), ...(gaps2 ? { gaps: gaps2 } : {}), ...typeset(graph, s2, W2, caps, st.bays, gaps2, base.dp) });
  const { lo, hi } = widthRange(graph, usable, aspect);
  for (const d of [-1, 1, -2, 2, -4, 4]) {
    const W2 = Math.min(hi, Math.max(lo, st.W + d));
    if (W2 !== st.W) yield make(seq, W2);
  }
  const bids = [...new Set((hot || []).filter((b) => st.blocks[b]))];
  const units = [...new Set(bids.map(unitOfBlock))].filter((u) => seq.includes(u)).slice(0, 4);
  const swapped = (i, j) => {
    const s2 = seq.slice();
    [s2[i], s2[j]] = [s2[j], s2[i]];
    return s2;
  };
  for (const u of units) {
    const i = seq.indexOf(u);
    // 竖着换：这个单元各块上下相邻行里横向重叠的块（两侧都看）
    const seen = new Set([u]);
    for (const b of Object.keys(st.blocks)) {
      if (unitOfBlock(b) !== u) continue;
      for (const flip of [() => 0.1, () => 0.9]) {
        const other = verticalPartner(graph, st, b, flip);
        const v = other ? unitOfBlock(other) : null;
        if (v && !seen.has(v)) {
          seen.add(v);
          yield make(swapped(i, seq.indexOf(v)), st.W);
        }
      }
    }
    for (let j = 0; j < n; j++) if (!seen.has(seq[j])) yield make(swapped(i, j), st.W);
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const s2 = seq.slice();
      const [x] = s2.splice(i, 1);
      s2.splice(j, 0, x);
      yield make(s2, st.W);
    }
    const gid = unitsOf(graph, caps).byId.get(u)?.gid;
    if (gapsOn && gid && gapChunk(graph.byId.get(gid)) > 0) {
      const gaps = (st.gaps || []).slice();
      const k = gaps.indexOf(gid);
      if (k >= 0) gaps.splice(k, 1);
      else gaps.push(gid);
      gaps.sort();
      yield make(seq, st.W, gaps);
    }
  }
}
