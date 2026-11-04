// 无带流蓝图：照量产计算器带来的 DSQ 生成器输入（calc.js 的 beltlessPlan）出整张（dsq.js），再重新摆放（repack.js）
import { Blueprint, itemMap } from './dsq.js';
import { repack } from './repack.js';
import { fromStr, toStr } from '../codec/parser.js';

const MODEL = { 2002: 36, 2012: 42, 2014: 483 }; // 换型号时的模型编号（同 data/Buildings.json）
const BELTS = new Set([2001, 2002, 2003]);
const SORTERS = new Set([2011, 2012, 2013, 2014]);
const SURPLUS = 0.01; // 每秒多出这么多才算（台数在 input.js 里写到小数点后 3 位，照常的中间产物两头差不到这么多）

/**
 * DSQ 出完带子后补的一步：线里用掉一部分、还多出来的东西（造氢的原油精炼厂顺带出的精炼油、多个目标里被另一个目标用掉一部分的那个）
 * DSQ 照中间产物铺，带尾不留出口；用料分拣器接完以后再铺的几条一个用料都没有，最后一节还指到下一列别的东西的带子上
 * （独立检查报「传送带 a→b 不相邻」，接站时 station.js 顺着指向把它并进那条带）。这里把这一下断开，多出来的那种东西
 * 每条带的带尾贴上标签当出口（同终产物：不接站从带尾出去，接站进物流站当供应），标签上的数照这条带的出货减分给它的用料
 * （DSQ 照铺的先后把用料分给各条，这里同样分）。精炼厂、化工厂这类出几种产物的，任何一种堆满整台就停（推断，看 AssemblerComponent），
 * 不留出口时精炼油堆满，氢也停了。made：出货分拣器编号 → 每秒放多少
 */
function exitSurplus(b, made) {
  const by = new Map(b.buildings.map((x) => [x.index, x]));
  const isBelt = (x) => !!x && BELTS.has(x.itemId);
  const belts = b.buildings.filter(isBelt);
  for (const n of belts) {
    const m = by.get(n.outputObjIdx);
    if (!isBelt(m)) continue;
    const [p, q] = [n.localOffset[0], m.localOffset[0]];
    if (Math.abs(p.x - q.x) + Math.abs(p.y - q.y) > 1.001) Object.assign(n, { outputObjIdx: -1, outputToSlot: 0 });
  }
  const left = new Map(); // 多出来的那几种：物品 ID → 还没分到带上的用量（每秒）
  for (const [name, s] of Object.entries(b.itemSummary)) if (s.fromBuildingNum && s.toBuildingNum && s.rate - s.inputRate > SURPLUS) left.set(itemMap[name].iconId, s.inputRate);
  if (!left.size) return;
  const fed = new Set(belts.map((n) => n.outputObjIdx));
  const heads = belts.filter((n) => !fed.has(n.index)).sort((u, v) => u.localOffset[0].x - v.localOffset[0].x); // 一列一条，x 小的先铺
  const sorters = b.buildings.filter((x) => SORTERS.has(x.itemId));
  for (const head of heads) {
    const nodes = [];
    for (let n = head; isBelt(n) && nodes.length <= belts.length; n = by.get(n.outputObjIdx)) nodes.push(n);
    const tail = nodes[nodes.length - 1];
    if (head.parameters?.iconId || tail.parameters?.iconId) continue;
    const on = new Set(nodes.map((n) => n.index));
    const give = sorters.filter((s) => on.has(s.outputObjIdx));
    const item = give[0]?.filterId;
    if (!left.has(item)) continue;
    const prod = give.reduce((a, s) => a + (made.get(s.index) ?? 0), 0);
    const use = Math.min(prod, left.get(item));
    left.set(item, left.get(item) - use);
    if (prod - use > 1e-9) tail.parameters = { iconId: item, count: ((prod - use) * 60).toFixed(0) };
  }
}

/**
 * plan：{ title, icons, recipe: { proliferator, subRecipes }, config, desc, layout }；opt.zoneAt：带子区放在机器那一圈的哪儿 { side, offset }
 * （画布上拖的，perimeter.js）；opt.station：接物流站 { pile }（不给就不接）；opt.partShift：接了站时各块拖过的格数；
 * opt.sorter、opt.belt：分拣器、带子照设置换型号（DSQ 的配置 onlySorterMk3、onlyConveyorBeltMk3 由 input.js 照同样的设置给）；opt.power、opt.wide、opt.limits：供电、高纬度间距、宽长上限（repack.js）。
 * 返回 { text 蓝图码, zone 带子区放在哪（repack.js 的 zone） }
 */
export function beltlessBlueprint(plan, opt = {}) {
  const b = new Blueprint(plan.title, plan.icons, structuredClone(plan.recipe), structuredClone(plan.config));
  b.init();
  b.generateBuildings();
  const made = new Map(Object.values(b.sorters).flatMap((s) => (s.output ?? []).map((o) => [o.index, o.rate]))); // 出货分拣器每秒放多少（铺带时会被取走，先抄下来）
  b.generateConveyorBelts();
  exitSurplus(b, made);
  b.generateConveyorBeltsForSprayCoater();
  const out = repack(b.buildings, { zoneAt: opt.zoneAt, station: opt.station, partShift: opt.partShift, power: opt.power, wide: opt.wide, limits: opt.limits, fold: opt.fold });
  b.blueprintTemplate.buildings = out.buildings;
  b.blueprintTemplate.header.desc = plan.desc ?? '';
  if (plan.layout) b.blueprintTemplate.header.layout = plan.layout;
  let text = b.toStr();
  // 分拣器、带子照设置的型号：DSQ 只分一级、三级（onlySorterMk3 时全用三级），带子一级或三级；集装分拣器（DSQ 的编码不认）、
  // 二级的出好以后用这边的编码换
  const swap = (x) => ((opt.sorter === 2014 && x.itemId === 2013) || (opt.sorter === 2012 && x.itemId === 2011) ? opt.sorter : opt.belt === 2 && x.itemId === 2001 ? 2002 : 0);
  if (out.buildings.some(swap)) {
    const bp = fromStr(text);
    for (const x of bp.buildings) {
      const to = swap(x);
      if (to) Object.assign(x, { itemId: to, modelIndex: MODEL[to] });
    }
    text = toStr(bp);
  }
  return { text, zone: out.zone, picked: out.picked };
}
