// 高架：每段高架的格子、逐段分配高度（可请出重排）、升降落成原地竖直的一叠、路网统计
import { RAMP_MAX_DZ } from '../../gamedata.js';
import { gk, line } from './shared.js';
import { solveLevels } from './levels.js';

// 归属表的缓冲区按线程复用：每次 liftLegs 换一个代际，表不够大才重新分配；代际用到上限时清零重来
let gridBuf = new Int32Array(0);
let gridGen = 0;
function ownerGrid(size) {
  if (gridBuf.length < size || gridGen >= 500000) {
    gridBuf = new Int32Array(Math.max(size, Math.ceil(gridBuf.length * 1.5)));
    gridGen = 0;
  }
  gridGen++;
  return { buf: gridBuf, gen: gridGen };
}

// 平面格子（按 (x, y) 编号，不含层）的临时表，也按线程复用：mark 记「这一格这一轮记过」，val 存附带的数（槽号）；
// seen 给每段查自己走没走回头路；fix 记「物流站、喷涂保护区、形状随层变的段占过这一格」。
// 每用一轮换一个新戳（全局递增），戳不同就当没记过，不用清零
let planeMark = new Int32Array(0);
let planeVal = new Int32Array(0);
let planeSeen = new Int32Array(0);
let planeFix = new Int32Array(0);
let planeStamp = 0;
function planeScratch(size) {
  // 一次 liftLegs 最多用「段数 + 几个」个戳（段数 < 4096），离上限留足余量
  if (planeMark.length < size || planeStamp >= 2e9) {
    const n = Math.max(size, Math.ceil(planeMark.length * 1.5));
    planeMark = new Int32Array(n);
    planeVal = new Int32Array(n);
    planeSeen = new Int32Array(n);
    planeFix = new Int32Array(n);
    planeStamp = 0;
  }
}

// 约束表（每个平面格子上有哪些段，见 liftLegs）的缓冲区，也按线程复用：槽头、槽尾、槽里的段数、链上的下一个、值、临时表
let atHead = new Int32Array(0);
let atTail = new Int32Array(0);
let atCnt = new Int32Array(0);
let atNext = new Int32Array(0);
let atVal = new Int32Array(0);
let atList = new Int32Array(0);
function atScratch(n) {
  if (atHead.length < n) {
    const m = Math.max(n, Math.ceil(atHead.length * 1.5));
    atHead = new Int32Array(m);
    atTail = new Int32Array(m);
    atCnt = new Int32Array(m);
    atNext = new Int32Array(m);
    atVal = new Int32Array(m);
    atList = new Int32Array(m);
  } else atCnt.fill(0, 0, n); // 只有段数要从 0 数起，其余写了才读
}

// 只有高度变的段的平面格号（水平部分 pb、升降那一叠 ps、碰到固定东西的那几格）都依次排在这一个按线程复用的缓冲里，
// 每段只记开头和个数（不再每段各开几个数组）。每次 liftLegs 从头用起；用满了换一个两倍大的（旧的内容抄过去）
let geoBuf = new Int32Array(1024);
let geoTop = 0;
const geoPush = (v) => {
  if (geoTop === geoBuf.length) {
    const grown = new Int32Array(geoBuf.length * 2);
    grown.set(geoBuf);
    geoBuf = grown;
  }
  geoBuf[geoTop++] = v;
};

// 两段之间的约束（不能同层、必须更高）这一次加过没有：n × n 的表按线程复用，存这一次的戳。
// 两段有一长串格子重合时同一对约束要加很多遍，Set 里已有的再加不会变（先后次序也不变），记过的就不再调 add
let pairNeq = new Int32Array(0);
let pairAbove = new Int32Array(0);
let pairStamp = 0;
const PAIR_MAX = 512; // 段数再多就不用表（表太大），照原来每次都 add

/** 横着沿方向 d 从 a 走到 b 的格子 [x, y, z] 推进 cells（b 在 a 的反方向时没有）：和 line(a, b) 逐格一样，不拼临时数组 */
function runX(cells, a, b, d, y, z) {
  if ((b - a) * d < 0) return;
  const st = b >= a ? 1 : -1;
  for (let x = a; x !== b + st; x += st) cells.push([x, y, z]);
}
/** 竖着沿方向 d 从 a 走到 b 的格子 [x, y, z] 推进 cells（b 在 a 的反方向时没有） */
function runY(cells, a, b, d, x, z) {
  if ((b - a) * d < 0) return;
  const st = b >= a ? 1 : -1;
  for (let yy = a; yy !== b + st; yy += st) cells.push([x, yy, z]);
}
/** line(a, b).slice(1) 的竖直格子：从 a 的下一格走到 b（a === b 时没有） */
function pastY(cells, a, b, x, z) {
  const st = b >= a ? 1 : -1;
  for (let yy = a + st; yy !== b + st; yy += st) cells.push([x, yy, z]);
}

/** 没有走廊里多走的那一格时 cellsFor 结果的 pre / post：所有结果共用这一个空数组，只读（谁都不往里加） */
const NO_CELLS = [];
/**
 * 升降那一叠：在地面那一端（groundEnd 为 0 是 (x0, y0)，为 1 是 (x1, y1)）的格子上占 1..L−RAMP_MAX_DZ 层（影子格推进 r.shadow），
 * 那一格记作 r.rise（升起）或 r.drop（落下）
 */
function ramp(r, L, x0, y0, x1, y1, groundEnd = 0) {
  const x = groundEnd === 0 ? x0 : x1;
  const y = groundEnd === 0 ? y0 : y1;
  for (let z = 1; z <= L - RAMP_MAX_DZ; z++) r.shadow.push([x, y, z]);
  if (groundEnd === 0) r.rise = [x, y];
  else r.drop = [x, y];
}

/**
 * 喷涂机空当（layout/belts.js 的 sprayGap）要护住的格子：别的高架段不许压在候选位置的头顶。
 *   guard2（第 1~2 层让开）：空当里喷涂机候选压着的 4 格——喷涂机身子两层高，取料孔在第 2 层；
 *   guard1（第 1 层让开）：两个取料格候选左右的邻格——增产剂带要从那里在第 1 层横穿进出。
 * 跨过这里的段只能去第 3 层以上（金字塔代价照算），搜索的几何和代价都算上了这块保护区。
 */
/** 一段喷涂空当的候选格（沿流向最多 4 格；被站列截短时更少）。前两格是取料格候选，骑的位置在取料格下游一格 */
export function sprayGapCells(s) {
  if (s.sprayGap === 'edgeIn') return []; // 喷涂机在边缘入口往外接出的几节上（plan/addons.js 的 pre），图里没有空当格
  const fd = s.sprayGap === 'in' || s.sprayGap === 'legIn' ? s.dir : s.dout; // 空当里带子的流向
  if (!fd) return [];
  if (s.sprayGap === 'legIn') {
    // 原料的喷涂机骑在入口那截高架上：窗口是段头（gapX）上游的 5 格水平走行（layout/belts.js 的 segOf 保证够长），
    // 候选是紧挨段头的 4 格，顺序沿流向（离段头最远的在前），前两格是取料格候选
    // 段头还是 gapX：窗口在入口那截高架上（段外）；段头挪了（layout/ports.js 把段在地面一直接到了边缘，高架作废）：
    // 窗口那几格成了段里的地面直带，只取段内的
    const cells = [4, 3, 2, 1].map((i) => s.gapX - fd * i);
    return s.entryX === s.gapX ? cells : cells.filter((x) => x >= s.a && x <= s.b);
  }
  if (s.sprayGap === 'legOut') {
    // 喷涂机骑在段尾接下去那截高架上（layout/belts.js 的 LEG_WINDOW）：窗口是段尾（gapX）下游的 5 格水平走行，
    // 前 4 格是候选（第 5 格只要直着就行），顺序沿流向，和地面空当一样前两格是取料格候选
    return [1, 2, 3, 4].map((i) => s.gapX + fd * i);
  }
  if (s.sprayGap === 'mid') {
    // 放料段和取料段在地面接成一条（layout/belts.js 的 JOIN）：空当是最后一个放料口（gapX）下游的 4 格
    const out = [];
    for (let i = 1; i <= 4; i++) {
      const x = s.gapX + fd * i;
      if (x >= s.a && x <= s.b) out.push(x);
    }
    return out;
  }
  // 入口空当贴着段头（端点那格是落地的，候选从下一格起）；段尾空当贴着段尾（端点那格要升起，候选到它前一格为止）
  const end = s.sprayGap === 'in' ? (fd > 0 ? s.a : s.b) : (fd > 0 ? s.b : s.a);
  const offs = s.sprayGap === 'in' ? [1, 2, 3, 4] : [-4, -3, -2, -1]; // 沿流向，离端点的格数
  return offs.map((i) => end + fd * i).filter((x) => x >= s.a && x <= s.b);
}

/**
 * placing：正在分层（liftLegs / estimateLegs）：窗口高架的头顶由它们自己管（winFree / winOf），这里不护；
 * 高架作废了的窗口（layout/ports.js 把段在地面接到了边缘，leg.direct）任何时候都按地面空当护
 */
export function sprayGuards(segments, legs = null, placing = false) {
  const guard2 = [];
  const guard1 = [];
  const guardZ = []; // 高架上的窗口（legOut / legIn）：[x, y, z]，层数按那截高架定下来的层算
  const winLeg = new Map();
  if (legs) for (const l of legs) if (l.spray) winLeg.set(l.spray.seg, l);
  for (const s of segments) {
    if (!s.sprayGap) continue;
    const cells = sprayGapCells(s);
    if (s.sprayGap === 'legOut' || s.sprayGap === 'legIn') {
      const l = legs && winLeg.get(s.id);
      if (!l) continue;
      if (!l.direct) {
        if (placing) continue;
        const L = l.level ?? 0;
        if (L > 0) {
          for (const x of cells) guardZ.push([x, s.y, L + 1], [x, s.y, L + 2]);
          for (const x of cells.slice(0, 2)) guardZ.push([x, s.y - 1, L + 1], [x, s.y + 1, L + 1]);
          continue;
        }
      }
      // 高架作废（窗口格成了段里的地面直带）或落在地面的（没分到层）：按地面空当算
    }
    for (const x of cells) guard2.push([x, s.y]);
    for (const x of cells.slice(0, 2)) { // 取料格候选：流向上最靠前的两格
      guard1.push([x, s.y - 1], [x, s.y + 1]);
    }
  }
  return { guard2, guard1, guardZ };
}

/**
 * 高架段的格子算法（闭包）：给定段和层数 L，返回水平部分的格子、升降那一叠的影子格和两头的地面格。
 * 分配高度（liftLegs）和快速评估（estimateLegs）共用。
 */
function makeCellsFor(c) {
  const { legs, segments, side } = c;
  // 靠左侧站列时，站的车道从左边水平进到走廊口；口上直接升起去走廊，就是一边转弯一边升降（游戏里会拧成麻花）。
  // 走廊里口的上一格或下一格地面空着时，先在地面拐进走廊走一格，再在那一格直着升起（落下时反过来）。
  // 走廊地面上只有各段的出入口格，按段的顺序先到先得，定下来以后整个分配过程不变。
  const corridorStep = new Map(); // 段 ID → 走廊里多走的那一格地面 [x, y]
  if (side) {
    const used = new Set(legs.filter((l) => l.kind !== 'link').map((l) => gk(l.edge, l.py)));
    for (const l of legs) {
      if (l.direct || l.kind === 'link') continue;
      const s = segments[l.kind === 'in' ? l.to : l.from];
      if (l.edge === (l.kind === 'in' ? s.entryX : s.exitX)) continue;
      const dy = l.kind === 'in' ? Math.sign(s.y - l.py) : Math.sign(l.py - s.y);
      if (!dy || Math.abs(s.y - l.py) < 2) continue;
      const k = gk(l.edge, l.py + (l.kind === 'in' ? dy : -dy));
      if (used.has(k)) continue;
      used.add(k);
      corridorStep.set(l.id, [l.edge, l.py + (l.kind === 'in' ? dy : -dy)]);
    }
  }
  // 结果：cells 水平部分、shadow 升降那一叠的影子格、rise / drop 两头升降的地面格、pre / post 走廊里多走的那一格，
  // varies：退回原地升降（格子里有随层数变长的竖直一叠），形状随层变；其余的段换层只是 z 变了。
  // 结果对象开头就建好全部字段（不再另造一个 ends 再抄过来），没有 pre / post 时共用一个空数组（只读，没人往里加）
  const cellsFor = (leg, L) => {
    const cells = [];
    const shadow = [];
    const r = { cells, shadow, rise: null, drop: null, pre: NO_CELLS, post: NO_CELLS, varies: false };
    if (leg.direct) return r;
    // 沿方向 d 从 a 走到 b 的格子；b 在 a 的反方向时为空（runX 横着走、runY 竖着走，见文件开头）
    // 升降那一叠在地面那一端的格子上：1..L−RAMP_MAX_DZ 层（RAMP_MAX_DZ = 0 时一直到第 L 层），见 ramp
    if (leg.kind === 'in') {
      const s = segments[leg.to];
      const d = Math.sign(s.entryX - leg.edge) || s.dir;
      if (leg.py === s.y) {
        // 出入口和段在同一行：斜坡升起，沿这一行直走，斜坡落进段首
        runX(cells, leg.edge + d, s.entryX - d, d, s.y, L);
        if (!cells.length) {
          // 段首紧挨边缘、又不能走地面：退回原地升降
          r.varies = true;
          for (let z = 1; z <= L; z++) cells.push([leg.edge, s.y, z]);
          for (let z = L; z >= 1; z--) cells.push([s.entryX, s.y, z]);
          return r;
        }
        ramp(r, L, leg.edge, s.y, leg.edge + d, s.y);
      } else if (s.entryX === leg.edge) {
        // 段首就在走廊这一列（最靠左的那台工厂紧挨走廊）：沿走廊升起、走到段首前一格、斜坡落下
        const dy = Math.sign(s.y - leg.py);
        runY(cells, leg.py + dy, s.y - dy, dy, leg.edge, L);
        if (!cells.length) return r; // 出入口紧挨段首：地面直接接上
        ramp(r, L, leg.edge, leg.py, leg.edge, leg.py + dy);
        const last = cells[cells.length - 1];
        ramp(r, L, last[0], last[1], s.entryX, s.y, 1);
        return r;
      } else {
        const dy = Math.sign(s.y - leg.py);
        const step = corridorStep.get(leg.id);
        runY(cells, leg.py + dy * (step ? 2 : 1), s.y, dy, leg.edge, L);
        runX(cells, leg.edge + d, s.entryX - d, d, s.y, L);
        if (step) {
          r.pre = [[step[0], step[1], 0]];
          ramp(r, L, step[0], step[1], leg.edge, step[1] + dy);
        } else ramp(r, L, leg.edge, leg.py, leg.edge, leg.py + dy);
      }
      const last = cells[cells.length - 1];
      ramp(r, L, last[0], last[1], s.entryX, s.y, 1);
    } else if (leg.kind === 'out') {
      const s = segments[leg.from];
      const d = s.dout;
      if (leg.py !== s.y && s.exitX === leg.edge) {
        // 段尾就在走廊这一列：沿走廊斜坡升起，走到出入口前一格再落下
        const dy = Math.sign(leg.py - s.y);
        runY(cells, s.y + dy, leg.py - dy, dy, leg.edge, L);
        if (!cells.length) return r;
        ramp(r, L, s.exitX, s.y, cells[0][0], cells[0][1]);
        const last = cells[cells.length - 1];
        ramp(r, L, last[0], last[1], leg.edge, leg.py, 1);
        return r;
      }
      if (leg.py === s.y) {
        runX(cells, s.exitX + d, leg.edge - d, d, s.y, L);
        if (!cells.length) {
          r.varies = true;
          for (let z = 1; z <= L; z++) cells.push([s.exitX, s.y, z]);
          for (let z = L; z >= 1; z--) cells.push([leg.edge, s.y, z]);
          return r;
        }
      } else {
        const dy = Math.sign(leg.py - s.y);
        const step = corridorStep.get(leg.id);
        runX(cells, s.exitX + d, leg.edge, d, s.y, L);
        runY(cells, s.y + dy, leg.py - dy * (step ? 2 : 1), dy, leg.edge, L);
        if (step && cells.length && !(cells[0][0] === s.exitX && cells[0][1] === s.y)) {
          ramp(r, L, s.exitX, s.y, cells[0][0], cells[0][1]);
          ramp(r, L, cells[cells.length - 1][0], cells[cells.length - 1][1], step[0], step[1], 1);
          r.post = [[step[0], step[1], 0]];
          return r;
        }
      }
      if (!cells.length || (cells[0][0] === s.exitX && cells[0][1] === s.y)) {
        // 段朝出口的反方向流（搜索里已按走不通重罚，这里只保证几何能生成）：退回原地升降
        r.varies = true;
        cells.length = 0;
        for (let z = 1; z <= L; z++) cells.push([s.exitX, s.y, z]);
        const sx = Math.sign(leg.edge - s.exitX);
        if (sx) for (const x of line(s.exitX + sx, leg.edge)) cells.push([x, s.y, L]);
        pastY(cells, s.y, leg.py, leg.edge, L);
        for (let z = L - 1; z >= 1; z--) cells.push([leg.edge, leg.py, z]);
        return r;
      }
      ramp(r, L, s.exitX, s.y, cells[0][0], cells[0][1]);
      const last = cells[cells.length - 1];
      ramp(r, L, last[0], last[1], leg.edge, leg.py, 1);
    } else {
      const s0 = segments[leg.from];
      const s1 = segments[leg.to];
      runX(cells, s0.exitX + s0.dout, leg.xv, s0.dout, s0.y, L);
      pastY(cells, s0.y, s1.y, leg.xv, L);
      runX(cells, leg.xv + s1.dir, s1.entryX - s1.dir, s1.dir, s1.y, L);
      if (!cells.length) cells.push([leg.xv, s0.y, L]);
      ramp(r, L, s0.exitX, s0.y, cells[0][0], cells[0][1]);
      const last = cells[cells.length - 1];
      ramp(r, L, last[0], last[1], s1.entryX, s1.y, 1);
    }
    return r;
  };
  return cellsFor;
}

/** 升降落到实处：地面那一端先原地竖直升到 L−RAMP_MAX_DZ 层，再水平走；落下时反过来。c 是 cellsFor(l, l.level) 的结果 */
function realizeLeg(l, c) {
  const k = l.level - RAMP_MAX_DZ;
  const up = c.rise ? Array.from({ length: k }, (_, i) => [c.rise[0], c.rise[1], i + 1]) : [];
  const down = c.drop ? Array.from({ length: k }, (_, i) => [c.drop[0], c.drop[1], k - i]) : [];
  l.cells = [...c.pre, ...up, ...l.cells, ...down, ...c.post];
  l.shadow = [];
}

/**
 * 只有高度变的段（形状不随层变）落到第 L 层：a 是 cellsFor(l, 1) 的结果。第 L 层的水平格子就是第 1 层的每格换成 z = L，
 * 两头升降的地面格、走廊里多走的那一格都和层无关，所以不用再算一遍 cellsFor(l, L)，直接拼出和 realizeLeg 一样的最终格子
 */
function realizeFlat(l, a, L) {
  const cells = a.cells;
  if (!cells.length) {
    // 没有水平部分（出入口紧挨段首之类）：和以前一样不落升降，格子留空
    l.cells = cells;
    l.shadow = a.shadow;
    return;
  }
  const k = L - RAMP_MAX_DZ;
  const pre = a.pre;
  const post = a.post;
  // 第 1 层的格子和装它们的数组都是这一段独有的（cellsAt 按段、按层各算一份，落到实处以后别处不再用）：
  // 落到第 L 层时原地把每格的 z 改成 L，不用再另造一份 [x, y, L]；最终的格子也直接拼在这个数组里——
  // 开头让出 pre 和升起那一叠的位置（整体往后挪），末尾接上落下那一叠和 post，和另开一个数组依次推进去一模一样
  const n0 = cells.length;
  if (L !== 1) for (let i = 0; i < n0; i++) cells[i][2] = L;
  const nr = a.rise && k > 0 ? k : 0;
  const h = pre.length + nr;
  if (h > 0) {
    for (let i = 0; i < h; i++) cells.push(null);
    for (let i = n0 - 1; i >= 0; i--) cells[i + h] = cells[i];
    let j = 0;
    for (let i = 0; i < pre.length; i++) cells[j++] = pre[i];
    if (nr) {
      const x = a.rise[0];
      const y = a.rise[1];
      for (let i = 0; i < k; i++) cells[j++] = [x, y, i + 1];
    }
  }
  if (a.drop) {
    const x = a.drop[0];
    const y = a.drop[1];
    for (let i = 0; i < k; i++) cells.push([x, y, k - i]);
  }
  for (let i = 0; i < post.length; i++) cells.push(post[i]);
  l.cells = cells;
  l.shadow = [];
}

// 路网统计里「每格叠了几条竖直高架」的表：按 (x, y) 编号的 Int32Array，按线程复用。last 存最后计入这一格的段的戳
// （每次 roadStats 占用一段连续的戳：base+1..base+段数），戳不属于这一次就当这格还是 0 条，不用清零
let stackCnt = new Int32Array(0);
let stackLast = new Int32Array(0);
let stackStamp = 0;
// 一段高架竖直走过的列（去重，按出现的先后），按线程复用
let vxBuf = new Float64Array(16);

/** 路网（只用于显示和统计）：每段高架的竖直部分走在哪一类「路」上 */
function roadStats(c) {
  const { corridor, height, legs, side, xL, xR } = c;
  // 主干 = 物流站旁的走廊；外环 = 左右边缘；辅路 = 生产区内部的空列；本通道 = 没有竖直部分（只在通道上空跨过去）
  const roads = { trunk: 0, ring: 0, street: 0, local: 0, maxStack: 0 };
  // 每次 route() 都要算（退火里是热点）：竖直走过的列用小数组，不拼临时数组。
  // 叠的条数按格记在上面的表里（布局四周各留 SM 格）；万一有格子在表外，退回 Map：格 → 条数 × 2^20 + 段序号 + 1
  const SM = 32;
  const SW = xR - xL + 1 + 2 * SM;
  const SH = (height ?? 0) + 2 * SM;
  if (stackCnt.length < SW * SH || stackStamp >= 2e9) {
    const size = Math.max(SW * SH, Math.ceil(stackCnt.length * 1.5));
    stackCnt = new Int32Array(size);
    stackLast = new Int32Array(size);
    stackStamp = 0;
  }
  const CNT = stackCnt;
  const LAST = stackLast;
  const base = stackStamp;
  stackStamp += legs.length + 1;
  let far = null; // 表外的格子很少有，用到才建
  const TAG = 1048576;
  let maxStack = 0;
  for (let li = 0; li < legs.length; li++) {
    const l = legs[li];
    const cells = l.cells;
    if (!cells?.length) continue;
    // 竖直走过的列：列号都是整数坐标，和数组 includes 去重一样
    let vx = vxBuf;
    let nv = 0;
    for (let i = 1; i < cells.length; i++) {
      const a = cells[i - 1];
      const b = cells[i];
      if (a[0] !== b[0] || a[1] === b[1]) continue;
      const x = a[0];
      let has = false;
      for (let j = 0; j < nv; j++) {
        if (vx[j] === x) {
          has = true;
          break;
        }
      }
      if (has) continue;
      if (nv === vx.length) {
        const grown = new Float64Array(vx.length * 2);
        grown.set(vx);
        vxBuf = vx = grown;
      }
      vx[nv++] = x;
    }
    let trunk = false;
    let ring = false;
    let street = false;
    for (let j = 0; j < nv; j++) {
      const x = vx[j];
      if (side && x === corridor) trunk = true;
      else if (x <= xL || x >= xR) ring = true;
      else street = true;
    }
    l.road = trunk ? 'trunk' : ring ? 'ring' : street ? 'street' : 'local';
    roads[l.road]++;
    if (!nv) continue;
    // 同一段经过同一格只算一次
    const tag = base + li + 1;
    for (let ci = 0; ci < cells.length; ci++) {
      const cl = cells[ci];
      let onVx = false;
      for (let j = 0; j < nv; j++) {
        if (vx[j] === cl[0]) {
          onVx = true;
          break;
        }
      }
      if (!onVx) continue;
      const sx = cl[0] - xL + SM;
      const sy = cl[1] + SM;
      let v;
      if (sx >= 0 && sy >= 0 && sx < SW && sy < SH) {
        const k = sx * SH + sy;
        const t = LAST[k];
        if (t === tag) continue;
        v = (t > base ? CNT[k] : 0) + 1;
        CNT[k] = v;
        LAST[k] = tag;
      } else {
        if (!far) far = new Map();
        const k = gk(cl[0], cl[1]);
        const was = far.get(k) || 0;
        const last = was % TAG;
        if (last === li + 1) continue;
        v = (was - last) / TAG + 1;
        far.set(k, v * TAG + li + 1);
      }
      if (v > maxStack) maxStack = v;
    }
  }
  roads.maxStack = maxStack;
  return roads;
}

/** route() 的一步：读写共享的布局上下文 c */
export function liftLegs(c) {
  const { P, addPenalty, graph, height, itemBids, legs, opt, segments, stations, xR } = c;
  /**
   * 高架段的节点（不含两端的地面格），按流向排列。这里先按「地面格的下一个节点直接在第 L 层」生成水平部分，
   * 升降的那一叠（地面那一端格子的 1..L 层，RAMP_MAX_DZ = 0 时）记在 shadow 里，分配高度时一并占用；
   * 分配完再把 shadow 落成真正的一叠竖直带（见下面「升降落到实处」）。升降前后沿同一方向直走，
   * 拐弯只在地面或第 L 层上发生，不在升降的那一格拐（和游戏里手动拉的垂直传送带一样）。
   */
  const cellsFor = makeCellsFor(c);
  // 分配高度：先算出两两之间的约束（同格不能同层、压在别人升降叠上必须比它高），交给 levels.js 的 solveLevels，
  // 长的段尽量低、短的段去高层；maxLevel 层里放不下的放到更高的空层（加罚），再不行就记为断开（重罚），绝不重叠。
  // （2026/10/07 以前是「长的先排、放不下把挡路的请出去重排」，引力矩阵每次都把请出的预算耗光，高层的段也不会再落下来。）
  // 最高会试到 maxLevel + 24 层，固定乘 16 会把相邻格错误合并。
  const levelStride = opt.maxLevel + 25;
  // 高架格的归属表：按 (x, y, z) 编成一维下标的 Int32Array（代替 Map），每格存「代际 × 4096 + 段 ID + 2」，
  // 代际不同就当没人占，这样每次 route() 不用清零整张表。退火里 isFree / place 要查几万次，这里是热点。
  const GM = 24; // 四周留的余量（高架可能走到布局外一两格）
  const GH = height + 2 * GM;
  const GW = xR + 2 + 2 * GM;
  const grid = ownerGrid(GW * GH * levelStride);
  const G = grid.buf;
  const gen = grid.gen;
  if (legs.length + 2 >= 4096) throw new Error(`高架段太多（${legs.length}）`);
  /** (x, y) 的平面格号（不含层）；超出表的范围就报错，免得悄悄算错 */
  const planeIdx = (x, yy) => {
    const gx = x + GM;
    const gy = yy + GM;
    if (gx < 0 || gy < 0 || gx >= GW || gy >= GH) throw new Error(`高架格 (${x},${yy}) 超出归属表范围`);
    return gx * GH + gy;
  };
  /** (x, y) 第 0 层在归属表里的下标；第 z 层再加 z */
  const cellIdx = (x, yy) => planeIdx(x, yy) * levelStride;
  const ak = (x, yy, z) => cellIdx(x, yy) + z;
  // 平面格子的临时表：fixSt 这一戳记「固定的东西（物流站、喷涂保护区、形状随层变的段）占过这一格」，
  // solveLevels 问某段某层能不能放时，没碰到固定的东西的段不用逐格查归属表
  planeScratch(GW * GH);
  const PM = planeMark;
  const PV = planeVal;
  const PS = planeSeen;
  const PF = planeFix;
  const fixSt = ++planeStamp;
  let nFix = 0; // 记过几次：一次都没有时（不接站列、不喷涂、没有形状随层变的段，退火里最常见）谁都碰不到固定的东西
  const fixAt = (x, yy) => {
    PF[planeIdx(x, yy)] = fixSt;
    nFix++;
  };
  const NONE = -3; // 没人占
  /** 某个高架格归谁：段 ID、-1 物流站，没人占时 NONE */
  const ownerAt = (k) => {
    const v = G[k];
    return (v >>> 12) === gen ? (v & 4095) - 2 : NONE;
  };
  const setOwner = (k, id) => {
    G[k] = gen * 4096 + id + 2;
  };
  for (let si = 0; si < stations.length; si++) {
    const st = stations[si];
    for (let dx = -3; dx <= 3; dx++)
      for (let dy = -3; dy <= 3; dy++) {
        const b = cellIdx(st.x + dx, st.y + dy);
        for (let z = 1; z <= opt.maxLevel + 24; z++) setOwner(b + z, -1);
        fixAt(st.x + dx, st.y + dy);
      }
  }
  // 喷涂机空当的保护区（喷增产剂时才有）：候选格头顶两层、取料格邻格第 1 层不给高架用
  const guards = sprayGuards(c.segments, c.legs, true);
  for (let i = 0; i < guards.guard2.length; i++) {
    const x = guards.guard2[i][0];
    const yy = guards.guard2[i][1];
    const b = cellIdx(x, yy);
    setOwner(b + 1, -1);
    setOwner(b + 2, -1);
    fixAt(x, yy);
  }
  for (let i = 0; i < guards.guard1.length; i++) {
    const x = guards.guard1[i][0];
    const yy = guards.guard1[i][1];
    setOwner(ak(x, yy, 1), -1);
    fixAt(x, yy);
  }
  // 同一段同一层的格子只算一次：路径不随分配过程变（cellsFor 只读段本身和各段的几何）。
  // 第 1 层每段都要，按段 ID（legs 的下标）放数组；别的层（只有形状随层变的段才用到）放 Map，用到才建
  const cells1 = [];
  for (let i = 0; i < legs.length; i++) cells1.push(null);
  let cellCache = null;
  const cellsAt = (l, L) => {
    if (L === 1) {
      let c = cells1[l.id];
      if (!c) cells1[l.id] = c = cellsFor(l, 1);
      return c;
    }
    if (!cellCache) cellCache = new Map();
    const k = l.id * 64 + L;
    let c = cellCache.get(k);
    if (!c) cellCache.set(k, (c = cellsFor(l, L)));
    return c;
  };
  const conflicts = (l, L) => {
    const a = cellsAt(l, L);
    const cells = a.cells;
    const shadow = a.shadow;
    const who = new Set();
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      const o = ownerAt(ak(c[0], c[1], c[2]));
      if (o !== NONE && o !== l.id) who.add(o);
    }
    for (let i = 0; i < shadow.length; i++) {
      const c = shadow[i];
      const o = ownerAt(ak(c[0], c[1], c[2]));
      if (o !== NONE && o !== l.id) who.add(o);
    }
    // 同一段自己走回头路（格子重复）也算冲突
    const seen = new Set();
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      const k = ak(c[0], c[1], c[2]);
      if (seen.has(k)) who.add(-2);
      seen.add(k);
    }
    return { cells, shadow, who };
  };
  // 快速判断：多数高架段换高度只是 z 变了，路径不变。每段只算一次各格的格号，查某层时加上层号即可。
  // 形状随不随层变由 cellsFor 直接告诉（varies，只有退回原地升降的那几种），不用再算一遍第 2 层逐格比较。
  // pb：水平部分各格的平面格号；ps：升降那一叠的平面格号（去重，按出现顺序）。第 L 层在归属表里的下标是 平面格号 × levelStride + L。
  // 两串都放在 geoBuf 里（见文件开头），几何里记 geoBuf 里的开头和个数：pb 是 geoBuf[pbOff .. pbOff + pbLen)，ps 同理
  // 段 ID → 几何。段 ID 就是 legs 的下标：先按段数占满（元素类型从头到尾不变，按 ID 乱序写入也不会变成有洞的数组）
  geoTop = 0;
  const geoOf = [];
  for (let i = 0; i < legs.length; i++) geoOf.push(null);
  const geo = (l) => {
    let g = geoOf[l.id];
    if (g) return g;
    const a = cellsAt(l, 1);
    if (!a.varies) {
      const cs = a.cells;
      const pbOff = geoTop;
      for (let i = 0; i < cs.length; i++) geoPush(planeIdx(cs[i][0], cs[i][1]));
      const pbLen = geoTop - pbOff;
      // 升降那一叠的平面格：第 2 层的叠是第 1 层的每格再往上一格（RAMP_MAX_DZ = 0 时），去重后两者一样，用第 1 层的就行
      const sh = (RAMP_MAX_DZ === 0 ? a : cellsAt(l, 2)).shadow;
      const psOff = geoTop;
      for (let i = 0; i < sh.length; i++) {
        const p = planeIdx(sh[i][0], sh[i][1]);
        let has = false;
        for (let j = psOff; j < geoTop; j++) {
          if (geoBuf[j] === p) {
            has = true;
            break;
          }
        }
        if (!has) geoPush(p);
      }
      const psLen = geoTop - psOff;
      // 自己走回头路：水平部分有重复的格子
      const st = ++planeStamp;
      let dup = false;
      for (let i = pbOff; i < pbOff + pbLen; i++) {
        const p = geoBuf[i];
        if (PS[p] === st) dup = true;
        PS[p] = st;
      }
      g = { flat: true, pbOff, pbLen, psOff, psLen, dup };
    } else g = { flat: false, dup: false };
    geoOf[l.id] = g;
    return g;
  };
  const isFree = (l, L) => {
    const g = geo(l);
    if (g.dup) return false;
    if (!g.flat) return !conflicts(l, L).who.size;
    return flatFree(l.id, g.pbOff, g.pbLen, g.psOff, g.psLen, L);
  };
  /**
   * 只有高度变的段放第 L 层时，水平部分（平面格 geoBuf[pbOff..+pbLen)）和升降那一叠（平面格 geoBuf[psOff..+psLen)，
   * 占 1..L−RAMP_MAX_DZ 层）有没有被别人占
   */
  const flatFree = (id, pbOff, pbLen, psOff, psLen, L) => {
    const buf = geoBuf;
    for (let i = pbOff; i < pbOff + pbLen; i++) {
      const o = ownerAt(buf[i] * levelStride + L);
      if (o !== NONE && o !== id) return false;
    }
    for (let i = psOff; i < psOff + psLen; i++) {
      const p = buf[i];
      for (let z = 1; z <= L - RAMP_MAX_DZ; z++) {
        const o = ownerAt(p * levelStride + z);
        if (o !== NONE && o !== id) return false;
      }
    }
    return true;
  };
  // 放下：直接遍历格子，不拼临时数组
  const place = (l, L, cells, shadow) => {
    l.level = L;
    l.cells = cells;
    l.shadow = shadow;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      setOwner(ak(c[0], c[1], c[2]), l.id);
      fixAt(c[0], c[1]);
    }
    for (let i = 0; i < shadow.length; i++) {
      const c = shadow[i];
      setOwner(ak(c[0], c[1], c[2]), l.id);
      fixAt(c[0], c[1]);
    }
  };
  for (let i = 0; i < legs.length; i++) {
    const l = legs[i];
    l.cells = [];
    l.shadow = [];
    if (l.direct) l.level = 0;
  }
  const name = (l) => graph.items.get(l.itemId).name;
  const top = opt.maxLevel + 24;
  const settle = (l, L) => {
    const c = cellsAt(l, L);
    place(l, L, c.cells, c.shadow);
    if (L > opt.maxLevel) addPenalty('level', P.level * (L - opt.maxLevel), `${name(l)} 的高架段和别的高架段撞在一起（${opt.maxLevel} 层都占满了，升到第 ${L} 层）`, itemBids(l.itemId));
  };
  const broken = (l) => {
    l.broken = true;
    l.level = 0;
    addPenalty('route', P.route * 4, `${name(l)} 的高架段无处可放`, itemBids(l.itemId));
  };
  // 形状随层变的段（退回原地升降之类，很少）先按长的先排、放最低的空层，当成固定的；其余（只有高度变）交给 solveLevels。
  // 长的先排：按水平格数从多到少的稳定插入排序（一样长的保持原来的先后，和 Array.prototype.sort 的稳定排序同一个结果）
  const todo = [];
  const todoN = [];
  for (let li = 0; li < legs.length; li++) {
    const l = legs[li];
    if (l.direct) continue;
    const n = cellsAt(l, 1).cells.length;
    let i = todo.length;
    todo.push(l);
    todoN.push(n);
    while (i > 0 && todoN[i - 1] < n) {
      todo[i] = todo[i - 1];
      todoN[i] = todoN[i - 1];
      i--;
    }
    todo[i] = l;
    todoN[i] = n;
  }
  // 带喷涂窗口的段（layout/belts.js 的 legOut：喷涂机骑在紧挨段尾的 5 格上）：窗口候选格头顶两层、取料格候选两侧一层也不能有别的段，
  // 和地面空当的保护区一样，只是层数跟着这截高架定下来的层走。所以这些段先排（和形状随层变的一起、长的先），放下以后保护区当成固定的东西占住
  const winCells = (l) => sprayGapCells(segments[l.spray.seg]);
  const winFree = (l, L) => {
    const cells = winCells(l);
    const y = segments[l.spray.seg].y;
    for (let i = 0; i < cells.length; i++) for (const z of [L + 1, L + 2]) {
      const o = ownerAt(ak(cells[i], y, z));
      if (o !== NONE && o !== l.id) return false;
    }
    for (let i = 0; i < 2 && i < cells.length; i++) for (const yy of [y - 1, y + 1]) {
      const o = ownerAt(ak(cells[i], yy, L + 1));
      if (o !== NONE && o !== l.id) return false;
    }
    return true;
  };
  const winPlace = (l, L) => {
    const cells = winCells(l);
    const y = segments[l.spray.seg].y;
    for (let i = 0; i < cells.length; i++) {
      for (const z of [L + 1, L + 2]) setOwner(ak(cells[i], y, z), -1);
      fixAt(cells[i], y);
    }
    for (let i = 0; i < 2 && i < cells.length; i++) for (const yy of [y - 1, y + 1]) {
      setOwner(ak(cells[i], yy, L + 1), -1);
      fixAt(cells[i], yy);
    }
  };
  // 先按排好的次序把每段的几何算出来、挑出只有高度变的段，再排形状随层变的段和带窗口的段（几何和排没排下无关）
  const flat = [];
  for (let i = 0; i < todo.length; i++) if (geo(todo[i]).flat && !todo[i].spray) flat.push(todo[i]);
  for (let i = 0; i < todo.length; i++) {
    const l = todo[i];
    if (geo(l).flat && !l.spray) continue;
    let L = 1;
    if (l.spray) {
      while (L <= top && !(isFree(l, L) && winFree(l, L))) L++;
      if (L <= top) {
        settle(l, L);
        winPlace(l, L);
      } else broken(l);
      continue;
    }
    while (L <= top && !isFree(l, L)) L++;
    if (L <= top) settle(l, L);
    else broken(l);
  }
  const n = flat.length;
  const neq = Array.from({ length: n }, () => new Set());
  const above = Array.from({ length: n }, () => new Set());
  const bad = flat.map((l) => geo(l).dup);
  // 每个平面格子上有哪些段：水平部分记 2k，升降那一叠记 2k + 1。
  // 格子按第一次出现的顺序编槽号（逐对加约束的顺序和以前按 Map 插入顺序遍历一样），每槽的段按加入顺序串成链，
  // 用平面临时表代替以格号为键的 Map 和每格一个小数组
  let nE = 0;
  for (let k = 0; k < n; k++) nE += geo(flat[k]).pbLen + geo(flat[k]).psLen;
  atScratch(nE);
  const slotHead = atHead;
  const slotTail = atTail;
  const slotCnt = atCnt;
  const nextE = atNext;
  const valE = atVal;
  const atSt = ++planeStamp;
  let nS = 0;
  let nE2 = 0;
  const putAt = (p, v) => {
    let sl;
    if (PM[p] === atSt) {
      sl = PV[p];
      nextE[slotTail[sl]] = nE2;
    } else {
      PM[p] = atSt;
      PV[p] = sl = nS++;
      slotHead[sl] = nE2;
    }
    slotTail[sl] = nE2;
    slotCnt[sl]++;
    valE[nE2++] = v;
  };
  for (let k = 0; k < n; k++) {
    const g = geo(flat[k]);
    const buf = geoBuf;
    for (let i = g.pbOff; i < g.pbOff + g.pbLen; i++) putAt(buf[i], 2 * k);
    for (let i = g.psOff; i < g.psOff + g.psLen; i++) putAt(buf[i], 2 * k + 1);
  }
  const list = atList;
  const usePair = n <= PAIR_MAX;
  if (usePair) {
    if (pairNeq.length < n * n || pairStamp >= 2e9) {
      pairNeq = new Int32Array(Math.max(n * n, pairNeq.length));
      pairAbove = new Int32Array(Math.max(n * n, pairAbove.length));
      pairStamp = 0;
    }
    pairStamp++;
  }
  const pst = pairStamp;
  for (let sl = 0; sl < nS; sl++) {
    const m = slotCnt[sl];
    if (m < 2) continue;
    for (let u = 0, q = slotHead[sl]; u < m; u++, q = nextE[q]) list[u] = valE[q];
    for (let u = 0; u < m; u++)
      for (let v = u + 1; v < m; v++) {
        const i = list[u] >> 1;
        const j = list[v] >> 1;
        if (i === j) continue;
        const ri = list[u] & 1;
        const rj = list[v] & 1;
        if (!ri && !rj) {
          if (usePair) {
            const key = i < j ? i * n + j : j * n + i;
            if (pairNeq[key] === pst) continue;
            pairNeq[key] = pst;
          }
          neq[i].add(j);
          neq[j].add(i);
        } else if (!ri && rj) {
          if (usePair) {
            const key = i * n + j;
            if (pairAbove[key] === pst) continue;
            pairAbove[key] = pst;
          }
          above[i].add(j);
        } else if (ri && !rj) {
          if (usePair) {
            const key = j * n + i;
            if (pairAbove[key] === pst) continue;
            pairAbove[key] = pst;
          }
          above[j].add(i);
        } else bad[flat[i].cells.length <= flat[j].cells.length ? i : j] = true;
      }
  }
  const len = flat.map((l) => cellsAt(l, 1).cells.length + geo(l).psLen);
  // 第 L 层和固定的东西冲不冲突（就是 isFree）：只有固定的东西占过的平面格才可能有人，每段先挑出这几格（多数段一格都没有），
  // 之后每次只查它们。自己走回头路的段哪一层都不行（null）
  const touchOf = [];
  for (let k = 0; k < n; k++) touchOf.push(undefined); // 先占满（元素类型不变），undefined 表示还没挑
  // 挑出来的那几格也接着排在 geoBuf 里（按原来的先后），记开头和个数
  const none = { pbOff: 0, pbLen: 0, psOff: 0, psLen: 0 };
  const touched = (off, len) => {
    for (let i = off; i < off + len; i++) {
      const p = geoBuf[i];
      if (PF[p] === fixSt) geoPush(p);
    }
  };
  const fixedOk = (k, L) => {
    let t = touchOf[k];
    if (t === undefined) {
      const g = geo(flat[k]);
      if (g.dup) t = null;
      else if (nFix === 0) t = none;
      else {
        const pbOff = geoTop;
        touched(g.pbOff, g.pbLen);
        const psOff = geoTop;
        touched(g.psOff, g.psLen);
        t = { pbOff, pbLen: psOff - pbOff, psOff, psLen: geoTop - psOff };
      }
      touchOf[k] = t;
    }
    return t !== null && flatFree(flat[k].id, t.pbOff, t.pbLen, t.psOff, t.psLen, L);
  };
  const lv = solveLevels(n, { len, neq, above, bad, fixedOk, maxLevel: opt.maxLevel, top });
  // 只有高度变的段：直接按第 1 层的格子落到分到的层（见 realizeFlat）。之后再没有人查归属表，不用再写
  const isFlat = new Uint8Array(legs.length);
  for (let k = 0; k < n; k++) {
    const l = flat[k];
    const L = lv[k];
    if (!L) {
      broken(l);
      continue;
    }
    isFlat[l.id] = 1;
    l.level = L;
    if (L > opt.maxLevel) addPenalty('level', P.level * (L - opt.maxLevel), `${name(l)} 的高架段和别的高架段撞在一起（${opt.maxLevel} 层都占满了，升到第 ${L} 层）`, itemBids(l.itemId));
  }

  for (let li = 0; li < legs.length; li++) {
    const l = legs[li];
    if (isFlat[l.id]) {
      realizeFlat(l, cellsAt(l, 1), l.level);
      continue;
    }
    if (!l.cells?.length || l.broken || !(l.level > RAMP_MAX_DZ)) continue;
    realizeLeg(l, cellsAt(l, l.level));
  }
  c.roads = roadStats(c);
}

/**
 * 快速评估（route 的 quick 模式）：高度分配只做「长的先排、第一层不冲突就放」的一遍（不请出重排）。
 * 冲突按平面格子算，和完整算法同一套规则：两段高架经过同一格就不能同层；一段升降那一叠占 1..L 层，
 * 别的段从它上空经过必须更高（反过来，自己从别人的叠上经过必须更高）。排不进 maxLevel 层的按 level 计罚，
 * 两头的约束互相矛盾（必须比对方低又比对方高）时也按多占一层计罚，一段自己走回头路按无处可放计罚。
 * 搜索的全局阶段用它：比完整评估省掉请出重排那部分时间，判断和完整算法基本一致（完整算法多一次请出重排，只会更好）。
 */
export function estimateLegs(c) {
  const { P, addPenalty, graph, itemBids, legs, opt } = c;
  const cellsFor = makeCellsFor(c);
  const paths = []; // { l, r, keys, ends }
  for (const l of legs) {
    l.cells = [];
    l.shadow = [];
    l.level = 0;
    if (l.direct) continue;
    const r = cellsFor(l, 1);
    if (!r.cells.length) continue;
    const mine = new Set();
    let dup = false;
    for (const [x, y] of r.cells) {
      const k = gk(x, y);
      if (mine.has(k)) dup = true;
      mine.add(k);
    }
    if (dup) {
      l.broken = true;
      addPenalty('route', P.route * 4, `${graph.items.get(l.itemId).name} 的高架段无处可放`, itemBids(l.itemId));
      continue;
    }
    const ends = new Set();
    for (const e of [r.rise, r.drop]) if (e) ends.add(gk(e[0], e[1]));
    for (const e of [...r.pre, ...r.post]) mine.add(gk(e[0], e[1]));
    for (const k of ends) mine.add(k);
    paths.push({ l, r, keys: [...mine], ends, n: r.cells.length });
  }
  // 长的先排；每段取第一层满足约束的
  paths.sort((a, b) => b.n - a.n);
  const at = new Map(); // 格 -> 已放下的段 [{ L, end }]
  // 喷涂机空当的保护区：当成已经放着的「叠」，候选格头顶按 2 层、取料格邻格按 1 层算，别的段从上面过要更高
  const guards = sprayGuards(c.segments, c.legs, true);
  for (const [h, list] of [[2, guards.guard2], [1, guards.guard1]]) {
    for (const [x, y] of list) {
      const k = gk(x, y);
      if (!at.has(k)) at.set(k, []);
      at.get(k).push({ L: h, end: true });
    }
  }
  // 带喷涂窗口的段（layout/belts.js 的 legOut）：窗口候选格头顶两层、取料格候选两侧一层也不能有别的段（完整算法见 liftLegs 的 winFree）
  const winOf = (l) => {
    if (!l.spray) return null;
    const s = c.segments[l.spray.seg];
    const cells = sprayGapCells(s);
    return { head: cells.map((x) => gk(x, s.y)), side: cells.slice(0, 2).flatMap((x) => [gk(x, s.y - 1), gk(x, s.y + 1)]) };
  };
  const winBlocked = (w, L) => {
    for (const k of w.head) for (const o of at.get(k) ?? []) if (!o.end && (o.L === L + 1 || o.L === L + 2)) return true;
    for (const k of w.side) for (const o of at.get(k) ?? []) if (!o.end && o.L === L + 1) return true;
    return false;
  };
  for (const p of paths) {
    const used = new Set();
    let lo = 1;
    let hi = Infinity;
    for (const k of p.keys) {
      const ls = at.get(k);
      if (!ls) continue;
      const myEnd = p.ends.has(k);
      for (const o of ls) {
        if (o.end) lo = Math.max(lo, o.L + 1); // 从别人的叠上经过：要更高
        if (myEnd) hi = Math.min(hi, o.L - 1); // 别人从我的叠上经过：我要更低
        if (!o.end && !myEnd) used.add(o.L);
      }
    }
    const w = winOf(p.l);
    let L = lo;
    while (used.has(L) || (w && winBlocked(w, L))) L++;
    let over = Math.max(0, L - opt.maxLevel);
    if (L > hi) over += 1; // 两头的约束矛盾：完整算法要靠请出重排才可能放下，按多占一层计
    p.l.level = L;
    p.l.cells = p.r.cells;
    realizeLeg(p.l, p.r);
    for (const k of p.keys) {
      if (!at.has(k)) at.set(k, []);
      at.get(k).push({ L, end: p.ends.has(k) });
    }
    if (w) {
      // 窗口的保护区当成已经放着的叠：头顶按 L+2 层、两侧按 L+1 层，后排的段从上面过要更高
      for (const k of w.head) {
        if (!at.has(k)) at.set(k, []);
        at.get(k).push({ L: L + 2, end: true });
      }
      for (const k of w.side) {
        if (!at.has(k)) at.set(k, []);
        at.get(k).push({ L: L + 1, end: true });
      }
    }
    if (over) addPenalty('level', P.level * over, `${graph.items.get(p.l.itemId).name} 的高架段和别的高架段撞在一起（${opt.maxLevel} 层都占满了，升到第 ${L} 层）`, itemBids(p.l.itemId));
  }
  c.roads = roadStats(c);
}
