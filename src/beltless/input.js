// 无带流生成器（dsq.js）的输入照生成器自己的产线计算出（src/calc/calculator.js 的 calculate，设置同排有带的蓝图）：
// 每组工厂一条（设备、台数、配方每台每秒的原料和产物、增产剂用法、游戏配方 ID），原料和外部供应各一条（每秒要多少），
// 顺序从目标往下一路展开（同 DSQ 老页面的表）。只喷最终产物那一道（calc.spray.to），增产剂从外面供，在原料里列一条。
// 一种东西既要运进来、又有配方顺带产出时（氢、精炼油这类）：产出的那份当另一种东西（氢是 DSQ 的 hydrogenOutput，别的照样加一个 …Output）
// 单独送走，运进来的按全部用量算（同计算器 calc.js）。DSQ 只拆了氢；同一种东西两头都有时它的 generateConveyorBelts 凑不够量、停不下来
import { itemMap, buildingMap } from './dsq.js';
import { recipe as recipeOf } from '../gamedata.js';

const H2 = 1120;
const amount = (v) => Number(v.toFixed(3)); // DSQ 老页面表里写到小数点后 3 位，生成器读的是写出来的数
const itemName = new Map();
for (const [k, v] of Object.entries(itemMap)) if (v.iconId && !itemName.has(v.iconId)) itemName.set(v.iconId, k);
const buildingName = new Map(Object.entries(buildingMap).filter(([, v]) => v.category != null).map(([k, v]) => [v.itemId, k]));

/**
 * calc：calculate 的结果；opt：{ belt 1~3, sorter 分拣器 ID, labStack 研究站最多叠几层 }。
 * 返回 dsq.js 的 Blueprint 要的 { title, icons, recipe: { proliferator, subRecipes }, config, desc, layout }；有认不出的物品、设备时抛错
 */
export function dsqInput(calc, opt = {}) {
  const unknown = [];
  const nameOf = (id, name) => {
    const n = itemName.get(id);
    if (!n && !unknown.includes(name)) unknown.push(name);
    return n ?? String(id);
  };
  const names = new Map();
  for (const u of calc.units) names.set(u.itemId, u.item);
  for (const r of calc.raw) names.set(r.itemId, r.item);
  const producer = new Map();
  for (const u of calc.units) for (const o of recipeOf(u.recipeId).outputs) if (!producer.has(o.id) || o.id === u.itemId) producer.set(o.id, u);
  const raw = new Map(calc.raw.map((r) => [r.itemId, r]));
  // 顺序：从目标往下一路展开，原料按第一次用到的先后
  const order = [];
  const seen = new Set();
  const visit = (id) => {
    if (seen.has(id)) return;
    seen.add(id);
    const u = raw.has(id) ? null : producer.get(id);
    if (!u) {
      if (raw.has(id)) order.push({ raw: raw.get(id) });
      return;
    }
    if (!order.some((o) => o.unit === u)) order.push({ unit: u });
    if (u.spray && calc.spray && !order.some((o) => o.spray)) order.push({ spray: true }); // 喷了增产剂的那组先列增产剂，再展开自己的原料
    for (const q of recipeOf(u.recipeId).inputs) visit(q.id);
  };
  for (const t of calc.targets) visit(t.itemId);
  for (const r of calc.raw) visit(r.itemId);
  // 既运进来又有产出的：产出的那份另算一种，运进来的按全部用量
  const split = new Set([...raw.keys()].filter((id) => calc.units.some((u) => recipeOf(u.recipeId).outputs.some((o) => o.id === id))));
  const need = (id) => calc.flows.filter((f) => f.itemId === id && f.to !== 'OUT').reduce((a, f) => a + f.rate, 0);
  const outName = (id) => {
    if (id === H2) return 'hydrogenOutput';
    const n = `${nameOf(id, names.get(id) ?? String(id))}Output`;
    itemMap[n] ??= { name: n, iconId: id, remark: names.get(id) }; // 分拣器的筛选、带尾的标签照 iconId 写，还是这种东西
    return n;
  };
  const subRecipes = [];
  const proliferator = calc.spray ? `proliferatorMk${calc.spray.level}` : null;
  for (const o of order) {
    if (o.spray) {
      subRecipes.push({ building: null, output: [{ name: proliferator, rate: amount(calc.spray.rate) / 60 }], input: null, acceleratorMode: -1, recipeID: 0 });
      continue;
    }
    if (o.raw) {
      const rate = split.has(o.raw.itemId) ? need(o.raw.itemId) : o.raw.rate;
      subRecipes.push({ building: null, output: [{ name: nameOf(o.raw.itemId, o.raw.item), rate: amount(rate) / 60 }], input: null, acceleratorMode: -1, recipeID: 0 });
      continue;
    }
    const u = o.unit;
    const r = recipeOf(u.recipeId);
    const building = buildingName.get(u.factoryId);
    if (!building) throw new Error(`无带流生成器不认识「${u.factory}」，换一种设备再试`);
    const rate = (x, out) => ({ name: out && split.has(x.id) ? outName(x.id) : nameOf(x.id, names.get(x.id) ?? String(x.id)), rate: x.count / r.time });
    const mode = u.spray?.mode === 'speed' ? 1 : u.spray?.mode === 'extra' ? 0 : -1;
    subRecipes.push({ building: { name: building, num: amount(u.labs ?? u.exact ?? u.count) }, output: r.outputs.map((x) => rate(x, true)), input: r.inputs.map((x) => rate(x, false)), acceleratorMode: mode, recipeID: u.recipeId });
  }
  if (unknown.length) throw new Error(`无带流生成器认不出这些物品：${unknown.join('、')}`);
  const first = calc.targets[0];
  const icons = calc.targets.map((t) => t.itemId).slice(0, 5);
  return {
    title: `${first.name}-${first.rate.toFixed(3)}/min`,
    icons: icons.concat(Array(5).fill(0)).slice(0, 5),
    recipe: { proliferator, subRecipes },
    config: {
      maxSorterNumOneBelt: 8,
      conveyorBeltStackLayer: 4,
      x_y_ratio: 2,
      compactLayout: false,
      upgradeConveyorBelt: false,
      onlyConveyorBeltMk3: Number(opt.belt) === 3,
      onlySorterMk3: Number(opt.sorter) >= 2013,
      maxLabLayers: Number(opt.labStack) || 15,
      selfSpray: false,
      generateTeslaTower: true,
      teslaTowerInterval: 10,
      teslaTowerLineInterval: 1,
      onlyConveyorBeltMk3Downgrade: false,
    },
    desc: calc.targets.map((t) => `${t.name}-${t.rate.toFixed(3)} /min`).join('\n'),
    layout: { 1: 10, 2: 20, 3: 30, 4: 40 }[icons.length] ?? 51,
  };
}
