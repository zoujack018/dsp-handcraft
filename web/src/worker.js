// 网页后台线程：计算 → 规划 → 出蓝图 → 独立检查。和命令行用的是同一套代码。
import { blueprintText, blueprintSize, spaceStats } from '../../src/metrics/space.js';
import { calculate } from '../../src/calc/calculator.js';
import { planLine, planLineAsync, planSteps } from '../../src/plan/index.js';
import { SORTER_SPEED } from '../../src/plan/sorters.js';
import { pileCapOf } from '../../src/plan/piling.js';
import { DEFAULTS as ROUTE_DEFAULTS } from '../../src/plan/route.js';
import { buildGraph } from '../../src/plan/graph.js';
import { powerDemand, powerText, fmtWatts, generatorsFor, IDLE_W, PILER_W, PILER_IDLE_W, COATER_W, COATER_IDLE_W, STATION_IDLE_W, STATION_CHARGE_W } from '../../src/metrics/energy.js';
import { runTask } from '../../src/plan/tasks.js';
import { validate } from '../../src/plan/validate.js';
import { emitBlueprint, stationSettings, chainTiles } from '../../src/emit/blueprint.js';
import { beltStats } from '../../src/plan/reroute.js';
import { checkBlueprint } from '../../src/emit/check.js';
import { ITEMS, RAW_ITEM_IDS, BELT_IDS, factory, hasHighLatitude, recipeChoices, defaultRecipe, addGameData, plannable, recipe as recipeOf } from '../../src/gamedata.js';
import { renderModel, groupLabels } from './model.js';
import { autoWatcher, previewShapeOk } from './autowatch.js';
import vanilla from '../../data/Vanilla.json' with { type: 'json' };
import { fractionatorArray, checkArray, arrayModel, arrayPlan } from '../../src/fractionate/array.js';
import { annealedArray, annealedEstimate } from '../../src/fractionate/anneal.js';
import { fromStr, toStr } from '../../src/codec/parser.js';

// 重氢的「分馏塔阵列」：不是普通配方（分馏塔不接分拣器、带子从塔里穿过），选了它就单独生成一张分馏阵列蓝图
const DEUTERIUM = 1121;
const FRAC_RECIPE = 115;
const FRAC_CHOICE = { id: FRAC_RECIPE, name: '重氢分馏（分馏塔阵列）', line: '氢 → 重氢，分馏塔阵列，单独一张蓝图' };
/** 选了分馏：从配方里拿掉（计算器不认分馏塔），重氢不是目标时当外部供应 */
function splitFraction(targets, raw, recipes) {
  const on = Number(recipes?.[DEUTERIUM]) === FRAC_RECIPE;
  if (!on) return { on, raw, recipes: recipes || {} };
  const rest = { ...recipes };
  delete rest[DEUTERIUM];
  const isGoal = targets.some((t) => Number(t.target) === DEUTERIUM);
  return { on, raw: isGoal || raw.includes('重氢') ? raw : [...raw, '重氢'], recipes: rest, isGoal };
}

// 搜索力度按空间利用率的目标分档：达到目标就停，没达到就把面积的权重加倍再搜，最多 retries 轮
// （用户 2026-10-04：快 >50%、中 >70%、细 >85%；2026/10/07 改成 50 / 66 / 80，85 太高了）。细档不设时间上限，一百多台工厂的产线要几分钟。
// 没达标（不可行或利用率不到这一档）就换种子接着搜，直到达标或到 untilTarget.maxMs（快 15 分钟、标准 60 分钟、细 200 分钟）。
// 上限只防极端的长尾，按大约 95% 的人碰不到来定（用户 2026/10/07）；到点还没达标就交出搜到的最好那张，页面照常显示，状态栏说明没到这一档
// 快档每轮 3000 步（2026/10/08，用户定）：云上和考卷都量过每轮步数是最管用的旋钮，1500 → 3000 不喷的 36 格面积少 4%~5%、利用率 +2 个百分点、
// 放大 3 倍那套全部可行，线程时间 1.4~1.6 倍；每轮上限跟着 10 → 20 秒，不然 Mac 上引力矩阵 30 一轮（约 12 秒）会被截掉
// 细档的 groundTax：高架落地加变层税，一段高架少在层之间来回变（src/plan/ground.js，分支 explore/bridges 的试验）
// 细档的 heightTax：搜索打分里线性超高税代替金字塔，第 5 层起另加（src/plan/layout/score.js，分支 explore/bridges 的试验）
// 细档的 bundleFee：开路费，高架竖直那截挑列时旁边没有别的竖直段就多计 8 格，带子挨着走成束（src/plan/layout/positions.js，分支 explore/bridges 的试验）
// 细档的 openFee：走空地费，高架竖直那截穿过的行里既不压着也不挨着建筑的，每行多计 2 格，带子贴着建筑走（src/plan/layout/positions.js，分支 explore/bridges 的试验）
// core：用哪个内核（src/plan/index.js 的 planCore；routeOptions.core 写明的为准），不写是主干内核。标准、美观档 'auto'：先排版内核，
// 第 2 段搜完还不可行换主干内核、从排版内核最好那张热启动（考卷 2 的数在 docs/history.md「内核分档」）；快速档不用：考卷 2 上面积不省、线程时间 1.4 倍。
// 美观档 autoSegments 4：排版内核搜满 4 段还不可行才换（考卷 3 的大线常在第 3、4 段才排出，换早了主干内核只排到五六成，2026/10/29）
// 美观档 aspectTarget 1.78（16:9）：排版内核的行宽瞄着 16:9 横的（src/plan/index.js 的 planFrame；设了宽、长上限时不瞄，长宽比上限比它小时按上限）。
// 用户 2026/10/28 要蓝图「长宽比最好符合电脑屏幕是横着的 16:9」；不瞄时大线上排版内核会挑 3 行、400 来格宽的长条，到后处理又排不成（考卷的数待补）
const EFFORT = {
  quick: { iterations: 3000, restarts: 2, timeLimit: 20000, targetSpace: 0.5, retries: 1, untilTarget: { maxMs: 15 * 60000 } },
  normal: { iterations: 3000, restarts: 4, timeLimit: 30000, targetSpace: 0.66, retries: 2, untilTarget: { maxMs: 60 * 60000 }, powerHoles: true, core: 'auto' },
  fine: { iterations: 8000, restarts: 6, timeLimit: null, targetSpace: 0.8, retries: 4, untilTarget: { maxMs: 200 * 60000 }, powerHoles: true, groundTax: true, core: 'auto', autoSegments: 4, aspectTarget: 1.78 },
};

// 别的网页带来的物品和配方（嵌在量产量化计算器里时，那边新出的物品随方案带过来，见 web/src/handoff.js 的 defs）。
// 帮手线程各有一份游戏数据，开的时候也发一份过去（makePool）
let defs = null;
const extraItems = []; // 加进来的物品，物品陈列里接在「物品」页最后一行后面
function takeDefs(d) {
  defs = d;
  extraItems.push(...addGameData(d).items);
}
const LAST_ROW = Math.max(...vanilla.items.filter((x) => Math.floor(x.GridIndex / 1000) === 1).map((x) => Math.floor((x.GridIndex % 1000) / 100)));

/**
 * 物品陈列：按游戏里的格位（GridIndex = 页×1000 + 行×100 + 列）列出全部物品，并标出状态：
 *   raw        原矿，始终从边缘供应
 *   ok         只用熔炉/制造台就能做（考虑已选的外部供应）
 *   partial    产线里有原油精炼厂等暂不支持的工厂，选中后会建议把它们设为外部供应
 *   self       它本身就要用原油精炼厂等暂不支持的工厂，不能作为目标
 *   none       没有单产物的常规配方（比如只能由精炼副产得到），只能当外部供应
 */
function catalog(raw = []) {
  const out = [];
  for (const it of ITEMS.values()) {
    const k = extraItems.indexOf(it.id);
    const gi = k >= 0 ? 1000 : vanilla.items.find((x) => x.ID === it.id)?.GridIndex ?? -1;
    if (gi < 1000) continue;
    let status;
    if (RAW_ITEM_IDS.has(it.id)) status = 'raw';
    else {
      if (!defaultRecipe(it.id)) status = 'none';
      else {
        try {
          const calc = calculate({ target: it.id, rate: 60, raw: raw.filter((n) => n !== it.name) });
          const self = calc.units.find((u) => u.itemId === it.id);
          status = self && !plannable(self.recipeId, self.factoryId) ? 'self' : calc.units.every((u) => plannable(u.recipeId, u.factoryId)) ? 'ok' : 'partial';
        } catch {
          status = 'partial';
        }
      }
    }
    out.push({
      id: it.id,
      name: it.name,
      page: Math.floor(gi / 1000),
      row: k >= 0 ? LAST_ROW + 1 + Math.floor(k / 14) : Math.floor((gi % 1000) / 100),
      col: k >= 0 ? 1 + (k % 14) : gi % 100,
      type: it.type,
      icon: vanilla.items.find((x) => x.ID === it.id)?.IconName ?? '',
      status,
    });
  }
  return out;
}

/** 依次把最靠近目标的「不支持的工厂」所产物品设为外部供应，直到整条线都能排；返回需要的外部供应列表 */
function minimalExternal(targets, base, recipes = {}) {
  const ext = [...base];
  const goalIds = new Set();
  for (let i = 0; i < 60; i++) {
    const c = calculate({ targets, raw: ext, recipes });
    c.targets.forEach((t) => goalIds.add(t.itemId));
    const bad = c.units.find((u) => !goalIds.has(u.itemId) && !plannable(u.recipeId, u.factoryId));
    if (!bad) return ext;
    ext.push(bad.item);
  }
  return ext;
}

/**
 * 目标产物的中间产物清单与依赖关系，供「外部供应」弹窗使用。
 *   goals：最终目标（第 0 层）。
 *   units：完整产线（不设外部供应）里除目标外的每种中间产物，带层级（离最近的目标最远几步）、所需工厂、
 *          当前是否仍在产线里（上游被设为外部供应后，它可能已经不需要了）、是否被设为外部供应。
 *          设成外部供应、可现在产线里已经没人用它（比如只有硫酸用精炼油，硫酸也设成了外部供应）的算 dropped：不画、不算进外部供应。
 *   edges：谁被谁消耗：from 物品 → to 物品（消费者），rate 为当前流量（不在产线里时为完整产线的流量），
 *          state = line（还在产线里）/ external（来源改为外部供应）/ dropped（消费者已不需要）/ raw（原料：原矿、黑雾掉落这类没有配方的）。
 *   raws：当前产线从外面进的原料（不含设成外部供应的中间产物），带物品编号、类别。
 *   byproducts：当前产线的副产物，ofId 是出它的那组工厂的产物。
 *   recipes：有新配方的物品，每个新配方带 ore（原料里的珍奇矿物，没有为 null）和 key（弹窗里给它配图标的物品）。
 *   suggested：让整条线可排的最少外部供应（基于当前选择补齐）。
 */
/** 配方写成一行：可燃冰×2 → 石墨烯×2 + 氢×1 */
const recipeLine = (r) => `${r.inputs.map((x) => `${ITEMS.get(x.id).name}×${x.count}`).join(' + ')} → ${r.outputs.map((x) => `${ITEMS.get(x.id).name}×${x.count}`).join(' + ')}`;

/**
 * 计算结果的配方组，外加「和主产物同一组工厂出、也供产线的」那几种（calculator.js 的 unit.shared：石墨烯、氢都选了石墨烯（高效）时只开一组）
 * 各当一种物品：编号、名字换成它的，outputRate 是这组出它多少，coOf 是主产物。弹窗里它们照常画卡、连到用它的物品
 */
const withShared = (calc) =>
  calc.units.flatMap((u) => [
    u,
    ...(u.shared ?? []).map((id) => ({ ...u, itemId: id, item: ITEMS.get(id).name, outputRate: calc.flows.filter((f) => f.itemId === id && f.from === u.id).reduce((a, f) => a + f.rate, 0), coOf: u.itemId })),
  ]);

function chain({ targets, raw: raw0 = [], recipes: recipes0 = {}, lab = 2901, labStack = 15 }) {
  const frac = splitFraction(targets, raw0, recipes0);
  const raw = frac.raw;
  const recipes = frac.recipes;
  const full = calculate({ targets, raw: [], recipes, lab: Number(lab), labStack: Number(labStack) });
  const cur = calculate({ targets, raw, recipes, lab: Number(lab), labStack: Number(labStack) });
  const goalIds = new Set(full.targets.map((t) => t.itemId));
  const curUnits = new Map(withShared(cur).map((u) => [u.itemId, u]));
  const curRaw = new Map(cur.raw.map((r) => [r.itemId, r.rate]));
  const unitByItem = new Map(withShared(full).map((u) => [u.itemId, u]));
  const itemOfUnit = (calc) => new Map(calc.units.map((u) => [u.id, u.itemId]));
  const fullOwner = itemOfUnit(full);
  const curOwner = itemOfUnit(cur);
  // 层级：目标为 0，它的输入为 1，以此类推，取最深（同一物品被不同层消耗时放在最下面那层）
  // 多个目标时单遍扫描不一定按拓扑序，反复松弛到不再变化（生产图无环，最多 units 轮）
  const depth = new Map([...goalIds].map((id) => [id, 0]));
  for (let round = 0, changed = true; changed && round <= full.units.length; round++) {
    changed = false;
    for (const fl of full.flows) {
      if (fl.to === 'OUT' || !unitByItem.has(fl.itemId) || goalIds.has(fl.itemId)) continue;
      const owner = fullOwner.get(fl.to);
      if (owner === fl.itemId) continue; // 自环：比如重整精炼用精炼油做精炼油
      const d = depth.get(owner);
      if (d == null) continue;
      if ((depth.get(fl.itemId) ?? -1) < d + 1) {
        depth.set(fl.itemId, d + 1);
        changed = true;
      }
    }
  }
  const describe = (u) => {
    const f = factory(u.factoryId);
    const now = curUnits.get(u.itemId);
    const external = raw.includes(u.item) && curRaw.has(u.itemId); // 设成外部供应、现在还有人用
    return {
      id: u.itemId,
      name: u.item,
      type: ITEMS.get(u.itemId).type,
      depth: goalIds.has(u.itemId) ? 0 : depth.get(u.itemId) ?? 1,
      factory: f.name,
      supported: plannable(u.recipeId, u.factoryId),
      count: now ? now.count : u.count,
      levels: (now ?? u).levels ?? null, // 研究站：count 是叠数，每叠几层
      rate: now ? now.outputRate : curRaw.get(u.itemId) ?? u.outputRate,
      state: external ? 'external' : now ? 'line' : 'dropped',
      co: (now ?? u).coOf ?? null, // 和哪种物品同一组工厂出（withShared）
    };
  };
  // 目标重氢选了分馏阵列：单独一张分馏阵列蓝图，只吃外面来的氢（1 个氢出 1 个重氢），完整产线里做氢的那些都不画
  const fracGoal = frac.on && frac.isGoal && targets.length === 1;
  const goals = full.targets.map((t) => ({ ...describe(unitByItem.get(t.itemId)), out: t.rate }));
  // 目标重氢选了分馏阵列：塔数、耗氢按分馏算（1 个氢分出 1 个重氢）
  if (frac.on && frac.isGoal) for (const g of goals) if (g.id === DEUTERIUM) Object.assign(g, { factory: '分馏塔', count: arrayPlan(g.out).towers });
  const units = fracGoal ? [] : withShared(full).filter((u) => !goalIds.has(u.itemId)).map(describe);
  // 依赖边：只连中间产物和目标之间（原矿不在弹窗里）
  const curRate = new Map();
  for (const fl of cur.flows) if (fl.to !== 'OUT') curRate.set(`${fl.itemId}>${curOwner.get(fl.to)}`, fl.rate);
  const edges = [];
  for (const fl of full.flows) {
    if (fl.to === 'OUT' || !unitByItem.has(fl.itemId)) continue;
    const to = fullOwner.get(fl.to);
    if (to === fl.itemId) continue;
    const key = `${fl.itemId}>${to}`;
    const live = curRate.get(key);
    const state = live != null ? (raw.includes(unitByItem.get(fl.itemId).item) ? 'external' : 'line') : 'dropped';
    if (!fracGoal) edges.push({ from: fl.itemId, to, rate: live ?? fl.rate, state });
  }
  // 原料（原矿、黑雾掉落、临界光子这类没有配方的）→ 当前产线里用它的产物，同一对合成一条
  const raws = fracGoal
    ? [{ itemId: 1120, item: ITEMS.get(1120).name, rate: Number(targets[0].rate) }]
    : cur.raw.filter((r) => !raw.includes(r.item));
  const rawIds = new Set(raws.map((r) => r.itemId));
  const rawEdges = new Map();
  if (fracGoal) rawEdges.set('1120>1121', { from: 1120, to: DEUTERIUM, rate: Number(targets[0].rate), state: 'raw' });
  else
    for (const fl of cur.flows) {
      if (fl.to === 'OUT' || fl.byproduct || !rawIds.has(fl.itemId)) continue;
      const to = curOwner.get(fl.to);
      const key = `${fl.itemId}>${to}`;
      if (rawEdges.has(key)) rawEdges.get(key).rate += fl.rate;
      else rawEdges.set(key, { from: fl.itemId, to, rate: fl.rate, state: 'raw' });
    }
  edges.push(...rawEdges.values());
  // 同一组工厂一起出的：主产物 → 这种物品，画成副产物那样的点线
  for (const u of withShared(cur)) if (u.coOf != null && !fracGoal) edges.push({ from: u.coOf, to: u.itemId, rate: u.outputRate, state: 'by' });
  return {
    title: full.targets.map((t) => `${t.name} ${t.rate}/分`).join(' + '),
    goals,
    units,
    edges,
    raws: raws.map((r) => ({ id: r.itemId, name: r.item, rate: r.rate, type: ITEMS.get(r.itemId).type })),
    blocking: fracGoal ? [] : cur.units.filter((u) => !goalIds.has(u.itemId) && !plannable(u.recipeId, u.factoryId)).map((u) => u.item),
    suggested: minimalExternal(targets, raw, recipes),
    // 有新配方的物品（目标和还在产线里的中间产物）：弹窗底部逐个开关
    recipes: [...full.targets.map((t) => t.itemId), ...withShared(full).map((u) => u.itemId)]
      .filter((id, i, a) => a.indexOf(id) === i && ((id === DEUTERIUM && frac.on) || (!fracGoal && !raw.includes(ITEMS.get(id).name) && (curUnits.has(id) || full.targets.some((t) => t.itemId === id)))))
      .map((id) => ({ id, name: ITEMS.get(id).name, choices: (id === DEUTERIUM ? [...recipeChoices(id), FRAC_CHOICE] : recipeChoices(id)).filter((r) => !UNLISTED_ALTS.has(r.id)) }))
      .filter((x) => x.choices.length > 1)
      .map((x) => ({
        id: x.id,
        name: x.name,
        def: { id: x.choices[0].id, name: x.choices[0].name, line: recipeLine(x.choices[0]) },
        alts: x.choices.slice(1).map((r) => ({ id: r.id, name: r.name, line: r.line ?? recipeLine(r), ...altKey(r, x.choices[0]) })),
        chosen: x.id === DEUTERIUM && frac.on ? FRAC_RECIPE : Number(recipes[x.id]) || null,
      })),
    // 几种物品选了同一道配方、合成一组时，用不完的那部分（calculator.js 的 flow.extra，跟着那条带送出）
    surplus: fracGoal ? [] : cur.flows.filter((f) => f.extra).map((f) => ({ id: f.itemId, name: ITEMS.get(f.itemId).name, rate: f.rate })),
    // 副产物：弹窗里画在出它的那组工厂下面，底部也说一句（单独一条带送出）
    byproducts: fracGoal ? [] : cur.byproducts.map((b) => ({ id: b.itemId, name: b.item, type: ITEMS.get(b.itemId).type, rate: b.rate, of: ITEMS.get(b.of).name, ofId: b.of })),
  };
}

// 弹窗里不列的新配方（用户 2026/10/27：不常用）：有机晶体（原始）。有机晶体在弹窗右栏当珍奇（有矿脉）直接设外部供应
const UNLISTED_ALTS = new Set([54]);
// 珍奇矿物（游戏里的稀有资源）：新配方那一栏按它们归拢，一种矿只列一次（用户 2026/10/27）
const RARE_ORES = new Set([1011, 1012, 1013, 1014, 1015, 1016]); // 可燃冰、金伯利矿石、分形硅石、光栅石、刺笋结晶、单极磁石
/**
 * 新配方的「关键原料」：ore 是原料里的珍奇矿物；key 是弹窗里给它配图标的物品——有珍奇就是珍奇，没有就是默认配方不用的第一种原料
 * （有机晶体（原始）的木材、空间翘曲器（高级）的引力矩阵），重氢分馏是分馏塔
 */
function altKey(r, def) {
  if (r.id === FRAC_RECIPE) return { ore: null, key: { id: 2314, name: ITEMS.get(2314).name } };
  const ore = r.inputs.find((x) => RARE_ORES.has(x.id));
  const key = ore ?? r.inputs.find((x) => !def.inputs.some((y) => y.id === x.id)) ?? r.inputs[0];
  const it = (x) => (x ? { id: x.id, name: ITEMS.get(x.id).name } : null);
  return { ore: it(ore), key: it(key) };
}


/** 箱子供货的各组（plan/storage.js）：在哪几行（排进行里的储物仓）或哪边哪一行（外面的储液罐、增产剂仓）、什么仓、几个、叠几层、装满够几分钟 */
function stores(graph, L) {
  const inRow = new Map();
  for (const p of L.pos.values()) {
    if (!p.g.store) continue;
    if (!inRow.has(p.g.id)) inRow.set(p.g.id, { g: p.g, ys: new Set() });
    inRow.get(p.g.id).ys.add(L.rowCy[p.row] + (L.origin?.y ?? 0));
  }
  const rows = [...inRow.values()].map(({ g, ys }) => ({
    kind: g.store.kind,
    item: g.item,
    rate: g.store.rate,
    what: g.factoryId === 2106 ? '储液罐' : g.factoryId === 2101 ? '小型储物仓' : '大型储物仓',
    count: g.count,
    layers: g.levels ?? 1,
    dist: g.store.dist,
    minutes: g.store.minutes,
    rows: [...ys].sort((a, b) => b - a),
    unit: L.rotated ? '列' : '行',
    y: Math.max(...ys),
  }));
  return rows.concat((L.stores || []).map((s) => {
    const left = s.side < 0;
    return {
      kind: s.kind,
      item: ITEMS.get(s.itemId)?.name ?? String(s.itemId),
      rate: s.rate,
      what: s.type === 2106 ? '储液罐' : s.type === 2101 ? '小型储物仓' : '大型储物仓',
      count: s.count,
      layers: s.layers,
      dist: s.dist,
      minutes: s.minutes,
      side: L.rotated ? (left ? '上' : '下') : left ? '左' : '右',
      unit: L.rotated ? '列' : '行',
      y: s.gate[1] + (L.origin?.y ?? 0),
      ...(s.inside ? { rows: [s.boxes[0][1] + (L.origin?.y ?? 0)] } : null), // 摆在蓝图里面的增产剂仓（plan/addons.js）：照行里的仓说第几行
    };
  }));
}

/** 原料入口与成品出口，告诉玩家从哪接 */
function ports(graph, L) {
  return L.ports.map((p) => {
    const left = p.x < L.width / 2;
    const at = p.y + (L.origin?.y ?? 0); // 「第几行」按蓝图里的坐标说，外沿加地后要平移
    return {
      kind: p.kind,
      item: graph.items.get(p.itemId)?.name ?? ITEMS.get(p.itemId)?.name ?? String(p.itemId),
      rate: p.rate,
      // 竖排的蓝图整张顺时针转了 90°：原来的左边成了上边、右边成了下边，第几行成了第几列
      side: L.rotated ? (left ? '上' : '下') : left ? '左' : '右',
      unit: L.rotated ? '列' : '行',
      x: p.x,
      y: at,
      store: p.store ?? null, // 接了储物仓 / 储液罐的（箱子供货），页面按 stores 写
    };
  });
}
/** 布局坐标（含外沿平移）→ 蓝图坐标：竖排时整张顺时针转了 90° */
const toBlueprint = (L, x, y) => (L.rotated ? { x: y, y: L.width - 1 - x } : { x, y });

// ---------- 多线程 ----------
// 这个线程是总调度；页面把打包好的脚本源码发过来（init），这里再开 threads 个帮手线程（同一份脚本），
// 搜索的各轮退火、各个候选的后处理分给它们并行。浏览器不让后台线程再开线程时，退回单线程。
let helperUrl = null;
let threads = 1;
let pool = null; // null 未建，false 不可用
function makePool() {
  if (pool !== null) return pool;
  pool = false;
  if (!helperUrl || threads < 2 || typeof Worker === 'undefined') return pool;
  try {
    const idle = [];
    const queue = [];
    const waiting = new Map();
    let seq = 0;
    const pump = () => {
      while (idle.length && queue.length) {
        const w = idle.pop();
        const job = queue.shift();
        waiting.set(job.id, job);
        w.postMessage({ type: 'task', id: job.id, task: job.task });
      }
    };
    const workers = Array.from({ length: threads }, () => {
      const w = new Worker(helperUrl);
      if (defs) w.postMessage({ type: 'defs', defs });
      w.onmessage = (ev) => {
        const { id, result, error, progress } = ev.data;
        const job = waiting.get(id);
        if (!job) return;
        if (progress) {
          // 搜索中途的快照（实时预览），不是任务完成：交给上层转发，活接着等
          pool.onProgress?.(job.task, progress);
          return;
        }
        waiting.delete(id);
        idle.push(w);
        pump();
        if (error) job.reject(new Error(error));
        else job.resolve(result);
      };
      w.onerror = (e) => {
        e.preventDefault?.();
        for (const job of waiting.values()) job.reject(new Error(e.message || '帮手线程出错'));
        waiting.clear();
      };
      idle.push(w);
      return w;
    });
    pool = {
      size: workers.length,
      run: (task) => new Promise((resolve, reject) => {
        queue.push({ id: ++seq, task, resolve, reject });
        pump();
      }),
      // 取消本轮生成：停掉所有帮手线程（正在跑的退火没法中途叫停，只能整个关掉），没做完的活都按出错退回；下次生成再新开
      stop: () => {
        for (const w of workers) w.terminate();
        for (const job of [...waiting.values(), ...queue.splice(0)]) job.reject(new Error('已停止'));
        waiting.clear();
        pool = null;
      },
    };
  } catch {
    pool = false;
  }
  return pool;
}
/** 帮手线程能不能用：发一个空活，3 秒内没回音就当不能用 */
async function poolReady() {
  const p = makePool();
  if (!p) return null;
  if (p.checked) return p.ok ? p : null;
  p.checked = true;
  p.ok = await Promise.race([p.run({ kind: 'ping' }).then(() => true, () => false), new Promise((r) => setTimeout(() => r(false), 3000))]);
  return p.ok ? p : null;
}

// ---------- 测速 ----------
// 页面打开、闲下来后测一次这台机器多快（页面发 { type: 'bench' }，每次打开页面一次，页面上不显示）：
// 每个帮手线程同时跑同一段固定的搜索（粒子容器 60/分、精炼油外部供应、页面默认设置、快档第一段的第 0 轮，只跑 BENCH_STEPS 步、不设时间上限），
// 在帮手线程里计时、取中位数；开搜前的预计（estimateSeconds）按它和参照机同一段测速的比折算。只计时，不碰任何规划结果
const BENCH_STEPS = 1000;
const BENCH_TARGET = 1206; // 粒子容器
let bench = null; // { ms, threads }：测速的中位毫秒、几个线程同时跑；没测或测失败为 null（按参照机估）
let benchTask = null; // 那份固定的搜索活，只建一次
let benchRunning = false;
let planning = 0; // 正在跑的规划份数：有就不测速

function makeBenchTask() {
  if (benchTask) return benchTask;
  const p = { assembler: '2303', smelter: '2302', chemical: '2309', chemwide: '0', lab: '2901', labstack: 15, belt: '3', sorter: '2013', power: 'tesla', station: '', spray: '0', aspect: '3', effort: 'quick', orient: 'h' };
  const targets = [{ target: BENCH_TARGET, rate: 60 }];
  const calc = calculate(lineInput(p, targets, splitFraction(targets, ['精炼油'], {})));
  // 和 planOne 给第一段搜索的设置一样（快档，每段 2 轮）
  const options = {
    ...EFFORT.quick,
    restarts: 2,
    routeOptions: { belt: 3, sorter: 2013, maxAspect: 3, maxWidth: null, maxHeight: null },
    station: null,
    power: 'tesla',
    burn: false,
    supply: null,
    storeLayers: 15,
    orient: 'h',
  };
  delete options.untilTarget;
  delete options.core; // 测速一直量主干内核（TIME_MODEL.ref 按它定的），档位的内核改了也不跟着变
  const req = planSteps(calc, options).next().value;
  benchTask = { kind: 'bench', calc, options: { ...req.options, iterations: BENCH_STEPS, timeLimit: null } };
  return benchTask;
}

/** 跑一遍测速的搜索（帮手线程里，或单线程回退时就地），返回毫秒 */
function timeBench(task) {
  const t0 = performance.now();
  runTask({ kind: 'search', calc: task.calc, options: task.options, rounds: [0] });
  return performance.now() - t0;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

async function runBench() {
  if (bench || benchRunning || planning) return; // 有规划在跑就不测
  benchRunning = true;
  try {
    const task = makeBenchTask();
    const helpers = await poolReady();
    if (planning) return; // 等帮手线程回话的工夫开始了规划：不往它前面插活，这次不测
    let ms;
    let n;
    if (helpers) {
      n = helpers.size;
      ms = median(await Promise.all(Array.from({ length: n }, () => helpers.run(task))));
    } else {
      n = 1;
      ms = timeBench(task);
    }
    if (!(ms > 0)) return;
    bench = { ms, threads: n };
    self.postMessage({ type: 'bench', ms, threads: n });
  } catch {
    bench = null; // 测速出错：照旧按参照机估
  } finally {
    benchRunning = false;
  }
}

/**
 * 开搜前的预计用时（秒），页面「预计约 X 秒」就是它（跑约一秒后进度条改用 previewer 的实测 liveEst，预计那个数不改）。
 * 2026/10/19 在 Mac mini（M6，8 线程）上按「打开页面先测速、再点生成」实跑快、标准、细三档，27 条线（300 座建筑以内）× 各种选项 618 份量出来：
 *   每段（一遍搜索 + 后处理）秒数 = 乘幂模型（组数、台数、物品种类，再加选项的倍数），乘每线程要跑几波；
 *   段数按开搜前的瓶颈规则（bottleneck：分拣器或带子运力不够、组数多）取每类的中位；
 *   别的机器按页面打开时的测速（runBench）和参照机同一段测速的比折算。
 * 整条线留一：每段误差中位 13%、80% 分位 23%；总用时中位 19%、80% 分位 45%（没瓶颈的 17%、36%；有瓶颈的多半要搜十几段，偶尔一段就完，会估长）。
 */
const TIME_MODEL = {
  ref: { benchMs: 294, threads: 8 }, // 参照机（Mac mini M6，8 线程）上同一段测速的中位毫秒
  seg: [-4.209, 0.318, 0.454, 0.471], // log 每段秒数 = c0 + a·log 组数 + b·log 台数 + d·log 物品种类（参照机 8 线程、1 波）
  opt: { edge: 0.312, side: 0.814, spray: 0.24, normal: -0.034, fine: 0.689, belt1: 0.077, sorter2011: 0.062 }, // 选项的 log 倍数
  segs: { quick: { ok: 1, flag: 14 }, normal: { ok: 1, flag: 18 }, fine: { ok: 1, flag: 19 } }, // 段数（没瓶颈 / 有瓶颈），每类的中位
};
const BELT_CAP = { 1: 360, 2: 720, 3: 1800 }; // 每条带每分钟运多少（不叠）
const FINISH_SHARE = 0.02; // 每段里算给后处理的份额（previewer 的 liveEst 要加上它）

/**
 * 开搜前的瓶颈：某组每台的进料或出料超过一根 1 格分拣器速度的八成（快档 536 份里判没瓶颈的 425 份只有 2 份卡住，按 1 倍判漏 16 份）、某条带的流量超过运力 1.5 倍、或者组数很多。
 * 有瓶颈的线往往一段搜不达标，要多搜好几段
 */
function bottleneck(graph, p) {
  const speed = (SORTER_SPEED[Number(p.sorter)] ?? SORTER_SPEED[2013])[1];
  const cap0 = BELT_CAP[Number(p.belt)] ?? BELT_CAP[3];
  let sorterLoad = 0;
  let beltLoad = 0;
  for (const it of graph.items.values()) {
    // 物流站出的原料能叠；产物带默认过自动集装机（route.js 的 pilers），运力和规划器排的一样（plan/piling.js 的 pileCapOf，
    // route.js 的 pileModel 不写时按 4 条带算；最低配置不放集装机，earlyGame）
    const cap = it.producer === 'RAW' ? (p.station ? cap0 * Number(p.pile || 1) : cap0) : earlyGame(p) ? cap0 : Math.max(cap0, pileCapOf(cap0, ROUTE_DEFAULTS.pileModel));
    const toGroup = new Map();
    for (const c of it.consumers) {
      beltLoad = Math.max(beltLoad, c.rate / cap);
      if (graph.byId.has(c.to)) toGroup.set(c.to, (toGroup.get(c.to) ?? 0) + c.rate);
    }
    for (const [to, rate] of toGroup) sorterLoad = Math.max(sorterLoad, rate / graph.byId.get(to).count / speed);
  }
  for (const g of graph.groups) {
    for (const o of g.outputs) {
      sorterLoad = Math.max(sorterLoad, o.perFactory / speed);
      beltLoad = Math.max(beltLoad, (o.perFactory * g.count) / cap0);
    }
  }
  return sorterLoad > 0.8 || beltLoad > 1.5 || graph.groups.length >= 36;
}

/** 返回每段的搜索、后处理秒数和期望段数 segs；总数 =（search + finish）× segs */
function estimateSeconds(calc, effort, p, threads) {
  const name = Object.keys(EFFORT).find((k) => EFFORT[k] === effort) ?? 'normal';
  let graph = null;
  try {
    graph = buildGraph(calc);
  } catch {
    graph = null; // 有还不支持的工厂：让规划那边照常报错、建议外部供应，这里不抢着抛
  }
  const groups = calc.units.length;
  const machines = calc.units.reduce((n, u) => n + u.count, 0); // 研究站一叠算一台
  const items = graph ? graph.items.size : new Set(calc.flows.map((f) => `${f.itemId}:${!!f.byproduct}`)).size;
  const [c0, a, b, d] = TIME_MODEL.seg;
  const o = TIME_MODEL.opt;
  const station = p.station ? (p.station === 'ils-side' ? 'side' : 'edge') : null; // 'ils' 放进空地，'ils-side' 靠左侧站列
  const opt =
    (station === 'edge' ? o.edge : 0) +
    (station === 'side' ? o.side : 0) +
    (Number(p.spray || 0) > 0 ? o.spray : 0) +
    (name === 'normal' ? o.normal : 0) +
    (name === 'fine' ? o.fine : 0) +
    (Number(p.belt) === 1 ? o.belt1 : 0) +
    (Number(p.sorter) === 2011 ? o.sorter2011 : 0);
  const devFactor = bench ? bench.ms / TIME_MODEL.ref.benchMs : 1;
  const waves = Math.ceil(effort.restarts / Math.max(1, threads)); // 单线程（threads 1）时各轮一轮接一轮跑
  const segSec = Math.exp(c0 + a * Math.log(groups) + b * Math.log(machines) + d * Math.log(items) + opt) * devFactor * waves;
  let search = segSec * (1 - FINISH_SHARE);
  let finish = segSec * FINISH_SHARE;
  if (effort.timeLimit) search = Math.min(search, effort.timeLimit / 1000);
  const segs = TIME_MODEL.segs[name][(graph ? bottleneck(graph, p) : groups >= 36) ? 'flag' : 'ok'];
  // 总数不超过没达标接着搜的总时限
  const maxSec = effort.untilTarget?.maxMs ? effort.untilTarget.maxMs / 1000 : Infinity;
  const k = Math.min(1, maxSec / ((search + finish) * segs));
  return { search: search * k, finish: finish * k, segs };
}
/**
 * 给帮手线程池包一层，数搜索的轮数和后处理的候选数，报给页面（type: 'progress'）。
 * 利用率不到目标、加重面积再搜时搜索的总轮数会变多，估算跟着加一段
 */
function tracked(helpers, id, est, restarts, preview = null) {
  const n = { search: [0, 0], finish: [0, 0] };
  const post = () => {
    const phases = Math.max(1, Math.ceil(n.search[1] / Math.max(1, restarts)));
    // 实测估时（previewer 跑约一秒后算出）比开搜前的公式准，有就用它；公式按期望段数估，实际搜的段数多了就按实际的
    const live = preview?.liveEst;
    self.postMessage({ type: 'progress', id, est: live ?? (est.search + est.finish) * Math.max(est.segs ?? 1, phases), live: live != null, maxMs: preview?.maxMs ?? null, search: n.search, finish: n.finish });
  };
  post();
  if (!helpers) return null;
  return {
    size: helpers.size,
    run: (task) => {
      const k = n[task.kind];
      if (!k) return helpers.run(task);
      k[1]++;
      // 给搜索任务标上第几段（没达标接着搜时一段一段来），快照带着它回来，预览好不认上一段的旧账
      if (task.kind === 'search') task.gen = Math.max(1, Math.ceil(k[1] / Math.max(1, restarts)));
      post();
      return helpers.run(task).then((r) => {
        k[0]++;
        post();
        return r;
      });
    },
  };
}

/**
 * 实时预览（观摩退火）+ 实测估时，同一条快照通道两用。
 * 帮手线程每半秒把「这一轮搜到第几步」连同温度、代价报上来（见 onmessage 的 task 分支），这里：
 *   1）数字全转发给页面（type 'preview'）；绘图模型只转发页面正在看的那一轮——自动模式看利用率最高的那一轮，
 *      但不频繁切换（autowatch.js：别的轮连续领先够久才切，两次切换有间隔下限）；页面发 { type: 'watch', round } 指定看第几轮（'auto' 传 null）；
 *   2）跑满约一秒后用实测速度估剩余时间（剩余步数 ÷ 速度，几轮并行取最慢的那轮），自动适应不同 CPU、
 *      线程数和浏览器；第一秒之前页面沿用 estimateSeconds 的公式。
 * 没达标接着搜（untilTarget）时每段搜索是新一段（gen），上一段的快照不再理会。
 */
function previewer(id, est, restarts, threads, maxMs) {
  const t0 = Date.now();
  const rounds = new Map(); // 这一段里每轮的进度：{ first, i0, t, i, iterations, best, space, timeLimit }
  let gen = 1;
  const ctl = { id, watch: 'auto', liveEst: null, maxMs, lastSent: 0, forceNext: false };
  const autoPick = autoWatcher();
  const estimate = (now) => {
    let slowest = 0;
    let n = 0;
    let avg = 0;
    for (const r of rounds.values()) {
      if (now - r.t > 2500) continue; // 已经搜完的轮不算
      if (r.t - r.first < 900 || r.i <= r.i0) continue; // 跑满约一秒才有实测速度
      const v = ((r.i - r.i0) * 1000) / (r.t - r.first); // 步/秒
      let left = (r.iterations - r.i) / v;
      if (r.timeLimit) left = Math.min(left, Math.max(0, r.timeLimit - (now - r.first)) / 1000); // 有时间上限的轮到点收手
      slowest = Math.max(slowest, left);
      n++;
      avg += r.iterations / v;
    }
    if (!n) return;
    // 轮数多于线程时还有没开跑的轮，按实测的平均每轮时长补上
    const waves = Math.ceil(Math.max(0, restarts - rounds.size) / Math.max(1, threads));
    ctl.liveEst = (now - t0) / 1000 + slowest + waves * (avg / n) + est.finish;
    self.postMessage({ type: 'progress', id, est: ctl.liveEst, live: true, maxMs });
  };
  /** 收一份快照。task 是线程池里那份活（带 gen、options）；单线程回退时传 { gen: 1, options } */
  ctl.take = (task, p) => {
    if (task.kind && task.kind !== 'search') return;
    const g = task.gen ?? 1;
    const now0 = Date.now();
    if (g > gen) {
      gen = g;
      rounds.clear();
      autoPick.newSegment(now0);
      ctl.liveEst = null;
    } else if (g < gen) return;
    const now = Date.now();
    let r = rounds.get(p.s);
    if (!r) rounds.set(p.s, (r = { first: now, i0: p.i, timeLimit: task.options?.timeLimit ?? null }));
    Object.assign(r, { t: now, i: p.i, iterations: p.iterations, best: p.best, space: p.space });
    // 自动模式每份快照都过一遍（挑战者连续领先多久要按时间记），不只在带图的那份
    const auto = autoPick(rounds, now);
    let model = p.model;
    if (model) {
      const sel = ctl.watch === 'auto' ? auto : ctl.watch;
      // 页面只画正在看的那一轮，其余轮只发数字；图每 PREVIEW_EVERY 才换一张（用户 2026/10/07：别频繁更新），
      // 页面上点了别的轮马上给一张；长宽比离谱、超出宽长上限的排法不给（autowatch.js 的 previewShapeOk）
      if (sel !== p.s || (!ctl.forceNext && now - ctl.lastSent < PREVIEW_EVERY) || !previewShapeOk(model, task.options?.routeOptions)) model = null;
      else {
        ctl.lastSent = now;
        ctl.forceNext = false;
      }
    }
    self.postMessage({ type: 'preview', id, gen: g, round: p.s, i: p.i, iterations: p.iterations, T: p.T, cost: p.cost, best: p.best, feasible: p.feasible, model });
    estimate(now);
  };
  return ctl;
}
let curPreview = null; // 正在跑的那份规划的实时预览（页面的 watch 消息找它）
let activeId = 0;
const cancelled = new Set(); // 页面取消了的请求（取消本轮生成）：搜索那边后来再出结果就不发了
const PREVIEW_EVERY = 25000; // 预览的图多久换一张

/**
 * 全部选最低配置（用户 2026/10/28）：不放供电或电力感应塔、传送带或传送带 + 箱子（不接物流站）、普通传送带、电弧熔炉、制造台 Mk.I、不喷增产剂。
 * 当作还没解锁「超级磁场发生器」：高架不用原地竖直升降（route.js 的 noLift），检查按没解锁的存档查（check.js 的 noTech）；
 * 自动集装机多半也没解锁：带上不叠（route.js 的 pilers）
 */
const earlyGame = (p) => !p.station && (!p.power || p.power === 'tesla') && String(p.belt) === '1' && String(p.smelter) === '2302' && String(p.assembler) === '2303' && !Number(p.spray || 0);
/** 页面的「箱子」+「物流配送器」→ plan/storage.js 的 SUPPLY 键：side-s / side-l 是左侧一列仓组（2026/10/26），放配送器就是 sdist-s / sdist-l；以前的 box-s / box-l 照旧认 */
const supplyOf = (p) => (!p.station && p.supply ? (p.dist === '1' ? p.supply.replace(/^box/, 'dist').replace(/^side/, 'sdist') : p.supply) : null);
/** 页面参数 → calculate() 的参数。chemwide：左栏「化工厂、精炼厂高纬度间距展开」，默认化工厂、量子化工厂、原油精炼厂按赤道的紧凑间距排（只在赤道附近放得下），开了才加宽（任何纬度都能放） */
function lineInput(p, targets, frac) {
  // 供货（不接物流站时）：原料、成品换成排进行里的储物仓（plan/storage.js 的 storeUnits），液体照旧在外面接储液罐
  const supply = supplyOf(p);
  const store = supply ? { supply, storeSorter: Number(p.sorter), storeLayers: Number(p.labstack || 15), storeBelt: Number(p.belt || 3), burn: Array.isArray(p.burn) && p.burn.length ? p.burn.map(Number) : false } : null;
  return { targets, assembler: Number(p.assembler), smelter: Number(p.smelter), chemical: Number(p.chemical || 2309), lab: Number(p.lab || 2901), labStack: Number(p.labstack || 15), raw: frac.raw, recipes: frac.recipes, spray: Number(p.spray || 0), latitude: p.chemwide === '1' ? 'high' : 'equator', ...store };
}

async function run(p, id = 0) {
  const targets = (p.targets || [{ target: p.target, rate: p.rate }]).map((t) => ({ target: Number(t.target), rate: Number(t.rate) }));
  const frac = splitFraction(targets, (p.raw || []).filter(Boolean), p.recipes || {});
  if (frac.on && frac.isGoal) {
    if (targets.length > 1) return { error: '重氢选了分馏塔阵列时，目标只能是重氢一种（分馏阵列单独一张蓝图）。可以把别的目标另外生成，重氢设为外部供应。' };
    return fractionRun(targets[0].rate, Number(p.spray || 0), arrayLimits(p), p.stationPrefs, p.fracengine === 'anneal' ? EFFORT_ARRAY[p.effort === 'fine' ? 'fine' : 'normal'] : null);
  }
  const input = lineInput(p, targets, frac);
  const pool = await poolReady();
  if (cancelled.has(id)) return { error: '已取消本轮生成。' }; // 等帮手线程回话的工夫页面已经取消了：不开搜（不然白占着帮手线程，下一次生成要排在它后面）
  const effort = EFFORT[p.effort || 'normal'];
  // 各轮退火分给各线程：轮数补成线程数的整数倍，墙上时间不变，搜得更广（4 线程时细档 6 轮补成 8 轮）
  const restarts = pool ? Math.ceil(effort.restarts / pool.size) * pool.size : effort.restarts;
  // 网页不切块（用户 2026/10/27 去掉了「自动切分」）：大产线切块只在命令行、考卷里（src/plan/modules.js）
  const est = estimateSeconds(calculate(input), effort, p, pool ? pool.size : 1);
  activeId = id;
  // 实时预览 + 实测估时
  const preview = previewer(id, est, restarts, pool ? pool.size : 1, effort.untilTarget?.maxMs ?? null);
  curPreview = preview;
  if (pool && preview) pool.onProgress = (task, snap) => preview.take(task, snap);
  const helpers = tracked(pool, id, est, restarts, preview);
  // 每搜完一轮（含没达标接着搜的）报一次：第几轮、目前最好的利用率、可不可行
  const onRound = (r) => self.postMessage({ type: 'progress', id, round: r.round, best: r.space, feasible: r.feasible, target: r.target });
  return planOne(calculate(input), p, helpers, effort, restarts, onRound, preview);
}

/**
 * 生成前的预告（用户 2026/10/26：选完目标、改了选项就看到，写在「生成蓝图」下面），参数和 run() 一样：
 *   machines、byFactory：建筑几台、按工厂分（研究站按实际台数，叠起来的每层都是一台）；
 *   seconds：预计用时，同开搜前的 estimateSeconds（帮手线程还没开时照 makePool 的条件猜几个）；分馏塔阵列不用搜，为 0；
 *   power：工厂满负荷用电（还没排，分拣器、喷涂机、物流站不算）；
 *   chainItems：不设外部供应时这条线用到的物品（目标、中间产物、原料），页面左栏只列当前产线用得上的外部供应、新配方；算不出来为 null
 *   supplied：按现在的外部供应，产线从外面要的物品名（设了外部供应、可现在没人用的不在里面，左栏不列）；算不出来为 null
 */
function forecast(p) {
  const targets = (p.targets || [{ target: p.target, rate: p.rate }]).map((t) => ({ target: Number(t.target), rate: Number(t.rate) }));
  const frac = splitFraction(targets, (p.raw || []).filter(Boolean), p.recipes || {});
  let chainItems = null;
  let supplied = null;
  try {
    // 产线里有哪些物品和产量无关：产量还没填好时按 60 算
    const input = { targets: targets.map((t) => ({ ...t, rate: t.rate > 0 ? t.rate : 60 })), recipes: frac.recipes, lab: Number(p.lab || 2901), labStack: Number(p.labstack || 15) };
    const c = calculate({ ...input, raw: [] });
    chainItems = [...new Set([...c.targets.map((t) => t.itemId), ...withShared(c).map((u) => u.itemId), ...c.raw.map((r) => r.itemId)])];
    supplied = frac.on && frac.isGoal ? ['氢'] : calculate({ ...input, raw: frac.raw }).raw.map((r) => r.item);
  } catch {
    chainItems = null;
  }
  try {
    if (!targets.every((t) => t.rate > 0)) return { error: '每分钟产量需要是正数。', chainItems, supplied };
    if (frac.on && frac.isGoal) {
      if (targets.length > 1) return { error: '重氢选了分馏塔阵列时，目标只能是重氢一种。', chainItems, supplied };
      // 分馏塔阵列：照 fractionRun 生成一遍数塔（几毫秒）；一座站带不动时这张图要贴几份，塔数、用电都乘上
      // 退火排法（新）：不在预告里退火，按稳态够数要几座塔、几台集装机和喷涂机估（annealedEstimate）
      const r = p.fracengine === 'anneal' ? annealedEstimate(targets[0].rate, { spray: Number(p.spray || 0) }) : fractionatorArray(targets[0].rate, { spray: Number(p.spray || 0), ...arrayLimits(p) });
      const k = r.plan.copies;
      const e = fracEnergy(r);
      return { machines: r.fracs * k, byFactory: [{ name: '分馏塔', count: r.fracs * k }], seconds: 0, power: forecastPower(e.idle * k, e.work * k, e.sprayExtra * k), chainItems: [DEUTERIUM], supplied };
    }
    const calc = calculate(lineInput(p, targets, frac));
    const by = new Map();
    for (const u of calc.units) by.set(u.factory, (by.get(u.factory) ?? 0) + (u.labs ?? u.count));
    const est = estimateSeconds(calc, EFFORT[p.effort || 'normal'], p, helperCount());
    const e = powerDemand(calc, { sorters: 0 }, { sorter: Number(p.sorter) });
    return {
      machines: [...by.values()].reduce((n, x) => n + x, 0),
      byFactory: [...by].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
      seconds: (est.search + est.finish) * est.segs,
      power: forecastPower(e.idle, e.work, e.sprayExtra),
      chainItems,
      supplied,
    };
  } catch (e) {
    return { error: e.message, chainItems, supplied };
  }
}
const forecastPower = (idle, work, sprayExtra) => ({ idle, work, sprayExtra, idleText: fmtWatts(idle), workText: fmtWatts(work), maxText: fmtWatts(work + sprayExtra) });
/** 生成时会有几个帮手线程（预告估时用）：线程池还没开时照 makePool 的条件猜，开不了、没回音就是单线程 */
const helperCount = () => (pool ? (pool.checked && !pool.ok ? 1 : pool.size) : pool === false || !helperUrl || threads < 2 || typeof Worker === 'undefined' ? 1 : threads);

/** 再点一次「生成蓝图」时种子每次加多少：取个大质数，和规划器里各处的种子偏移（每轮 1013、没进展 7919、重排 4099、切块 1000）错开 */
const AGAIN_SEED = 1000003;

/** 排一张：搜索、出蓝图、检查，整理成页面要的结果 */
async function planOne(calc, p, helpers, effort, restarts, onRound = null, preview = null) {
  let plan;
  let options;
  let once;
  try {
    options = {
      ...effort,
      restarts,
      routeOptions: {
        belt: Number(p.belt),
        sorter: Number(p.sorter),
        maxAspect: p.aspect ? Number(p.aspect) : null,
        maxWidth: p.maxwidth ? Number(p.maxwidth) : null,
        maxHeight: p.maxheight ? Number(p.maxheight) : null,
        ...(p.core ? { core: p.core } : {}), // 内核 master / typeset / auto（src/plan/index.js 的 planCore），页面上没有开关；不写按档位（EFFORT 的 core）
        // 传送带重走（src/plan/reroute.js）：各档都开，只重走挑中的那张、哪一项都不比原来差才换上（用户 2026/10/29 要在网页上审）
        reroute: true,
        ...(earlyGame(p) ? { noLift: true, pilers: false } : {}), // 全部选最低配置：当作没解锁超级磁场、自动集装机
      },
      station: p.station ? { place: p.station === 'ils-side' ? 'side' : 'edge', stack: Number(p.pile || 1), slots: { warper: p.warper === '1', keepFree: p.proslot !== '0' && Number(p.spray || 0) > 0 } } : null,
      power: p.power || null,
      burn: Array.isArray(p.burn) && p.burn.length ? p.burn.map(Number) : false, // 要就地烧掉的副产物（plan/burn.js；网页上的开关 2026/10/26 拿掉了，页面不再传）
      // 供货：不接物流站时原料、成品接储物仓 / 储液罐（plan/storage.js 的 SUPPLY）；左栏「物流配送器」选了放在仓顶就是 dist-s / dist-l
      supply: supplyOf(p),
      storeLayers: Number(p.labstack || 15), // 储物仓最多叠几层：按「研究站最多叠几层」（推断同一个「垂直建造」科技管）
      orient: p.orient || 'h',
      onRound,
      // 同样的输入再点一次「生成蓝图」换一个种子（app.js 记这是第几次，用户 2026/10/24）；第一次用规划器默认的种子，和命令行、考卷一样
      ...(p.again > 0 ? { seed: 7 + AGAIN_SEED * p.again } : {}),
    };
    if (preview) {
      options.snapshotMs = 500; // 实时预览：每半秒报一次步数（实测估时用），绘图模型最多一秒一份
      if (!helpers) {
        // 单线程回退：就地装快照钩子（多线程时帮手线程自己装，见 onmessage 的 task 分支）
        const st = { last: 0, bestRef: null, space: null };
        options.onSnapshot = (snap) => preview.take({ gen: 1, options }, snapshotPayload(snap, st));
      }
    }
    once = async (o) => {
      try {
        return helpers ? await planLineAsync(calc, o, helpers) : planLine(calc, o);
      } catch (e) {
        if (!helpers || e.item || cancelled.has(activeId)) throw e; // 取消本轮生成停掉的：不再重来
        return planLine(calc, o); // 帮手线程中途出错：单线程重来
      }
    };
    plan = await once(options);
  } catch (e) {
    return { error: e.message, suggestRaw: e.item ?? null };
  }
  // 规划器觉得达标了、出蓝图后检查却没过，总时限内换种子重排（最多 3 次），留过了的那张
  if (effort.untilTarget) {
    const blueprintOk = (pl) => {
      const r = emitBlueprint(pl.graph, pl.layout, { belt: Number(p.belt), sorter: Number(p.sorter) });
      return !r.issues.length && checkBlueprint(r.str, { noTech: earlyGame(p) }).ok;
    };
    const stopAt = Date.now() + effort.untilTarget.maxMs - (plan.ms ?? 0);
    for (let k = 1; k <= 3 && plan.targetMet && !blueprintOk(plan) && stopAt - Date.now() > 5000; k++) {
      try {
        // 重排只能用总时限剩下的时间（不然每次重排又领一份完整的时限）
        const again = await once({ ...options, seed: (options.seed ?? 7) + 4099 * k, untilTarget: { maxMs: Math.max(0, stopAt - Date.now()) } });
        if (again.targetMet) plan = { ...again, ms: (plan.ms ?? 0) + (again.ms ?? 0) };
      } catch {
        break;
      }
    }
  }
  return describePlan(plan, calc, p, effort, helpers ? helpers.size : 1);
}

/**
 * 蓝图里各座物流站的设置（页面点站看简介、在简介里改，用户 2026/10/27）：存储格（物品、本地 / 星际 0 仓储 1 供应 2 需求、上限）、
 * 12 个站口（dir 1 出站 2 进站、接第几格）、出货叠几层；顺序和图上 T1、T2… 一样（出蓝图时按 layout.stations 的顺序放）
 */
const isStation = (b) => b.itemId === 2104 || b.itemId === 2103;
function stationCfg(str) {
  try {
    return fromStr(str).buildings.filter(isStation).map((b) => ({
      type: b.itemId,
      storage: b.parameters.storage.map((x) => ({ itemId: x.itemId, localRole: x.localRole, remoteRole: x.remoteRole, max: x.max })),
      slots: b.parameters.slots.map((x) => ({ dir: x.dir, storageIdx: x.storageIdx })),
      pilerCount: b.parameters.pilerCount,
      set: stationSettings(b.parameters), // 整站设置：充能功率、路程、起送量…
    }));
  } catch {
    return [];
  }
}
/** 分馏阵列自带的站（照用户的图，不经 emitBlueprint）：翘曲器格、增产剂格也按存过的设置改 */
function withPrefs(str, prefs) {
  if (!prefs?.warper && !prefs?.spray && !prefs?.station) return str;
  const bp = fromStr(str);
  for (const st of bp.buildings.filter(isStation))
    for (const x of Object.assign(st.parameters, stationSettings(prefs.station)).storage) {
      const k = x.itemId === 1210 ? 'warper' : [1141, 1142, 1143].includes(x.itemId) && (x.localRole === 2 || x.remoteRole === 2) ? 'spray' : null;
      if (k && prefs[k]) Object.assign(x, prefs[k]);
    }
  return toStr(bp);
}
/** 在简介里改了第 k 座站的存储格（storage[i] 为空的那格不动）、整站设置（set，整张图的站都改）：改这张蓝图里的参数，重出字符串 */
function patchStation({ str, k, storage = [], set = null }) {
  const bp = fromStr(str);
  const all = bp.buildings.filter(isStation);
  const st = all[k];
  if (!st) throw new Error('找不到这座物流站');
  if (set) for (const b of all) Object.assign(b.parameters, stationSettings(set));
  storage.forEach((x, i) => {
    if (!x || !st.parameters.storage[i]?.itemId) return;
    Object.assign(st.parameters.storage[i], { localRole: x.localRole, remoteRole: x.remoteRole, max: x.max });
  });
  const out = toStr(bp);
  return { blueprint: out, stationCfg: stationCfg(out) };
}

/**
 * 陡坡的步数：相邻两节不在同一格、一格升降超过半层（要超级磁场，docs/game-rules.md 第 34、38 条）。
 * 带子和 beltStats（src/plan/reroute.js）一样：每条链的主链和劈开的那半、翘曲器带、增产剂带
 */
function steepSteps(L) {
  const runs = [];
  for (const ch of L.chains) {
    const t = chainTiles(L, ch);
    runs.push(t.main, ...t.extra);
  }
  for (const w of L.warperLinks || []) runs.push(w.cells);
  for (const pl of L.proLines || []) runs.push(pl.cells);
  let n = 0;
  for (const t of runs)
    for (let k = 1; k < t.length; k++) {
      const [a, b] = [t[k - 1], t[k]];
      if ((a[0] !== b[0] || a[1] !== b[1]) && Math.abs((b[2] ?? 0) - (a[2] ?? 0)) > 0.5 + 1e-6) n++;
    }
  return n;
}

/** 规划结果 → 页面要的结果：出蓝图、独立检查、各种数字和说明 */
function describePlan(plan, calc, p, effort, threadCount) {
  const L = plan.layout;
  const v = validate(plan.graph, L);
  const text = blueprintText(L, calc.label);
  const { str, issues } = emitBlueprint(plan.graph, L, { belt: Number(p.belt), sorter: Number(p.sorter), ...text, targetId: calc.targetId, icons: calc.targets.map((t) => t.itemId), stationPrefs: p.stationPrefs });
  const check = checkBlueprint(str, { noTech: earlyGame(p) }); // 最低配置按没解锁超级磁场的存档查（原地竖直升降、太陡的坡都报错）
  const labels = groupLabels(plan.graph.groups); // 图例的字母和图上一样（熔炉用小写字母）
  const bs = beltStats(L); // 带子量，和重走守门同一个口径（src/plan/reroute.js）
  return {
    target: calc.target,
    rate: calc.rate,
    title: calc.targets.map((t) => `${t.name} ${t.rate}/分`).join(' + '),
    ms: plan.ms,
    threads: threadCount,
    // 达没达标和页面上的「检查通过」同一个标准：可行、独立检查和出蓝图都没问题，再加利用率到这一档
    goal: { met: plan.targetMet !== false && !!L.feasible && check.ok && !issues.length, space: L.space.space, target: effort.targetSpace, feasible: !!L.feasible, rounds: plan.searchRounds, stalled: !!plan.stalled },
    metrics: {
      ...blueprintSize(L), // 竖排时出出来的蓝图转了 90°，宽长对调
      orient: plan.orientTried?.length > 1 || plan.orient === 'v' ? { used: plan.orient, alt: plan.orientAlt ? { ...plan.orientAlt, ...(plan.orientAlt.rotated ? { width: plan.orientAlt.height, height: plan.orientAlt.width } : {}) } : null } : null,
      area: L.area,
      belts: L.belts,
      sorters: L.sorters,
      factories: L.factories,
      airBelts: L.airBelts,
      lifted: bs.lifts, // 原地竖直升降的节数（垂直传送带）
      steep: steepSteps(L), // 一格升一层的陡坡几步；这两样都要超级磁场
      noLift: !!L.noLift, // 按没解锁超级磁场出的图（earlyGame）：升降都是坡，页面不提垂直传送带
      maxLevel: bs.top,
      reroute: L.rerouteGuard ?? null, // 传送带重走的守门：试了几次、第几次换上、没换上的原因、用时（控制台的规划细节写一行）
      roads: L.roads,
      fill: L.fill,
      space: L.space,
      longestBelt: L.longestBelt,
      sorterLengths: L.sorterLengths,
      target: plan.targetSpace,
      searchRounds: plan.searchRounds,
      stationFallback: !!plan.stationFallback,
      // 出图的是哪个内核（p.core 写明的为准，不写按档位）；auto 换过的 coreSwitch 记着排版内核搜了几段、热启动没有（warm）
      core: plan.coreSwitch ? 'master' : (p.core || effort.core) === 'auto' ? 'typeset' : p.core || effort.core || 'master',
      coreSwitch: plan.coreSwitch ?? null,
      power: L.power
        ? {
            name: L.power.name,
            count: L.power.nodes.length,
            ext: Object.entries(L.power.extend).filter(([, v]) => v).map(([k, v]) => `${{ left: '左', right: '右', bottom: '下', top: '上' }[k]} ${v} 格`).join('、'),
          }
        : null,
    },
    groups: plan.graph.groups.map((g) => ({ letter: labels.get(g.id) ?? g.letter, item: g.item, factory: g.factory, count: g.count, levels: g.levels ?? 1 })),
    // 就地烧掉的副产物（plan/burn.js）：烧什么、每分钟多少、几台火力发电厂、满负荷发多少电；没烧成的原因
    burn: (L.burners || []).map((b) => ({ item: ITEMS.get(b.itemId).name, rate: b.rate, plants: b.plants.length, mw: b.mw, cols: b.cols, depth: b.depth })),
    burnNotes: L.burnNotes ?? [],
    // 化工厂、精炼厂按赤道的紧凑间距排的（左栏默认；页面检查栏写一句：只在赤道附近放得下）
    latitude: (() => {
      const gs = plan.graph.groups.filter((x) => hasHighLatitude(x.factoryId));
      return gs.length ? { factory: [...new Set(gs.map((g) => g.factory))].join('、'), high: gs[0].latitude === 'high' } : null;
    })(),
    byproducts: calc.byproducts.map((b) => ({ name: b.item, rate: b.rate, of: ITEMS.get(b.of).name })),
    recipes: calc.units.filter((u) => recipeChoices(u.itemId)[0]?.id !== u.recipeId).map((u) => ({ item: u.item, recipe: u.recipe })),
    addons: {
      spray: calc.spray ? { name: calc.spray.name, rate: calc.spray.rate, units: calc.units.filter((u) => u.spray).map((u) => `${u.item}（${u.spray.mode === 'extra' ? `增产 +${Math.round((u.spray.outMul - 1) * 1000) / 10}%` : `加速 +${Math.round((u.spray.speedMul - 1) * 100)}%`}）`) } : null,
      coaters: L.coaters?.length ?? 0,
      pilers: L.pilers?.length ?? 0,
      notes: [...(L.addonNotes ?? []), ...(L.warperNotes ?? []), ...(L.storeNotes ?? [])],
      // 翘曲器整张一格（plan/stations.js 的 linkWarpers）：哪座站存、送到哪几座
      warper: (L.stations || []).some((st) => st.items.some((it) => it.role === 'warper'))
        ? { home: (L.stations || []).findIndex((st) => st.items.some((it) => it.role === 'warper')) + 1, to: (L.warperLinks || []).map((w) => w.to.k + 1) }
        : null,
      lines: (L.proLines || []).map((pl) => (pl.station ? `物流站 ${pl.station.k + 1} 的 ${pl.station.slot} 号口` : pl.store != null ? `储物仓（${L.stores[pl.store].side < 0 ? '左' : '右'}边）` : `边缘第 ${pl.edge[1] + (L.origin?.y ?? 0)} ${L.rotated ? '列' : '行'}的入口`)),
    },
    model: renderModel(plan.graph, L),
    ports: ports(plan.graph, L),
    stores: stores(plan.graph, L),
    stations: (L.stations || []).map((st) => ({
      ...toBlueprint(L, st.x + (L.origin?.x ?? 0), st.y + (L.origin?.y ?? 0)),
      items: st.items.map((it) => ({ name: ITEMS.get(it.itemId)?.name ?? plan.graph.items.get(it.itemId)?.name ?? String(it.itemId), role: it.role })),
      ports: st.ports.map((p) => ({ slot: p.slot, dir: p.dir, item: plan.graph.items.get(p.itemId)?.name ?? ITEMS.get(p.itemId)?.name ?? String(p.itemId) })),
    })),
    penalties: L.penalties.filter((x) => x.kind !== 'fill' && x.kind !== 'long').map((x) => ({ kind: x.kind, msg: x.msg })).concat((L.power?.warnings || []).map((msg) => ({ kind: 'power', msg }))), // 土地利用率在「检查」里单独说；带长先不考虑
    feasible: L.feasible,
    validate: { ok: v.ok, errors: v.errors.slice(0, 10) },
    check: { ok: check.ok && !issues.length, errors: [...issues, ...check.errors].slice(0, 12), warnings: check.warnings },
    blueprint: str,
    stationCfg: stationCfg(str),
    parts: { belt: ITEMS.get(BELT_IDS[Number(p.belt)] ?? 2003)?.name, sorter: ITEMS.get(Number(p.sorter))?.name }, // 工厂小窗写传送带、分拣器是哪一级
    energy: energyOf(calc, L, p),
  };
}

/** 用电：数值和要显示的文字都在后台算好（页面不引游戏数据） */
function energyOf(calc, L, p) {
  const e = powerDemand(calc, L, { sorter: Number(p.sorter) });
  return { ...energyTexts(e), detail: `${e.byFactory.map((f) => `${f.name} ${f.count} 台 ${fmtWatts(f.watts)}`).join('、')}${e.stations ? `；物流站充电另算，最多 ${fmtWatts(e.stationCharge)}` : ''}` };
}
/**
 * 用电卡片、标题栏的文字（用户 2026/10/26）：待机、工作、喷涂另加（没喷为 null）、最大（满负荷总数）、物流站充电最多多少；
 * gens：最大用电按额定功率折成几台火力发电厂 / 微型聚变发电站 / 人造恒星（两位小数）
 */
function energyTexts(e) {
  return {
    ...e,
    text: powerText(e),
    totalText: fmtWatts(e.total),
    idleText: fmtWatts(e.idle),
    workText: fmtWatts(e.work),
    sprayText: e.sprayExtra > 0 ? fmtWatts(e.sprayExtra) : null,
    maxText: fmtWatts(e.total),
    stationChargeText: fmtWatts(e.stationCharge),
    gens: generatorsFor(e.total).map((g) => ({ name: g.name, n: Math.round(g.n * 100) / 100, unit: g.name === '人造恒星' ? '座' : '台' })),
  };
}

/**
 * 分馏阵列也照左栏的宽度、长度、长宽比上限（用户 2026/10/26；src/fractionate/array.js 按上限挑每份几个循环）。
 * 一律照原图竖着出（2026/10/30）：以前「化工厂、精炼厂高纬度间距展开」关着时横放（整张转 90°），塔距 4 格、循环两头最外面那条带离塔心 2 格
 * 都到了东西向，用户在游戏里贴了报「最边上的传送带无法建造」——按游戏的碰撞体东西向格宽不到赤道的 98.7%（赤道带里约 9° 以外）那条带就撞塔，
 * 以前只算了塔撞塔（89.5%），说明里写的「只有几条纬度带贴不上」不对。竖着出的在任何纬度都能贴（array.js 的 checkArray 按最窄纬度查过）
 */
const arrayLimits = (p) => ({ maxWidth: p.maxwidth ? Number(p.maxwidth) : null, maxHeight: p.maxheight ? Number(p.maxheight) : null, maxAspect: p.aspect ? Number(p.aspect) : null, orient: 'v' });
/** 分馏阵列退火排法（src/fractionate/anneal.js）每档的步数、重启几次：macmini 上 1000~5000/分 × 不喷 / Mk.III 量的，quick 0.35~1.4 秒、normal 0.37~1.8 秒、fine 0.55~4.1 秒 */
const EFFORT_ARRAY = { quick: { steps: 200, restarts: 1 }, normal: { steps: 300, restarts: 1 }, fine: { steps: 600, restarts: 2 } };
/** 分馏塔阵列：结果的字段和普通产线一样，页面照常画图、出检查和说明 */
function fractionRun(rate, spray = 0, limits = {}, prefs = null, anneal = null) {
  const t0 = performance.now();
  // anneal：用退火排法（物流站在上、方形左右对称；宽、长、长宽比上限这一版不管，说明里写）
  const r = anneal ? annealedArray(rate, { spray, ...anneal }) : fractionatorArray(rate, { spray, ...limits });
  if (anneal && (limits.maxWidth != null || limits.maxHeight != null || limits.maxAspect != null)) r.notes.push('宽度、长度、长宽比上限对新排法不起作用（这一版只排成接近方形）。');
  const check = checkArray(r.str);
  const model = arrayModel(r);
  const B = r.buildings;
  const isBelt = (b) => b.itemId >= 2001 && b.itemId <= 2003;
  const belts = B.filter(isBelt);
  const ground = new Set();
  const K = (x, y) => `${Math.round(x)},${Math.round(y)}`;
  for (const b of B) {
    const o = b.localOffset[0];
    const h = b.itemId === 2104 ? 3 : b.itemId === 2314 ? 1 : 0;
    if (isBelt(b) && o.z > 0.25) continue;
    for (let dx = -h; dx <= h; dx++) for (let dy = -h; dy <= h; dy++) ground.add(K(o.x + dx, o.y + dy));
  }
  const area = r.width * r.height;
  const st = B.find((b) => b.itemId === 2104);
  const role = (n) => (n === 1 ? 'supply' : 'demand');
  const names = { 1120: '氢', 1121: '重氢', 1143: '增产剂 Mk.III', 1210: '空间翘曲器' };
  const storage = st.parameters.storage;
  const towers = B.filter((b) => b.itemId === 2201).length;
  return {
    target: '重氢',
    rate: r.fracs * r.plan.perTower,
    title: `重氢 ${rate}/分 · 分馏塔阵列`,
    ms: Math.round(performance.now() - t0),
    threads: 1,
    metrics: {
      width: r.width,
      height: r.height,
      area,
      belts: belts.length,
      sorters: 0,
      factories: r.fracs,
      airBelts: belts.filter((b) => b.localOffset[0].z > 0.25).length,
      lifted: 0,
      steep: 0,
      maxLevel: 2,
      roads: null,
      fill: 1,
      space: { space: ground.size / area, factory: (r.fracs * 9) / area, rows: 1 },
      longestBelt: 0,
      sorterLengths: {},
      power: { name: '电力感应塔', count: towers, ext: '' },
    },
    groups: [...new Set(model.rows.flatMap((row) => row.groups.map((g) => g.letter)))].sort().map((k) => ({ letter: k, item: '重氢', factory: '分馏塔', count: model.rows.reduce((n, row) => n + row.groups.filter((g) => g.letter === k).length, 0) })),
    byproducts: [],
    recipes: [{ item: '重氢', recipe: '重氢分馏（分馏塔阵列）' }],
    model,
    ports: [],
    stations: [{
      x: Math.round(st.localOffset[0].x),
      y: Math.round(st.localOffset[0].y),
      items: storage.filter((s) => s.itemId).map((s) => ({ name: names[s.itemId] ?? ITEMS.get(s.itemId)?.name ?? String(s.itemId), role: role(s.localRole) })),
      ports: st.parameters.slots.map((sl, slot) => ({ slot, sl })).filter(({ sl }) => sl.dir).map(({ slot, sl }) => ({ slot, dir: sl.dir === 1 ? 'out' : 'in', item: names[storage[sl.storageIdx - 1]?.itemId] ?? '' })),
    }],
    penalties: [],
    feasible: true,
    validate: { ok: true, errors: [] },
    check: { ok: check.ok, errors: check.errors.slice(0, 12), warnings: check.warnings },
    blueprint: withPrefs(r.str, prefs),
    stationCfg: stationCfg(withPrefs(r.str, prefs)),
    array: { notes: r.notes, plan: r.plan, fracs: r.fracs },
    energy: fracEnergy(r),
  };
}

/** 分馏塔阵列的用电（字段同 powerDemand）：分馏塔、自动集装机算工作，喷涂机算喷涂另加，物流站待机两边都算；电力感应塔、分流器、带子不耗电 */
function fracEnergy(r) {
  const n = (id) => r.buildings.filter((b) => b.itemId === id).length;
  const fracs = n(2314);
  const pilers = n(2040);
  const coaters = n(2313);
  const stations = n(2104);
  const fw = ITEMS.get(2314)?.power ?? 0;
  const stationIdle = stations * STATION_IDLE_W;
  const work = fracs * fw + pilers * PILER_W + stationIdle;
  const sprayExtra = coaters * COATER_W;
  return energyTexts({
    total: work + sprayExtra,
    factories: fracs * fw,
    sorters: 0,
    addons: pilers * PILER_W + coaters * COATER_W,
    stationIdle,
    stations,
    stationCharge: stations * STATION_CHARGE_W,
    byFactory: [{ name: '分馏塔', count: fracs, watts: fracs * fw }],
    idle: fracs * IDLE_W[2314] + pilers * PILER_IDLE_W + coaters * COATER_IDLE_W + stationIdle,
    work,
    sprayExtra,
  });
}

/**
 * 快照 → 发给上层的消息体：步数、温度、代价每次都带；绘图模型（几十 KB）最多一秒一份，
 * 其余时候只带数字（半秒一报，给实测估时用）。转模型失败只丢这一份预览，绝不影响搜索。
 * space：这一轮目前最好那张的空间利用率（自动模式按它挑看哪一轮）；最好那张不可行时为 null。最好那张换了才重算
 */
function snapshotPayload(snap, state) {
  if (snap.best !== state.bestRef) {
    state.bestRef = snap.best;
    try {
      state.space = snap.best?.feasible ? spaceStats(snap.best).space : null;
    } catch {
      state.space = null;
    }
  }
  let model = null;
  if (Date.now() - state.last >= 1000) {
    state.last = Date.now();
    try {
      model = renderModel(snap.graph, snap.layout);
    } catch {
      model = null;
    }
  }
  return { s: snap.s, i: snap.i, iterations: snap.iterations, T: snap.T, cost: snap.cost, best: snap.bestCost, space: state.space, feasible: snap.feasible, model };
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  if (msg.type === 'defs') {
    takeDefs(msg.defs);
    return;
  }
  // 帮手线程：只管跑分来的活
  if (msg.type === 'task') {
    // 实时预览：搜索任务带了 snapshotMs 开关时在这里装快照钩子（回调传不过线程，只能本地装）。
    // 快照走 { id, progress } 消息发回总调度线程，别和任务完成 { id, result } 弄混
    if (msg.task.kind === 'search' && msg.task.options?.snapshotMs > 0) {
      const st = { last: 0, bestRef: null, space: null };
      msg.task.options.onSnapshot = (snap) => {
        try {
          self.postMessage({ id: msg.id, progress: snapshotPayload(snap, st) });
        } catch {
          /* 预览发不出去就算了，搜索照常 */
        }
      };
    }
    try {
      // 测速（runBench）：在这个线程里计时，只回毫秒
      self.postMessage({ id: msg.id, result: msg.task.kind === 'ping' ? 'pong' : msg.task.kind === 'bench' ? timeBench(msg.task) : runTask(msg.task) });
    } catch (e) {
      self.postMessage({ id: msg.id, error: e.message || String(e) });
    }
    return;
  }
  if (msg.type === 'init') {
    try {
      helperUrl = URL.createObjectURL(new Blob([msg.src], { type: 'text/javascript' }));
    } catch {
      helperUrl = null;
    }
    threads = Math.max(1, Math.min(16, Number(msg.threads) || 1));
    return;
  }
  if (msg.type === 'watch') {
    // 页面切换观摩哪一轮：round 为 null 是自动（看目前最好的那一轮）
    if (curPreview && curPreview.id === msg.id) {
      curPreview.watch = msg.round == null ? 'auto' : Number(msg.round);
      curPreview.forceNext = true; // 点了就马上给一张，不等下一个 25 秒
    }
    return;
  }
  if (msg.type === 'cancel') {
    // 取消本轮生成：帮手线程只能整个停掉（正在跑的退火没法中途叫停），没做完的活按出错退回，planOne 那边见 cancelled 就不再单线程重来；下次生成再新开线程池。
    // 单线程回退（没有帮手线程）时正在跑的 planLine 停不下来，这条消息等它跑完才轮到，结果照常发出去，页面那边编号已经加了一、不认
    cancelled.add(msg.id);
    if (activeId === msg.id) {
      pool?.stop?.();
      curPreview = null;
    }
    return;
  }
  try {
    if (msg.type === 'catalog') self.postMessage({ type: 'catalog', id: msg.id, list: catalog(msg.raw || []) });
    else if (msg.type === 'chain') self.postMessage({ type: 'chain', id: msg.id, data: chain(msg.params) });
    else if (msg.type === 'forecast') self.postMessage({ type: 'forecast', id: msg.id, data: forecast(msg.params) });
    else if (msg.type === 'patch') self.postMessage({ type: 'patched', id: msg.id, data: patchStation(msg) });
    else if (msg.type === 'plan') {
      planning++;
      let data;
      try {
        data = await run(msg.params, msg.id);
      } finally {
        planning--;
      }
      if (!cancelled.has(msg.id)) self.postMessage({ type: 'result', id: msg.id, data });
    } else if (msg.type === 'bench') await runBench(); // 不抛错：测不成就算了
  } catch (e) {
    if (!cancelled.has(msg.id)) self.postMessage({ type: 'result', id: msg.id, data: { error: e.message } });
  }
};
