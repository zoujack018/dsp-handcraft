// 夹心式布局的布线与打分。
//
// 模型（自下而上）：通道0 | 第0行工厂 | 通道1 | 第1行工厂 | ... | 第R-1行 | 通道R
// - 配方组可以拆成几个「块」（同配方连续的几台工厂），分别放在不同的行。
// - 第 r 行的块只能从通道 r（下方）和通道 r+1（上方）取料、出料；分拣器最长 3 格，所以一个通道最多 3 条地面轨道。
// - 每种物品一条单品带，按顺序经过若干个通道（「访问」）。带子只在有分拣器接的那一段落地（「取放段」，占地面轨道），
//   段与段之间、入口到第一段、最后一段到出口都走高架（z ≥ 1）：段尾原地抬升，沿通道上空走到一列空列（左右边缘或行间空隙），
//   竖直走到目标通道，再走到下一段段首原地落下。高架可以从地面带子和分拣器上方经过，不从工厂上方经过（game-rules 第 4 条）。
// - 原地升降是同一格里 z 差 1 的两节带子直接相连，要解锁「超级磁场发生器」（game-rules 第 6、34 条；没解锁时见 noLift）。
// - 原料从左右边缘的地面入口进来，成品从边缘的地面出口离开。
//
// route() 是确定性的：给定行、块、空列和辅路，算出完整几何和成本。它按顺序调用 layout/ 下的几步，每一步读写同一个上下文 c：
//   positions 横向位置 → belts 物品路线 → tracks 轨道与纵向位置 → ports 出入口与物流站 → elevation 高架 → score 打分
import { placeBlocks } from './layout/positions.js';
import { routeItems } from './layout/belts.js';
import { placeTracks } from './layout/tracks.js';
import { placePorts } from './layout/ports.js';
import { liftLegs, estimateLegs, rampLegs } from './layout/elevation.js';
import { scoreLayout, preLegFloor, preLegSorterFloor, preLegWantFloor, preLegElevFloor, sorterPlanOf } from './layout/score.js';
import { powerHoles } from './layout/powerholes.js';
import { BELT_SPEED } from '../gamedata.js';

export { STATION_SIZE, TRUNK, STATION_COLS, STATION_SLOTS } from './layout/shared.js';

export const DEFAULTS = {
  belt: 3, // 传送带等级 1/2/3
  stack: 1, // 带上堆叠层数（保守按 1 计算运力）
  // 自动集装机：产物一种超过单条带的运力时不拆带，一条带最多运 pileModel 定的运力，带上每放约 1700/分单个物品，
  // 后处理就在下游放一台集装机（plan/addons.js 的 stackPilers）。关掉时按单条带拆带
  pilers: true,
  // 开集装机时产物带一条按多少运力排（plan/piling.js 的 pileCapOf）：null 按单条带的 4 倍；正整数 k 按一条带最多放 k 台集装机够得着的算
  pileModel: null,
  // 集装分拣器往带上叠几层（「集装分拣器改良」，game-rules 第 45 条），只在 sorter 2014 时由调用方传 >1：
  // 产物带一条按单条带格位 × 这个数排、超了拆带，后处理放料按这么多层记。原料带不看它
  sorterStack: 1,
  maxTracks: 3, // 分拣器最长 3 格 => 每个通道最多 3 条地面轨道
  // 第 4 条轨：每根分拣器都够得着时（下方那行接第 0~2 条、上方那行接第 1~3 条）一个通道排 4 条地面轨道（layout/tracks.js）。
  // 喷增产剂时 plan/index.js 打开
  fourthTrack: false,
  // 宽通道（排版内核打开）：一个通道超过 3 条轨时按每段由哪一侧接重新分轨（只下方接的放低处、只上方接的放高处、两边接的放中间），
  // 每根分拣器不超过 3 格，最多 6 条。通道变宽、不用升高架
  wideTracks: false,
  // 按侧拆段（和宽通道一起开）：一种物品上下两行都接、但两行接的横向范围差 SIDE_SPLIT 格以上时，拆成只下方接、只上方接两段，中间走高架
  sideSplit: false,
  // 精确分带（排版内核打开）：要几条带的产物按块分带凑不齐时，换生产者的切法、消费者的分法再找缺口最小的（layout/belts.js 的 exactBins）
  exactSplit: false,
  leftMargin: 1, // 第 0 列是左边缘：入口、出口和竖直高架带走这里
  sorter: 2013, // 分拣器类型：2011 分拣器 2012 高速 2013 极速 2014 集装
  maxAspect: null, // 长宽比上限，null 表示不限制
  maxWidth: null, // 宽度上限（格），比如 25/50/100，贴合星球纬度方向铺蓝图；超出按不可行处理
  maxHeight: null, // 长度上限（格，y 方向），比如 25/50/100；超出按不可行处理
  headroom: 1.15, // 分拣器速度至少比平均需求高这么多，不够就并排加一根
  sorterLenWeight: 2, // 分拣器每多伸 1 格计入成本的权重（拉长会变慢，尽量用短的）
  maxBelt: null, // 一种物品从带头到带尾的最长格数（含高架），超出部分加罚；null 不限制
  minFill: 0.7, // 土地利用率（工厂行被工厂占满的比例）合格线，低于它按差额加罚
  maxLevel: 4, // 高架最多抬几层
  // 结构代价（不影响可行性，只让退火避开难看、费地的结构）：
  singleWeight: 2, // 一排只有一台工厂：每排计 这个数 × 宽度
  splitWeight: 8, // 一个配方组拆成的块数超过限宽所需：每多一块计这么多格
  farWeight: 4, // 同组的块之间隔了不相邻的行：每多隔一行计这么多格
  entryWeight: 40, // 同一种原料的入口数超过运力所需：每多一个入口计这么多格（也用来决定原料带串不串通道）
  sameSide: true, // 同一种原料的几个入口都在同一边，layout/belts.js 左右各试算一遍取便宜的
  // 同一种原料的几个入口挨在一起：侧边总线，口都在右边布局外最外那一列、相邻几行，每条带在外面各占一列竖着走到自己那段的行
  // （layout/ports.js、layout/elevation.js；都挤在边缘一列的话高架层不够用）
  groupPorts: true,
  // 出入口都在左边（箱子供货的左侧仓列模式）：原料从左边进、成品从左边出，和靠左侧站列一样的方向约束
  leftPorts: false,
  // 不用原地升降（没解锁「超级磁场发生器」）：高架的升降都换成每格升降半层的坡（layout/elevation.js 的 rampLegs，game-rules 第 38 条）；
  // 不做高架落地（plan/ground.js），接物流站、仓组、翘曲器的线只走地面，还剩原地升降的（喷涂）按不可行
  noLift: false,
  longFrom: 24, // 高架段超过这么长（格）的部分
  longWeight: 1, // 每格再多计这么多（为一种子材料拉跨半张图的长带）
  levelWeight: 3, // 高架每多抬一层（第 2 层起）计入成本的格数：叠得高不好看，也难手搭
  // 口味（罚得轻，省地仍是主要的）：不要太高的带子、反复升降、频繁拐弯。层数按格子收「金字塔」：低一层够多了才往上叠，
  // 不要某处叠很高、别处只有 2 层
  pyramidWeight: 0.5, // 金字塔：高架的水平格子按所在的层计代价，第 L 层每格 (2^(L−pyramidFrom) − 1) × 这个数（1 层 0、2 层 1、3 层 3、4 层 7、5 层 15……）
  pyramidFrom: 1, // 这一层及以下的格子不计金字塔代价
  turnWeight: 1, // 高架段每拐一次弯计这么多格
  liftWeight: 4, // 一条带子第二次及以后的升降（多一段高架）每次计这么多格
  rawChain: 3, // 同一种原料的一条带最多串几个相邻通道；串与不串按代价（含入口代价 entryWeight）试算后取便宜的
  crowdWeight: 6, // 选竖直列时，这一列每已有一条区间相交的高架段，按多绕这么多格计
  power: null, // 供电方式 'tesla' | 'substation'：搜索时把"附近没空地插塔、只能外沿加地"的面积计入成本
  // 卫星配电站够不着时在行里挖空位再排一遍（layout/powerholes.js），每段搜索慢约 1.3 倍。网页标准档、细档打开
  powerHoles: false,
  powerOptions: {},
  // 星际物流站靠左侧：{ stack: 1|2|4 } 站输出货物的集装数量。原料、成品都进出物流站，不再有边缘接口
  station: null,
  externalStack: 1, // 不在这里排站、但原料由物流站供应时（边缘放站），原料带按站输出集装数算运力
  // 喷增产剂：只喷这几种物品（最终产物的直接原料，calculator.js 的 calc.spray.items），这几种带上的喷涂机放在 sprayTo 那几组（最终产物）
  // 取料之前、别的消费者取完之后，入口或段尾多留 SPRAY_GAP 格直带给喷涂机骑（layout/belts.js），几何和代价都算进搜索；不喷时 null
  sprayItems: null,
  sprayTo: null,
  areaWeight: 1, // 面积在代价里的权重；空间利用率不达标时 planLine 会加倍再搜一次
  quick: false, // 快速评估：不分配高架高度（只估长度）、不估供电外沿和物流站空地，给搜索的全局阶段用（约快一倍）
  // 退火提前拒绝时把分拣器挪到高架之前排、补紧下限（见下面的 earlyArm）：'auto' 按线自适应，true 总挪、false 总不挪。只影响速度
  earlySorters: 'auto',
  // 分拣器落位按通道缓存（sorters.js 的 SC）。只影响速度
  sorterCache: true,
  penalty: { tracks: 3000, slots: 3000, shortfall: 2000, belt: 2000, clash: 3000, slow: 400, long: 25, level: 3000, route: 5000, fill: 2, power: 300, width: 400, height: 400, spray: 1500 },
};

/** 自动集装机（pilers）开着时单条带的运力（后处理按它放集装机，plan/addons.js 的 stackPilers），关着时 0。ro 是 route() 的选项 */
export function stackCapOf(ro = {}) {
  return (ro.pilers ?? DEFAULTS.pilers) ? BELT_SPEED[ro.belt ?? DEFAULTS.belt] * (ro.stack ?? DEFAULTS.stack) * 60 : 0;
}
/** 集装分拣器往带上叠几层（route 选项 sorterStack，见 DEFAULTS）：不小于 1 的整数，后处理放集装机用（plan/index.js 的 finishOne） */
export function sorterStackOf(ro = {}) {
  return Math.max(1, Math.floor(ro.sorterStack ?? DEFAULTS.sorterStack) || 1);
}

/**
 * @param {*} graph buildGraph 的结果
 * @param {string[][]} rows 自下而上，每行从左到右的块 ID（不拆分时块 ID 就是组 ID）
 * @param {*} options 见 DEFAULTS
 * @param {Record<string, number>} pads 每个块左边空出的列数（0~3），上下两行的分拣器排不开时让它们错开
 * @param {Record<string, {gid: string, n: number}>|null} blocks 块的定义；为空时每个组整组一个块
 */
export function route(graph, rows, options = {}, pads = {}, blocks = null, streets = []) {
  const opt = { ...DEFAULTS, ...options, penalty: { ...DEFAULTS.penalty, ...(options.penalty || {}) } };
  // 接物流站时进出站的带子都挤在主干走廊里竖直走，多给两层高架
  if (options.station && options.maxLevel == null) opt.maxLevel = 6;
  const first = layout(graph, rows, options, opt, pads, blocks, streets, null);
  // 卫星配电站有够不着的：按第一遍的位置在行里挖空位（layout/powerholes.js）再排一遍，两遍取代价低的。
  // 有辅路时不挖（辅路按列预留，挪动会压上去）。第二遍的下限不低于第一遍的代价时不可能被选上，提前交回第一遍
  if (opt.power !== 'substation' || !opt.powerHoles || first.rejected || !first.powerPlan?.lonely?.length || (Array.isArray(streets) && streets.length)) return first;
  const plan = powerHoles(first, opt);
  if (!plan.length) return first;
  const ask = opt.rejectFloor;
  const second = layout(graph, rows, options, { ...opt, rejectFloor: (floor) => floor >= first.cost || (ask ? ask(floor) : false) }, pads, blocks, streets, plan);
  return second.cost < first.cost ? second : first;
}

/** liftLegs 局部搜索之前的提前拒绝（score.js 的 preLegElevFloor）。写成模块级函数：每次评估新建闭包挂到 c 上会明显变慢 */
function elevAsk(c, nDead) {
  const f = preLegElevFloor(c, nDead);
  if (f === null || !c.opt.rejectFloor(f)) return false;
  c.elevRejected = f;
  return true;
}

/** 排一遍：holePlan 是要挖的配电站空位（第二遍才有） */
function layout(graph, rows, options, opt, pads, blocks, streets, holePlan) {
  // 物流站靠左侧：站在最左侧 7 列，紧挨着一列主干走廊，生产区全在右边
  const side = !!opt.station;
  const R = rows.length;
  const P = opt.penalty;
  const penalties = [];
  // bids：和这条惩罚有关的块，退火时优先挪动它们（有的放矢的邻域）
  const addPenalty = (kind, amount, msg, bids = null) => penalties.push({ kind, amount, msg, bids });

  // 上下文 c：后面各步写的字段先按写入的先后占好位置（undefined），免得陆续加进四十多个属性让 V8 转成字典模式
  const c = {
    graph, rows, pads, blocks, streets, options, opt, side, R, P, penalties, addPenalty, holePlan,
    // layout/positions.js
    addLoad: undefined, atPort: undefined, bestColumn: undefined, blocksOf: undefined, corridor: undefined, entryCol: undefined, exitCol: undefined, extraBottom: undefined, extraTop: undefined,
    itemBids: undefined, pos: undefined, powerHoles: undefined, rowAbove: undefined, rowBelow: undefined, stationX: undefined, streetX: undefined, xL: undefined, xR: undefined,
    // layout/belts.js（labGaps：研究站夹带，只有宇宙矩阵那种组才有）
    beltCap: undefined, chains: undefined, legs: undefined, pileCap: undefined, rawCap: undefined, segments: undefined, sides: undefined, labGaps: undefined,
    // layout/tracks.js、layout/ports.js（height 两步都写）
    channels: undefined, height: undefined, rowCy: undefined, ports: undefined, stations: undefined,
    // layout/elevation.js
    roads: undefined,
    // 下面的 earlySorters：高架之前排好的分拣器（scoreLayout 直接用）
    sorterPlan: undefined,
    // score.js 的 preLegWantFloor 记下的够不着、太慢的条数，liftLegs 局部搜索之前那一问（elevAsk）
    wantCounts: undefined, elevAsk: undefined, elevRejected: undefined,
  };
  placeBlocks(c);
  routeItems(c);
  placeTracks(c);
  placePorts(c);
  // 退火提前拒绝：高架（约占 route 一半时间）之前按最终代价的下限问一次退火要不要拒（score.js 的 preLegFloor，算不了时 null）
  const floorPre = preLegFloor(c);
  if (floorPre !== null && opt.rejectFloor(floorPre)) return { rejected: true, cost: floorPre };
  // 再补上分拣器位、够不着、太慢问一次（score.js 的 preLegWantFloor）。放在下面自适应开关的计时之前
  if (floorPre !== null) {
    const floorWant = preLegWantFloor(c);
    if (floorWant !== null && opt.rejectFloor(floorWant)) return { rejected: true, cost: floorWant };
  }
  // earlySorters：分拣器挪到高架之前排，加上它的惩罚和长度代价再问一次（score.js 的 preLegSorterFloor），没拒就留给 scoreLayout 用。
  // 挪不挪按线自适应（earlyArm）
  let st = null; // 自适应时这条线的统计，不自适应时 null、不计时
  let early = false;
  let t0 = 0;
  if (floorPre !== null && !opt.quick && opt.earlySorters !== false) {
    if (opt.earlySorters === true) early = true;
    else {
      st = earlyStatsOf(graph);
      early = earlyArm(st);
      t0 = performance.now();
    }
  }
  if (early) {
    const plan = sorterPlanOf(c);
    c.sorterPlan = plan;
    const floor = preLegSorterFloor(c, plan);
    if (floor !== null && opt.rejectFloor(floor)) {
      if (st !== null) noteArm(st, true, performance.now() - t0);
      return { rejected: true, cost: floor };
    }
  }
  if (opt.noLift) {
    // 坡的半层不能压分拣器的手臂，要先知道分拣器落在哪（和 scoreLayout 用同一份）
    if (c.sorterPlan === undefined) c.sorterPlan = sorterPlanOf(c);
    rampLegs(c);
  } else if (opt.quick) estimateLegs(c);
  else {
    // 高架分层的局部搜索之前，按已经判死的段再问一次（elevAsk；只在上面 preLegWantFloor 问过时问）
    if (c.wantCounts !== undefined) c.elevAsk = elevAsk;
    liftLegs(c);
    if (c.elevRejected !== undefined) {
      if (st !== null) noteArm(st, early, performance.now() - t0);
      return { rejected: true, cost: c.elevRejected };
    }
  }
  const res = scoreLayout(c);
  if (st !== null) noteArm(st, early, performance.now() - t0);
  if (opt.noLift && !res.rejected) res.noLift = true; // 后处理（plan/index.js）、校验（plan/validate.js）认这个
  return res;
}

// earlySorters 'auto' 的自适应开关：两臂赌博机，每条线（graph）记两种做法（提前排分拣器 / 不提前）从做决定到 layout() 返回的平均毫秒数。
// 前 EARLY_WARMUP 次两臂交替，之后走平均用时小的那臂，每 EARLY_EXPLORE 次强制走一次另一臂（退火降温时拒绝率会变，两臂的估计都要新鲜）。
// 开不开都不改结果：提前问的下限不超过最终代价，也不超过供电之前那一问的下限（score.js 的 preLegSorterFloor），rejectFloor 对下限单调，
// 所以只是拒得早；没有供电那一问时，拒掉的本来也会被 runRound 的接受判断拒掉，随机数序列一样。
// 定点精修（place.js 的 polish）被拒的候选不进存档，多拦会改存档，所以那里传 earlySorters: false
const EARLY_WARMUP = 64; // 每条线前这么多次两臂交替（各 32 次）
const EARLY_EXPLORE = 16; // 之后每这么多次强制走一次平均用时大的那臂
const EARLY_SPAN = 32; // 滑动平均：每臂前 EARLY_SPAN 个样本按算术平均起步，之后每个新样本占 1/EARLY_SPAN
const earlyStats = new WeakMap(); // graph → 统计；线程各自一份
function earlyStatsOf(graph) {
  let s = earlyStats.get(graph);
  if (s === undefined) earlyStats.set(graph, (s = { n: 0, nOn: 0, tOn: 0, nOff: 0, tOff: 0 }));
  return s;
}
/** 第 k 个样本（从 1 数）进滑动平均 */
const ema = (m, x, k) => m + (x - m) / Math.min(k, EARLY_SPAN);
/** 这一次走哪臂：true 提前排 */
function earlyArm(s) {
  const n = ++s.n;
  if (n <= EARLY_WARMUP) return (n & 1) === 1;
  const best = s.tOn < s.tOff;
  return n % EARLY_EXPLORE === 0 ? !best : best;
}
/** 这一次评估走了哪臂、用了 ms 毫秒 */
function noteArm(s, on, ms) {
  if (on) s.tOn = ema(s.tOn, ms, ++s.nOn);
  else s.tOff = ema(s.tOff, ms, ++s.nOff);
}
/** 只给工具和测试看：这条线自适应的统计（没有时 null）。n 做过几次决定；nOn、tOn 开的那臂走了几次、平均毫秒；nOff、tOff 关的那臂 */
export function earlySortersStats(graph) {
  return earlyStats.get(graph) ?? null;
}
