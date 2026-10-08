// 生产图：配方组（同一配方的一排工厂）+ 物品流。规划器只认这个结构。
import { factory, recipe as recipeOf, item as itemOf, BYPRODUCT } from '../gamedata.js';

const GROUP_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** 工厂上下两侧里有槽位的列数少的那一侧（一般 3，对撞机 2） */
const slotCols = (f) => Math.min(Object.keys(f.slots?.bottom ?? {}).length, Object.keys(f.slots?.top ?? {}).length) || 3;
const ITEM_LETTERS = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * @param {ReturnType<import('../calc/calculator.js').calculate>} calc
 * @returns {{groups: Group[], items: Map<number, ItemFlow>, target: number}}
 */
export function buildGraph(calc) {
  const groups = calc.units.map((u, i) => {
    const f = factory(u.factoryId, calc.latitude);
    if (!f.supported) {
      const e = new Error(`「${u.item}」需要${f.name}，目前只能排熔炉、制造台、化工厂、研究站和粒子对撞机。可以把它设为外部供应。`);
      e.item = u.item;
      e.code = 'UNSUPPORTED_FACTORY';
      throw e;
    }
    const r = recipeOf(u.recipeId);
    // 研究站一叠 levels 台，规划里把一叠当一台：每「台」的产量乘层数
    const levels = f.kind === 'lab' ? u.levels ?? 1 : 1;
    // 喷了增产剂的配方：增产多出产物、加速整体快（见 calculator.js）
    const outMul = u.spray?.outMul ?? 1;
    const speedMul = u.spray?.speedMul ?? 1;
    const rateOf = (o) => (o.count * outMul * 60 * f.speed * speedMul * levels) / r.time; // 个/分钟
    const perFactory = rateOf(r.outputs.find((o) => o.id === u.itemId) ?? r.outputs[0]);
    // 产物：主产物 + 副产物（副产物在生产图里的编号是 BYPRODUCT + 真实编号，单独一条带）
    const outputs = r.outputs.map((o) => ({ itemId: o.id === u.itemId ? o.id : BYPRODUCT + o.id, perFactory: rateOf(o) }));
    return {
      id: u.id,
      letter: GROUP_LETTERS[i] ?? `G${i}`,
      itemId: u.itemId,
      item: u.item,
      recipeId: u.recipeId,
      inputs: r.inputs.map((x) => x.id),
      factoryId: f.id,
      factory: f.name,
      kind: f.kind,
      pitch: f.pitch,
      center: f.center,
      trailing: f.trailing,
      bodyWidth: f.bodyWidth,
      bodyHeight: f.bodyHeight,
      bodyBelow: f.bodyBelow,
      bodyAbove: f.bodyAbove,
      edgeBelow: f.edgeBelow,
      edgeAbove: f.edgeAbove,
      edgeShiftBelow: f.edgeShiftBelow,
      slots: f.slots,
      tap: f.tap ?? 0,
      slotPos: f.slotPos ?? null,
      collider: f.collider,
      colliderShift: f.colliderShift,
      ...(f.latitude ? { latitude: f.latitude } : null), // 化工厂、量子化工厂按哪套间距排：high 加宽、equator 赤道压缩
      levels,
      levelZ: f.levelZ ?? 0,
      // 一侧可用的分拣器列（中心 −1/0/+1）折算成和间距可比的数；对撞机每侧只有 2 列有槽位，就按 2 算
      colCap: slotCols(f) < 3 ? slotCols(f) : Math.min(f.pitch, 4),
      count: u.count,
      width: u.count * f.pitch + f.trailing,
      perFactory,
      outputs,
      outputRate: u.outputRate,
    };
  });
  const byId = new Map(groups.map((g) => [g.id, g]));

  const items = new Map();
  let li = 0;
  const flowOf = (itemId, by) => {
    const key = by ? BYPRODUCT + itemId : itemId;
    if (!items.has(key)) {
      items.set(key, { itemId: key, real: itemId, byproduct: !!by, name: itemOf(itemId).name + (by ? '（副产）' : ''), letter: ITEM_LETTERS[li++] ?? '?', producer: null, consumers: [], rate: 0 });
    }
    return items.get(key);
  };
  for (const fl of calc.flows) {
    const f = flowOf(fl.itemId, fl.byproduct);
    f.producer = fl.from; // 组 ID 或 'RAW'
    f.consumers.push({ to: fl.to, rate: fl.rate }); // 组 ID 或 'OUT'
    f.rate += fl.rate;
  }
  for (const f of items.values()) {
    if (f.producer !== 'RAW' && !byId.has(f.producer)) throw new Error(`物品「${f.name}」的生产组缺失`);
    // 每台生产者往这条带上放多少（主产物、副产物各不相同）
    if (f.producer !== 'RAW') f.perFactory = byId.get(f.producer).outputs.find((o) => o.itemId === f.itemId)?.perFactory ?? byId.get(f.producer).perFactory;
  }
  return { groups, byId, items, target: calc.targetId };
}

/** 最长路径分层：原料层为 0，配方组的层 = 其输入生产者的最大层 + 1 */
export function layers(graph) {
  const layer = new Map();
  const visit = (g) => {
    if (layer.has(g.id)) return layer.get(g.id);
    let l = 0;
    for (const inp of g.inputs) {
      const p = graph.items.get(inp)?.producer;
      if (p && p !== 'RAW') l = Math.max(l, visit(graph.byId.get(p)) + 1);
    }
    layer.set(g.id, l);
    return l;
  };
  graph.groups.forEach(visit);
  return layer;
}
