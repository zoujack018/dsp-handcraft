// 夹心式布局的布线与打分（v0.6：配方组可拆分、物品带串联多个通道、运输段走高架）。
//
// 模型（自下而上）：通道0 | 第0行工厂 | 通道1 | 第1行工厂 | ... | 第R-1行 | 通道R
// - 配方组可以拆成几个「块」（同配方连续的几台工厂），分别放在不同的行。
// - 第 r 行的块只能从通道 r（下方）和通道 r+1（上方）取料、出料；分拣器最长 3 格，所以一个通道最多 3 条地面轨道。
// - 每种物品一条单品带，按顺序经过若干个通道（「访问」）。在每个通道里，带子只在有分拣器接的那一段落地
//   （「取放段」，占地面轨道）；段与段之间、原料入口到第一段、最后一段到成品出口都走高架（z ≥ 1）：
//   在段尾原地抬升，沿通道上空水平走，到一列没有工厂的空列（左右边缘或行间空隙）竖直走到目标通道，
//   再水平走到下一段段首原地落下。高架带可以从地面带子和分拣器上方经过（玩家确认），不能从工厂上方经过。
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
import { liftLegs, estimateLegs } from './layout/elevation.js';
import { scoreLayout } from './layout/score.js';

export { STATION_SIZE, TRUNK, STATION_COLS, STATION_SLOTS } from './layout/shared.js';

export const DEFAULTS = {
  belt: 3, // 传送带等级 1/2/3
  stack: 1, // 带上堆叠层数（保守按 1 计算运力）
  maxTracks: 3, // 分拣器最长 3 格 => 每个通道最多 3 条地面轨道
  // 第 4 条轨：一个通道 4 条地面轨道，条件是每根分拣器都够得着（下方那行只接第 0~2 条、上方那行只接第 1~3 条，layout/tracks.js 挑排法）。
  // 默认关；喷增产剂时 plan/index.js 打开（2026/10/08，待办 3 第二步，先只在喷涂线上量）
  fourthTrack: false,
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
  // 结构代价（不影响可行性，只让退火避开难看、费地的结构）：
  singleWeight: 2, // 一排只有一台工厂：每排计 这个数 × 宽度
  splitWeight: 8, // 一个配方组拆成的块数超过限宽所需：每多一块计这么多格
  farWeight: 4, // 同组的块之间隔了不相邻的行：每多隔一行计这么多格
  entryWeight: 40, // 同一种原料的入口数超过运力所需：每多一个入口计这么多格（也用来决定原料带串不串通道）
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
  pyramidWeight: 0.5, // 金字塔：高架的水平格子按所在的层计代价，第 L 层每格 (2^(L−pyramidFrom) − 1) × 这个数（1 层 0、2 层 1、3 层 3、4 层 7、5 层 15……）
  pyramidFrom: 1, // 这一层及以下的格子不计金字塔代价
  turnWeight: 1, // 高架段每拐一次弯计这么多格
  liftWeight: 4, // 一条带子第二次及以后的升降（多一段高架）每次计这么多格
  rawChain: 3, // 同一种原料的一条带最多串几个相邻通道；串与不串按代价（含入口代价 entryWeight）试算后取便宜的
  crowdWeight: 6, // 选竖直列时，这一列每已有一条区间相交的高架段，按多绕这么多格计
  power: null, // 供电方式 'tesla' | 'substation'：搜索时把"附近没空地插塔、只能外沿加地"的面积计入成本
  powerOptions: {},
  // 星际物流站靠左侧：{ stack: 1|2|4 } 站输出货物的集装数量。原料、成品都进出物流站，不再有边缘接口
  station: null,
  externalStack: 1, // 不在这里排站、但原料由物流站供应时（边缘放站），原料带按站输出集装数算运力
  // 喷增产剂（所有原料和中间产物）：一个访问里生产者、消费者不交错（交错就喷不到），每条要进工厂的带
  // 在入口（原料）或最后一个生产访问的段尾多留 SPRAY_GAP 格直带给喷涂机骑（layout/belts.js），几何和代价都算进搜索
  sprayAll: false,
  areaWeight: 1, // 面积在代价里的权重；空间利用率不达标时 planLine 会加倍再搜一次
  quick: false, // 快速评估：不分配高架高度（只估长度）、不估供电外沿和物流站空地，给搜索的全局阶段用（约快一倍）
  penalty: { tracks: 3000, slots: 3000, shortfall: 2000, belt: 2000, clash: 3000, slow: 400, long: 25, level: 3000, route: 5000, fill: 2, power: 300, width: 400, height: 400, spray: 1500 },
};

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
    graph, rows, pads, blocks, streets, options, opt, side, R, P, penalties, addPenalty,
    // layout/positions.js
    addLoad: undefined, atPort: undefined, bestColumn: undefined, blocksOf: undefined, corridor: undefined, entryCol: undefined, exitCol: undefined, extraBottom: undefined, extraTop: undefined,
    itemBids: undefined, pos: undefined, rowAbove: undefined, rowBelow: undefined, stationX: undefined, streetX: undefined, xL: undefined, xR: undefined,
    // layout/belts.js
    beltCap: undefined, chains: undefined, legs: undefined, rawCap: undefined, segments: undefined, sides: undefined,
    // layout/tracks.js、layout/ports.js（height 两步都写）
    channels: undefined, height: undefined, rowCy: undefined, ports: undefined, stations: undefined,
    // layout/elevation.js
    roads: undefined,
  };
  placeBlocks(c);
  routeItems(c);
  placeTracks(c);
  placePorts(c);
  if (opt.quick) estimateLegs(c);
  else liftLegs(c);
  return scoreLayout(c);
}
