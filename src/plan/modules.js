// 大产线分模块（handoff 任务 2）。
//
// 为什么要切：一两百台以上、物品种类多的产线，一整块排不出可行解。原因是结构性的：要竖着穿过行间的高架段比能竖直穿行的列多一倍
// （2026/10/05 一条 322 台、53 种物品的产线，最挤的水平线要被 19~21 段高架穿过，能竖直走的只有左右边缘几列，容量十条上下），
// 搜索怎么挪都变不出这一倍的容量。切成几块、每块单独排、块与块之间用星际物流站送货，每块都能排。
//
// 怎么切（在生产图上做划分，只看计算器的结果，不看布局）：
//   1. 物品种数不超过 SPLIT_ITEMS 的产线不切，结果和以前一字不差。
//   2. 矿到锭的冶炼（熔炉、原料全是外部供应）单独成块：它们简单（一进一出）、台数多，放进别的块只会占地方。
//   3. 支配关系：一个物品只被某一块用（卡西米尔晶体只给位面过滤器），它的生产组就跟着那一块；反复做到不再变化。
//      被好几块用的大宗物品（铁块、石墨烯、钛合金）留在自己那块，走物流站。
//   4. 打包：先合并能省下最多站口（两块之间来往的物品）的两块，再把小块凑在一起，每块不超过 MODULE_ITEMS 种物品、MODULE_MACHINES 台。
// 每块的目标是块里产出、被块外用掉的量（加上最终目标），块外流进来的物品是这一块的外部供应。各组的需求和整条线一样，所以台数也一样。
import { calculate } from '../calc/calculator.js';
import { item, factory } from '../gamedata.js';

/** 整条线的物品种数超过这个才切（引力矩阵 38 种不切，小型运载火箭 44 种、那条 322 台的线 53 种要切） */
export const SPLIT_ITEMS = 40;
/** 每块最多几种物品、几台工厂（考卷上 27 种物品以内的线每次都能排出来；冶炼块 120 台实测能排） */
export const MODULE_ITEMS = 24;
export const MODULE_MACHINES = 120;
/** 每块经物流站进出几种物品（一座站 5 种，进出 17 种的块要 4 座站，一半种子放不进空地、退回站列；14 种以内 3 座） */
export const MODULE_EXT = 14;

/**
 * 要不要切、怎么切。input 是 calculate() 的参数。
 * 返回 null（不用切），或 [{ name, smelt, groups, items, machines, ext, targets, inputs, input }]：
 *   groups 这一块的配方组（整条线的 unit id），items 涉及几种物品，machines 几台，ext 要经物流站进出几种物品，
 *   targets / inputs 这一块的产出 / 外部供应（物品编号），input 这一块自己的 calculate() 参数。
 */
export function splitLine(input, { splitItems = SPLIT_ITEMS, maxItems = MODULE_ITEMS, maxMachines = MODULE_MACHINES, maxExt = MODULE_EXT, force = false } = {}) {
  const calc = calculate(input);
  const units = calc.units;
  const byId = new Map(units.map((u) => [u.id, u]));
  const real = calc.flows.filter((f) => !f.byproduct);
  const allItems = new Set(calc.flows.map((f) => f.itemId));
  if (!force && allItems.size <= splitItems) return null;

  // 每组涉及的物品：原料、产物、副产物
  const itemsOf = new Map(units.map((u) => [u.id, new Set([u.itemId])]));
  for (const f of calc.flows) {
    if (f.to !== 'OUT') itemsOf.get(f.to).add(f.itemId);
    if (f.byproduct) itemsOf.get(f.from).add(f.itemId);
  }
  const consumers = new Map(); // 物品 -> 用它的组
  for (const f of real) if (f.to !== 'OUT') (consumers.get(f.itemId) ?? consumers.set(f.itemId, new Set()).get(f.itemId)).add(f.to);
  const goesOut = new Set(real.filter((f) => f.to === 'OUT').map((f) => f.from)); // 产出最终目标的组
  const rawIn = (u) => real.filter((f) => f.to === u.id).every((f) => f.from === 'RAW');
  const smelt = new Set(units.filter((u) => factory(u.factoryId).kind === 'smelter' && rawIn(u)).map((u) => u.id));

  // 一个簇（组的集合）的统计：涉及几种物品、几台、经物流站进出几种物品
  const stats = (groups) => {
    const set = new Set(groups);
    const items = new Set();
    let machines = 0;
    for (const g of groups) {
      for (const it of itemsOf.get(g)) items.add(it);
      machines += byId.get(g).count;
    }
    const ext = new Set();
    for (const f of calc.flows) {
      const fromIn = set.has(f.from);
      const toIn = set.has(f.to);
      if (fromIn !== toIn) ext.add(f.itemId); // 进出这一块的流（原料、最终目标、副产物都算）
    }
    return { items: items.size, machines, ext: ext.size };
  };
  const fits = (s) => s.items <= maxItems && s.machines <= maxMachines && s.ext <= maxExt;

  // 并查集：每个簇一个代表
  const parent = new Map(units.map((u) => [u.id, u.id]));
  const find = (g) => (parent.get(g) === g ? g : (parent.set(g, find(parent.get(g))), parent.get(g)));
  const members = (r) => units.filter((u) => find(u.id) === r).map((u) => u.id);

  // 支配关系：产物只被一个簇用（不是最终目标），就并进那个簇，合并后不超上限才并。冶炼组不参与。
  // 从最深的组往上做（计算器的组是从目标往下排的，倒过来走），子树先长成，长不进上一层就自己成一块
  for (let changed = true; changed; ) {
    changed = false;
    for (const u of units.slice().reverse()) {
      if (smelt.has(u.id) || goesOut.has(u.id)) continue;
      const to = new Set([...(consumers.get(u.itemId) ?? [])].map(find));
      if (to.size !== 1) continue;
      const [c] = to;
      const r = find(u.id);
      if (c === r || smelt.has(c) || !fits(stats([...members(r), ...members(c)]))) continue;
      parent.set(r, c);
      changed = true;
    }
  }

  let clusters = [];
  const seen = new Map();
  for (const u of units) {
    const r = find(u.id);
    if (!seen.has(r)) seen.set(r, clusters.push({ groups: [], smelt: smelt.has(u.id) }) - 1);
    clusters[seen.get(r)].groups.push(u.id);
  }
  for (const c of clusters) Object.assign(c, stats(c.groups));

  // 打包，一次合并一对（只在冶炼和非冶炼各自内部合并）：
  //   第一轮挑合并后省下站口最多的一对（省 0 个就停）；
  //   第二轮把剩下的小块凑起来：挑合并后物品最少的一对，直到哪一对合起来都超上限
  const mergeBest = (score) => {
    let best = null;
    for (let i = 0; i < clusters.length; i++)
      for (let j = i + 1; j < clusters.length; j++) {
        const [a, b] = [clusters[i], clusters[j]];
        if (a.smelt !== b.smelt) continue;
        const s = stats([...a.groups, ...b.groups]);
        if (!fits(s)) continue;
        const v = score(a, b, s);
        if (v != null && (!best || v > best.v)) best = { i, j, s, v };
      }
    if (!best) return false;
    const [a, b] = [clusters[best.i], clusters[best.j]];
    clusters = clusters.filter((_, k) => k !== best.i && k !== best.j);
    clusters.push({ groups: [...a.groups, ...b.groups], smelt: a.smelt, ...best.s });
    return true;
  };
  while (mergeBest((a, b, s) => (a.ext + b.ext - s.ext > 0 ? (a.ext + b.ext - s.ext) * 1000 - s.machines : null)));
  while (mergeBest((a, b, s) => -s.items * 1000 - s.machines));

  // 每块的产出（块外要用的量 + 最终目标）和外部供应
  const order = new Map(units.map((u, i) => [u.id, i]));
  const name = (id) => item(id).name;
  const modules = clusters.map((c) => {
    const set = new Set(c.groups);
    const out = new Map();
    const inputs = new Set();
    for (const f of real) {
      if (set.has(f.from) && !set.has(f.to)) out.set(f.itemId, (out.get(f.itemId) ?? 0) + f.rate);
      if (set.has(f.to) && !set.has(f.from)) inputs.add(f.itemId);
    }
    const targets = [...out.entries()].map(([itemId, rate]) => ({ itemId, rate }));
    // 名字：最终目标在前，其余按量从大到小，取前三个
    const goal = new Set(calc.targets.map((t) => t.itemId));
    const named = targets.slice().sort((a, b) => (goal.has(b.itemId) - goal.has(a.itemId)) || b.rate - a.rate).slice(0, 3).map((t) => name(t.itemId));
    const rest = { ...input };
    delete rest.target; // 单目标写法换成 targets
    delete rest.rate;
    return {
      name: c.smelt ? `冶炼：${named.join('、')}${targets.length > 3 ? '等' : ''}` : `${named.join('、')}${targets.length > 3 ? '等' : ''}`,
      smelt: c.smelt,
      groups: c.groups.sort((a, b) => order.get(a) - order.get(b)),
      items: c.items,
      machines: c.machines,
      ext: c.ext,
      targets,
      inputs: [...inputs],
      input: { ...rest, targets: targets.map((t) => ({ target: t.itemId, rate: t.rate })), raw: [...new Set([...(input.raw ?? []).map((n) => item(n).id), ...inputs])] },
    };
  });
  // 冶炼块放最前面，其余按台数从多到少
  return modules.sort((a, b) => b.smelt - a.smelt || b.machines - a.machines);
}

/** 一块退回靠左侧站列时，换几个种子再排（种子 + 1000、+ 2000） */
export const FALLBACK_RETRIES = 2;

/**
 * 排一块。物流站放不进这一块边上的空地、退回靠左侧站列时（接站本来就不太稳，一块大约十几个种子里有一个），
 * 换种子再排，取第一张不退回的；都退回就用第一张。种子是固定的，结果照样能复现。
 * run(options) 返回规划结果（planLine / planLineAsync 包一层）。
 */
export async function planModule(run, options) {
  let first = null;
  for (let k = 0; k <= FALLBACK_RETRIES; k++) {
    const plan = await run(k ? { ...options, seed: (options.seed ?? 7) + k * 1000 } : options);
    if (!plan.stationFallback) return k ? { ...plan, moduleRetries: k } : plan;
    first ??= plan;
  }
  return { ...first, moduleRetries: FALLBACK_RETRIES };
}
