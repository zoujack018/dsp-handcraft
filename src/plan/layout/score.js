// 约束检查与计数：分拣器落位、各类惩罚、面积与带数、结构代价、最终代价
import { assignSorters, sideCap } from '../sorters.js';
import { powerBands } from '../power.js';
import { stationHoles } from '../holes.js';
import { STATION_COLS, TOL, busMinX, gk } from './shared.js';
import { sprayGapCells } from './elevation.js';
import { OVERPASS_Z } from '../../gamedata.js';

// 线性超高税（opt.heightTax）要查的「这一格在不在熔炉、制造台本体头顶」：按 (x, y) 编号的表，按线程复用，存这一次的戳（不用清零）
let overBuf = new Int32Array(0);
let overStamp = 0;
/**
 * 熔炉、制造台的块（整段 x0..x1，含制造台之间的窄缝）本体那几行的格子，和 plan/ground.js 落地时的 over 一样；每次 route() 建一次
 * （有桥段时才建）。块都在 0..xR、0..height−1 里，表外的格子不在工厂头顶。返回 (x, y) → 在不在
 */
function overTable(pos, rowCy, xR, height) {
  const W = xR + 1;
  const H = height;
  if (overBuf.length < W * H || overStamp >= 2e9) {
    overBuf = new Int32Array(Math.max(W * H, Math.ceil(overBuf.length * 1.5)));
    overStamp = 0;
  }
  const st = ++overStamp;
  const buf = overBuf;
  pos.forEach((p) => {
    if (p.g.kind !== 'smelter' && p.g.kind !== 'assembler') return;
    const cy = rowCy[p.row];
    for (let x = p.x0; x <= p.x1; x++) {
      if (!Number.isInteger(x) || x < 0 || x >= W) continue;
      for (let y = cy - p.g.bodyBelow; y <= cy + p.g.bodyAbove; y++) if (Number.isInteger(y) && y >= 0 && y < H) buf[x * H + y] = st;
    }
  });
  return (x, y) => x >= 0 && x < W && y >= 0 && y < H && buf[x * H + y] === st;
}

/**
 * 线性超高税（opt.heightTax）的一格：第 z 层、这一格最低能走第 need 层。
 * per × max(0, z − need) + topWeight × max(0, z − topFrom + 1)（默认第 5 层每格另加 1、第 6 层另加 2）
 */
export const heightCell = (z, need, per, topFrom, topWeight) => per * Math.max(0, z - need) + topWeight * Math.max(0, z - topFrom + 1);

/**
 * 一段高架的线性超高税：水平走进的每一格（和上一格不在同一 (x, y)、在空中；和 plan/ground.js 的 taxStep 数的格子一样，
 * 两头升降那一叠只有落下那一叠的叠顶算一格），层按段分到的层 lv 算。完整分层（liftLegs）里这些格子都在第 lv 层；
 * 快速评估（estimateLegs）里普通段的水平格子只按第 1 层记（只估长度），按 lv 算两边才一致。
 * isOver：桥段才传（overTable 的结果），桥段在熔炉、制造台本体头顶的格子最低能走第 OVERPASS_Z 层，别处都是第 1 层。
 * 按「普通格数 × 一格的税 + 工厂头顶格数 × 一格的税」算
 */
export function legHeightTax(cs, lv, isOver, per, topFrom, topWeight) {
  let nH = 0;
  let nOver = 0;
  for (let i = 1; i < cs.length; i++) {
    const q = cs[i];
    const p = cs[i - 1];
    if (q[2] > 0 && (q[0] !== p[0] || q[1] !== p[1])) {
      nH++;
      if (isOver !== null && isOver(q[0], q[1])) nOver++;
    }
  }
  if (!nH) return 0;
  return (nH - nOver) * heightCell(lv, 1, per, topFrom, topWeight) + nOver * heightCell(lv, OVERPASS_Z, per, topFrom, topWeight);
}

/** route() 的一步：读写共享的布局上下文 c */
/**
 * 一段高架里升降和拐弯挨得多近（用户 2026/10/07：转弯后没过几个格子就升降、升降后直接转弯，看着挤）。只用来量（考卷、测试），
 * 没进打分、也没改选列（2026/10/07 量过，都没留）：
 *   放进打分（每缺一格计 1）：6 条线 × 3 种模式 × 3 个种子，挨太近 422 → 432，退火没有挪升降位置的动作，等于白加；
 *   选竖直穿行那一列时（layout/positions.js 的 bestColumn）要求两头各直走 3 格、每缺一格 +2：引力矩阵 30 挨太近 −17%，
 *   但高架格子 +8%，27 次里可行 22 → 13（密的大产线能竖直穿行的列本来就少，挑远的那列高架更长、层更挤）；每缺一格 +1.5：和噪声分不开。
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
const legLen = (l) => l.cells.length + (l.kind !== 'link' && !l.direct ? 1 : 0);
/** 不影响可行的惩罚（只是提示或口味） */
const softKind = (k) => k === 'aspect' || k === 'long' || k === 'fill' || k === 'spray';
const NO_BLOCKS = [];
// 每条带的格数（设了 maxBelt 时要逐条再看一遍），按线程复用
let pathLenBuf = new Float64Array(64);

// 惩罚文字按内容复用（按线程）：退火每一步都要记几十上百条「分拣器不够快」「要伸太长」（同一块的每台工厂各一条），
// 组名、物品名和几个数都一样时拼出来的字一模一样（字符串不可变，共用一份和每次各拼一份没有区别），拼一次就记下来。
// 表按 组名 → 物品名 查到一串 [数…, 文字, 数…, 文字, …]（同一组同一物品只有几种根数、长度，流量是定的），数按 === 比
// （和 Map 的键一样 +0、−0 算同一个，拼出来也一样是 "0"；有 NaN 的不记，每次照拼）；条目太多时整张清掉重来
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

// 退火提前拒绝，第三处（分支 explore/typeset）：在 route() 里 placePorts 之后、liftLegs/estimateLegs 之前问一次。
// 背景：退火里 92%~97% 的 route() 最后被 rejectFloor 拒掉，但原来的两处提前拒绝（本文件 scoreLayout 里，分拣器之前、
// 供电之前）都在 elevation（liftLegs）跑完之后——而 elevation 一步就占 route 总时间的一半。在它之前先按下限问一次，
// 能省掉最费时的这一步。量到的数（macmini，引力矩阵 180 塔，每轮 3000 步）：gm180 的两轮里分别多拦掉被拒评估的
// 16% 和 37%，一次误拒都没有（gm360 当前不可行、代价里有分层记的层/路惩罚，暂时拦不到，可行后也会有收益）。
//
// 为什么 floor_pre 不超过最终代价（最终代价见本文件末尾 result.cost）：
//   最终代价 = (area+extraArea)*areaWeight + groundBelts + airBelts + penalty + sorterLenCost + levelCost
//            + shape.cost + holes项 + taste.cost。这里把它拆成「算得出的下限」加「一律按 0 的非负项」：
//   - 面积：width_lb = max(xR−1, 各 segments[i].b, 各 ports[i].x) + 1 − minX，和 scoreLayout 算 maxX 的前三项一样，只少了
//     高架格子那一项（maxX 还会并上各 leg 的格子 x，只会更大，所以 width_lb ≤ 最终 width；minX 是左边总线口那一列、没有时 0，
//     两处一样，口 elevation 不改）；height 在 tracks/ports
//     之后已定、elevation 不再改（ports.js 可能抬高 height，那也在这一步之前）；extraArea ≥ 0、areaWeight ≥ 0。
//   - groundBelts = segCells + portCells + stubCells，照 scoreLayout 里 segments[i].b−a+1 求和、!ports[i].direct 计数、
//     legs[i].stub?.length 求和。这三样（segments 的 a/b、ports 的 direct、legs 的 stub）elevation 都不改，和最终相等。
//   - penalty：只累加已记下的（positions/belts/tracks/ports 记的 shortfall/route/spray/tracks 等）。惩罚只增不删、按
//     记下的先后往数组里 push，这里累加的正好是最终那串的一段前缀，剩下的（elevation、分拣器、供电记的）都在后面追加、
//     每条 amount ≥ 0，所以这段前缀和 ≤ 最终 penalty（IEEE754：对非负数 fl(x+y) ≥ x，把同一个部分和继续加非负项只增不减）。
//   - 其余项（airBelts、sorterLenCost、levelCost、shape.cost、holes、taste）在守卫成立时都 ≥ 0，一律按 0。
//   浮点加法对非负操作数单调（a≤a′、b≤b′ ⇒ fl(a+b)≤fl(a′+b′)），逐项套下来 floor_pre ≤ scoreLayout 第一处的 floor
//   ≤ 最终代价。于是单调的 rejects(floor)（floor 越大越容易拒）对这次更小的 floor_pre 下的结论，不会把本会算完的候选误拒：
//   一个候选最终是「被拒」还是「算完」的判定不变，被拒时退火照样只抽掉一个随机数、序列和存档一字不变；stateMemo 记的下限
//   多了这一项，回放时逐项问、单调性保证结论一样。
// 守卫（参照 scoreLayout 里 early 第 309 行并加严）：所有进最终代价的权重和惩罚项都要 ≥ 0，任一不成立（或没传 rejectFloor）
// 就返回 null，调用方照旧往下算。默认值都满足。
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
      opt.highWeight >= 0 &&
      opt.pyramidWeight >= 0 &&
      opt.turnWeight >= 0 &&
      opt.liftWeight >= 0 &&
      (!opt.bridges || opt.bridgeWeight >= 0) &&
      (!opt.heightTax || (Number(opt.heightPerLevel) >= 0 && Number(opt.heightTopWeight) >= 0))
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

/**
 * 高架前的下限里不含惩罚的那两项：面积下限 × areaWeight + 地面带，和最终代价开头的 (面积 + 外沿) × areaWeight + groundBelts 同一个先后
 * （preLegFloor、preLegSorterFloor 共用；拆出来以前 preLegFloor 直接写 areaLb * w + (seg + port + stub) + pen，从左到右加，和 preLegBase(c) + pen 逐位一样）
 */
function preLegBase(c) {
  const { opt, segments, ports, legs, height, xR } = c;
  // 面积下限：少了高架格子那一项（最终 maxX 只会更大）
  let maxX = xR - 1;
  for (let i = 0; i < segments.length; i++) maxX = Math.max(maxX, segments[i].b);
  for (let i = 0; i < ports.length; i++) maxX = Math.max(maxX, ports[i].x);
  const minX = opt.busSide === 'auto' ? busMinX(ports) : 0; // 左边的总线（和 scoreLayout 一样）
  const areaLb = (maxX - minX + 1) * height;
  // 地面带（和 scoreLayout 第 210~214 行同一个算法）
  let segCells = 0;
  for (let i = 0; i < segments.length; i++) segCells += segments[i].b - segments[i].a + 1;
  let portCells = 0;
  for (let i = 0; i < ports.length; i++) if (!ports[i].direct) portCells++;
  let stubCells = 0;
  for (let i = 0; i < legs.length; i++) stubCells += legs[i].stub?.length ?? 0;
  return areaLb * opt.areaWeight + (segCells + portCells + stubCells);
}

/** 排分拣器（scoreLayout 和 route.js 的 layout() 提前排时共用，参数一模一样） */
export function sorterPlanOf(c) {
  const { graph, rows, pos, rowCy, rowBelow, rowAbove, channels, segments, sides, opt } = c;
  return assignSorters(graph, { rows, pos, rowCy, rowBelow, rowAbove, channels, segments }, sides, { sorter: opt.sorter, headroom: opt.headroom, fourthTrack: !!opt.fourthTrack, wideTracks: !!opt.wideTracks, cache: opt.sorterCache !== false });
}

// 退火提前拒绝，第四处（route.js 的 earlySorters）：分拣器挪到高架之前排，用它的惩罚和长度代价把 preLegFloor 补紧，再问一次。
// 背景（2026/10/24 影子评估）：慢线上高架占 route 的 40%~57%，preLegFloor 只拦下注定被拒的 1%~11%，九成要跑完高架、到下面
// scoreLayout 的第一处（分拣器之前）才被拒；差的主要就是分拣器那一步的惩罚。加上它能多拦没拦住的 45%~70%（master）、64%~89%（排版内核）。
// 能挪的根据：分拣器只读 rows、pos、rowCy、rowBelow、rowAbove、channels、segments、sides（sorterPlanOf），placePorts 之后都定了；
// elevation（liftLegs）只写各 leg 的 cells/shadow/level/broken/road、c.roads 和 level/route 惩罚，不碰这些（segments 的
// a/b/ch/itemId/id/taps/track/split/dir/fed、channels 的 c/n、pos 里的 g/gid/centers、sides 里的表都只读），
// 所以提前排出来和 scoreLayout 里排的逐字一样，scoreLayout 直接用这一份（c.sorterPlan）。
//
// 为什么这个下限不超过最终代价（论证照 preLegFloor）：
//   最终代价按 (面积+外沿)×w + groundBelts + airBelts + penalty + sorterLenCost + levelCost + shape.cost + holes项 + taste.cost 从左到右加；
//   这里是 面积下限×w + groundBelts + pen + sorterLenCost，同样从左到右加：
//   - 面积下限×w、groundBelts：和 preLegFloor 一样（preLegBase），前者 ≤ 最终、后者相等。
//   - pen：最终的惩罚数组按记下的先后是 高架前已记的 → 高架记的（level、route）→ slots → clash → shortfall → tracks → slow
//     → spray → late（belt/width/height/aspect/long/fill）→ power。这里按 高架前已记的 → slots → clash → shortfall → tracks → slow
//     逐条加，是它的一个子序列（相对先后不变，只少了中间几段）；每条的数和 scoreLayout 记的同一个式子、同样的输入（slots 照
//     scoreLayout 开头的算法，其余几项来自同一份分拣器结果），逐位相同。一串非负数的部分和里任意位置插进非负项，后面每个部分和
//     都只增不减（fl(s+e) ≥ s，fl 单调），所以 pen ≤ 最终 penalty。
//   - sorterLenCost：同一份 sorters、同一个式子，相等。
//   - 少掉的 airBelts、levelCost、shape.cost、holes 项、taste.cost 在守卫成立时都 ≥ 0，按 0。
//   浮点加法、乘法对非负操作数单调，逐项套下来这个下限 ≤ 最终代价，和 preLegFloor 一样不会把本会算完的候选误拒。
//   同样的道理，它也不超过 scoreLayout 里供电之前那一问的下限（那一问的各项按同样的先后都在，只多了非负项；分拣器之前那一问
//   没有分拣器的惩罚，不一定比它大）：开着供电或站空地、有那一问时，这一问能拒的，算下去到那一问也一定被拒。
//   不往 c.penalties 里记任何东西：最终惩罚数组的内容和先后和原来一样。
// 守卫：调用方只在 preLegFloor 不是 null（权重、opt.penalty 每一项、已记的惩罚都 ≥ 0）时才来，这里再看一遍新用到的几项；不成立返回 null
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

// 退火提前拒绝，第五处（route.js 的 layout()：preLegFloor 没拒之后、提前排分拣器之前）：preLegFloor 补上分拣器位、够不着、太慢三项再问一次。
// 背景（2026/10/27，分支 explore/template 的 tools/exp/reject-anatomy.mjs，排版内核 8 条线 × 两轮）：调了 route() 的评估只有 2%~7% 被接受，
// 被拒的多半要等分拣器排完才拒——上下撞列、太慢、够不着占被拒的 10%~86%（300 台以上的线 20%~86%），高架前那一问只拦得住通道超轨的。
// 够不着、太慢在 assignSorters 收集工厂那一段就定了（接哪段带、第几条轨、分拣器多长、按槽位上限减根数），不用动态规划（countOnly），
// 分拣器位分带之后就定了；补上这三项，大部分本来要排完分拣器、甚至跑完高架才拒的评估在这里就拒了。
//
// 为什么这个下限不超过最终代价（论证照 preLegSorterFloor）：这里是 面积下限×w + 地面带（preLegBase）+ pen，pen 按 高架前已记的 → slots
// → 够不着（每条一个 P.tracks）→ 太慢（每条一个 P.slow）逐条加，是最终惩罚数组（高架前已记的 → 高架记的 → slots → clash → shortfall
// → tracks → slow → …）的一个子序列，每条的数和 scoreLayout 记的同一个式子、同样的输入：slots 照 scoreLayout 开头的算法；够不着、太慢的
// 条数和不带 countOnly 时 tooLong、slow 的长度一样（同一段代码，分拣器的输入 placePorts 之后都定了、高架不改，见 preLegSorterFloor）。
// 一样的道理，它也不超过 preLegSorterFloor（多了 clash、shortfall 和分拣器长度代价），不超过 scoreLayout 里供电之前那一问（各项按同样的
// 先后都在，只多了非负项）。所以：
//   - 退火（place.js 的 runRound）：这里拒了的，算完也注定被接受判断拒掉，随机数、状态、存档、best 都一样；stateMemo 多记一个下限，回放单调；
//   - 只在 opt.power || opt.stationHoles（scoreLayout 有供电之前那一问）时问：那一问只要算到就一定问，这里能拒的、算下去到那一问也一定
//     被拒，所以定点精修（place.js 的 polish，被拒的不进存档）、配电站挖空位第一遍（route.js 的 route）拒不拒都和原来一样；
//   - 提前排分拣器开着时，那一问能拒的这里先拒了，只是更早；
//   - 不往 c.penalties 里记任何东西，assignSorters 只数不排、不碰按通道的缓存（cache: false），后面排分拣器照旧从头排。
// 守卫：调用方只在 preLegFloor 不是 null（权重、opt.penalty 每一项、已记的惩罚都 ≥ 0）时才来，这里再看一遍新用到的几项；不问时返回 null
export function preLegWantFloor(c) {
  const { graph, rows, pos, rowCy, rowBelow, rowAbove, channels, segments, sides, opt, P } = c;
  if (!(opt.power || opt.stationHoles)) return null;
  if (!(P.slots >= 0 && P.tracks >= 0 && P.slow >= 0)) return null;
  let pen = preLegSlotsPen(c);
  const counts = assignSorters(graph, { rows, pos, rowCy, rowBelow, rowAbove, channels, segments }, sides, { sorter: opt.sorter, headroom: opt.headroom, cache: false, countOnly: true });
  c.wantCounts = counts; // 第六处（preLegElevFloor）接着用
  for (let i = 0; i < counts.nTooLong; i++) pen += P.tracks;
  for (let i = 0; i < counts.nSlow; i++) pen += P.slow;
  return preLegBase(c) + pen;
}

// 退火提前拒绝，第六处（elevation.js 的 liftLegs → levels.js 的 solveLevels：拓扑排序、贪心放层之后，局部搜索之前）：
// 在第五处（或提前排的分拣器那一问）上补高架已经定了的罚分再问一次。
// 背景（2026/10/27，分支 explore/perf6 的 tools/exp/cost-anatomy.mjs，考卷 2 十格 × 两轮，主干内核）：打分里才被拒的评估多半靠的是高架的
// 「无处可放」（每段 4 个 P.route），这些段在局部搜索之前就全判死了（成环里最短的、贪心放不下的，还有带喷涂窗口和形状随层变的那批先排时
// 放不下的）；在这里问能省掉局部搜索、落地和打分，量出来每步 0.4%~21%（量子化工厂那条、轨道采集器高配最多）。
//
// 为什么这个下限不超过最终代价（论证照 preLegSorterFloor、preLegWantFloor）：这里是 面积下限×w + 地面带（preLegBase：高架不改段、口、
// 桩和高）+ pen，pen 按 已记的（高架前的 + 高架先排那批记的，正好是最终惩罚数组的前缀）→ 已判死的平段各一个 P.route × 4 → slots →
// （提前排过分拣器时）clash → shortfall → tracks → slow，或者（没排过）第五处数的够不着、太慢，逐条加。判死的段 solveLevels 不会再放回去
// （dead 只置 1），liftLegs 对层号是 0 的平段各记一条 P.route × 4，所以这几条是最终惩罚数组高架那一段的子序列（值都一样，先后无关），
// 整串是最终惩罚数组的子序列；分拣器长度代价同 preLegSorterFloor。也不超过 scoreLayout 里供电之前那一问（各项都在，只多了非负项）。
// 所以和第五处一样：退火里拒了的算完也注定被拒；只在第五处问过时问（开着供电或站空地），精修、配电站挖空位第一遍拒不拒不变；stateMemo 回放单调。
// 第五处没问（c.wantCounts 没有）时返回 null
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
// 函数还没被优化编译时也不会每一步都造迭代结果和小数组；算出的数和以前逐项按同样的先后相加，一字不差
export function scoreLayout(c) {
  const { P, R, addPenalty, beltCap, blocks, blocksOf, chains, channels, corridor, graph, height, itemBids, legs, opt, pads, penalties, pileCap, ports, pos, powerHoles, rawCap, roads, rowAbove, rowBelow, rowCy, rows, segments, side, sides, stations, streetX, xR } = c;
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
  // 不依赖分拣器的部分先算（流量、尺寸、带数、结构、叠层、口味）；这几项的惩罚先存在 late 里，等分拣器的惩罚记完再按原来的次序记
  const late = [];
  // 每条带（原料每个入口一条，产物一种一条）的流量不能超过单条带运力（产物带开集装机时是集装后的运力 pileCap，layout/belts.js）
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
    if (rate > cap + TOL) late.push(['belt', P.belt, `${it.name} 流量 ${rate.toFixed(0)}/分 超过${cap > beltCap && it.producer !== 'RAW' ? '一条带叠 4 层的' : '单条带'}运力 ${cap}/分`, itemBids(ch.itemId)]);
  }

  let maxX = xR - 1;
  for (let i = 0; i < segments.length; i++) maxX = Math.max(maxX, segments[i].b);
  for (let i = 0; i < ports.length; i++) maxX = Math.max(maxX, ports[i].x);
  // 总线排到左边（busSide 'auto'）：口和竖走的列在 x < 0，宽从左边总线口那一列算起（和右边的总线一样算进面积），
  // 坐标到收尾才挪成从 0 起（plan/index.js 的 finishOne）；总线的格子都在口的右边，最左就是口
  const minX = opt.busSide === 'auto' ? busMinX(ports) : 0;
  // 高架段扫一遍：最右的格子、高架格数、地面插头格数、超长部分（结构代价）、叠层（第 2 层起每层每段），
  // 以及口味里逐格数的两项（金字塔：在本段所在层的格数；拐弯：连着三格同层、方向变了），每段的格子只走一遍
  // 线性超高税（route.js 的 heightTax，细档开）：开着时代替金字塔，关着时不读它的参数
  const heightOn = !!opt.heightTax;
  const tasteOn = opt.highWeight || opt.pyramidWeight || opt.turnWeight || opt.liftWeight || heightOn;
  let airBelts = 0;
  let stubCells = 0;
  let longCells = 0;
  let lifted = 0;
  let tHigh = 0;
  let tPyramid = 0;
  let tTurns = 0;
  let tHeight = 0;
  // 桥（route.js 的 bridges）：关着时不读 leg.bridge
  const bridgeOn = !!opt.bridges;
  let nBridge = 0;
  // 超高税的参数（考卷的 ro.heightPerLevel=1 会解析成 true，一律按数取），有桥段时建「在不在工厂头顶」的表
  let hPer = 0;
  let hTopFrom = 0;
  let hTopW = 0;
  let isOver = null;
  if (heightOn) {
    hPer = Number(opt.heightPerLevel);
    hTopFrom = Number(opt.heightTopFrom);
    hTopW = Number(opt.heightTopWeight);
    for (let li = 0; bridgeOn && li < legs.length; li++) {
      if (legs[li].bridge !== true || !legs[li].cells.length) continue;
      isOver = overTable(pos, rowCy, xR, height);
      break;
    }
  }
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
    // 桥段（竖直那截从熔炉、制造台头顶过）：叠层、太高、金字塔都按「有效层」= 层 − (bridgeLevel − 1) 算（第 4 层的桥按第 1 层计），
    // 另外每座桥计 bridgeWeight（下面的 levelCost，和 positions.js 选列时加的一样），「不喜欢桥」只看这一个数；
    // 两头多叠的升降节数照常算在 airBelts 里（2026/10/19 改：原来按真实层算，第 4 层一格金字塔就 3.5，桥几乎都不划算）。
    // 线性超高税（heightTax）开着时不用有效层：桥段在工厂头顶那几格本来就得在第 OVERPASS_Z 层、不收，在通道上空那几格按真实层收
    // （落地开着变层税时桥是整段 0→4→0，通道上空那截也在第 4 层）
    let ev = lv;
    if (bridgeOn && l.bridge === true) {
      ev = lv - (opt.bridgeLevel - 1);
      if (cs.length) nBridge++;
    }
    lifted += cs?.length && ev > 1 ? ev - 1 : 0;
    if (tasteOn && cs?.length) {
      // 太高：第 highFrom 层往上每段 1、3、6……；金字塔：长的段在高层最贵，2 层够多了才值得上 3 层
      const k = ev - opt.highFrom;
      if (k > 0) tHigh += (k * (k + 1)) / 2;
      // 线性超高税开着时代替金字塔：按真实层（lv）算，桥段在工厂头顶的格子从第 OVERPASS_Z 层起算、在通道上空照样从第 1 层起算
      if (heightOn) tHeight += legHeightTax(cs, lv, isOver !== null && l.bridge === true ? isOver : null, hPer, hTopFrom, hTopW);
      else if (ev > opt.pyramidFrom) tPyramid += nTop * (2 ** (ev - opt.pyramidFrom) - 1);
      tTurns += turns;
    }
  }
  const width = maxX - minX + 1;
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
      len += p.seg != null ? segLen(segments[p.seg]) : legLen(legs[p.leg]);
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
  // 高架叠层的代价：第 2 层起每层每段 levelWeight 格（桥段按有效层）；每座桥再加 bridgeWeight 格（没有桥时不加，结果和原来一字不差）
  let levelCost = lifted * opt.levelWeight;
  if (nBridge) levelCost += nBridge * opt.bridgeWeight;
  // 口味（用户 2026/10/06）：太高的高架、拐弯、一条带子反复升降各计一点（权重为 0 时不算，结果和以前一样）
  const taste = { high: 0, pyramid: 0, turns: 0, lifts: 0, cost: 0 };
  if (tasteOn) {
    // 太高、金字塔、拐弯在上面扫高架段时已经按段的先后加好
    taste.high = tHigh;
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
    taste.cost = taste.high * opt.highWeight + taste.pyramid * opt.pyramidWeight + taste.turns * opt.turnWeight + taste.lifts * opt.liftWeight;
    // 线性超高税（开着时金字塔是 0）：权重已经在每格的税里，直接加；关着时 taste 里没有这一项
    if (heightOn) {
      taste.height = tHeight;
      taste.cost += tHeight;
    }
  }
  // 退火提前拒绝（place.js 的 runRound 传 opt.rejectFloor，只在退火评估邻域时有）：到这里面积、带数、叠层、结构、口味代价
  // 和已经记下的惩罚都定了，还没算的（分拣器、喷涂空当、供电外沿、物流站空地的代价和惩罚，分拣器长度代价）都不是负的，
  // 所以下面按最终代价同样的次序、把没算的项当 0 加出来的 floor 不会比最终代价高（浮点加法对每一项都是单调的；
  // 惩罚按记下的先后加，只是少了中间几项）。rejectFloor(floor) 说这一步注定被拒，就不再算后面最费时的几步，
  // 返回 { rejected: true }；不拒时照常算完，结果一字不差。分拣器排完再问一次（那时只差供电外沿、站空地和供电惩罚）
  const early = opt.rejectFloor && opt.areaWeight >= 0 && opt.sorterLenWeight >= 0 && P.clash >= 0 && P.shortfall >= 0 && P.tracks >= 0 && P.slow >= 0 && P.spray >= 0 && P.power >= 0 ? opt.rejectFloor : null;
  if (early) {
    let pen = 0;
    for (let i = 0; i < penalties.length; i++) pen += penalties[i].amount;
    for (let i = 0; i < late.length; i++) pen += late[i][1];
    const floor = area * opt.areaWeight + groundBelts + airBelts + pen + levelCost + shape.cost + taste.cost;
    if (early(floor)) return { rejected: true, cost: floor };
  }
  // route.js 的 layout() 在高架之前已经排过（earlySorters，见 preLegSorterFloor）就直接用那一份，排出来逐字一样
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
  // 喷涂机的空当要真能骑（opt.sprayAll）：压着的 3 格上不能有分拣器横穿，取料格两侧不能都是工厂
  // （增产剂带要在取料格上方第 1 层横穿，至少一侧要能进）。两个候选位置都被堵的按走不通罚，退火会把块挪开
  if (opt.sprayAll) {
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
    // 工厂本体占的格（原来把每块本体的格子都按 gk 记进集合，再按 gk 查）。只查几个取料格的邻格，不用把几千格都记一遍：
    // 坐标都是整数、y 在 gk 不撞号的范围（−16 ≤ y < 4080）里时，gk 一格一号，「集合里有这一格」就是「落在某台工厂本体的矩形里」，
    // 直接按矩形判断；有别的情况（本体宽是偶数之类）时照原来建集合
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
  // 流量、宽、长、长宽比、带长、行利用率的惩罚，记在原来的位置（喷涂之后、供电之前）；没带块的那几条第 4 项是 undefined，和不传一样取默认的 null
  for (let i = 0; i < late.length; i++) {
    const p = late[i];
    addPenalty(p[0], p[1], p[2], p[3]);
  }
  const sorterLengths = { 1: 0, 2: 0, 3: 0 };
  {
    // 1~3 格的先在局部变量里数，最后写回（整数键的先后次序固定，对象和逐个加一模一样）
    let n1 = 0, n2 = 0, n3 = 0;
    for (let i = 0; i < sorters.length; i++) {
      const len = sorters[i].length;
      if (len === 1) n1++;
      else if (len === 2) n2++;
      else if (len === 3) n3++;
      else sorterLengths[len] = (sorterLengths[len] || 0) + 1;
    }
    sorterLengths[1] = n1;
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
    powerPlan = powerBands({ pos, rowCy, chains, legs, segments, ports, stations, sorterList: sorterPlan.sorters, width, height, x0: minX }, opt.power, { ...opt.powerOptions, maxWidth: opt.maxWidth, maxHeight: opt.maxHeight });
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
    sorters: sorters.length,
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
  return result;
}
