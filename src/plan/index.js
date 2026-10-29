// 规划入口：计算结果 -> 生产图 -> 摆放搜索 -> 候选布局逐个做后处理（接物流站、高架落地、供电）-> 按最终指标挑一个
//
// 搜索（place.js + route.js）只管紧凑的生产区；后处理是一层层独立的步骤，作用在搜索留下的几个候选上，
// 最后按「面积 + 传送带」和空间利用率挑：利用率达标（默认 80%）的候选里挑代价最小的。
//
// 流程写成一个生成器 planSteps：要搜索、要做后处理时 yield 一个请求，由驱动去执行。
//   planLine       单线程驱动：请求就地执行（测试、命令行默认）。
//   planLineAsync  多线程驱动：搜索的各轮退火、各个候选的后处理分给线程池并行（网页、命令行 --threads）。
// 没有时间上限时，两种驱动的结果完全一致。
import { buildGraph } from './graph.js';
import { optimize, mergeRounds, precompute } from './place.js';
import { addPower, placePower, fitPlacement } from './power.js';
import { spaceStats } from '../metrics/space.js';
import { attachStations, linkWarpers, cropToContent } from './stations.js';
import { groundRoutes, groundOptions } from './ground.js';
import { rerouteBelts, rerouteOptions, beltStats, rerouteWorse } from './reroute.js';
import { addAddons, needsStacking } from './addons.js';
import { stackCapOf } from './route.js';
import { addStores, addProStores, isColumnSupply } from './storage.js';
import { addBurners, burnable } from './burn.js';
import { translateLayout } from './coordinates.js';
import { busMinX } from './layout/shared.js';
import { powerCells, realItem } from '../gamedata.js';
import { chainTiles } from '../emit/blueprint.js';

export const TARGET_SPACE = 0.8;
/** 为了利用率达标，传送带最多比代价最小的候选多这么多 */
export const BELT_SLACK = 0.1;
/** 内核 'auto'：排版内核搜完这么多段、最好那张还不可行，就换主干内核从头排（planCore） */
export const AUTO_SEGMENTS = 2;

/**
 * 物流站选项统一成 { place, stack }：
 *   place 'edge'（默认）：搜索时就估算站放进哪块空地，排完紧凑布局再把站放进去，用 A* 直接接到各段端头（stations.js）
 *   place 'side'：站排在最左侧的站列，生产区让出站列和主干走廊（layout/ports.js）
 * 兼容旧写法 routeOptions.station = { stack }。
 */
export function stationOption(options = {}) {
  const s = options.station ?? options.routeOptions?.station ?? null;
  if (!s) return null;
  return { place: s.place === 'side' ? 'side' : 'edge', stack: Math.max(1, Number(s.stack) || 1), slots: s.slots ?? null };
}

/**
 * 一个搜索候选走完全部后处理；接不上物流站时返回 null。只用到布局本身，可以放到后台线程里做。
 * ctx：{ station, power, powerOptions, maxWidth, maxHeight, noGrounding, ground 高架落地的选项（ground.js 的 groundOptions，变层税没开时 null）, aw, spray, sprayItems, sprayTo, pile, sprayRate, burn,
 *        stackCap 运的超过一条带的产物带上放集装机（route.js 的 stackCapOf，0 是关着；plan/addons.js 的 stackPilers）,
 *        supply 箱子供货（plan/storage.js 的 SUPPLY，不接物流站时）, sorter 分拣器（箱子组按它的速度算几根）, storeLayers 储物仓最多叠几层 }
 */
/**
 * 段两头超出首尾分拣器、又没有任何东西接着的格子裁掉：段的范围按候选口位（tmin/tmax）留，分拣器实际落位可能在里面一格，
 * 那一格就成了多伸出去的死胡同。有腿（高架、口、仓的接线）接在这头、这一格是出入口、段留了喷涂空当或劈开过的都不动。
 * 裁到图框边上的那一格时整张重新裁边（stations.js 的 cropToContent，带数、长宽一起重算）
 */
function trimSegmentEnds(L) {
  if (!L.sorterList?.length) return 0;
  const cols = new Map();
  for (const s of L.sorterList) {
    const c = cols.get(s.segId);
    if (!c) cols.set(s.segId, { lo: s.col, hi: s.col });
    else { c.lo = Math.min(c.lo, s.col); c.hi = Math.max(c.hi, s.col); }
  }
  const endUsed = new Set(); // 腿接着的段端、出入口所在格
  for (const l of L.legs) {
    if (l.to != null && l.to >= 0 && L.segments[l.to]) endUsed.add(`${l.to}:${L.segments[l.to].entryX}`);
    if (l.from != null && l.from >= 0 && L.segments[l.from]) endUsed.add(`${l.from}:${L.segments[l.from].exitX}`);
  }
  const portAt = new Set((L.ports || []).map((p) => `${p.x},${p.y}`));
  let cut = 0;
  let edge = false;
  for (const s of L.segments) {
    const c = cols.get(s.id);
    if (!c || s.sprayGap || s.split != null) continue;
    for (;;) {
      // 左端 a 多出来、没人用：往里收一格；右端同理
      let moved = false;
      if (s.a < c.lo && !endUsed.has(`${s.id}:${s.a}`) && !portAt.has(`${s.a},${s.y}`)) {
        if (s.a === 0) edge = true;
        if (s.entryX === s.a) s.entryX = s.a + 1;
        if (s.exitX === s.a) s.exitX = s.a + 1;
        s.a += 1;
        cut++;
        moved = true;
      }
      if (s.b > c.hi && !endUsed.has(`${s.id}:${s.b}`) && !portAt.has(`${s.b},${s.y}`)) {
        if (s.b === L.width - 1) edge = true;
        if (s.entryX === s.b) s.entryX = s.b - 1;
        if (s.exitX === s.b) s.exitX = s.b - 1;
        s.b -= 1;
        cut++;
        moved = true;
      }
      if (!moved) break;
    }
  }
  if (cut) {
    if (edge) cropToContent(L);
    else L.belts -= cut;
  }
  return cut;
}

/** 整张图的带子里有几处原地竖直升降（同一格前后两节高度不同）：各条物品带（含劈开的死胡同那半）、翘曲器带、增产剂带 */
function liftsLeft(L) {
  let n = 0;
  const scan = (tiles) => {
    for (let i = 1; i < tiles.length; i++) if (tiles[i][0] === tiles[i - 1][0] && tiles[i][1] === tiles[i - 1][1] && tiles[i][2] !== tiles[i - 1][2]) n++;
  };
  for (const chain of L.chains) {
    const { main, extra } = chainTiles(L, chain);
    scan(main);
    for (const t of extra) scan(t);
  }
  for (const w of L.warperLinks || []) scan(w.cells);
  for (const p of L.proLines || []) scan(p.cells);
  return n;
}

export function finishOne(cand, ctx) {
  const { station, power, powerOptions, maxWidth, maxHeight, noGrounding, ground = null, busGround = false, aw = 1, spray = 0, sprayItems = null, sprayTo = null, pile = false, sprayRate = 0, burn = false, supply = null, sorter = 2013, storeLayers = 15, stackCap = 0 } = ctx;
  // 后处理改的是自己的一份。接物流站（edge）时 attachStations 自己先复制一份再改，供电预选只读布局，这里不用先复制；
  // 就地烧副产物要先改布局（标 burn、加发电厂），照旧先复制
  let L = burn || station?.place !== 'edge' ? structuredClone(cand.layout) : cand.layout;
  // 侧边总线排到了左边（route.js 的 busSide 'auto'，只在不接站时有）：口和竖走的列在 x < 0，宽、面积搜索时已经算上（layout/score.js）。
  // 这里整张往右挪成从 0 起，后面的后处理、校验、出蓝图都照旧按非负坐标
  const bx = busMinX(L.ports);
  if (bx < 0) {
    if (L === cand.layout) L = structuredClone(L);
    translateLayout(L, -bx, 0);
  }
  // 搜索代价里除了面积和带数以外的部分（惩罚、分拣器长度、叠层……），后处理不改变它们
  const other = L.cost - (L.area + (L.powerPlan?.extraArea ?? 0)) * aw - L.belts;
  // 段两头给分拣器口位预留却没用上的那一格裁掉（用户 2026/10/26：带子不要多伸出去一格）：只裁没有腿、没有口、没有喷涂空当的死胡同那头，裁在搜索之后，不进代价
  trimSegmentEnds(L);
  // 多余副产物就地烧掉（plan/burn.js）：接物流站之前先接到一排火力发电厂上，烧掉的不进站；没接上的照旧送出（进站）
  if (burn) {
    L.burnNotes = [];
    if (station?.place === 'side') {
      if (L.ports.some((p) => p.kind === 'out' && burnable(p.itemId))) L.burnNotes.push('靠左侧站列时副产物照旧进站，没有就地烧掉');
    } else {
      // burn：true 全烧，或要烧的真实物品编号（网页「外部供应」弹窗里逐个选）
      const want = (id) => burn === true || (Array.isArray(burn) && burn.includes(realItem(id)));
      for (const p of L.ports) if (p.kind === 'out' && burnable(p.itemId) && want(p.itemId)) p.burn = true;
      L = addBurners(L, { power, maxWidth, maxHeight, ...(L.noLift ? { maxLevel: 0 } : null) });
    }
  }
  // 箱子供货（不接物流站时，plan/storage.js）：原料入口、成品出口接储物仓 / 储液罐，原来通到边缘的那截作废
  if (supply && !station) L = addStores(L, { supply, sorter, maxLayers: storeLayers, maxWidth, maxHeight, sprayItems: spray ? sprayItems ?? true : null, ...(L.noLift ? { maxLevel: 0 } : null) });
  if (station?.place === 'edge') {
    // 要供电时先在紧凑布局上选好塔位，接站时绕开它们，免得站的接线把塔唯一能放的空地占掉
    let reserve = [];
    let reserveItem = null;
    if (power) {
      const pre = placePower(L, power, { ...powerOptions, maxWidth, maxHeight });
      reserve = pre.nodes.flatMap((n) => powerCells(pre.itemId, n.x, n.y)); // 设施占的每一格
      reserveItem = pre.itemId;
    }
    const opts = { stack: station.stack, maxWidth, maxHeight, maxLevel: L.noLift ? 0 : 6, siteLimit: 6, slots: station.slots };
    // 预留的塔位挡住了所有站位或接线时，不预留再试一次（塔位之后另找）
    L = attachStations(L, { ...opts, reserve, reserveItem }) ?? (reserve.length ? attachStations(L, opts) : null);
    if (!L) return null;
  }
  // 高架落地（plan/ground.js）的升降是原地竖直的：不用原地升降（route.js 的 noLift）时不做
  if (!noGrounding && L.feasible && !L.noLift) groundRoutes(L, ground, busGround);
  // 翘曲器整张一格：一座站存，别的站用传送带接（落地之后、增产剂和供电之前，后面的会让开这些带子）
  if (station?.slots?.warper && L.stations?.length) linkWarpers(L, L.noLift ? { maxLevel: 0 } : undefined);
  // 增产剂（所有原料和中间产物进工厂前喷）和自动集装机（产物出线前叠层；运的超过一条带的产物带上集装）：在供电之前加，供电要给喷涂机、集装机通电
  const stack = needsStacking(L, stackCap);
  if (spray || pile || stack) {
    addAddons(L, { spray, sprayItems, sprayTo, pile, sprayRate, supply: station ? null : supply, sorter, maxLayers: storeLayers, stackCap: stack ? stackCap : 0 });
    // 集装机放不下（有一段带上单个物品占的格位超过一条带的运力）：那条带运不过来，按不可行处理
    if (L.stackShort) {
      L.feasible = false;
      L.penalties = [...L.penalties, { kind: 'belt', amount: 0, msg: L.stackShort }];
    }
    // 有带子没喷上（没地方骑喷涂机或接不上增产剂带）：没喷到的料进工厂就没有增产效果，按不可行处理
    if (spray && L.sprayMissed && !ctx.allowMissed) { // allowMissed：实验开关（考卷量上界用），漏喷不算不可行
      L.feasible = false;
      L.penalties = [...L.penalties, { kind: 'spray', amount: 0, msg: `${L.sprayMissed} 条进工厂的带没喷上增产剂（${L.addonNotes.join('；')}）` }];
    }
    // 箱子供货：增产剂带从边缘出来的源头也接储物仓（plan/storage.js 的 addProStores）
    if (spray && supply && !station) addProStores(L, { supply, sorter, maxLayers: storeLayers, ...(L.noLift ? { maxLevel: 0 } : null) });
  }
  // 后处理重走只做挑中的那张时（planFrame 的 mode 'pick'）：记一份供电之前的布局，挑完以后拿它接着做后半段（finishTail，中间加重走），
  // 不用从头再接一遍站（大的线接站要一两秒）
  const pre = ctx.keepPre ? { layout: structuredClone(L), other } : null;
  L = finishTail(L, ctx, other);
  return pre ? { ...cand, layout: L, pre } : { ...cand, layout: L };
}

/**
 * 后处理的后半段（finishOne 接完站、落地、翘曲器带、喷涂机、集装机之后）：开了重走时先重走，再放供电、查不用原地升降、尺寸上限，
 * 算利用率和最终代价。L 原地改，返回 L；other 是搜索代价里除了面积和带数以外的部分
 */
export function finishTail(L, ctx, other) {
  const { station, power, powerOptions, maxWidth, maxHeight, noGrounding } = ctx;
  // 后处理重走（routeOptions.reroute，plan/reroute.js）：落地、翘曲器带、喷涂机、增产剂带、集装机都照旧放完（和不重走时一字不差），
  // 放供电之前把段间高架、站的接线、翘曲器带拆了重走（增产剂带、喷涂机、集装机当固定的让开）
  if (ctx.reroute && !noGrounding && station?.place !== 'side' && L.feasible) rerouteBelts(L, { opts: ctx.reroute, power, powerOptions, maxWidth, maxHeight, slots: station?.slots ?? null });
  if (power) {
    // 后处理重走：现选的要往外加地或有覆盖不到的，而重走前选好的那一组（L.powerReserve）原样还能用，就用那一组
    let P = null;
    if (L.powerReserve) {
      const po = { ...powerOptions, maxWidth, maxHeight };
      const now = placePower(L, power, po);
      const e = now.extend;
      P = now.uncovered || e.left || e.right || e.bottom || e.top ? fitPlacement(L, power, L.powerReserve.nodes, po) ?? now : now;
      delete L.powerReserve;
    }
    addPower(L, power, { ...powerOptions, maxWidth, maxHeight }, P);
    // 有工厂或分拣器没通上电，这张图贴进游戏也开不起来，按不可行处理
    if (L.power.uncovered) {
      L.feasible = false;
      L.penalties = [...L.penalties, { kind: 'power', amount: 0, msg: `${L.power.uncovered} 个工厂/分拣器不在${L.power.name}范围内` }];
    }
  }
  // 不用原地升降（route.js 的 noLift）：高架段走的是坡，后处理接的线（物流站、仓组、发电厂、翘曲器的寻路只走地面）照理也没有升降；
  // 还剩原地竖直升降的（增产剂带之类还不会走坡）按不可行处理，免得出一张没解锁超级磁场贴不上的图
  if (L.noLift) {
    const n = liftsLeft(L);
    if (n) {
      L.feasible = false;
      L.penalties = [...L.penalties, { kind: 'route', amount: 0, msg: `选了不用原地升降，还有 ${n} 处原地竖直升降（增产剂带等的接线还不会走坡）` }];
    }
  }
  // 接站、供电外沿加地之后再看一次尺寸上限：超出的按不可行处理
  for (const [lim, size, word] of [[maxWidth, L.width, '宽'], [maxHeight, L.height, '长']]) {
    if (lim && size > lim) {
      L.feasible = false;
      L.penalties = [...L.penalties, { kind: word === '宽' ? 'width' : 'height', amount: 0, msg: `接站、供电之后${word} ${size} 格，超过上限 ${lim} 格` }];
    }
  }
  L.space = spaceStats(L);
  // 最终代价：后处理之后的真实面积（含供电外沿加地、物流站）和带数，面积按 1 倍计
  L.finalCost = L.area + L.belts + other;
  return L;
}

/**
 * 规划流程。yield 两种请求：
 *   { kind: 'search', graph, options }  搜索，期待 optimize 的返回值
 *   { kind: 'finish', cands, ctx }      后处理，期待 cands.map((c) => finishOne(c, ctx))
 * @param {*} calc calculate() 的结果
 * @param {{iterations?, restarts?, seed?, timeLimit?, routeOptions?, station?, power?, powerOptions?, targetSpace?, finishCount?, noGrounding?, adaptive?, beltSlack?, orient?}} options
 *
 * orient：排布方向。'h' 横排（行沿 x，默认）；'v' 竖排（行沿 y：把宽、长上限对调后横着排，出蓝图时整张转 90°，
 * layout.rotated = true）；'auto' 宽、长上限不一样时两种都排、挑最终代价小的（没有上限或上限一样时两种只差一个旋转，只排横的）。
 * 为什么有用：限宽 30 时横排只能把行切短、摞很多行，每行都多一条通道；竖着排行可以很长，同样塞进 30 宽，
 * 实测面积少 4~6%、传送带少 20% 左右（2026/10/04，处理器 120、粒子容器 60、电磁涡轮 270）。
 */
export function* planSteps(calc, options = {}) {
  const ro = options.routeOptions || {};
  const swapped = () => ({ ...options, routeOptions: { ...ro, maxWidth: ro.maxHeight ?? null, maxHeight: ro.maxWidth ?? null } });
  const orient = options.orient ?? 'h';
  const asym = (ro.maxWidth ?? null) !== (ro.maxHeight ?? null);
  if (orient === 'v') {
    const r = yield* planCore(calc, swapped());
    r.layout.rotated = true;
    return { ...r, orient: 'v', orientTried: ['v'] };
  }
  if (orient === 'auto' && asym) {
    // 两种各用一半时间
    const half = (o) => (o.timeLimit ? { ...o, timeLimit: Math.max(1000, o.timeLimit / 2) } : o);
    const h = yield* planCore(calc, half(options));
    const v = yield* planCore(calc, half(swapped()));
    v.layout.rotated = true;
    const score = (r) => (r.layout.feasible ? 0 : 1e9) + r.layout.finalCost;
    const pick = score(v) < score(h) ? v : h;
    return { ...pick, ms: h.ms + v.ms, orient: pick === v ? 'v' : 'h', orientTried: ['h', 'v'], orientAlt: { orient: pick === v ? 'h' : 'v', width: (pick === v ? h : v).layout.width, height: (pick === v ? h : v).layout.height, rotated: pick !== v, area: (pick === v ? h : v).layout.area, belts: (pick === v ? h : v).layout.belts, feasible: (pick === v ? h : v).layout.feasible, finalCost: (pick === v ? h : v).layout.finalCost } };
  }
  const r = yield* planCore(calc, options);
  return { ...r, orient: 'h', orientTried: ['h'] };
}

/**
 * 用哪个内核：routeOptions.core 写明的为准，没写用 options.core（网页档位 EFFORT 给的默认，web/src/worker.js；考卷外壳照抄），
 * 都没写是主干内核。'master' 主干内核（等于不写）；'typeset' 排版内核（src/plan/typeset.js）；
 * 'auto'（用户 2026/10/27）：先用排版内核排，搜完第 AUTO_SEGMENTS 段最好那张还不可行，就换主干内核从头再排一遍，
 * 和直接用主干内核一样（同一个种子），只是整次规划的时间（untilTarget.maxMs）、段数上限扣掉排版内核用掉的（至少留一半，
 * 退回站列也是这么给的）；每段搜索的 timeLimit 是保险丝，照档位原样给，换过的就和只用主干内核排出来的一样。
 * 换过的在返回值的 coreSwitch 里记着排版内核搜了几段，网页打到控制台的「规划细节」；searchRounds、ms 是两次合计。
 * 依据（考卷 2 标准档 3 个种子）：排版内核不可行的 5 份第 2 段搜完都还不可行、再搜十几段也没救回来，可行的 25 份最多用 2 段
 */
function* planCore(calc, options) {
  const ro = options.routeOptions || {};
  const core = ro.core ?? options.core;
  // 没有档位给的 options.core、routeOptions 里也没写 auto / master：原来的路，一字不动
  if (!('core' in options) && core !== 'auto' && core !== 'master') return yield* planFrame(calc, options);
  // 往下传的不带 options.core（搜索的活里只看 routeOptions.core），主干内核就是不写
  const base = { ...options };
  delete base.core;
  const pin = (c) => {
    const r = { ...ro };
    if (c == null || c === 'master') delete r.core;
    else r.core = c;
    return r;
  };
  if (core !== 'auto') return yield* planFrame(calc, { ...base, routeOptions: pin(core) });
  const a = yield* planFrame(calc, { ...base, routeOptions: pin('typeset'), giveUpAfter: AUTO_SEGMENTS });
  if (!a.gaveUp) return a;
  const master = pin('master');
  const left = (cap, used) => Math.max(cap * 0.5, cap - used);
  const ut = options.untilTarget;
  const b = yield* planFrame(calc, {
    ...base,
    routeOptions: master,
    ...(ut ? { untilTarget: { ...ut, ...(ut.maxMs != null ? { maxMs: left(ut.maxMs, a.ms) } : {}), ...(ut.maxSegments != null ? { maxSegments: Math.ceil(left(ut.maxSegments, a.searchRounds)) } : {}) } } : {}),
    ...(options.onRound ? { onRound: (r) => options.onRound({ ...r, round: r.round + a.searchRounds }) } : {}),
  });
  return { ...b, searchRounds: a.searchRounds + b.searchRounds, ms: a.ms + b.ms, coreSwitch: { from: 'typeset', segments: a.searchRounds } };
}

/** 在一个方向上规划（宽、长上限按给定的算） */
function* planFrame(calc, options) {
  const graph = buildGraph(calc);
  const t = Date.now();
  const station = stationOption(options); // 回退时会改成 side
  const target = options.targetSpace ?? TARGET_SPACE;
  const routeOptions = { ...options.routeOptions };
  delete routeOptions.station;
  if (station?.place === 'side') routeOptions.station = { stack: station.stack, slots: station.slots };
  if (station?.place === 'edge') Object.assign(routeOptions, { externalStack: station.stack, stationHoles: options.stationHoles ?? true, freeEnds: options.freeEnds ?? true, stationSlots: station.slots });
  // 箱子供货的左侧一列仓组（不接物流站时，plan/storage.js 的 isColumnSupply）：出入口都在左边（route.js 的 leftPorts；routeOptions 里写明的为准）
  if (!station && isColumnSupply(options.supply) && routeOptions.leftPorts == null) routeOptions.leftPorts = true;
  const power = options.power && options.power !== 'none' ? options.power : null;
  if (power) Object.assign(routeOptions, { power, powerOptions: options.powerOptions });
  if (options.powerHoles) routeOptions.powerHoles = true; // 卫星配电站在行里挖空位（route.js，标准档、细档开）
  if (options.groundTax && routeOptions.groundTax == null) routeOptions.groundTax = true; // 高架落地加变层税（ground.js，细档开；routeOptions 里写明的为准）
  if (options.heightTax && routeOptions.heightTax == null) routeOptions.heightTax = true; // 线性超高税代替金字塔（layout/score.js，细档开；routeOptions 里写明的为准）
  if (options.bundleFee && routeOptions.bundleFee == null) routeOptions.bundleFee = options.bundleFee; // 开路费（layout/positions.js 的 bestColumn，细档 8；routeOptions 里写明的为准）
  if (options.openFee && routeOptions.openFee == null) routeOptions.openFee = options.openFee; // 走空地费（layout/positions.js 的 bestColumn，细档 2；routeOptions 里写明的为准）
  // 喷增产剂：走线要给要喷的带留喷涂机的空当（layout/belts.js 的 sprayAll），不喷时几何一字不动。
  // 只喷最终产物的直接原料（calc.spray.items），喷涂机在这几种带上放在最终那几组（calc.spray.to）取料之前、别的工厂取完之后
  if (calc.spray) {
    routeOptions.sprayAll = true;
    if (calc.spray.items) Object.assign(routeOptions, { sprayItems: calc.spray.items, sprayTo: calc.spray.to });
  }
  // 喷涂时放开第 4 条轨（route.js 的 fourthTrack：每根分拣器都够得着才算数）；不喷的照旧最多 3 条
  if (calc.spray && routeOptions.fourthTrack == null) routeOptions.fourthTrack = true;
  // 排版内核（分支 explore/typeset）也放开：行都铺满，大线的通道常要 4 条轨（引力矩阵 180 塔：放开后分拣器太慢、超轨都没了），
  // 考卷 6 条 + 放大 3 倍里 4 条塔模式合计 +0.2%（种子 1）
  if (routeOptions.core === 'typeset' && routeOptions.fourthTrack == null) routeOptions.fourthTrack = true;
  // 宽通道（route.js 的 wideTracks：5~6 条轨，每根分拣器都够得着才算数）也只在排版内核开
  if (routeOptions.core === 'typeset' && routeOptions.wideTracks == null) routeOptions.wideTracks = true;
  if (routeOptions.core === 'typeset' && routeOptions.sideSplit == null) routeOptions.sideSplit = true;
  if (routeOptions.core === 'typeset' && routeOptions.exactSplit == null) routeOptions.exactSplit = true;
  // 排版内核：够不着电每个目标按 2000 罚（master 300）。行都铺满，大线最后常剩十来个够不着电的目标，300 一个时搜索宁可留着它们换面积
  // （引力矩阵 360 塔：只剩 1~18 个目标够不着电）；后处理放不下塔照样不可行，和供给顺序、超轨（2000~3000）一样当硬约束
  if (routeOptions.core === 'typeset') routeOptions.penalty = { power: 2000, ...routeOptions.penalty };
  const deadline = options.timeLimit ? t + options.timeLimit : null;
  const searchOpts = (ro, timeLimit) => {
    const o = { ...options, routeOptions: ro, timeLimit };
    delete o.station; // 物流站已经折进 routeOptions
    delete o.untilTarget; // 下面几个只在这里用；回调也传不进帮手线程
    delete o.onRound;
    delete o.giveUpAfter;
    // onSnapshot（实时预览的快照钩子）留着：单线程驱动就地执行用得上；多线程驱动发活前自己删（见 planLineAsync），
    // 帮手线程按 snapshotMs 开关自己装钩子（web/src/worker.js 的 task 分支）
    return o;
  };
  const ctx = (aw = routeOptions.areaWeight ?? 1) => ({ station: station && { ...station }, power, powerOptions: options.powerOptions, maxWidth: routeOptions.maxWidth, maxHeight: routeOptions.maxHeight, noGrounding: !!options.noGrounding, ground: groundOptions(routeOptions), busGround: !!routeOptions.busGround, aw, spray: calc.spray ? calc.spray.level : 0, sprayItems: calc.spray?.items ?? null, sprayTo: calc.spray?.to ?? null, pile: !!options.pile, sprayRate: calc.spray?.rate ?? 0, burn: options.burn || false, allowMissed: !!routeOptions.allowMissed, supply: options.supply ?? null, sorter: routeOptions.sorter ?? options.sorter ?? 2013, storeLayers: options.storeLayers ?? 15, stackCap: stackCapOf(routeOptions), ...rerouteCtx(routeOptions) });

  let result = yield { kind: 'search', graph, options: searchOpts(routeOptions, options.timeLimit ?? null) };

  const pool = (res) => {
    // 最好的那个（收尾合并过块）和存档里同一形状的那个往往是同一个布局，按尺寸和代价去重
    const seen = new Set();
    const list = [res, ...(res.candidates || [])].filter((c) => {
      const k = `${c.layout.width}x${c.layout.height}:${Math.round(c.layout.cost)}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    // 排版内核的候选带着队、行宽、站位、供电缝（seq…），下一段接力用（见下面 warmOf）
    return list.slice(0, options.finishCount ?? 6).map(({ layout, rows, pads, blocks, streets, seq, W, bays, gaps }) => ({ layout, rows, pads, blocks, streets, ...(seq ? { seq, W, bays, gaps } : {}) }));
  };
  /**
   * 挑候选：先找代价最小的那个；传送带不超过它 (1 + BELT_SLACK) 倍的候选里，利用率达标的挑代价最小的，
   * 都不达标时挑「代价 + 8 × 差额」最小的（差额 = 达标还缺几格被占用的地）。
   */
  const choose = (list) => {
    const ok = list.filter((c) => c.layout.feasible);
    const use = ok.length ? ok : list;
    const base = use.reduce((a, b) => (b.layout.finalCost < a.layout.finalCost ? b : a));
    const slack = options.beltSlack ?? BELT_SLACK;
    const kept = use.filter((c) => c.layout.belts <= base.layout.belts * (1 + slack) + 1e-9);
    const short = (L) => Math.max(0, target * L.area - L.space.usedCells);
    const met = kept.filter((c) => short(c.layout) <= 0);
    if (met.length) return met.reduce((a, b) => (b.layout.finalCost < a.layout.finalCost ? b : a));
    return kept.reduce((a, b) => (b.layout.finalCost + 8 * short(b.layout) < a.layout.finalCost + 8 * short(a.layout) ? b : a));
  };

  // 后处理重走只做挑中的那张时（routeOptions.reroute 的 mode 'pick'，默认，见最后）：每个候选的后处理多记一份供电之前的布局（finishOne 的 keepPre）
  // 和用的哪份 ctx，挑完拿它接着做后半段。不重走时不记，ctx 和以前一字不差、也不多占内存
  const rrPick = (() => {
    const r = rerouteOptions(routeOptions);
    return r && r.mode !== 'all' && !options.noGrounding ? r : null;
  })();
  const finish = function* (cands, c) {
    const res = yield { kind: 'finish', cands, ctx: rrPick ? { ...c, keepPre: true } : c };
    return rrPick ? res.map((r) => (r ? { ...r, srcCtx: c } : null)).filter(Boolean) : res.filter(Boolean);
  };
  // 已经有可行的了，不可行的以后不会再挑中（choose 只在可行的里挑），它们记着的那份布局扔掉，少占内存
  const dropPre = (list) => {
    if (rrPick && list.some((x) => x.layout.feasible)) for (const x of list) if (!x.layout.feasible) delete x.pre;
    return list;
  };
  let finished = dropPre(yield* finish(pool(result), ctx()));
  let fallback = false;
  if (!finished.length && station?.place === 'edge') {
    // 所有候选都接不上站：改用靠左侧的站列重新搜索（不是悄悄丢掉物流站）
    fallback = true;
    station.place = 'side';
    routeOptions.station = { stack: station.stack, slots: station.slots };
    delete routeOptions.externalStack;
    delete routeOptions.stationHoles;
    delete routeOptions.freeEnds;
    delete routeOptions.stationSlots;
    // 退回站列要重搜一遍：大产线第一遍搜索常常把时间上限用光，这里至少再给原预算的一半，不然只剩 1 秒搜出来的是废图
    result = yield { kind: 'search', graph, options: searchOpts(routeOptions, deadline ? Math.max(options.timeLimit * 0.5, deadline - Date.now()) : options.timeLimit ?? null) };
    finished = dropPre(yield* finish(pool(result), ctx()));
  }
  let pick = choose(finished);
  // 物流站放进空地时，搜索里的高架最多 4 层（route.js 的 DEFAULTS.maxLevel），站列模式、接站的线（attachStations）、增产剂带都是 6 层。
  // 第一段搜完（接上站以后）最好那张还不可行时，后面各段搜索放到 6 层（考卷 2 的量子化工厂 + 大型采矿机高配：主干内核 20 段 240 轮
  // 没有一轮可行，193 轮卡在高架层数上，最接近的那张只差一截电路板要第 5 层）。只在这时才放：第一段就可行的线一字不变
  // （可行了以后挑的一直是可行的，不会再放）；routeOptions 里写明了 maxLevel 的照写明的
  const levelRelaxed = station?.place === 'edge' && routeOptions.maxLevel == null && !pick.layout.feasible;
  if (levelRelaxed) routeOptions.maxLevel = 6;
  // 接力退火（排版内核，分支 explore/typeset）：后面每一段从目前最好那张接着退一半的轮（place.js 的 warm），不是都从头再来。
  // 大线一段段从头搜，常常每段都卡在同一个地方（黄棒 30 塔第 3~13 段都是 78.2%、不可行）
  const warmOf = (c) => (routeOptions.core === 'typeset' && c?.seq ? { seq: c.seq, W: c.W, bays: c.bays ?? null, gaps: c.gaps ?? null } : null);
  // 空间利用率没到目标：把面积的权重加倍再搜（用剩下的时间），最多 retries 轮，达标就停；各轮的候选放在一起挑。
  // 网页的搜索力度就是按这个分档：快 ≥50%、中 ≥70%、细 ≥85%（见 web/src/worker.js 的 EFFORT）
  const retries = options.adaptive === false ? 0 : options.retries ?? 1;
  let aw = routeOptions.areaWeight ?? 1;
  let rounds = 1;
  // planCore 的内核 'auto' 用：搜完第 giveUpAfter 段（≥ 2）最好那张还不可行就不往下搜了，交回去换主干内核
  const giveUp = () => rounds >= (options.giveUpAfter ?? Infinity) && !pick.layout.feasible;
  // 利用率只看地面占得满不满：一长条单行（比如 152×10）利用率也能有 75%，面积却大一倍多。
  // 所以没设宽 / 长 / 长宽比上限时，搜出来比 4:1 还瘦长的也加重面积再搜一轮
  const free = !routeOptions.maxWidth && !routeOptions.maxHeight && !routeOptions.maxAspect;
  const lanky = (L) => free && Math.max(L.width, L.height) > 4 * Math.min(L.width, L.height);
  // 可行优先（2026/10/07，用户报「通道 3 需要 4 条地面轨道」）：最好那张还不可行时，加重面积只会把图挤得更密、更难可行，
  // 这时面积权重不加，换个种子再搜；可行了才加重面积去压利用率
  const ff = options.feasibleFirst !== false;
  for (let k = 0; k < retries && (pick.layout.space.space < target || lanky(pick.layout)) && (!deadline || deadline - Date.now() > 2000); k++) {
    const stuck = ff && !pick.layout.feasible;
    if (!stuck) aw *= 2;
    const ro = { ...routeOptions, areaWeight: aw };
    const so = searchOpts(ro, deadline ? deadline - Date.now() : options.timeLimit ?? null);
    if (stuck) so.seed = (options.seed ?? 7) + 7919 * (k + 1);
    if (warmOf(pick)) so.warm = warmOf(pick);
    const again = yield { kind: 'search', graph, options: so };
    const more = yield* finish(pool(again), ctx(aw));
    finished = dropPre([...finished, ...more]);
    pick = choose(finished);
    rounds++;
    options.onRound?.({ round: rounds, space: pick.layout.space.space, feasible: !!pick.layout.feasible, target });
    if (giveUp()) return { gaveUp: true, searchRounds: rounds, ms: Date.now() - t };
  }
  // 没达标接着搜（用户 2026/10/07，网页的三档用）：照上面搜完还没达标（不可行或利用率不到目标），换种子、面积权重继续加倍（封顶 16）再搜，
  // 直到达标或到 untilTarget.maxMs；每轮的时间上限照旧。达没达标写在 targetMet 里，到点没达标页面照常显示最好那张、说明没到这一档
  // 没进展就停（用户 2026/10/07：高纯硅块 1500 靠左侧站列 + 细档，利用率卡在 70%~72%、够不着 85%，会一直搜到 200 分钟）：
  // 每多搜一段看最好那张有没有进步（变可行，或利用率涨了至少 1 个百分点）；已经可行的连续 3 段、还不可行的连续 6 段没进步，就交出最好那张（stalled）
  const met = (L) => !!L.feasible && L.space.space >= target && !lanky(L);
  let stalled = false;
  if (options.untilTarget) {
    const stopAt = t + options.untilTarget.maxMs;
    const patience = (L) => (L.feasible ? options.untilTarget.patience ?? 3 : options.untilTarget.patienceInfeasible ?? (ff ? 12 : 6));
    let best = { feasible: !!pick.layout.feasible, space: pick.layout.space.space };
    let still = 0;
    // maxSegments：整次规划最多搜几段（含第一段），按段数收手、和机器快慢无关（考卷 tools/exam 用；网页不传，照旧按时间）
    const segCap = options.untilTarget.maxSegments ?? Infinity;
    for (let k = 1; !met(pick.layout) && stopAt - Date.now() > 2000 && rounds < segCap; k++) {
      if (still >= patience(pick.layout)) {
        stalled = true;
        break;
      }
      aw = ff && !pick.layout.feasible ? routeOptions.areaWeight ?? 1 : Math.min(aw * 2, 16); // 还不可行：面积权重回到原值，只换种子
      const o = searchOpts({ ...routeOptions, areaWeight: aw }, Math.min(options.timeLimit ?? Infinity, stopAt - Date.now()));
      o.seed = (options.seed ?? 7) + 1009 * k;
      if (warmOf(pick)) o.warm = warmOf(pick);
      const again = yield { kind: 'search', graph, options: o };
      const more = yield* finish(pool(again), ctx(aw));
      finished = dropPre([...finished, ...more]);
      pick = choose(finished);
      rounds++;
      options.onRound?.({ round: rounds, space: pick.layout.space.space, feasible: !!pick.layout.feasible, target });
      if (giveUp()) return { gaveUp: true, searchRounds: rounds, ms: Date.now() - t };
      const now = { feasible: !!pick.layout.feasible, space: pick.layout.space.space };
      if ((now.feasible && !best.feasible) || (now.feasible === best.feasible && now.space >= best.space + 0.01)) {
        best = now;
        still = 0;
      } else still++;
    }
  }
  // 后处理重走只做挑中的那张（routeOptions.reroute 的 mode 'pick'，默认）：搜索、每个候选的后处理、挑法都和不重走时一字不差，
  // 挑完拿这张供电之前的那份布局、照它那份 ctx 接着做后半段（finishTail，中间加重走），哪一项都不比原来差才换上（plan/reroute.js 的 rerouteWorse）；
  // 差了就把相遇、叠格的代价加重再试一次，还差就留原来那张。就在这里做、不交给线程池（只有一张，排在别的活后面等线程反而慢）；
  // 用时记在 layout.rerouteGuard（ms 合计、tryMs 每次）
  if (rrPick && pick?.pre && station?.place !== 'side') {
    const t0 = Date.now();
    const base = beltStats(pick.layout);
    // 拐弯守门（实验开关 turnGuard）：拐弯也比；第一次换不上，先把拐弯的代价加重再试，再不行拐弯、相遇、叠格一起加重
    const heavyTurn = { ...rrPick, turn: rrPick.turn * rrPick.turnMul, slopeTurn: rrPick.slopeTurn * rrPick.turnMul };
    const tries = rrPick.turnGuard ? [rrPick, heavyTurn, { ...heavyTurn, meet: rrPick.meet * 3, over: rrPick.over * 1.5 }] : [rrPick, { ...rrPick, meet: rrPick.meet * 3, over: rrPick.over * 1.5 }];
    const guard = { tried: 0, used: 0, why: [], ms: 0, tryMs: [] };
    for (const o of tries) {
      guard.tried++;
      const t1 = Date.now();
      const alt = finishTail(structuredClone(pick.pre.layout), { ...pick.srcCtx, reroute: o }, pick.pre.other);
      guard.tryMs.push(Date.now() - t1);
      if (!alt.reroute) {
        guard.why.push('没重走');
        break;
      }
      const why = rerouteWorse(pick.layout, base, alt, beltStats(alt), { turns: rrPick.turnGuard });
      // 带子少了利用率会跟着降一点：原来达标、换上以后不达标（网页会说没到这一档）也不换
      if (met(pick.layout) && !met(alt)) why.push('没达标');
      if (!why.length) {
        guard.used = guard.tried;
        pick = { ...pick, layout: alt };
        break;
      }
      guard.why.push(why.join('，'));
    }
    guard.ms = Date.now() - t0;
    pick.layout.rerouteGuard = guard;
  }
  const rest = { ...result };
  delete rest.candidates; // 候选只在这里用，不往外带
  return { graph, ...rest, rows: pick.rows, pads: pick.pads, blocks: pick.blocks, streets: pick.streets, layout: pick.layout, station, stationFallback: fallback, levelRelaxed, targetSpace: target, targetMet: met(pick.layout), stalled, searchRounds: rounds, ms: Date.now() - t };
}

/**
 * 一份搜索任务（options 是发给帮手线程的那份：物流站已经折进 routeOptions）对应的后处理参数，和 planFrame 里的 ctx 一样。
 * 网页「就这个蓝图了」（用户 2026/10/07）用：拿实时预览正在画的那一轮的当前排法直接收尾、出图。
 */
export function finishContext(calc, options) {
  const ro = options.routeOptions || {};
  const station = ro.station ? { place: 'side', stack: ro.station.stack, slots: ro.station.slots } : ro.externalStack != null ? { place: 'edge', stack: ro.externalStack, slots: ro.stationSlots } : null;
  return { station, power: ro.power ?? null, powerOptions: ro.powerOptions, maxWidth: ro.maxWidth, maxHeight: ro.maxHeight, noGrounding: !!options.noGrounding, ground: groundOptions(ro), busGround: !!ro.busGround, aw: ro.areaWeight ?? 1, spray: calc.spray ? calc.spray.level : 0, sprayItems: calc.spray?.items ?? null, sprayTo: calc.spray?.to ?? null, pile: !!options.pile, sprayRate: calc.spray?.rate ?? 0, burn: options.burn || false, allowMissed: !!ro.allowMissed, supply: options.supply ?? null, sorter: ro.sorter ?? options.sorter ?? 2013, storeLayers: options.storeLayers ?? 15, stackCap: stackCapOf(ro), ...rerouteCtx(ro) };
}
/**
 * 后处理重走（plan/reroute.js）的参数进 ctx：没开时、只做挑中的那张时（mode 'pick'，planFrame 最后自己做）不加这一项，ctx 和以前一字不差；
 * mode 'all' 时每个候选的后处理都重走（重走以后的代价参与挑选）
 */
function rerouteCtx(ro) {
  const r = rerouteOptions(ro);
  return r && r.mode === 'all' ? { reroute: r } : {};
}

/** 就地执行一个请求 */
export function runRequest(req) {
  if (req.kind === 'search') return optimize(req.graph, req.options);
  return req.cands.map((c) => finishOne(c, req.ctx));
}

/** 单线程规划 */
export function planLine(calc, options = {}) {
  const gen = planSteps(calc, options);
  let r = gen.next();
  while (!r.done) r = gen.next(runRequest(r.value));
  return r.value;
}

/**
 * 多线程规划。pool：{ size, run(task) => Promise }，task 见 tasks.js（search / finish）。
 * 搜索的 restarts 轮退火每轮一份活交给线程池（各轮互不相干，种子由轮号决定），合并时和单线程一样按轮号取 best；
 * 后处理每个候选一份。pool 为空或只有 1 个线程时退回单线程。
 */
export async function planLineAsync(calc, options = {}, pool = null) {
  if (!pool || pool.size <= 1) return planLine(calc, options);
  const gen = planSteps(calc, options);
  let r = gen.next();
  while (!r.done) {
    const req = r.value;
    let res;
    if (req.kind === 'search') {
      // 每轮一份活，线程池按先来先做分派：各轮用时差得不少（同样步数，布局大小不同），这样比按轮号预先分组更均匀。
      // 有时间上限而轮数多于线程时，每轮只给自己那份时间，排在后面的轮次也有时间跑。
      const n = req.options.restarts ?? 4;
      const opts = { ...req.options };
      delete opts.onSnapshot; // 函数不能结构化克隆；帮手线程按 opts.snapshotMs 自己装快照钩子
      if (opts.timeLimit && n > pool.size) opts.timeLimit = Math.max(500, (opts.timeLimit * pool.size) / n);
      // pool.run 是同步往线程 postMessage 的，所以先把各轮的 Promise 建出来（工作线程随即开跑），
      // 不 await；主线程趁各轮在跑把初始解算好填 candsMemo，mergeRounds 里的 prepare 命中、不再串行算 1~2 秒。
      const pending = Promise.all(Array.from({ length: n }, (_, s) => pool.run({ kind: 'search', calc, options: opts, rounds: [s] })));
      pending.catch(() => {}); // precompute 若抛错，pending 还在飞——先挂个 catch 免得变成 unhandledRejection（下面的 await 仍会把真正的错抛出来）
      precompute(req.graph, req.options); // 和 mergeRounds 用同一个 req.options：键一样，命中 memo
      const parts = (await pending).flat();
      res = mergeRounds(req.graph, req.options, parts);
    } else {
      res = await Promise.all(req.cands.map((cand) => pool.run({ kind: 'finish', cand, ctx: req.ctx })));
    }
    r = gen.next(res);
  }
  return r.value;
}
