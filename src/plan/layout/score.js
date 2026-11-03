// 约束检查与计数：分拣器落位、各类惩罚、面积与带数、结构代价、最终代价
import { assignSorters, sideCap, SORTER_SPEED } from '../sorters.js';
import { powerBands } from '../power.js';
import { stationHoles } from '../holes.js';
import { STATION_COLS, TOL, gk } from './shared.js';
import { sprayGapCells } from './elevation.js';
import { BELT_SPEED } from '../../gamedata.js';

/**
 * 一段高架里升降和拐弯挨得多近（转弯后没过几个格子就升降、升降后直接转弯，看着挤）。只用来量，没进打分也没进选列：
 * 退火没有挪升降位置的动作，放进打分等于白加；选竖直穿行那一列（layout/positions.js 的 bestColumn）时要求两头直走几格，
 * 密的大产线能用的列本来就少，挑远的那列高架更长、层更挤。
 * 每一叠竖直升降往前、往后各看一眼：水平直走了 run 格就拐弯的，记 k − run（run ≥ k 不记）；直走到头或接着又是升降不算。
 * 升降那一格进出方向不同（一边转弯一边升降）按 run = 0 记。cells 是逐格的 [x, y, z]。
 */
export function nearLiftTurns(cells, k) {
  const moves = []; // 每一步：'v' 竖直，或水平方向 'dx,dy'
  for (let i = 1; i < cells.length; i++) {
    const dx = cells[i][0] - cells[i - 1][0], dy = cells[i][1] - cells[i - 1][1];
    moves.push(dx || dy ? `${dx},${dy}` : 'v');
  }
  let n = 0;
  for (let i = 0; i < moves.length; i++) {
    if (moves[i] !== 'v' || moves[i - 1] === 'v') continue; // 只从一叠的第一步看
    let j = i;
    while (moves[j + 1] === 'v') j++;
    const before = moves[i - 1], after = moves[j + 1];
    if (before && after && after !== 'v' && before !== after) {
      n += k; // 一边转弯一边升降
      continue;
    }
    // 往后：升起（落下）之后直走几格就拐弯
    if (after && after !== 'v') {
      let r = 0;
      while (moves[j + 1 + r] === after) r++;
      const next = moves[j + 1 + r];
      if (next && next !== 'v' && r < k) n += k - r;
    }
    // 往前：拐弯之后直走几格就升降
    if (before && before !== 'v') {
      let r = 0;
      while (moves[i - 1 - r] === before) r++;
      const prev = moves[i - 1 - r];
      if (prev && prev !== 'v' && r < k) n += k - r;
    }
  }
  return n;
}

/** 劈开的段按继续走的那一半算 */
const segLen = (s) => (s.split == null ? s.b - s.a + 1 : s.cont === 'L' ? s.split - s.a : s.cont === 'R' ? s.b - s.split + 1 : Math.max(s.split - s.a, s.b - s.split + 1));
/** 研究站夹带（layout/belts.js 的 labGaps）那一列的地面格数 */
const gapLen = (gp) => gp.y1 - gp.y0 + 1;
const legLen = (l) => l.cells.length + (l.kind !== 'link' && !l.direct ? 1 : 0);
/** 不影响可行的惩罚（只是提示或口味） */
const softKind = (k) => k === 'aspect' || k === 'long' || k === 'fill' || k === 'spray';
const NO_BLOCKS = [];
// 每条带的格数（设了 maxBelt 时要逐条再看一遍），按线程复用
let pathLenBuf = new Float64Array(64);

// 惩罚文字按内容复用（按线程）：退火每一步都要记几十上百条「分拣器不够快」「要伸太长」（同一块的每台工厂各一条），
// 组名、物品名和几个数都一样时拼出来的字一样，拼一次就记下来。表按 组名 → 物品名 查到一串 [数…, 文字, 数…, 文字, …]，
// 数按 === 比（+0、−0 拼出来都是 "0"；有 NaN 的不记，每次照拼）；条目太多时整张清掉重来
const MSG_MEMO_MAX = 20000;
let slowMemo = new Map();
let tracksMemo = new Map();
let msgMemoSize = 0;
/** 组名 → 物品名 → 这一对的条目串 */
const memoList = (memo, group, item) => {
  let byItem = memo.get(group);
  if (byItem === undefined) memo.set(group, (byItem = new Map()));
  let list = byItem.get(item);
  if (list === undefined) byItem.set(item, (list = []));
  return list;
};
const noteMsg = () => {
  if (++msgMemoSize > MSG_MEMO_MAX) {
    slowMemo = new Map();
    tracksMemo = new Map();
    msgMemoSize = 0;
  }
};
/** 「用 k 根 length 格长的分拣器也不够快」 */
function slowMsg(sl) {
  if (sl.tank) return `储液罐「${sl.item}」的罐口接不上：罐口那截带子只能拐进紧贴的那条带，罐要在那条带的上游头上`;
  const { k, length, rate } = sl;
  if (k !== k || length !== length || rate !== rate) return `${sl.group} 的「${sl.item}」用 ${k} 根 ${length} 格长的分拣器也不够快（每台需 ${rate.toFixed(0)}/分），换更快的分拣器`;
  const list = memoList(slowMemo, sl.group, sl.item);
  for (let i = 0; i < list.length; i += 4) if (list[i] === k && list[i + 1] === length && list[i + 2] === rate) return list[i + 3];
  const m = `${sl.group} 的「${sl.item}」用 ${k} 根 ${length} 格长的分拣器也不够快（每台需 ${rate.toFixed(0)}/分），换更快的分拣器`;
  list.push(k, length, rate, m);
  noteMsg();
  return m;
}
/** 「要伸 length 格才够得着轨道」 */
function tracksMsg(t) {
  const length = t.length;
  if (length !== length) return `${t.group} 的「${t.item}」要伸 ${length} 格才够得着轨道，超过 3 格`;
  const list = memoList(tracksMemo, t.group, t.item);
  for (let i = 0; i < list.length; i += 2) if (list[i] === length) return list[i + 1];
  const m = `${t.group} 的「${t.item}」要伸 ${length} 格才够得着轨道，超过 3 格`;
  list.push(length, m);
  noteMsg();
  return m;
}

// 退火提前拒绝 preLegFloor：route.js 的 layout() 在 placePorts 之后、高架（liftLegs / estimateLegs，约占 route 一半时间）之前
// 按最终代价的下限问一次。为什么不超过最终代价（本文件末尾的 result.cost，从左到右加）：
//   面积只少了高架格子撑宽的那部分（高在 ports 之后已定，高架不改）、外沿按 0；地面带（段的 a/b、口的 direct、legs 的 stub）高架不改，相等；
//   惩罚只往数组后面追加、每条 ≥ 0，这里加的是前缀；airBelts、sorterLenCost、levelCost、shape、holes、taste 在守卫成立时都 ≥ 0，按 0。
//   浮点加法对非负数单调、加非负项不减（fl(x+y) ≥ x），所以这个下限 ≤ scoreLayout 里分拣器之前那一问的下限 ≤ 最终代价；rejectFloor 对下限单调
//   （越大越容易拒），不会误拒本会算完的候选，被拒时退火照样只抽掉一个随机数，stateMemo 记下的下限回放时结论一样。
// 守卫（比 scoreLayout 里的 early 严）：进最终代价的权重和惩罚项都要 ≥ 0，任一不成立或没传 rejectFloor 就返回 null，调用方照常往下算
export function preLegFloor(c) {
  const { opt, P, penalties } = c;
  if (!opt.rejectFloor) return null;
  if (
    !(
      opt.areaWeight >= 0 &&
      opt.sorterLenWeight >= 0 &&
      opt.levelWeight >= 0 &&
      opt.singleWeight >= 0 &&
      opt.splitWeight >= 0 &&
      opt.farWeight >= 0 &&
      opt.entryWeight >= 0 &&
      opt.longWeight >= 0 &&
      opt.pyramidWeight >= 0 &&
      opt.turnWeight >= 0 &&
      opt.liftWeight >= 0
    )
  )
    return null;
  for (const k in P) if (!(P[k] >= 0)) return null; // opt.penalty 里每一项都要 ≥ 0
  for (let i = 0; i < penalties.length; i++) if (!(penalties[i].amount >= 0)) return null;
  // 已经记下的惩罚（最终 penalty 的前缀子集）
  let pen = 0;
  for (let i = 0; i < penalties.length; i++) pen += penalties[i].amount;
  return preLegBase(c) + pen;
}

/** 高架前的下限里不含惩罚的那两项：面积下限 × areaWeight + 地面带，和最终代价开头同一个先后（几个 preLeg…Floor 共用） */
function preLegBase(c) {
  const { opt, segments, ports, legs, height, xR } = c;
  // 面积下限：少了高架格子那一项（最终 maxX 只会更大）
  let maxX = xR - 1;
  for (let i = 0; i < segments.length; i++) maxX = Math.max(maxX, segments[i].b);
  for (let i = 0; i < ports.length; i++) maxX = Math.max(maxX, ports[i].x);
  const areaLb = (maxX + 1) * height;
  // 地面带（和 scoreLayout 算 groundBelts 同一个算法）
  let segCells = 0;
  for (let i = 0; i < segments.length; i++) segCells += segments[i].b - segments[i].a + 1;
  let portCells = 0;
  for (let i = 0; i < ports.length; i++) if (!ports[i].direct) portCells++;
  let stubCells = 0;
  for (let i = 0; i < legs.length; i++) stubCells += legs[i].stub?.length ?? 0;
  return areaLb * opt.areaWeight + (segCells + portCells + stubCells);
}

/** 排分拣器（scoreLayout 和 route.js 的 layout() 提前排时共用） */
export function sorterPlanOf(c) {
  const { graph, rows, pos, rowCy, rowBelow, rowAbove, channels, segments, sides, opt } = c;
  return assignSorters(graph, { rows, pos, rowCy, rowBelow, rowAbove, channels, segments }, sides, { sorter: opt.sorter, headroom: opt.headroom, fourthTrack: !!opt.fourthTrack, wideTracks: !!opt.wideTracks, cache: opt.sorterCache !== false });
}

// 退火提前拒绝 preLegSorterFloor（route.js 的 earlySorters）：分拣器挪到高架之前排，用它的惩罚和长度代价把 preLegFloor 补紧再问一次。
// 能挪：分拣器只读 rows、pos、rowCy、rowBelow、rowAbove、channels、segments、sides（sorterPlanOf），placePorts 之后都定了；高架只写
// 各 leg 的 cells/shadow/level/broken/road、c.roads 和 level/route 惩罚，所以提前排的和 scoreLayout 里排的一样，scoreLayout 直接用（c.sorterPlan）。
// 不超过最终代价（同 preLegFloor）：这里是 preLegBase + pen + sorterLenCost。最终的惩罚数组按记下的先后是 高架前已记的 → 高架记的
// （level、route）→ slots → clash → shortfall → tracks → slow → spray → late（belt/width/height/aspect/long/fill）→ power，pen 按
// 高架前已记的 → slots → clash → shortfall → tracks → slow 逐条加，是它的子序列（每条同一个式子、同样的输入），非负数的部分和里
// 插进非负项只增不减；sorterLenCost 相等，其余项按 0。它也不超过 scoreLayout 里供电之前那一问的下限（分拣器之前那一问没有分拣器的
// 惩罚，不一定比它大），所以有那一问时这里能拒的算下去也一定被拒。不往 c.penalties 里记东西。
// 守卫：调用方只在 preLegFloor 不是 null 时来，这里再看一遍新用到的几项，不成立返回 null
export function preLegSorterFloor(c, plan) {
  const { opt, P } = c;
  if (!(P.slots >= 0 && P.clash >= 0 && P.shortfall >= 0 && P.tracks >= 0 && P.slow >= 0 && opt.sorterLenWeight >= 0)) return null;
  let pen = preLegSlotsPen(c);
  // 分拣器的 clash → shortfall → tracks → slow，和 scoreLayout 记的先后一样
  if (plan.clashes) pen += P.clash * plan.clashes;
  const { starved, tooLong, slow, sorters } = plan;
  for (let i = 0; i < starved.length; i++) pen += P.shortfall;
  for (let i = 0; i < tooLong.length; i++) pen += P.tracks;
  for (let i = 0; i < slow.length; i++) pen += P.slow;
  // 分拣器长度代价：和 scoreLayout 的 sorterLengths[2]、sorterLengths[3] 一样按 === 数
  let n2 = 0;
  let n3 = 0;
  for (let i = 0; i < sorters.length; i++) {
    const len = sorters[i].length;
    if (len === 2) n2++;
    else if (len === 3) n3++;
  }
  const sorterLenCost = (n2 + 2 * n3) * opt.sorterLenWeight;
  return preLegBase(c) + pen + sorterLenCost;
}

/** 已经记下的惩罚，再加上分拣器位（slots：和 scoreLayout 开头同一个算法、同一个先后，按块、先下侧后上侧）；preLegSorterFloor、preLegWantFloor 共用 */
function preLegSlotsPen(c) {
  const { penalties } = c;
  let pen = 0;
  for (let i = 0; i < penalties.length; i++) pen += penalties[i].amount;
  return addSlotsPen(c, pen);
}
/** 分拣器位（slots）逐条加到 pen 上（preLegSlotsPen、preLegElevFloor 共用） */
function addSlotsPen(c, pen) {
  const { P, pos, sides } = c;
  sides.forEach((sd, bid) => {
    const g = pos.get(bid).g;
    const nb = sd.bottom.size;
    const cb = sideCap(g, 'bottom');
    if (nb > cb) pen += P.slots * (nb - cb);
    const nt = sd.top.size;
    const ct = sideCap(g, 'top');
    if (nt > ct) pen += P.slots * (nt - ct);
  });
  return pen;
}

// 退火提前拒绝 preLegWantFloor（route.js 的 layout()：preLegFloor 没拒之后、提前排分拣器之前）：补上分拣器位、够不着、太慢再问一次。
// 被拒的多半要等分拣器排完才拒，而够不着、太慢在 assignSorters 收集工厂那一段就定了（countOnly，不做动态规划），分拣器位分带之后就定了。
// 不超过最终代价（同 preLegSorterFloor）：这里是 preLegBase + pen，pen 按 高架前已记的 → slots → 够不着（每条一个 P.tracks）
// → 太慢（每条一个 P.slow）逐条加，是最终惩罚数组的子序列（条数和不带 countOnly 时 tooLong、slow 的长度一样）；它也不超过
// preLegSorterFloor 和 scoreLayout 里供电之前那一问。只在 opt.power || opt.stationHoles（有供电之前那一问）时问：这里能拒的算到那一问
// 也一定被拒，所以退火（place.js 的 runRound）、定点精修（place.js 的 polish，被拒的不进存档）、配电站挖空位第一遍（route.js 的 route）
// 拒不拒都不变，stateMemo 多记一个下限、回放单调。不往 c.penalties 里记东西；assignSorters 只数不排、不碰按通道的缓存（cache: false）。
// 守卫：调用方只在 preLegFloor 不是 null 时来，这里再看一遍新用到的几项；不问时返回 null
export function preLegWantFloor(c) {
  const { graph, rows, pos, rowCy, rowBelow, rowAbove, channels, segments, sides, opt, P } = c;
  if (!(opt.power || opt.stationHoles)) return null;
  if (!(P.slots >= 0 && P.tracks >= 0 && P.slow >= 0)) return null;
  let pen = preLegSlotsPen(c);
  const counts = assignSorters(graph, { rows, pos, rowCy, rowBelow, rowAbove, channels, segments }, sides, { sorter: opt.sorter, headroom: opt.headroom, cache: false, countOnly: true });
  c.wantCounts = counts; // preLegElevFloor 接着用
  for (let i = 0; i < counts.nTooLong; i++) pen += P.tracks;
  for (let i = 0; i < counts.nSlow; i++) pen += P.slow;
  return preLegBase(c) + pen;
}

// 退火提前拒绝 preLegElevFloor（route.js 的 elevAsk：elevation.js 的 liftLegs → levels.js 的 solveLevels 贪心放层之后、局部搜索之前调）：
// 在 preLegWantFloor（或提前排的分拣器）那一问上补上高架已判死的段再问一次。打分里才被拒的多半靠高架的「无处可放」（每段 4 个 P.route），
// 这些段在局部搜索之前就全判死了，在这里拒能省掉局部搜索、落地和打分。
// 不超过最终代价（同 preLegSorterFloor、preLegWantFloor）：这里是 preLegBase + pen（提前排过分拣器时再加分拣器长度代价），pen 按
// 已记的（高架前的和高架先排那批记的，正好是最终惩罚数组的前缀）→ 已判死的平段各一个 P.route × 4 → slots →（提前排过分拣器时）
// clash → shortfall → tracks → slow，或者（没排过）preLegWantFloor 数的够不着、太慢，逐条加。判死的段 solveLevels 不会再放回去，
// liftLegs 对它们各记一条 P.route × 4（值都一样，先后无关），所以整串是最终惩罚数组的子序列。只在 preLegWantFloor 问过时问
// （c.wantCounts 有），拒不拒的道理和它一样；没问过时返回 null
export function preLegElevFloor(c, nDead) {
  const { P, opt, penalties } = c;
  const counts = c.wantCounts;
  if (counts === undefined) return null;
  let pen = 0;
  for (let i = 0; i < penalties.length; i++) pen += penalties[i].amount;
  for (let i = 0; i < nDead; i++) pen += P.route * 4;
  pen = addSlotsPen(c, pen);
  const plan = c.sorterPlan;
  if (plan === undefined) {
    for (let i = 0; i < counts.nTooLong; i++) pen += P.tracks;
    for (let i = 0; i < counts.nSlow; i++) pen += P.slow;
    return preLegBase(c) + pen;
  }
  // 提前排过分拣器：clash → shortfall → tracks → slow 和长度代价照 preLegSorterFloor
  if (plan.clashes) pen += P.clash * plan.clashes;
  const { starved, tooLong, slow, sorters } = plan;
  for (let i = 0; i < starved.length; i++) pen += P.shortfall;
  for (let i = 0; i < tooLong.length; i++) pen += P.tracks;
  for (let i = 0; i < slow.length; i++) pen += P.slow;
  let n2 = 0;
  let n3 = 0;
  for (let i = 0; i < sorters.length; i++) {
    const len = sorters[i].length;
    if (len === 2) n2++;
    else if (len === 3) n3++;
  }
  return preLegBase(c) + pen + (n2 + 2 * n3) * opt.sorterLenWeight;
}

// 退火里每一步都要打一次分：下面的循环都按下标走（不用 for…of、不解构、不拼临时数组），
// 函数还没被优化编译时也不会每一步都造迭代结果和小数组
export function scoreLayout(c) {
  const { P, R, addPenalty, beltCap, blocks, blocksOf, chains, channels, corridor, graph, height, itemBids, labGaps, legs, opt, pads, penalties, pileCap, ports, pos, powerHoles, rawCap, roads, rowAbove, rowBelow, rowCy, rows, segments, side, sides, stations, streetX, xR } = c;
  // ---------- F. 约束检查与计数 ----------
  // 每块上下两侧要接的物品种数不能超过分拣器位（Map.forEach：不造 [键, 值] 数组）
  sides.forEach((sd, bid) => {
    const g = pos.get(bid).g;
    const nb = sd.bottom.size;
    const cb = sideCap(g, 'bottom');
    if (nb > cb) addPenalty('slots', P.slots * (nb - cb), `${g.item} 的下侧要接 ${nb} 种物品，超过 ${cb} 个分拣器位`, [bid]);
    const nt = sd.top.size;
    const ct = sideCap(g, 'top');
    if (nt > ct) addPenalty('slots', P.slots * (nt - ct), `${g.item} 的上侧要接 ${nt} 种物品，超过 ${ct} 个分拣器位`, [bid]);
  });
  // 不依赖分拣器的部分先算（流量、尺寸、带数、结构、叠层、口味）；这几项的惩罚先存在 late 里，排在分拣器、喷涂的惩罚之后记
  const late = [];
  // 每条带（原料每个入口一条，产物一种一条）的流量不能超过单条带运力（产物带是 layout/belts.js 的 pileCap：开集装机时按 pileModel，
  // 集装分拣器叠层时按 sorterStack，说明文字跟着写）
  for (let i = 0; i < chains.length; i++) {
    const ch = chains[i];
    const parts = ch.parts;
    let rate = -Infinity; // 和 Math.max(...各段流量) 一样（没有段时是 −Infinity）
    for (let j = 0; j < parts.length; j++) {
      const p = parts[j];
      if (p.seg != null) rate = Math.max(rate, segments[p.seg].rate);
    }
    const it = graph.items.get(ch.itemId);
    const cap = it.producer === 'RAW' ? rawCap : pileCap;
    if (rate > cap + TOL) late.push(['belt', P.belt, `${it.name} 流量 ${rate.toFixed(0)}/分 超过${cap > beltCap && it.producer !== 'RAW' ? (opt.sorterStack > 1 && cap === BELT_SPEED[opt.belt] * 60 * opt.sorterStack ? `一条带叠 ${opt.sorterStack} 层的` : opt.pileModel > 0 ? `一条带过 ${Math.floor(opt.pileModel)} 台集装机的` : '一条带叠 4 层的') : '单条带'}运力 ${opt.pileModel > 0 ? Math.round(cap) : cap}/分`, itemBids(ch.itemId)]);
  }

  let maxX = xR - 1;
  for (let i = 0; i < segments.length; i++) maxX = Math.max(maxX, segments[i].b);
  for (let i = 0; i < ports.length; i++) maxX = Math.max(maxX, ports[i].x);
  // 高架段扫一遍：最右的格子、高架格数、地面插头格数、超长部分（结构代价）、叠层（第 2 层起每层每段），
  // 以及口味里逐格数的两项（金字塔：在本段所在层的格数；拐弯：连着三格同层、方向变了），每段的格子只走一遍
  const tasteOn = opt.pyramidWeight || opt.turnWeight || opt.liftWeight;
  let airBelts = 0;
  let stubCells = 0;
  let longCells = 0;
  let lifted = 0;
  let tPyramid = 0;
  let tTurns = 0;
  for (let li = 0; li < legs.length; li++) {
    const l = legs[li];
    const cs = l.cells;
    const lv = l.level;
    let nTop = 0;
    let turns = 0;
    let a = null;
    let b = null;
    for (let i = 0; i < cs.length; i++) {
      const q = cs[i];
      maxX = Math.max(maxX, q[0]);
      if (q[2] === lv) nTop++;
      // 升降那几格不算拐弯
      if (i >= 2 && a[2] === b[2] && b[2] === q[2] && (b[0] - a[0] !== q[0] - b[0] || b[1] - a[1] !== q[1] - b[1])) turns++;
      a = b;
      b = q;
    }
    airBelts += cs.length;
    stubCells += l.stub?.length ?? 0;
    longCells += Math.max(0, (cs?.length ?? 0) - opt.longFrom);
    lifted += cs?.length && lv > 1 ? lv - 1 : 0;
    if (tasteOn && cs?.length) {
      // 金字塔：长的段在高层最贵，2 层够多了才值得上 3 层
      if (lv > opt.pyramidFrom) tPyramid += nTop * (2 ** (lv - opt.pyramidFrom) - 1);
      tTurns += turns;
    }
  }
  const width = maxX + 1;
  if (opt.maxWidth && width > opt.maxWidth) late.push(['width', P.width * (width - opt.maxWidth) * height, `宽 ${width} 格，超过上限 ${opt.maxWidth} 格`]);
  if (opt.maxHeight && height > opt.maxHeight) late.push(['height', P.height * (height - opt.maxHeight) * width, `长 ${height} 格，超过上限 ${opt.maxHeight} 格`]);
  if (opt.maxAspect) {
    const aspect = Math.max(width, height) / Math.max(1, Math.min(width, height));
    if (aspect > opt.maxAspect) late.push(['aspect', Math.round((aspect - opt.maxAspect) * width * height * 0.5), `长宽比 ${aspect.toFixed(1)}:1 超过上限 ${opt.maxAspect}:1`]);
  }
  // 每种物品从带头到带尾的格数（地面段 + 高架段 + 出入口）；劈开的段按继续走的那一半算。最长的取第一条
  if (pathLenBuf.length < chains.length) pathLenBuf = new Float64Array(chains.length * 2);
  let longestLen = 0;
  let longestItem = null;
  for (let i = 0; i < chains.length; i++) {
    const parts = chains[i].parts;
    let len = 0;
    for (let j = 0; j < parts.length; j++) {
      const p = parts[j];
      len += p.seg != null ? segLen(segments[p.seg]) : p.gap != null ? gapLen(labGaps[p.gap]) : legLen(legs[p.leg]);
    }
    pathLenBuf[i] = len;
    if (len > longestLen) {
      longestLen = len;
      longestItem = chains[i].itemId;
    }
  }
  if (opt.maxBelt) {
    for (let i = 0; i < chains.length; i++) {
      const len = pathLenBuf[i];
      if (len > opt.maxBelt) late.push(['long', P.long * (len - opt.maxBelt), `${graph.items.get(chains[i].itemId).name}带长 ${len} 格，超过上限 ${opt.maxBelt} 格`]);
    }
  }
  let segCells = 0;
  for (let i = 0; i < segments.length; i++) segCells += segments[i].b - segments[i].a + 1;
  if (labGaps) for (let i = 0; i < labGaps.length; i++) segCells += gapLen(labGaps[i]); // 研究站夹带的地面格
  let portCells = 0;
  for (let i = 0; i < ports.length; i++) if (!ports[i].direct) portCells++;
  const groundBelts = segCells + portCells + stubCells;
  const area = width * height;
  // 土地利用率：工厂行里被工厂占满的比例
  let factoryCols = 0;
  pos.forEach((p) => {
    factoryCols += p.n * p.g.pitch;
  });
  // 站列那几列本来就不放工厂，不算进行利用率的分母
  const fill = R ? factoryCols / (R * Math.max(1, width - (side ? STATION_COLS : 0))) : 0;
  if (fill < opt.minFill) late.push(['fill', Math.round(P.fill * (opt.minFill - fill) * area), `行利用率 ${(fill * 100).toFixed(0)}%，低于 ${(opt.minFill * 100).toFixed(0)}%`]);
  // 结构代价：一排一台、无故拆块、多开入口、超长高架
  const shape = { single: 0, split: 0, far: 0, entries: 0, long: 0, cost: 0 };
  {
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      let n = 0;
      for (let i = 0; i < row.length; i++) n += pos.get(row[i]).n;
      if (n === 1) shape.single++;
    }
    const usableW = opt.maxWidth ? opt.maxWidth - (side ? STATION_COLS + 1 : 2) : Infinity;
    const groups = graph.groups;
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      const bl = blocksOf.get(g.id) || NO_BLOCKS;
      const need = Number.isFinite(usableW) ? Math.max(1, Math.ceil(g.width / usableW)) : 1;
      shape.split += Math.max(0, bl.length - need);
      if (bl.length < 2) continue; // 只有一块的组隔不了行
      // 各块所在的行（整数）去重排好后，相邻两行之间空出的行数之和 = (最大 − 最小) − (行数 − 1)
      let lo = Infinity;
      let hi = -Infinity;
      let nr = 0;
      for (let i = 0; i < bl.length; i++) {
        const r = bl[i].row;
        let dup = false;
        for (let j = 0; j < i; j++) {
          if (bl[j].row === r) {
            dup = true;
            break;
          }
        }
        if (dup) continue;
        nr++;
        if (r < lo) lo = r;
        if (r > hi) hi = r;
      }
      shape.far += hi - lo - (nr - 1);
    }
    // 同一种原料的入口数（按第一次出现的先后）超过运力所需的部分
    for (let i = 0; i < legs.length; i++) {
      const l = legs[i];
      if (l.kind !== 'in') continue;
      const itemId = l.itemId;
      let first = true;
      for (let j = 0; j < i; j++) {
        if (legs[j].kind === 'in' && legs[j].itemId === itemId) {
          first = false;
          break;
        }
      }
      if (!first) continue;
      let n = 1;
      for (let j = i + 1; j < legs.length; j++) if (legs[j].kind === 'in' && legs[j].itemId === itemId) n++;
      const cons = graph.items.get(itemId).consumers;
      let total = 0;
      for (let k = 0; k < cons.length; k++) total += cons[k].rate;
      shape.entries += Math.max(0, n - Math.ceil(total / rawCap - TOL));
    }
    shape.long = longCells;
    shape.cost = shape.single * opt.singleWeight * width + shape.split * opt.splitWeight + shape.far * opt.farWeight + shape.entries * opt.entryWeight + shape.long * opt.longWeight;
  }
  // 高架叠层的代价：第 2 层起每层每段 levelWeight 格
  const levelCost = lifted * opt.levelWeight;
  // 口味：太高的高架、拐弯、一条带子反复升降各计一点（权重都为 0 时不算）
  const taste = { pyramid: 0, turns: 0, lifts: 0, cost: 0 };
  if (tasteOn) {
    // 金字塔、拐弯在上面扫高架段时已经按段的先后加好
    taste.pyramid = tPyramid;
    taste.turns = tTurns;
    for (let i = 0; i < chains.length; i++) {
      const parts = chains[i].parts;
      let n = 0;
      for (let j = 0; j < parts.length; j++) {
        const q = parts[j];
        if (q.leg != null && legs[q.leg].cells?.length) n++;
      }
      taste.lifts += Math.max(0, n - 1);
    }
    taste.cost = taste.pyramid * opt.pyramidWeight + taste.turns * opt.turnWeight + taste.lifts * opt.liftWeight;
  }
  // 退火提前拒绝（place.js 的 runRound 传 opt.rejectFloor，只在退火评估邻域时有）：到这里面积、带数、叠层、结构、口味代价
  // 和已经记下的惩罚都定了，还没算的（分拣器、喷涂空当、供电外沿、物流站空地的代价和惩罚，分拣器长度代价）都不是负的，
  // 所以按最终代价同样的次序、把没算的项当 0 加出来的 floor 不会比最终代价高（浮点加法对每一项都是单调的；惩罚按记下的先后加，
  // 只是少了中间几项）。rejectFloor(floor) 说注定被拒就不再算后面最费时的几步，返回 { rejected: true }。
  // 分拣器排完再问一次（那时只差供电外沿、站空地和供电惩罚）
  const early = opt.rejectFloor && opt.areaWeight >= 0 && opt.sorterLenWeight >= 0 && P.clash >= 0 && P.shortfall >= 0 && P.tracks >= 0 && P.slow >= 0 && P.spray >= 0 && P.power >= 0 ? opt.rejectFloor : null;
  if (early) {
    let pen = 0;
    for (let i = 0; i < penalties.length; i++) pen += penalties[i].amount;
    for (let i = 0; i < late.length; i++) pen += late[i][1];
    const floor = area * opt.areaWeight + groundBelts + airBelts + pen + levelCost + shape.cost + taste.cost;
    if (early(floor)) return { rejected: true, cost: floor };
  }
  // route.js 的 layout() 在高架之前已经排过（earlySorters，见 preLegSorterFloor）就直接用那一份
  const sorterPlan = c.sorterPlan !== undefined ? c.sorterPlan : sorterPlanOf(c);
  if (sorterPlan.clashes) addPenalty('clash', P.clash * sorterPlan.clashes, `${sorterPlan.clashes} 处上下两侧分拣器在同一列`);
  const { starved, tooLong, slow, sorters } = sorterPlan;
  for (let i = 0; i < starved.length; i++) {
    const st = starved[i];
    addPenalty('shortfall', P.shortfall, `${st.group}#${st.building} 的取料分拣器在所有出料点上游，拿不到货`, [st.bid]);
  }
  for (let i = 0; i < tooLong.length; i++) {
    const t = tooLong[i];
    addPenalty('tracks', P.tracks, tracksMsg(t), [t.bid]);
  }
  // 同一块的各台工厂挨着各记一条、内容一样：和上一条的几个值都相同时直接用上一条的字，不用再查表
  let last = null;
  let lastMsg = '';
  for (let i = 0; i < slow.length; i++) {
    const sl = slow[i];
    if (!(last !== null && sl.group === last.group && sl.item === last.item && sl.k === last.k && sl.length === last.length && sl.rate === last.rate)) {
      last = sl;
      lastMsg = slowMsg(sl);
    }
    addPenalty('slow', P.slow, lastMsg, [sl.bid]);
  }
  // 研究站夹带的侧面分拣器（layout/belts.js 的 labGaps，每台一根、长 1）：速度不够时只能换更快的分拣器（侧面接不了第二根），按太慢罚
  let nGapSorters = 0;
  if (labGaps) {
    const sp = SORTER_SPEED[opt.sorter]?.[1] ?? 0;
    for (let i = 0; i < labGaps.length; i++) {
      const gp = labGaps[i];
      nGapSorters += gp.taps.length;
      const g = pos.get(gp.bid).g;
      if (g.perFactory * opt.headroom > sp + 1e-9) for (let j = 0; j < gp.taps.length; j++) addPenalty('slow', P.slow, `${g.item} 的「${graph.items.get(gp.itemId).name}」从侧面出，1 根 1 格长的分拣器不够快（每台需 ${g.perFactory.toFixed(0)}/分），换更快的分拣器`, [gp.bid]);
    }
  }
  // 喷涂机的空当要真能骑（喷增产剂时）：压着的 3 格上不能有分拣器横穿，取料格两侧不能都是工厂
  // （增产剂带要在取料格上方第 1 层横穿，至少一侧要能进）。两个候选位置都被堵的按走不通罚，退火会把块挪开
  if (opt.sprayItems) {
    const spans = new Map(); // 列 -> 这一列分拣器横穿的 y 区间，平铺成 [下, 上, 下, 上, …]
    for (let i = 0; i < sorters.length; i++) {
      const so = sorters[i];
      const p = pos.get(so.bid);
      const y0 = rowCy[p.row] + (so.side === 'top' ? p.g.edgeAbove : -p.g.edgeBelow);
      const y1 = segments[so.segId].y;
      let list = spans.get(so.col);
      if (list === undefined) spans.set(so.col, (list = []));
      list.push(Math.min(y0, y1), Math.max(y0, y1));
    }
    const crossed = (x, y) => {
      const list = spans.get(x);
      if (list === undefined) return false;
      for (let i = 0; i < list.length; i += 2) if (list[i] <= y && y <= list[i + 1]) return true;
      return false;
    };
    // 工厂本体占的格：只查几个取料格的邻格，不用把几千格都按 gk 记进集合。坐标都是整数、y 在 gk 不撞号的范围（−16 ≤ y < 4080）里时，
    // 「集合里有这一格」就是「落在某台工厂本体的矩形里」，直接按矩形判断；有别的情况（本体宽是偶数之类）时才建集合
    const blockList = [];
    let rectOk = true;
    pos.forEach((p) => {
      blockList.push(p);
      const hw = (p.g.bodyWidth - 1) / 2;
      const cy = rowCy[p.row];
      const yLo = cy - p.g.bodyBelow;
      const yHi = cy + p.g.bodyAbove;
      if (!(Number.isInteger(hw) && Number.isInteger(yLo) && Number.isInteger(yHi) && yLo >= -16 && yHi < 4080)) rectOk = false;
      for (let i = 0; i < p.centers.length; i++) if (!Number.isInteger(p.centers[i])) rectOk = false;
    });
    let solid = null;
    const solidAt = (qx, qy) => {
      if (rectOk && Number.isInteger(qx) && Number.isInteger(qy) && qy >= -16 && qy < 4080) {
        for (let b = 0; b < blockList.length; b++) {
          const p = blockList[b];
          const cy = rowCy[p.row];
          if (qy < cy - p.g.bodyBelow || qy > cy + p.g.bodyAbove) continue;
          const hw = (p.g.bodyWidth - 1) / 2;
          const cs = p.centers;
          for (let i = 0; i < cs.length; i++) if (cs[i] - hw <= qx && qx <= cs[i] + hw) return true;
        }
        return false;
      }
      if (!solid) {
        solid = new Set();
        for (let b = 0; b < blockList.length; b++) {
          const p = blockList[b];
          const hw = (p.g.bodyWidth - 1) / 2;
          const cy = rowCy[p.row];
          for (const cx of p.centers) for (let x = cx - hw; x <= cx + hw; x++) for (let y = cy - p.g.bodyBelow; y <= cy + p.g.bodyAbove; y++) solid.add(gk(x, y));
        }
      }
      return solid.has(gk(qx, qy));
    };
    // 高架上的窗口（legOut，喷涂机骑在段尾那截高架上）：地面的分拣器碰不到它，只看取料格两侧有没有一侧能让增产剂带进来
    const winLeg = new Set();
    for (let i = 0; i < legs.length; i++) if (legs[i].spray && !legs[i].direct) winLeg.add(legs[i].spray.seg);
    for (let si = 0; si < segments.length; si++) {
      const s = segments[si];
      if (!s.sprayGap || s.sprayGap === 'edgeIn') continue; // edgeIn：喷涂机在图外边距里的入口接出段上，图里没有要护的格
      const cells = sprayGapCells(s);
      const elevated = winLeg.has(s.id);
      const ok = (ki) => {
        if (ki + 2 >= cells.length) return false; // 空当被站列截短，骑不下
        if (!elevated) for (let j = ki; j <= ki + 2; j++) if (crossed(cells[j], s.y)) return false;
        return !solidAt(cells[ki], s.y - 1) || !solidAt(cells[ki], s.y + 1);
      };
      if (!ok(0) && !ok(1)) addPenalty('spray', P.spray, `${graph.items.get(s.itemId).name} 的喷涂空当被分拣器或工厂堵住`, itemBids(s.itemId));
    }
  }
  // 流量、宽、长、长宽比、带长、行利用率的惩罚记在喷涂之后、供电之前；没带块的那几条第 4 项是 undefined，和不传一样取默认的 null
  for (let i = 0; i < late.length; i++) {
    const p = late[i];
    addPenalty(p[0], p[1], p[2], p[3]);
  }
  const sorterLengths = { 1: 0, 2: 0, 3: 0 };
  {
    // 1~3 格的先在局部变量里数，最后写回（整数键的先后次序固定）
    let n1 = 0, n2 = 0, n3 = 0;
    for (let i = 0; i < sorters.length; i++) {
      const len = sorters[i].length;
      if (len === 1) n1++;
      else if (len === 2) n2++;
      else if (len === 3) n3++;
      else sorterLengths[len] = (sorterLengths[len] || 0) + 1;
    }
    sorterLengths[1] = n1 + nGapSorters;
    sorterLengths[2] = n2;
    sorterLengths[3] = n3;
  }
  const sorterLenCost = (sorterLengths[2] + 2 * sorterLengths[3]) * opt.sorterLenWeight;
  if (early && (opt.power || opt.stationHoles)) {
    let pen = 0;
    for (let i = 0; i < penalties.length; i++) pen += penalties[i].amount; // 只差最后才记的供电惩罚
    const floor = area * opt.areaWeight + groundBelts + airBelts + pen + sorterLenCost + levelCost + shape.cost + taste.cost;
    if (early(floor)) return { rejected: true, cost: floor };
  }
  // 供电可行性：附近没有空地插塔的工厂/分拣器只能靠外沿加地，加地面积计入成本
  let powerPlan = null;
  if (opt.power) {
    powerPlan = powerBands({ pos, rowCy, chains, legs, segments, ports, stations, sorterList: sorterPlan.sorters, width, height, labGaps }, opt.power, { ...opt.powerOptions, maxWidth: opt.maxWidth, maxHeight: opt.maxHeight });
    if (powerPlan.unreachable) addPenalty('power', P.power * powerPlan.unreachable, `${powerPlan.unreachable} 个工厂/分拣器离任何能放供电设施的地方都太远`, [...new Set((powerPlan.lonely || []).map((t) => t.bid).filter(Boolean))]);
  }
  // 边缘放站：估算把站放进空地（或贴在边上）要多占的面积和接线长度，退火会主动留出空地
  const holes = opt.stationHoles ? stationHoles({ pos, rowCy, segments, legs, ports, sorterList: sorterPlan.sorters, width, height }, { slots: opt.stationSlots }) : null;
  let penalty = 0;
  for (let i = 0; i < penalties.length; i++) penalty += penalties[i].amount;
  // 和惩罚有关的块：按第一次出现的先后去重（和 [...new Set(各条惩罚的块依次排开)] 一样）
  const hot = [];
  if (penalties.length) {
    // 同一块的几条惩罚常常挨着（每台工厂各一条）：和上一个看过的块一样时它肯定已经记过，不用再查集合
    const seen = new Set();
    let prev;
    let hasPrev = false;
    for (let i = 0; i < penalties.length; i++) {
      const bids = penalties[i].bids;
      if (!bids) continue;
      for (let j = 0; j < bids.length; j++) {
        const b = bids[j];
        if (hasPrev && b === prev) continue;
        hasPrev = true;
        prev = b;
        if (seen.has(b)) continue;
        seen.add(b);
        hot.push(b);
      }
    }
  }
  // spray（喷涂空当被堵的预警）只是提示：真喷不上由后处理判（finishOne 按 sprayMissed 记不可行），这里不算不可行
  let feasible = true;
  for (let i = 0; i < penalties.length; i++) {
    if (!softKind(penalties[i].kind)) {
      feasible = false;
      break;
    }
  }
  let factories = 0;
  for (let i = 0; i < graph.groups.length; i++) {
    const g = graph.groups[i];
    if (!g.store) factories += g.count * (g.levels ?? 1); // 排进行里的储物仓（箱子供货）不算工厂
  }
  const result = {
    rows,
    pads,
    blocks,
    pos,
    rowCy,
    rowBelow,
    rowAbove,
    channels,
    segments,
    legs,
    ports,
    chains,
    sides,
    width,
    height,
    area,
    fill,
    belts: groundBelts + airBelts,
    airBelts,
    longestBelt: longestLen,
    longestBeltItem: longestItem,
    sorters: sorters.length + nGapSorters,
    sorterList: sorters,
    sorterLengths,
    factories,
    penalties,
    penalty,
    hot,
    feasible,
    powerPlan,
    powerHoles, // 卫星配电站在行里留的空位（layout/powerholes.js），挖出来的供电时必放
    streets: streetX,
    roads,
    trunk: side ? corridor : null, // 主干走廊所在的列（只用于显示和统计）
    stations: stations.map((st) => ({ x: st.x, y: st.y, items: st.items, ports: st.ports, stack: opt.station?.stack ?? 1 })),
    holes,
    shape,
    cost: (area + (powerPlan?.extraArea ?? 0)) * opt.areaWeight + groundBelts + airBelts + penalty + sorterLenCost + levelCost + shape.cost + (holes ? holes.growth * opt.areaWeight + holes.dist : 0) + taste.cost,
    levelCost,
    taste,
    quick: !!opt.quick,
  };
  // 研究站夹带（宇宙矩阵那种组才有）：地面格、侧面分拣器，后处理、出蓝图、画图都从这里取。没有的线不加这个键
  if (labGaps) result.labGaps = labGaps;
  return result;
}
