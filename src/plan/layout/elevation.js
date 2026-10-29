// 高架：每段高架的格子、逐段分配高度（可请出重排）、升降落成原地竖直的一叠、路网统计
import { RAMP_MAX_DZ } from '../../gamedata.js';
import { gk, line, portRays } from './shared.js';
import { solveLevels, toCsr } from './levels.js';

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

// 两段之间的约束（不能同层 neq、必须更高 above）：原来每段一个 Set（n ≤ 512 时再用 n × n 的戳表挡掉重复的 add），
// 现在按原来 add 的先后记成边（行 = 哪一段的表，值 = 对面那段），加完用 levels.js 的 toCsr 按行排成 CSR 交给 solveLevels。
// toCsr 同一行按记下的先后、重复的只留第一次——和往 Set 里 add 一样（已有的再 add 不变，先后也不变），
// 所以每行的元素和遍历顺序跟原来的 Set 一模一样，段数多少都成立，戳表也不要了。缓冲区按线程复用：边用满了换两倍大的，别的不够大才换
let neqE = new Int32Array(2048); // 第 t 条边：行 neqE[2t]、值 neqE[2t + 1]
let neqTop = 0;
let aboveE = new Int32Array(2048);
let aboveTop = 0;
function pushNeq(i, j) {
  if (2 * neqTop + 2 > neqE.length) {
    const grown = new Int32Array(neqE.length * 2);
    grown.set(neqE);
    neqE = grown;
  }
  neqE[2 * neqTop] = i;
  neqE[2 * neqTop + 1] = j;
  neqTop++;
}
function pushAbove(i, j) {
  if (2 * aboveTop + 2 > aboveE.length) {
    const grown = new Int32Array(aboveE.length * 2);
    grown.set(aboveE);
    aboveE = grown;
  }
  aboveE[2 * aboveTop] = i;
  aboveE[2 * aboveTop + 1] = j;
  aboveTop++;
}
let neqOff = new Int32Array(0);
let neqAdj = new Int32Array(0);
let aboveOff = new Int32Array(0);
let aboveAdj = new Int32Array(0);

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
      } else if (leg.bus != null) {
        // 侧边总线（layout/ports.js）：口在右边布局外最外那一列，原地升起往里走到自己那一列，沿这一列竖着走到段那一行，再往里走到段首落下。
        // 排在左边的（busSide 'auto'）镜像：口在左边最外那一列，往里是往右
        const di = leg.bus < leg.edge ? -1 : 1; // 往里走的方向
        const dy = Math.sign(s.y - leg.py);
        runX(cells, leg.edge + di, leg.bus, di, leg.py, L);
        runY(cells, leg.py + dy, s.y, dy, leg.bus, L);
        runX(cells, leg.bus + d, s.entryX - d, d, s.y, L);
        ramp(r, L, leg.edge, leg.py, leg.edge + di, leg.py);
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
  // 右边从最靠外的出入口算起：侧边总线的口在布局外、每条原料带各占一列（layout/ports.js），原料带多的大线能排出去几十列。
  // 下标只用到 GH，宽只管表开多大，所以没排出去的线一格不变。
  // 左边从最靠外的总线口算起（busSide 'auto' 时总线可以排在左边布局外，口在 x < 0）：没有排到左边的总线时 xIn 是 0，表和下标都和原来一样
  let xOut = xR;
  let xIn = 0;
  for (let i = 0; i < legs.length; i++) {
    const e = legs[i].edge;
    if (e > xOut) xOut = e;
    else if (e < xIn && legs[i].bus != null) xIn = e;
  }
  const GX = GM - xIn; // x 方向左边留的余量
  const GW = xOut - xIn + 2 + 2 * GM;
  const grid = ownerGrid(GW * GH * levelStride);
  const G = grid.buf;
  const gen = grid.gen;
  if (legs.length + 2 >= 4096) throw new Error(`高架段太多（${legs.length}）`);
  /** (x, y) 的平面格号（不含层）；超出表的范围就报错，免得悄悄算错 */
  const planeIdx = (x, yy) => {
    const gx = x + GX;
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
  // 桥段（leg.bridge，竖直那截从熔炉、制造台头顶过）：最低第 bridgeLevel 层，超过 bridgeMaxLevel 层才罚；普通段从第 1 层起、超过 maxLevel 罚。
  // 桥关着时不读 leg.bridge。记 level 惩罚的两处照原来写在原地（2026/10/19 量过：换成一个共用的小函数，下面分层后那一圈
  // 每段调一次，bench 的 route() 就慢 10%~35%，原因没查清）
  const bridgeOn = !!opt.bridges;
  const lowOf = (l) => (bridgeOn && l.bridge ? opt.bridgeLevel : 1);
  const capOf = (l) => (bridgeOn && l.bridge ? opt.bridgeMaxLevel : opt.maxLevel);
  const settle = (l, L) => {
    const c = cellsAt(l, L);
    place(l, L, c.cells, c.shadow);
    const cap = bridgeOn && l.bridge ? opt.bridgeMaxLevel : opt.maxLevel;
    if (L > cap) addPenalty('level', P.level * (L - cap), `${name(l)} 的高架段和别的高架段撞在一起（${cap} 层都占满了，升到第 ${L} 层）`, itemBids(l.itemId));
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
    let L = lowOf(l);
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
  neqTop = 0;
  aboveTop = 0;
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
  // 约束按原来 add 的先后记成边（neq 两边各一条，先 i 行后 j 行），加完排成 CSR
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
          pushNeq(i, j);
          pushNeq(j, i);
        } else if (!ri && rj) pushAbove(i, j);
        else if (ri && !rj) pushAbove(j, i);
        else bad[flat[i].cells.length <= flat[j].cells.length ? i : j] = true;
      }
  }
  if (neqOff.length < n + 1) neqOff = new Int32Array(Math.max(n + 1, Math.ceil(neqOff.length * 1.5)));
  if (aboveOff.length < n + 1) aboveOff = new Int32Array(Math.max(n + 1, Math.ceil(aboveOff.length * 1.5)));
  if (neqAdj.length < neqTop) neqAdj = new Int32Array(Math.max(neqTop, Math.ceil(neqAdj.length * 1.5)));
  if (aboveAdj.length < aboveTop) aboveAdj = new Int32Array(Math.max(aboveTop, Math.ceil(aboveAdj.length * 1.5)));
  toCsr(n, neqE, neqTop, neqOff, neqAdj);
  toCsr(n, aboveE, aboveTop, aboveOff, aboveAdj);
  const neq = { off: neqOff, adj: neqAdj };
  const above = { off: aboveOff, adj: aboveAdj };
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
  // 有桥段时才给每段的最低层、不罚的最高层（关着时不建，solveLevels 照原来的走）
  let minLevel = null;
  let maxLevels = null;
  for (let k = 0; bridgeOn && k < n; k++) {
    if (!flat[k].bridge) continue;
    minLevel = flat.map(lowOf);
    maxLevels = flat.map(capOf);
    break;
  }
  const lv = solveLevels(n, { len, neq, above, bad, fixedOk, maxLevel: opt.maxLevel, top, minLevel, maxLevels, onGreedy: c.elevAsk ?? null, hookCtx: c });
  if (lv === null) return; // 局部搜索之前那一问拒了（route.js 的 layout() 看 c.elevRejected，这次评估作废）
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
    const cap = bridgeOn && l.bridge ? opt.bridgeMaxLevel : opt.maxLevel;
    if (L > cap) addPenalty('level', P.level * (L - cap), `${name(l)} 的高架段和别的高架段撞在一起（${cap} 层都占满了，升到第 ${L} 层）`, itemBids(l.itemId));
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
 * 不用原地升降（route.js 的 noLift，用户 2026/10/28：最低配置默认没解锁「超级磁场发生器」，蓝图里不能有原地竖直升降）。
 * 每段高架的平面路径照旧（cellsFor 第 1 层的格子），高度改成逐格的剖面：相邻两格最多差 RAMP_STEP（半层）——没解锁时贴得上的坡
 * （docs/game-rules.md 第 38 条）；中间的格子在 0.5 层以上，或者落在空着的地面上（和 plan/ground.js 的落地一个意思，那一步这时不做）。
 * 高度用半层计（第 k 个半层 = z k/2，第 0 个是地面），同一格里两段至少隔一个半层（gamedata.js 的 LEVEL_GAP），这些不能用：
 *   物流站 7×7 的所有高度；分拣器手臂那几格（从带子到工厂边）的地面和 0.5 层（手臂离地约 0.7~1.0 m，0.5 层的带子会穿在一起，推断）；
 *   喷涂空当候选格的地面到 2.5 层、取料格两侧的地面和第 1 层（同 liftLegs 的保护区）；桥段在熔炉、制造台头顶低于第 bridgeLevel 层；
 *   地面上已经有东西的格（地面段、出入口和它们往外留空的那一行、工厂和储物仓本体）；每段两头那一格的 0.5 层留给它自己。
 * 同一格前后两节都和别的段挨着走（同一条边）时，两段的上下不能在这条边上对调（不然在半路交叉）。
 * 排法：长的先排（同 liftLegs），每段在上面这些限制下做一遍动态规划挑剖面：每格每个半层计 RAMP_CELL、每变一次高度计 RAMP_CHANGE
 * （转弯那格变高度再加 RAMP_TURN），尽量低、少起伏。排不下的段算断开（同 liftLegs 的「无处可放」）；最高超过 maxLevel 按超出的层数计 level 罚。
 * 形状随层变的段（cellsFor 退回原地升降那几种）、带喷涂窗口的段（喷涂机要平的一截）、自己走回头路的段也算断开。
 * 分配完直接落成最终格子（没有升降那一叠），c.roads 照算
 */
const RAMP_CELL = 0.1;
const RAMP_CHANGE = 1;
const RAMP_TURN = 0.5;
/** 一次最多试着修几段排不下的（每段最多和 RAMP_RIVALS 段换先后）：断开很多段的排法本来就不会被选上，修多了只是费时间 */
const RAMP_REPAIR = 8;
const RAMP_RIVALS = 4;
// rampLegs 的平面表（按线程复用）：每格一个戳，戳不是这一次的就当空着。blk 固定挡住的半层位，occ 已排的段占的半层位，
// rsv 留给哪一段的 0.5 层（段号 + 1），ovr 桥段要垫高的工厂头顶，head 每格往 +x、+y 两条边上记的段（链表头，条目号 + 1）
let rpStamp = new Int32Array(0);
let rpBlk = new Int32Array(0);
let rpOcc = new Int32Array(0);
let rpRsv = new Int32Array(0);
let rpOvr = new Uint8Array(0);
let rpHead = new Int32Array(0);
let rpGen = 0;
// 边上的条目：下一条、哪一段、这条边小格号那头的半层、另一头的半层
let reNext = new Int32Array(1024);
let reLeg = new Int32Array(1024);
let reA = new Int8Array(1024);
let reB = new Int8Array(1024);
// 动态规划的表
let rpCost = new Float64Array(0);
let rpFrom = new Int8Array(0);
export function rampLegs(c) {
  const { P, addPenalty, graph, itemBids, legs, opt, segments, stations, ports, pos, rowCy } = c;
  const cellsFor = makeCellsFor(c);
  const K = Math.min(30, 2 * (opt.maxLevel + 2)); // 最高到第几个半层（再高算无处可放）
  const ALL = 2 ** (K + 1) - 1; // 第 0..K 个半层（第 0 个是地面）
  // 排的次序：长的先排（水平格数从多到少，一样长保持原来的先后），同 liftLegs
  const todo = [];
  for (const l of legs) {
    l.cells = [];
    l.shadow = [];
    l.level = 0;
    if (l.direct) continue;
    const r = cellsFor(l, 1);
    todo.push({ l, r, n: r.cells.length, idx: todo.length });
  }
  todo.sort((a, b) => b.n - a.n); // Array.prototype.sort 是稳定的
  const name = (l) => graph.items.get(l.itemId).name;
  // 平面表的范围：各段走过的格和两头接地面的格，四周留 1 格
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  const span = (q) => {
    if (q[0] < x0) x0 = q[0];
    if (q[0] > x1) x1 = q[0];
    if (q[1] < y0) y0 = q[1];
    if (q[1] > y1) y1 = q[1];
  };
  for (const t of todo) {
    for (const q of t.r.cells) span(q);
    if (t.r.rise) span(t.r.rise);
    if (t.r.drop) span(t.r.drop);
  }
  if (x0 > x1) {
    c.roads = roadStats(c);
    return;
  }
  x0--;
  y0--;
  x1++;
  y1++;
  const HH = y1 - y0 + 1;
  const size = (x1 - x0 + 1) * HH;
  if (rpStamp.length < size || rpGen >= 2e9) {
    const m = Math.max(size, Math.ceil(rpStamp.length * 1.5));
    rpStamp = new Int32Array(m);
    rpBlk = new Int32Array(m);
    rpOcc = new Int32Array(m);
    rpRsv = new Int32Array(m);
    rpOvr = new Uint8Array(m);
    rpHead = new Int32Array(2 * m);
    rpGen = 0;
  }
  const gen = ++rpGen;
  const ST = rpStamp;
  const BLK = rpBlk;
  const OCC = rpOcc;
  const RSV = rpRsv;
  const OVR = rpOvr;
  const HEAD = rpHead;
  const at = (x, y) => (x < x0 || x > x1 || y < y0 || y > y1 ? -1 : (x - x0) * HH + (y - y0));
  const touch = (i) => {
    if (ST[i] !== gen) {
      ST[i] = gen;
      BLK[i] = 0;
      OCC[i] = 0;
      RSV[i] = 0;
      OVR[i] = 0;
      HEAD[2 * i] = 0;
      HEAD[2 * i + 1] = 0;
    }
  };
  const blockAt = (x, y, m) => {
    const i = at(x, y);
    if (i < 0) return;
    touch(i);
    BLK[i] |= m;
  };
  // 固定挡住的：物流站 7×7 的所有高度；喷涂空当候选格的地面到 2.5 层、取料格两侧的地面和第 1 层；
  // 分拣器手臂那几格的地面和 0.5 层（下侧的分拣器从带子往上伸到工厂、上侧的往下）；地面上已经有东西的格（地面段、出入口和它们往外留空的那一行）
  for (const st of stations) for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) blockAt(st.x + dx, st.y + dy, ALL);
  const guards = sprayGuards(segments, legs, true);
  for (const [x, y] of guards.guard2) blockAt(x, y, 0b111111);
  for (const [x, y] of guards.guard1) blockAt(x, y, 0b101);
  for (const s of c.sorterPlan?.sorters ?? []) {
    if (s.stub || s.segId == null) continue;
    const seg = segments[s.segId];
    const sg = s.side === 'top' ? -1 : 1;
    for (let k = 0; k < s.length; k++) blockAt(s.col, seg.y + sg * k, 0b11);
  }
  for (const s of segments) {
    if (s.y < y0 || s.y > y1) continue;
    for (let x = Math.max(s.a, x0); x <= Math.min(s.b, x1); x++) blockAt(x, s.y, 1);
  }
  for (const q of ports) blockAt(q.x, q.y, 1);
  for (const [x, y] of portRays({ ports, width: c.xR + 1 })) if (x >= x0 && x <= x1) blockAt(x, y, 1);
  for (const t of todo) for (const q of [t.r.rise, t.r.drop, ...t.r.pre, ...t.r.post]) if (q) blockAt(q[0], q[1], 1); // 各段两头接地面的那一格、走廊里多走的那一格
  // 桥段（route.js 的 bridges）：熔炉、制造台本体头顶的格子低于第 bridgeLevel 层不行
  const lowBits = 2 ** Math.min(K + 1, 2 * (opt.bridgeLevel ?? 4)) - 1;
  if (opt.bridges) {
    pos.forEach((p) => {
      if (p.g.kind !== 'smelter' && p.g.kind !== 'assembler') return;
      const cy = rowCy[p.row];
      for (let x = Math.max(p.x0, x0); x <= Math.min(p.x1, x1); x++) for (let y = cy - p.g.bodyBelow; y <= cy + p.g.bodyAbove; y++) {
        const i = Number.isInteger(x) && Number.isInteger(y) ? at(x, y) : -1;
        if (i < 0) continue;
        touch(i);
        OVR[i] = 1;
      }
    });
  }
  // 每段不随排法变的东西：平面格号、地面那两头、转弯的格；两头那一格的 0.5 层先替它留着（坡从这里起；那一格空着的地面它自己也能用）
  for (const t of todo) {
    const { l, r, n } = t;
    if (!n) continue;
    if (r.varies) t.why = '这里只能原地升降';
    else if (l.spray) t.why = '喷涂机要骑在平的一截高架上';
    const cs = r.cells;
    t.keys = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const k = at(cs[i][0], cs[i][1]);
      t.keys[i] = k;
      touch(k);
    }
    if (!t.why && new Set(t.keys).size < n) t.why = '自己走回头路';
    if (t.why) continue;
    t.rise = r.rise ? at(r.rise[0], r.rise[1]) : -1;
    t.drop = r.drop ? at(r.drop[0], r.drop[1]) : -1;
    if (t.rise >= 0) touch(t.rise);
    if (t.drop >= 0) touch(t.drop);
    const prevOf = (i) => (i > 0 ? cs[i - 1] : r.rise ?? null);
    const nextOf = (i) => (i + 1 < n ? cs[i + 1] : r.drop ?? null);
    t.turn = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const a = prevOf(i);
      const b = nextOf(i);
      const q = cs[i];
      if (a && b && (q[0] - a[0] !== b[0] - q[0] || q[1] - a[1] !== b[1] - q[1])) t.turn[i] = 1;
    }
    for (const k of [t.keys[0], t.keys[n - 1]]) if (!RSV[k]) RSV[k] = t.idx + 1;
  }
  const release = (t) => {
    for (const k of [t.keys[0], t.keys[t.n - 1]]) if (RSV[k] === t.idx + 1) RSV[k] = 0;
  };
  // 边：格 i 往 +x（dir 0）或 +y（dir 1）那条，条目记两头的半层（a 在格 i、b 在邻格）和是哪一次记进来的（每段每记一次换一个号）；
  // alive[号] 为 0 的条目当不存在：拿掉一段只关它这次的号，放回原样再打开，重新记一遍的换新号（旧的条目一直关着）
  let eTop = 0;
  let cTop = 0;
  let alive = new Uint8Array(todo.length * 2 + 8);
  const legCid = new Int32Array(todo.length);
  /** 从格 p 走到相邻的格 q 那条边的槽：p 是小那头时 2p+dir、flip 0；q 是小那头时 2q+dir、flip 1（格号按 x 优先排，+x 一格差 HH） */
  let eSlot = 0;
  let eFlip = 0;
  const edgeOf = (p, q) => {
    if (q === p + HH) {
      eSlot = 2 * p;
      eFlip = 0;
    } else if (q === p - HH) {
      eSlot = 2 * q;
      eFlip = 1;
    } else if (q === p + 1) {
      eSlot = 2 * p + 1;
      eFlip = 0;
    } else {
      eSlot = 2 * q + 1;
      eFlip = 1;
    }
  };
  const grow = (a) => {
    const b = new a.constructor(a.length * 2);
    b.set(a);
    return b;
  };
  const putEdge = (p, kp, q, kq, leg) => {
    edgeOf(p, q);
    if (eTop === reNext.length) {
      reNext = grow(reNext);
      reLeg = grow(reLeg);
      reA = grow(reA);
      reB = grow(reB);
    }
    reNext[eTop] = HEAD[eSlot];
    reLeg[eTop] = leg;
    reA[eTop] = eFlip ? kq : kp;
    reB[eTop] = eFlip ? kp : kq;
    HEAD[eSlot] = ++eTop;
  };
  const W = K + 1;
  const INF = Infinity;
  /**
   * 在已排的段之外给段 t 挑剖面（动态规划：cost[i·W + k] 走到第 i 格、在第 k 个半层的最小代价）。从地面那一头上来，第 0 格只能在地面或 0.5 层；
   * 最后一格也一样（落地那一步也算一次变高度）。同一条边上挨着已排的段走时不能和它对调上下。排不下返回 null
   */
  const solve = (t) => {
    const { l, n, keys } = t;
    if (rpCost.length < n * W) {
      rpCost = new Float64Array(n * W * 2);
      rpFrom = new Int8Array(n * W * 2);
    }
    const cost = rpCost;
    const from = rpFrom;
    cost.fill(INF, 0, n * W);
    const me = t.idx + 1;
    const bridge = !!l.bridge;
    let k0 = keys[0];
    let bad = BLK[k0] | OCC[k0] | (RSV[k0] && RSV[k0] !== me ? 0b10 : 0) | (bridge && OVR[k0] ? lowBits : 0);
    // 两头接地面那两条边也不能和已排的段对调上下（地面那头在第 0 个半层）
    const edgeOk = (p, q, kp, kq) => {
      edgeOf(p, q);
      for (let e = HEAD[eSlot]; e; e = reNext[e - 1]) {
        if (!alive[reLeg[e - 1]]) continue;
        const a = eFlip ? reB[e - 1] : reA[e - 1]; // 别的段在 p 格的半层
        const b = eFlip ? reA[e - 1] : reB[e - 1]; // 在 q 格的
        if (kp > a !== kq > b) return false;
      }
      return true;
    };
    for (let k = 0; k <= 1; k++) if (!(bad & (1 << k)) && (t.rise < 0 || edgeOk(t.rise, keys[0], 0, k))) cost[k] = RAMP_CELL * k + (k ? RAMP_CHANGE : 0);
    for (let i = 1; i < n; i++) {
      k0 = keys[i];
      bad = BLK[k0] | OCC[k0] | (RSV[k0] && RSV[k0] !== me ? 0b10 : 0) | (bridge && OVR[k0] ? lowBits : 0);
      edgeOf(keys[i - 1], k0);
      const flip = eFlip;
      let e = HEAD[eSlot];
      while (e && !alive[reLeg[e - 1]]) e = reNext[e - 1];
      const turnHere = t.turn[i] || t.turn[i - 1];
      const base = (i - 1) * W;
      for (let k = 0; k <= K; k++) {
        if (bad & (1 << k)) continue;
        let best = INF;
        let arg = 0;
        const lo = k > 0 ? k - 1 : 0;
        const hi = k < K ? k + 1 : K;
        for (let kp = lo; kp <= hi; kp++) {
          const v = cost[base + kp];
          if (v === INF) continue;
          if (e) {
            let cross = false;
            for (let q = e; q; q = reNext[q - 1]) {
              if (!alive[reLeg[q - 1]]) continue;
              const a = flip ? reB[q - 1] : reA[q - 1]; // 别的段在第 i−1 格的半层
              const b = flip ? reA[q - 1] : reB[q - 1]; // 在第 i 格的
              if (kp > a !== k > b) {
                cross = true;
                break;
              }
            }
            if (cross) continue;
          }
          const w = kp !== k ? v + RAMP_CHANGE + (turnHere ? RAMP_TURN : 0) : v;
          if (w < best) {
            best = w;
            arg = kp;
          }
        }
        if (best === INF) continue;
        cost[i * W + k] = best + RAMP_CELL * k;
        from[i * W + k] = arg;
      }
    }
    let kEnd = -1;
    let cEnd = INF;
    for (let k = 0; k <= 1; k++) {
      if (t.drop >= 0 && !edgeOk(keys[n - 1], t.drop, k, 0)) continue;
      const v = cost[(n - 1) * W + k] + (k ? RAMP_CHANGE : 0);
      if (v < cEnd) {
        cEnd = v;
        kEnd = k;
      }
    }
    if (kEnd < 0) return null;
    const ks = new Int8Array(n);
    ks[n - 1] = kEnd;
    for (let i = n - 1; i > 0; i--) ks[i - 1] = from[i * W + ks[i]];
    return ks;
  };
  /** 段 t 按剖面 ks 记进表：占的半层、走过的边（两头接地面那两条也记，地面那头按第 0 个半层） */
  const commit = (t, ks) => {
    const { keys, n } = t;
    const cid = cTop++;
    if (cid >= alive.length) alive = grow(alive);
    alive[cid] = 1;
    legCid[t.idx] = cid;
    if (t.rise >= 0) putEdge(t.rise, 0, keys[0], ks[0], cid);
    if (t.drop >= 0) putEdge(keys[n - 1], ks[n - 1], t.drop, 0, cid);
    for (let i = 0; i < n; i++) {
      OCC[keys[i]] |= 1 << ks[i];
      if (i > 0) putEdge(keys[i - 1], ks[i - 1], keys[i], ks[i], cid);
    }
  };
  /** 把段 t 从表里拿掉（它边上的条目关掉） */
  const uncommit = (t, ks) => {
    for (let i = 0; i < t.n; i++) OCC[t.keys[i]] &= ~(1 << ks[i]);
    alive[legCid[t.idx]] = 0;
  };
  // 先按次序一段段排；排不下的再试着和挡它的段换先后（把那段拿掉、先排它、再把那段放回去，两段都排得下才换）
  const prof = new Array(todo.length).fill(null); // 段 → 剖面
  const failed = [];
  for (const t of todo) {
    if (!t.n || t.why) continue;
    const ks = solve(t);
    if (ks) {
      prof[t.idx] = ks;
      commit(t, ks);
    } else failed.push(t);
  }
  for (let f = 0; f < failed.length; f++) {
    const t = failed[f];
    if (f >= RAMP_REPAIR) {
      release(t);
      continue;
    }
    const mine = new Set(t.keys);
    let tried = 0;
    let done = false;
    for (const u of todo) {
      if (tried >= RAMP_RIVALS) break;
      const ku0 = prof[u.idx];
      if (!ku0 || !u.keys.some((k) => mine.has(k))) continue;
      tried++;
      uncommit(u, ku0);
      const ks = solve(t);
      if (ks) {
        commit(t, ks);
        const ku = solve(u);
        if (ku) {
          commit(u, ku);
          prof[t.idx] = ks;
          prof[u.idx] = ku;
          done = true;
          break;
        }
        uncommit(t, ks);
      }
      // 换不成：放回原样（它边上的条目还在，把它那次的号重新打开就是原来那份）
      for (let i = 0; i < u.n; i++) OCC[u.keys[i]] |= 1 << ku0[i];
      alive[legCid[u.idx]] = 1;
    }
    if (!done) release(t);
  }
  // 落成最终格子，按排的次序记惩罚
  for (const t of todo) {
    const { l, r, n } = t;
    if (!n) continue;
    const ks = prof[t.idx];
    if (!ks) {
      l.broken = true;
      l.level = 0;
      addPenalty('route', P.route * 4, `${name(l)} 的高架段无处可放${t.why ? `（${t.why}）` : ''}`, itemBids(l.itemId));
      continue;
    }
    let top = 0;
    for (let i = 0; i < n; i++) if (ks[i] > top) top = ks[i];
    l.level = top / 2;
    const cells = new Array(r.pre.length + n + r.post.length);
    let j = 0;
    for (const q of r.pre) cells[j++] = q;
    for (let i = 0; i < n; i++) {
      const q = r.cells[i];
      q[2] = ks[i] / 2;
      cells[j++] = q;
    }
    for (const q of r.post) cells[j++] = q;
    l.cells = cells;
    const cap = opt.bridges && l.bridge ? opt.bridgeMaxLevel : opt.maxLevel;
    if (l.level > cap) addPenalty('level', P.level * (l.level - cap), `${name(l)} 的高架段和别的高架段撞在一起（${cap} 层都占满了，升到第 ${l.level} 层）`, itemBids(l.itemId));
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
  const bridgeOn = !!opt.bridges; // 桥（见 liftLegs）：关着时不读 leg.bridge
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
    const isBridge = bridgeOn && p.l.bridge === true;
    let lo = isBridge ? opt.bridgeLevel : 1; // 桥段最低第 bridgeLevel 层（见 liftLegs 的 lowOf）
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
    const cap = isBridge ? opt.bridgeMaxLevel : opt.maxLevel;
    let over = Math.max(0, L - cap);
    if (L > hi) over += 1; // 两头的约束矛盾：完整算法要靠请出重排才可能放下，按多占一层计
    p.l.level = L;
    if (isBridge && L !== 1) {
      // 桥段：水平部分按分到的层落实（别的段这里照旧按第 1 层的格子记，金字塔只数到两头那叠的顶上一格；
      // 桥段打分按有效层（score.js），第 5 层的桥按第 2 层计金字塔，按第 1 层记格子会少算，和完整分层对不上）
      const rL = cellsFor(p.l, L);
      p.l.cells = rL.cells;
      realizeLeg(p.l, rL);
    } else {
      p.l.cells = p.r.cells;
      realizeLeg(p.l, p.r);
    }
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
    if (over) addPenalty('level', P.level * over, `${graph.items.get(p.l.itemId).name} 的高架段和别的高架段撞在一起（${cap} 层都占满了，升到第 ${L} 层）`, itemBids(p.l.itemId));
  }
  c.roads = roadStats(c);
}
