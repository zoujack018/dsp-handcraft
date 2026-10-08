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
import { optimize, mergeRounds } from './place.js';
import { addPower, placePower } from './power.js';
import { spaceStats } from '../metrics/space.js';
import { attachStations, linkWarpers } from './stations.js';
import { groundRoutes } from './ground.js';
import { addAddons } from './addons.js';
import { addBurners, burnable } from './burn.js';
import { powerCells, realItem } from '../gamedata.js';

export const TARGET_SPACE = 0.8;
/** 为了利用率达标，传送带最多比代价最小的候选多这么多 */
export const BELT_SLACK = 0.1;

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
 * ctx：{ station, power, powerOptions, maxWidth, maxHeight, noGrounding, aw, spray, pile, sprayRate }
 */
export function finishOne(cand, ctx) {
  const { station, power, powerOptions, maxWidth, maxHeight, noGrounding, aw = 1, spray = 0, pile = false, sprayRate = 0, burn = false } = ctx;
  // 后处理改的是自己的一份。接物流站（edge）时 attachStations 自己先复制一份再改，供电预选只读布局，这里不用先复制；
  // 就地烧副产物要先改布局（标 burn、加发电厂），照旧先复制
  let L = burn || station?.place !== 'edge' ? structuredClone(cand.layout) : cand.layout;
  // 搜索代价里除了面积和带数以外的部分（惩罚、分拣器长度、叠层……），后处理不改变它们
  const other = L.cost - (L.area + (L.powerPlan?.extraArea ?? 0)) * aw - L.belts;
  // 多余副产物就地烧掉（plan/burn.js）：接物流站之前先接到一排火力发电厂上，烧掉的不进站；没接上的照旧送出（进站）
  if (burn) {
    L.burnNotes = [];
    if (station?.place === 'side') {
      if (L.ports.some((p) => p.kind === 'out' && burnable(p.itemId))) L.burnNotes.push('靠左侧站列时副产物照旧进站，没有就地烧掉');
    } else {
      // burn：true 全烧，或要烧的真实物品编号（网页「外部供应」弹窗里逐个选）
      const want = (id) => burn === true || (Array.isArray(burn) && burn.includes(realItem(id)));
      for (const p of L.ports) if (p.kind === 'out' && burnable(p.itemId) && want(p.itemId)) p.burn = true;
      L = addBurners(L, { power, maxWidth, maxHeight });
    }
  }
  if (station?.place === 'edge') {
    // 要供电时先在紧凑布局上选好塔位，接站时绕开它们，免得站的接线把塔唯一能放的空地占掉
    let reserve = [];
    let reserveItem = null;
    if (power) {
      const pre = placePower(L, power, { ...powerOptions, maxWidth, maxHeight });
      reserve = pre.nodes.flatMap((n) => powerCells(pre.itemId, n.x, n.y)); // 设施占的每一格
      reserveItem = pre.itemId;
    }
    const opts = { stack: station.stack, maxWidth, maxHeight, maxLevel: 6, siteLimit: 6, slots: station.slots };
    // 预留的塔位挡住了所有站位或接线时，不预留再试一次（塔位之后另找）
    L = attachStations(L, { ...opts, reserve, reserveItem }) ?? (reserve.length ? attachStations(L, opts) : null);
    if (!L) return null;
  }
  if (!noGrounding && L.feasible) groundRoutes(L);
  // 翘曲器整张一格：一座站存，别的站用传送带接（落地之后、增产剂和供电之前，后面的会让开这些带子）
  if (station?.slots?.warper && L.stations?.length) linkWarpers(L);
  // 增产剂（所有原料和中间产物进工厂前喷）和自动集装机（产物出线前叠层）：在供电之前加，供电要给喷涂机、集装机通电
  if (spray || pile) {
    addAddons(L, { spray, pile, sprayRate });
    // 有带子没喷上（没地方骑喷涂机或接不上增产剂带）：没喷到的料进工厂就没有增产效果，按不可行处理
    if (spray && L.sprayMissed && !ctx.allowMissed) { // allowMissed：实验开关（考卷量上界用），漏喷不算不可行
      L.feasible = false;
      L.penalties = [...L.penalties, { kind: 'spray', amount: 0, msg: `${L.sprayMissed} 条进工厂的带没喷上增产剂（${L.addonNotes.join('；')}）` }];
    }
  }
  if (power) {
    addPower(L, power, { ...powerOptions, maxWidth, maxHeight });
    // 有工厂或分拣器没通上电，这张图贴进游戏也开不起来，按不可行处理
    if (L.power.uncovered) {
      L.feasible = false;
      L.penalties = [...L.penalties, { kind: 'power', amount: 0, msg: `${L.power.uncovered} 个工厂/分拣器不在${L.power.name}范围内` }];
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
  return { ...cand, layout: L };
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
    const r = yield* planFrame(calc, swapped());
    r.layout.rotated = true;
    return { ...r, orient: 'v', orientTried: ['v'] };
  }
  if (orient === 'auto' && asym) {
    // 两种各用一半时间
    const half = (o) => (o.timeLimit ? { ...o, timeLimit: Math.max(1000, o.timeLimit / 2) } : o);
    const h = yield* planFrame(calc, half(options));
    const v = yield* planFrame(calc, half(swapped()));
    v.layout.rotated = true;
    const score = (r) => (r.layout.feasible ? 0 : 1e9) + r.layout.finalCost;
    const pick = score(v) < score(h) ? v : h;
    return { ...pick, ms: h.ms + v.ms, orient: pick === v ? 'v' : 'h', orientTried: ['h', 'v'], orientAlt: { orient: pick === v ? 'h' : 'v', width: (pick === v ? h : v).layout.width, height: (pick === v ? h : v).layout.height, rotated: pick !== v, area: (pick === v ? h : v).layout.area, belts: (pick === v ? h : v).layout.belts, feasible: (pick === v ? h : v).layout.feasible, finalCost: (pick === v ? h : v).layout.finalCost } };
  }
  const r = yield* planFrame(calc, options);
  return { ...r, orient: 'h', orientTried: ['h'] };
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
  const power = options.power && options.power !== 'none' ? options.power : null;
  if (power) Object.assign(routeOptions, { power, powerOptions: options.powerOptions });
  if (options.powerHoles) routeOptions.powerHoles = true; // 卫星配电站在行里挖空位（route.js，标准档、细档开）
  // 喷增产剂：走线要给每条进工厂的带留喷涂机的空当（layout/belts.js 的 sprayAll），不喷时几何一字不动
  if (calc.spray) routeOptions.sprayAll = true;
  // 喷涂时放开第 4 条轨（route.js 的 fourthTrack：每根分拣器都够得着才算数）；不喷的照旧最多 3 条
  if (calc.spray && routeOptions.fourthTrack == null) routeOptions.fourthTrack = true;
  const deadline = options.timeLimit ? t + options.timeLimit : null;
  const searchOpts = (ro, timeLimit) => {
    const o = { ...options, routeOptions: ro, timeLimit };
    delete o.station; // 物流站已经折进 routeOptions
    delete o.untilTarget; // 下面两个只在这里用；回调也传不进帮手线程
    delete o.onRound;
    // onSnapshot（实时预览的快照钩子）留着：单线程驱动就地执行用得上；多线程驱动发活前自己删（见 planLineAsync），
    // 帮手线程按 snapshotMs 开关自己装钩子（web/src/worker.js 的 task 分支）
    return o;
  };
  const ctx = (aw = routeOptions.areaWeight ?? 1) => ({ station: station && { ...station }, power, powerOptions: options.powerOptions, maxWidth: routeOptions.maxWidth, maxHeight: routeOptions.maxHeight, noGrounding: !!options.noGrounding, aw, spray: calc.spray ? calc.spray.level : 0, pile: !!options.pile, sprayRate: calc.spray?.rate ?? 0, burn: options.burn || false, allowMissed: !!routeOptions.allowMissed });

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
    return list.slice(0, options.finishCount ?? 6).map(({ layout, rows, pads, blocks, streets }) => ({ layout, rows, pads, blocks, streets }));
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

  let finished = (yield { kind: 'finish', cands: pool(result), ctx: ctx() }).filter(Boolean);
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
    finished = (yield { kind: 'finish', cands: pool(result), ctx: ctx() }).filter(Boolean);
  }
  let pick = choose(finished);
  // 空间利用率没到目标：把面积的权重加倍再搜（用剩下的时间），最多 retries 轮，达标就停；各轮的候选放在一起挑。
  // 网页的搜索力度就是按这个分档：快 ≥50%、中 ≥70%、细 ≥85%（见 web/src/worker.js 的 EFFORT）
  const retries = options.adaptive === false ? 0 : options.retries ?? 1;
  let aw = routeOptions.areaWeight ?? 1;
  let rounds = 1;
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
    const again = yield { kind: 'search', graph, options: so };
    const more = (yield { kind: 'finish', cands: pool(again), ctx: ctx(aw) }).filter(Boolean);
    finished = [...finished, ...more];
    pick = choose(finished);
    rounds++;
    options.onRound?.({ round: rounds, space: pick.layout.space.space, feasible: !!pick.layout.feasible, target });
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
      const again = yield { kind: 'search', graph, options: o };
      const more = (yield { kind: 'finish', cands: pool(again), ctx: ctx(aw) }).filter(Boolean);
      finished = [...finished, ...more];
      pick = choose(finished);
      rounds++;
      options.onRound?.({ round: rounds, space: pick.layout.space.space, feasible: !!pick.layout.feasible, target });
      const now = { feasible: !!pick.layout.feasible, space: pick.layout.space.space };
      if ((now.feasible && !best.feasible) || (now.feasible === best.feasible && now.space >= best.space + 0.01)) {
        best = now;
        still = 0;
      } else still++;
    }
  }
  const rest = { ...result };
  delete rest.candidates; // 候选只在这里用，不往外带
  return { graph, ...rest, rows: pick.rows, pads: pick.pads, blocks: pick.blocks, streets: pick.streets, layout: pick.layout, station, stationFallback: fallback, targetSpace: target, targetMet: met(pick.layout), stalled, searchRounds: rounds, ms: Date.now() - t };
}

/**
 * 一份搜索任务（options 是发给帮手线程的那份：物流站已经折进 routeOptions）对应的后处理参数，和 planFrame 里的 ctx 一样。
 * 网页「就这个蓝图了」（用户 2026/10/07）用：拿实时预览正在画的那一轮的当前排法直接收尾、出图。
 */
export function finishContext(calc, options) {
  const ro = options.routeOptions || {};
  const station = ro.station ? { place: 'side', stack: ro.station.stack, slots: ro.station.slots } : ro.externalStack != null ? { place: 'edge', stack: ro.externalStack, slots: ro.stationSlots } : null;
  return { station, power: ro.power ?? null, powerOptions: ro.powerOptions, maxWidth: ro.maxWidth, maxHeight: ro.maxHeight, noGrounding: !!options.noGrounding, aw: ro.areaWeight ?? 1, spray: calc.spray ? calc.spray.level : 0, pile: !!options.pile, sprayRate: calc.spray?.rate ?? 0, burn: options.burn || false, allowMissed: !!ro.allowMissed };
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
      const parts = (await Promise.all(Array.from({ length: n }, (_, s) => pool.run({ kind: 'search', calc, options: opts, rounds: [s] })))).flat();
      res = mergeRounds(req.graph, req.options, parts);
    } else {
      res = await Promise.all(req.cands.map((cand) => pool.run({ kind: 'finish', cand, ctx: req.ctx })));
    }
    r = gen.next(res);
  }
  return r.value;
}
