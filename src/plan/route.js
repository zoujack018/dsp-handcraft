// 夹心式布局的布线与打分（v0.6：配方组可拆分、物品带串联多个通道、运输段走高架）。
//
// 模型（自下而上）：通道0 | 第0行工厂 | 通道1 | 第1行工厂 | ... | 第R-1行 | 通道R
// - 配方组可以拆成几个「块」（同配方连续的几台工厂），分别放在不同的行。
// - 第 r 行的块只能从通道 r（下方）和通道 r+1（上方）取料、出料；分拣器最长 3 格，所以一个通道最多 3 条地面轨道。
// - 每种物品一条单品带，按顺序经过若干个通道（「访问」）。在每个通道里，带子只在有分拣器接的那一段落地
//   （「取放段」，占地面轨道）；段与段之间、原料入口到第一段、最后一段到成品出口都走高架（z ≥ 1）：
//   在段尾原地抬升，沿通道上空水平走，到一列没有工厂的空列（左右边缘或行间空隙）竖直走到目标通道，
//   再水平走到下一段段首原地落下。高架带可以从地面带子和分拣器上方经过（玩家确认），不能从工厂上方经过
//   （试验开关 bridges 打开时，第 4 层以上可以从熔炉、制造台头顶过，见 DEFAULTS）。
// - 抬升和落下用 antian 已在游戏里验证的写法：同一格里 z 差 1 的两节带子直接相连
//   （需要解锁「超级磁场发生器」，它解除传送带的坡度限制）。
// - 原料从左右边缘的地面入口进来，成品从边缘的地面出口离开。
//
// route() 是确定性的：给定行、块、空列和辅路，算出完整几何和成本。它按顺序调用 layout/ 下的几步，
// 每一步读写同一个上下文 c（见各文件开头的说明）：
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
  // 自动集装机（用户 2026/10/26）：产物（不是原料）一种超过单条带的运力时，不拆成几条带，一条带最多运 pileModel 定的运力；
  // 带上每放约 1700/分的单个物品，后处理就在下游放一台自动集装机（plan/addons.js 的 stackPilers）。关掉时照旧按单条带拆带
  pilers: true,
  // 开集装机时产物带一条按多少运力排（layout/belts.js 的 pileCap，plan/piling.js 的 pileCapOf）：null 照旧按一台叠满 4 层算的单条带 4 倍（7200）；
  // 一台只把相邻两个合成一个（用户 2026/10/30），7200 要很多台才接近。写正整数 k 按一条带最多放 k 台集装机够得着的算
  // （料全先放后取，每台放在格位到 1700 处、之后补单个；极速带 k = 1~7：2626、3451、4119、4641、5071、5419、5700）。试验开关，量完考卷再定默认
  pileModel: null,
  maxTracks: 3, // 分拣器最长 3 格 => 每个通道最多 3 条地面轨道
  // 第 4 条轨：一个通道 4 条地面轨道，条件是每根分拣器都够得着（下方那行只接第 0~2 条、上方那行只接第 1~3 条，layout/tracks.js 挑排法）。
  // 默认关；喷增产剂时 plan/index.js 打开（2026/10/08，待办 3 第二步，先只在喷涂线上量）
  fourthTrack: false,
  // 宽通道（分支 explore/typeset，排版内核默认开）：一个通道要的轨道超过 3 条时，按每段由哪一侧的分拣器来接重新分轨
  // （只被下方那行接的段放低处、只被上方那行接的放高处、两边都接的放中间），每根分拣器都不超过 3 格就算数，最多 6 条
  // （下方一行够第 0~2 条、上方一行够第 n−3~n−1 条，6 条时上下两半互不相干）。通道变宽、不用升高架，代价按面积算。默认关，master 一字不变
  wideTracks: false,
  // 按侧拆段（分支 explore/typeset，和宽通道一起开）：一种物品在一个通道里上下两行都接、但两行接的横向范围差很多时
  // （比上下挨着的那截长出 SIDE_SPLIT 格以上，比如一组断到上一行行尾只剩一小截），原来铺一整段、上下都得够得着，
  // 把整条通道都占成两边共用的轨；拆成只下方接、只上方接两段，中间走一截高架，宽通道里各占下半、上半。默认关
  sideSplit: false,
  // 精确分带（分支 explore/typeset，排版内核默认开）：要几条带的产物按块分带凑不齐（某条带消费比生产多）时，换生产者的切法、
  // 消费者的分法再找一遍缺口最小的（layout/belts.js 的 exactBins）。默认关
  exactSplit: false,
  leftMargin: 1, // 第 0 列是左边缘：入口、出口和竖直高架带走这里
  sorter: 2013, // 分拣器类型：2011 分拣器 2012 高速 2013 极速 2014 集装
  maxAspect: null, // 长宽比上限，null 表示不限制
  maxWidth: null, // 宽度上限（格），比如 25/50/100，贴合星球纬度方向铺蓝图；超出按不可行处理
  maxHeight: null, // 长度上限（格，y 方向），比如 25/50/100；超出按不可行处理
  headroom: 1.15, // 分拣器速度至少比平均需求高这么多，不够就并排加一根
  sorterLenWeight: 2, // 分拣器每多伸 1 格计入成本的权重（拉长会变慢，尽量用短的）
  maxBelt: null, // 一种物品从带头到带尾的最长格数（含高架），超出部分加罚；默认不限制（影响很小，先不考虑），命令行和测试里仍可设
  minFill: 0.7, // 土地利用率（工厂行被工厂占满的比例）合格线，低于它按差额加罚
  maxLevel: 4, // 高架最多抬几层
  // 桥（试验开关，默认关）：用户 2026/10/19 实测熔炉、制造台（和储物箱）都是 3 层高，第 4~7 层的传送带能从它们头顶经过；
  // 物流站、卫星配电站更高，对撞机也更高；化工厂、量子化工厂、研究站、火力发电厂没确认，一律按不能过。
  // 打开时高架段的竖直那截可以穿过熔炉、制造台的块（layout/positions.js 的 bestColumn，选列代价加 bridgeWeight），
  // 这样的段（leg.bridge）整段至少在第 bridgeLevel 层、超过 bridgeMaxLevel 层才按 level 罚（layout/elevation.js、levels.js）。
  // 关着时结果一字不变
  bridges: false,
  bridgeWeight: 15, // 选列时穿过可跨块的列多计这么多格：约等于两头各多叠 3 节升降 + 多 3 层的 levelWeight
  bridgeLevel: 4, // 桥段最低第几层（工厂 3 层高，第 4 层起能过）
  bridgeMaxLevel: 5, // 桥段不罚的最高层（普通段照旧按 maxLevel）
  // 结构代价（不影响可行性，只让退火避开难看、费地的结构）：
  singleWeight: 2, // 一排只有一台工厂：每排计 这个数 × 宽度
  splitWeight: 8, // 一个配方组拆成的块数超过限宽所需：每多一块计这么多格
  farWeight: 4, // 同组的块之间隔了不相邻的行：每多隔一行计这么多格
  entryWeight: 40, // 同一种原料的入口数超过运力所需：每多一个入口计这么多格（也用来决定原料带串不串通道）
  sameSide: true, // 同一种原料的几个入口都在同一边（用户 2026/10/24），layout/belts.js 左右各试算一遍取便宜的
  // 同一种原料的几个入口挨在一起（用户 2026/10/24，要硬性的）：侧边总线，口都在右边布局外最外那一列、相邻几行，
  // 每条带在外面各占一列竖着走到自己那段的行（layout/ports.js、layout/elevation.js）。只挪口、不挪竖走的列时
  // 都沿边缘那一列走，同一列叠的段太多，高架层不够用（铁块 18000 那种十几条带的排不出）
  groupPorts: true,
  // 侧边总线排哪边：'right' 一律右边（现状）；'auto' 每种原料左右各试算一遍取便宜的那边，总线可以左右都有（用户 2026/10/26 边缘优化的候选，试验开关）。
  // 左边的总线口、竖走的列在 x < 0，宽和面积照右边一样算上（layout/score.js），收尾时整张挪回从 0 起（plan/index.js 的 finishOne）
  busSide: 'right',
  // 出入口都在左边（箱子供货的左侧仓列模式，用户 2026/10/26）：原料从左边进、成品从左边出，和靠左侧站列一样的方向约束，边缘口照旧
  leftPorts: false,
  busGround: false, // 侧边总线的竖直段也落地（试验开关，默认关；用户 2026/10/26 边缘优化的候选之一）：开着时 ground.js 不再跳过总线的段，能落地的照常落地
  // 不用原地升降（用户 2026/10/28：最低配置默认没解锁「超级磁场发生器」，原地竖直升降贴不上）：高架的升降都换成每格升降半层的坡，
  // 中间在 0.5 层以上或落在空着的地面上（layout/elevation.js 的 rampLegs，docs/game-rules.md 第 38 条）；后处理的高架落地（plan/ground.js）不做，
  // 接物流站、仓组、发电厂的线只走地面，还剩原地升降的（喷涂）按不可行。默认关，关着时结果一字不变
  noLift: false,
  longFrom: 24, // 高架段超过这么长（格）的部分
  longWeight: 1, // 每格再多计这么多（为一种子材料拉跨半张图的长带）
  levelWeight: 3, // 高架每多抬一层（第 2 层起）计入成本的格数：叠得高不好看，也难手搭
  // 口味（用户 2026/10/06：不想要太高的带子，宁可通道宽一点；不喜欢反复升降、频繁拐弯；罚得轻，省地仍是主要的）。
  // 2026/10/07 用户要求默认打开（面积、可行数持平：6 条线 × 3 种模式 × 5 个种子，拐弯 −6%、反复升降 −31%）：
  // 层数（用户 2026/10/07：不是禁止 3 层以上，是 2 层够多了才有 3 层、3 层够多了才有 4 层，不要某处叠很高、别处只有 2 层）：
  // 按格子算的「金字塔」代替原来按段算的「第 4 层起每段 60」。考卷（6 条线 × 3 种模式，大线 5 个、小线 15 个种子）：
  // 面积中位数合计 −1.5%、可行 177 → 179 / 180；高架格子 1:6797 2:3026 3:2007 4:1304 5:104 6:67 → 1:7239 2:2499 3:1236 4:460 5:74；
  // 系数 1.0 分布更陡但面积 +4%；从 3 层起才收（2 层免费）面积 +0.3%、第 5 层反而多
  highFrom: 3, // 高架超过这一层的段再加罚（highWeight 默认 0，不用了）
  highWeight: 0, // 第 highFrom+1 层每段计 1 份、再高一层 3 份、再高 6 份（1、3、6……）× 这个数
  pyramidWeight: 0.5, // 金字塔：高架的水平格子按所在的层计代价，第 L 层每格 (2^(L−pyramidFrom) − 1) × 这个数（1 层 0、2 层 1、3 层 3、4 层 7、5 层 15……）；heightTax 开着时不算
  pyramidFrom: 1, // 这一层及以下的格子不计金字塔代价
  // 线性超高税（试验开关，默认关，细档开；分支 explore/bridges）：代替上面的金字塔。用户 2026/10/19：低层确实好看，但不必硬逼第 4 层比第 3 层少，
  // 第 5 层要少用。高架水平走进的每一格计 heightPerLevel × (层 − 这一格最低能走的层) + heightTopWeight × max(0, 层 − heightTopFrom + 1)
  // （最低能走的层：桥段在熔炉、制造台本体头顶是 OVERPASS_Z，别处 1；第 5 层每格另加 1、第 6 层另加 2）。按真实层算，不用桥的有效层；
  // 叠层、太高、桥的代价照旧（layout/score.js）。高架落地的变层税（plan/ground.js）开着时水平每格也加同一个第 5 层起的附加项
  heightTax: false,
  heightPerLevel: 0.4,
  heightTopFrom: 5,
  heightTopWeight: 1,
  turnWeight: 1, // 高架段每拐一次弯计这么多格
  liftWeight: 4, // 一条带子第二次及以后的升降（多一段高架）每次计这么多格
  rawChain: 3, // 同一种原料的一条带最多串几个相邻通道；串与不串按代价（含入口代价 entryWeight）试算后取便宜的
  crowdWeight: 6, // 选竖直列时，这一列每已有一条区间相交的高架段，按多绕这么多格计
  // 开路费（试验开关，默认 0 = 关，细档开；分支 explore/bridges）：用户 2026/10/19 想要「束」，很多条带同一高度、x 挨着一起沿 y 走，
  // 少开辟新的路。选竖直列时，左右 bundleReach 列以内（不含这一列）没有区间相交的高架段，就多计这么多格（layout/positions.js 的 bestColumn）
  bundleFee: 0,
  bundleReach: 2,
  // 走空地费（试验开关，默认 0 = 关，细档开；分支 explore/bridges）：用户 2026/10/19 想要带子沿着建筑边走，不沿地图边走、不圈出空地。
  // 选竖直列时，穿过的行里这一列既不压着也不紧挨着块、站列、配电站空位的，每行多计这么多格（layout/positions.js 的 bestColumn）
  openFee: 0,
  power: null, // 供电方式 'tesla' | 'substation'：搜索时把"附近没空地插塔、只能外沿加地"的面积计入成本
  // 卫星配电站够不着时在行里挖空位再排一遍（layout/powerholes.js）：每段搜索慢约 1.3 倍，网页标准档、细档打开，快档不开（用户 2026/10/08 定）
  powerHoles: false,
  powerOptions: {},
  // 星际物流站靠左侧：{ stack: 1|2|4 } 站输出货物的集装数量。原料、成品都进出物流站，不再有边缘接口
  station: null,
  externalStack: 1, // 不在这里排站、但原料由物流站供应时（边缘放站），原料带按站输出集装数算运力
  // 喷增产剂（所有原料和中间产物）：一个访问里生产者、消费者不交错（交错就喷不到），每条要进工厂的带
  // 在入口（原料）或最后一个生产访问的段尾多留 SPRAY_GAP 格直带给喷涂机骑（layout/belts.js），几何和代价都算进搜索
  sprayAll: false,
  // 只喷这几种物品（最终产物的直接原料，calculator.js 的 calc.spray.items），这几种带上的喷涂机放在 sprayTo 那几组（最终产物）取料之前、
  // 别的消费者取完之后；都为 null 时每条进工厂的带都喷（sprayScope 'all'）
  sprayItems: null,
  sprayTo: null,
  areaWeight: 1, // 面积在代价里的权重；空间利用率不达标时 planLine 会加倍再搜一次
  quick: false, // 快速评估：不分配高架高度（只估长度）、不估供电外沿和物流站空地，给搜索的全局阶段用（约快一倍）
  // 退火提前拒绝时把分拣器挪到高架之前排、补紧下限（layout() 里的 earlySorters）：'auto' 按线自适应，true 总挪、false 总不挪。
  // 只改算的先后、不改结果，三种取值结果逐字一样；true / false 只给测试和量速度用
  earlySorters: 'auto',
  // 分拣器落位按通道记住算过的结果，同一个通道输入一模一样时直接复用（sorters.js 的 SC）。只省时间、不改结果，开关结果逐字一样；false 只给测试和量速度用
  sorterCache: true,
  penalty: { tracks: 3000, slots: 3000, shortfall: 2000, belt: 2000, clash: 3000, slow: 400, long: 25, level: 3000, route: 5000, fill: 2, power: 300, width: 400, height: 400, spray: 1500 },
};

/** 自动集装机（pilers）开着时单条带的运力（后处理按它放集装机，plan/addons.js 的 stackPilers），关着时 0。ro 是 route() 的选项 */
export function stackCapOf(ro = {}) {
  return (ro.pilers ?? DEFAULTS.pilers) ? BELT_SPEED[ro.belt ?? DEFAULTS.belt] * (ro.stack ?? DEFAULTS.stack) * 60 : 0;
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
  // 卫星配电站：第一遍估供电有够不着的（以前退火只好另起一行放配电站），按第一遍的位置在行里挖空位（layout/powerholes.js）再排一遍，
  // 两遍取代价低的；第一遍够得着的一字不变。有辅路时不挖（辅路按列预留，挪动会压上去）。
  // 第二遍的提前拒绝（2026/10/08，结果逐字不变）：打分算到的下限已经不低于第一遍的代价，第二遍不可能被选上，不再往下算、交回第一遍；
  // 下限还低于第一遍时才问退火那句（place.js 的 rejectFloor）——那时退火要拒的话两遍都注定被拒，记进 stateMemo 的下限照样成立
  if (opt.power !== 'substation' || !opt.powerHoles || first.rejected || !first.powerPlan?.lonely?.length || (Array.isArray(streets) && streets.length)) return first;
  const plan = powerHoles(first, opt);
  if (!plan.length) return first;
  const ask = opt.rejectFloor;
  const second = layout(graph, rows, options, { ...opt, rejectFloor: (floor) => floor >= first.cost || (ask ? ask(floor) : false) }, pads, blocks, streets, plan);
  return second.cost < first.cost ? second : first;
}

/**
 * 第六处的回调（liftLegs → solveLevels 局部搜索之前调，c 是这一次的布局上下文）：用模块级的这一个函数，不在每次评估里新建闭包挂到 c 上
 * （2026/10/27 量过：每次新建一个闭包、挂在 c 上再传进去调，回调什么都不做也让氘核燃料棒那条每步慢两成）
 */
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

  // 上下文 c：后面各步往里写的字段在这里先按写入的先后占好位置（值是 undefined，和还没写时读出来一样；键的先后也和以前一样）。
  // 不先占位的话，一个对象上陆续加进四十多个属性，V8 会把它转成字典模式（每次 route() 都要转一次），之后每一步读 c 都是查哈希表
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
    // 第五、六处（score.js 的 preLegWantFloor 记下够不着、太慢的条数，liftLegs 局部搜索之前那一问）
    wantCounts: undefined, elevAsk: undefined, elevRejected: undefined,
  };
  placeBlocks(c);
  routeItems(c);
  placeTracks(c);
  placePorts(c);
  // 退火提前拒绝，第三处：elevation（liftLegs，占 route 总时间约一半）之前先按最终代价的下限问一次退火要不要拒。
  // 下限怎么算、为什么不超过最终代价、为什么不改结果，见 score.js 的 preLegFloor。守卫不满足时返回 null，照常往下算。
  const floorPre = preLegFloor(c);
  if (floorPre !== null && opt.rejectFloor(floorPre)) return { rejected: true, cost: floorPre };
  // 第五处（2026/10/27）：再补上分拣器位、够不着、太慢（分拣器收集工厂那一段就定了，不排落位）问一次。开着供电或站空地时才问，
  // 下限怎么算、为什么不改结果见 score.js 的 preLegWantFloor。在下面自适应开关的计时之前：两臂都不含它
  if (floorPre !== null) {
    const floorWant = preLegWantFloor(c);
    if (floorWant !== null && opt.rejectFloor(floorWant)) return { rejected: true, cost: floorWant };
  }
  // 第四处（earlySorters）：分拣器挪到高架之前排，加上它的惩罚和长度代价再问一次（下限为什么不超过最终代价、为什么能挪，见 score.js 的
  // preLegSorterFloor）。没拒就把这份留给 scoreLayout 用。挪不挪按线自适应（earlyArm），只改算的先后、不改拒不拒、不改结果
  let st = null; // 自适应时这条线的统计（quick、没有 rejectFloor、强制开关时不记、不计时）
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
    // 坡的 0.5 层不压分拣器的手臂：要先知道分拣器落在哪（和 scoreLayout 用同一份，见上面的 earlySorters）
    if (c.sorterPlan === undefined) c.sorterPlan = sorterPlanOf(c);
    rampLegs(c);
  } else if (opt.quick) estimateLegs(c);
  else {
    // 第六处（2026/10/27）：高架分层的局部搜索之前，按已经判死的段补紧再问一次（score.js 的 preLegElevFloor，只在第五处问过时问）
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

// earlySorters 的自适应开关（opt.earlySorters 'auto'）：两臂赌博机，直接比两种做法的实测用时。
// 每条线（graph）记两个滑动平均：每次评估从做决定那一刻到 layout() 返回的毫秒数——
//   开（提前排）：提前排分拣器、问下限，没拦下时接着高架和 scoreLayout（用现成的分拣器）；被拦下提前返回也算一次；
//   关：高架和 scoreLayout。
// 前 EARLY_WARMUP 次两臂交替（开的先），之后走平均用时小的那臂，每 EARLY_EXPLORE 次强制走一次另一臂（退火降温时拒绝率会变，
// 两臂的估计都要新鲜）。2026/10/24 上一版按 c × 高架时间 > (c + r) × 分拣器时间估，假定拦下的那些原本都不排分拣器，多算了成本、偏保守
// （macmini：master 引力矩阵 90 塔 auto 比总开慢 5%~10%），换成直接量。少走的那臂约每 EARLY_EXPLORE 次才有一个样本，
// 平均值跟得慢一些（约 EARLY_EXPLORE × EARLY_SPAN 次评估），强制走的那几次会慢慢纠正过来。只有 'auto' 计时（每次两回 performance.now()，约 50 ns）。
// 为什么怎么定都逐字一致：开不开只决定高架之前多不多问一次 rejectFloor。问的下限不超过这一遍的最终代价，也不超过 scoreLayout 里
// 供电之前那一问的下限（score.js 的 preLegSorterFloor），rejectFloor 对下限单调（下限越大越容易拒）：
//   - 开着供电或站空地（有供电之前那一问）时，这一问能拒的，算下去到那一问也一定被拒：route() 拒不拒和不提前排一模一样，只是拒得早；
//   - 没有那一问时，这一问拒了的，原来算完也注定被 runRound 的接受判断拒掉（最终代价不低于这个下限），两边都只抽掉一个随机数，
//     随机数序列、状态、存档、best 都一样；
//   - stateMemo 记下的下限回放时逐项问，单调性保证结论一样（记下这个下限、没记完整代价的，再被提出时照常重算，结果一样）；
//   - 没拒时 scoreLayout 用的分拣器和自己排的逐字一样。
// 计时（performance.now()，浏览器、worker 里都有；浏览器里精度粗，多次平均下来差不多）只影响快慢。
// 定点精修（place.js 的 polish）不一样：那里被拒的候选不进存档，没有供电那一问时多拦会改存档，所以那里传 earlySorters: false
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
