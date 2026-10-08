// 迷你量化计算器：只为基准测试和单元测试生成输入。
// 正式集成时，输入来自 antian369/dsp-calc 的计算结果（produceUnits），这里的输出结构与之对应。
import { item, recipe as recipeOf, factory, RAW_ITEM_IDS, defaultRecipe, SPRAY_LEVELS } from '../gamedata.js';

const idOrName = (v) => (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v);

const EPS = 1e-9;

/**
 * @param {object} o
 * @param {string|number} o.target 目标产物（单目标写法）
 * @param {number} o.rate 目标产量，个/分钟
 * @param {{target: string|number, rate: number}[]} [o.targets] 多个最终目标（给了就忽略 target/rate）
 * @param {number} [o.smelter=2302] 熔炉 ID
 * @param {number} [o.assembler=2303] 制造台 ID
 * @param {number} [o.chemical=2309] 化工厂 ID（2317 量子化工厂）
 * @param {number} [o.lab=2901] 研究站 ID（2902 自演化研究站），做矩阵用
 * @param {number} [o.labStack=15] 研究站最多叠几层（垂直建造科技 1~6 级：5/7/9/11/13/15 层，来自 BWIKI）。
 *   研究站的 count 是「叠数」，每叠 levels 层，各叠一样高：需要 n 台、最多叠 m 层时叠数 = ⌈n/m⌉、层数 = ⌈n/叠数⌉
 * @param {Record<string,string|number>} [o.recipes] 指定配方 { 物品名或 ID: 配方名或 ID }；可以是有副产物的配方（如石墨烯高效），
 *   副产物单独算一股流（byproduct），从这组工厂送到出口，不抵产线里同种物品的需求
 * @param {string[]} [o.raw] 额外视为外部供应的物品
 * @param {0|1|2|3} [o.spray=0] 喷增产剂（Mk.I~Mk.III）：所有原料和中间产物进工厂前都过喷涂机（摆法见 plan/addons.js），
 *   所以每个配方都吃到——能增产的按增产（产物 +12.5%/20%/25%），只能加速的按加速（+25%/50%/100%）算（游戏规则：
 *   一台工厂的每一种原料都喷到才有效果，按最低喷涂等级算；工厂产出的东西不带增产，进下一台工厂前要再喷）。
 *   增产剂用量 = 所有进工厂的原料和中间产物的流量之和 ÷ 每个增产剂的喷涂次数（calc.spray.rate）
 * @param {'equator'|'high'} [o.latitude='high'] 化工厂、量子化工厂的间距：默认 'high' 加宽（任何纬度都能放，gamedata.js 的 GEOMETRY_HIGH_LATITUDE），
 *   'equator' 赤道压缩（化工厂隔 7、量子化工厂隔 8，只在赤道附近放得下；网页左栏「化工厂赤道间距压缩」）。
 *   只影响排布，不影响台数；原样放进返回值，buildGraph 按它取工厂几何
 */
export function calculate({ target, rate, targets, smelter = 2302, assembler = 2303, chemical = 2309, lab = 2901, labStack = 15, recipes = {}, raw = [], spray = 0, latitude = 'high' }) {
  const goals = (targets?.length ? targets : [{ target, rate }]).map((t) => ({ item: item(t.target), rate: Number(t.rate) }));
  const targetItem = goals[0].item;
  const rawIds = new Set([...RAW_ITEM_IDS, ...raw.map((n) => item(n).id)]);
  const overrides = new Map(Object.entries(recipes || {}).filter(([, v]) => v != null && v !== '').map(([k, v]) => [item(idOrName(k)).id, recipeOf(idOrName(v))]));

  const chooseRecipe = (itemId) => {
    if (rawIds.has(itemId)) return null;
    if (overrides.has(itemId)) return overrides.get(itemId);
    return defaultRecipe(itemId); // 优先单产物配方；只有带副产物的配方能做时（反物质），副产物单独送出
  };
  const chooseFactory = (r) => {
    if (r.factories.includes(smelter)) return factory(smelter);
    if (r.factories.includes(assembler)) return factory(assembler);
    if (r.factories.includes(chemical)) return factory(chemical);
    if (r.factories.includes(lab)) return factory(lab);
    return factory(r.factories[0]);
  };

  // 深度优先得到拓扑序（后序），再逆序传播需求，保证一个物品的需求在展开前已全部累加
  const recipeFor = new Map();
  const post = [];
  const visiting = new Set();
  const visit = (itemId) => {
    if (recipeFor.has(itemId)) return;
    if (visiting.has(itemId)) throw new Error(`配方存在循环：${item(itemId).name}`);
    visiting.add(itemId);
    const r = chooseRecipe(itemId);
    recipeFor.set(itemId, r);
    if (r) for (const inp of r.inputs) visit(inp.id);
    visiting.delete(itemId);
    post.push(itemId);
  };
  // 目标之间也可能有依赖（比如同时要电动机和电磁涡轮），按拓扑序统一展开
  for (const g of goals) visit(g.item.id);

  const demand = new Map();
  for (const g of goals) demand.set(g.item.id, (demand.get(g.item.id) || 0) + g.rate);
  const eff = SPRAY_LEVELS[spray] ?? null;
  let sprayFlow = 0; // 所有进工厂的原料和中间产物的流量之和（每一股都要过喷涂机）
  const units = [];
  const rawSupply = [];
  const byproducts = [];
  const flows = goals.map((g) => ({ itemId: g.item.id, from: null, to: 'OUT', rate: g.rate }));
  for (const itemId of post.slice().reverse()) {
    const need = demand.get(itemId) || 0;
    if (need <= EPS) continue;
    const r = recipeFor.get(itemId);
    if (!r) {
      rawSupply.push({ itemId, item: item(itemId).name, rate: need });
      continue;
    }
    const f = chooseFactory(r);
    // 喷增产剂：所有原料和中间产物都喷（用户 2026/10/08），每个配方都吃到——能增产的按增产，只能加速的按加速
    // （数据里 proliferator & 2 能增产、& 1 能加速：反物质质能储存、X 射线裂解这类只能加速）
    const mode = eff && r.inputs.length > 0 ? (r.proliferator & 2 ? 'extra' : r.proliferator & 1 ? 'speed' : null) : null;
    const outMul = mode === 'extra' ? 1 + eff.extra : 1;
    const speedMul = mode === 'speed' ? 1 + eff.speed : 1;
    const out = (r.outputs.find((o) => o.id === itemId) ?? r.outputs[0]).count * outMul;
    const perFactory = (out * 60 * f.speed * speedMul) / r.time;
    const exact = need / perFactory;
    const unit = {
      id: `g${units.length}`,
      itemId,
      item: item(itemId).name,
      recipeId: r.id,
      recipe: r.name,
      factoryId: f.id,
      factory: f.name,
      exact,
      count: Math.ceil(exact - EPS),
      outputRate: need,
      spray: mode ? { mode, outMul, speedMul } : null,
    };
    if (f.kind === 'lab') {
      const max = Math.max(1, Math.floor(Number(labStack) || 1));
      unit.stacks = Math.ceil(unit.count / max);
      unit.levels = Math.ceil(unit.count / unit.stacks);
      unit.labs = unit.stacks * unit.levels;
      unit.count = unit.stacks;
    }
    units.push(unit);
    // 副产物：按主产物的产量折算，单独一股流送到出口
    for (const o of r.outputs) {
      if (o.id === itemId) continue;
      const rate = (need / out) * o.count * outMul;
      byproducts.push({ itemId: o.id, item: item(o.id).name, rate, from: unit.id, of: itemId });
      flows.push({ itemId: o.id, from: unit.id, to: 'OUT', rate, byproduct: true });
    }
    for (const inp of r.inputs) {
      const inRate = (need / out) * inp.count;
      demand.set(inp.id, (demand.get(inp.id) || 0) + inRate);
      sprayFlow += inRate;
      flows.push({ itemId: inp.id, from: null, to: unit.id, rate: inRate });
    }
  }
  // 回填每条流的来源：生产该物品的配方组，或 'RAW'
  const producerOf = new Map(units.map((u) => [u.itemId, u.id]));
  for (const fl of flows) if (!fl.byproduct) fl.from = producerOf.get(fl.itemId) || 'RAW';
  // 增产剂用量：所有进工厂的带（原料和中间产物）都喷，一个增产剂喷 sprays 个
  const sprayInfo = eff ? { ...eff, rate: sprayFlow / eff.sprays } : null;
  // target/targetId/rate 保留给单目标的老代码；多目标时 target 是「A+B」，rate 是第一个目标的产量
  return {
    spray: sprayInfo,
    target: goals.map((g) => g.item.name).join('+'),
    targetId: targetItem.id,
    rate: goals[0].rate,
    targets: goals.map((g) => ({ itemId: g.item.id, name: g.item.name, rate: g.rate })),
    label: goals.map((g) => `${g.item.name}${g.rate}`).join('+'),
    units,
    raw: rawSupply,
    byproducts,
    flows,
    latitude: latitude === 'equator' ? 'equator' : 'high',
  };
}
