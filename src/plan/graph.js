// 生产图：配方组（同一配方的一排工厂）+ 物品流。规划器只认这个结构。
import { factory, recipe as recipeOf, item as itemOf, BYPRODUCT, realItem, plannable } from '../gamedata.js';

const GROUP_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** 工厂上下两侧里有槽位的列数少的那一侧（一般 3，对撞机 2） */
const slotCols = (f) => Math.min(Object.keys(f.slots?.bottom ?? {}).length, Object.keys(f.slots?.top ?? {}).length) || 3;
/**
 * 研究站一叠要接的物品（原料 + 产物）比上下两侧的分拣器位多（宇宙矩阵 6 进 1 出，上下各 3 个位；用户 2026/10/30：「把传送带从两个研究站之间插进去」）：
 * 产物改从左右两侧出，返回产物的编号，否则 null。只认一种产物、产物只送成品出口的（宇宙矩阵就是）。这种组每台右边多留一列（间距 6），
 * 两台中间那一列夹一条带（layout/belts.js 的 labGaps），上下两侧只接原料
 */
function sideItemOf(f, r, u, flows) {
  if (f.kind !== 'lab' || u.store || r.outputs.length !== 1) return null;
  const n = Object.keys(f.slots.bottom).length + Object.keys(f.slots.top).length;
  if (r.inputs.length + r.outputs.length <= n) return null;
  const outs = flows.filter((fl) => fl.from === u.id && !fl.byproduct);
  return outs.length && outs.every((fl) => fl.to === 'OUT' && fl.itemId === u.itemId) ? u.itemId : null;
}
const ITEM_LETTERS = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * @param {ReturnType<import('../calc/calculator.js').calculate>} calc
 * @returns {{groups: Group[], items: Map<number, ItemFlow>, target: number}}
 */
export function buildGraph(calc) {
  const groups = calc.units.map((u, i) => {
    const f = factory(u.factoryId, calc.latitude);
    if (!f.supported || !plannable(u.recipeId, u.factoryId)) {
      const e = new Error(`「${u.item}」需要${f.name}（${u.recipe}），目前只能排熔炉、制造台、化工厂、研究站、粒子对撞机和精炼厂的等离子精炼。可以把它设为外部供应。`);
      e.item = u.item;
      e.code = 'UNSUPPORTED_FACTORY';
      throw e;
    }
    // 箱子供货的储物仓（plan/storage.js 的 storeUnits）：没有配方，「储物仓供货」一叠往带上放 rate ÷ 叠数，「储物仓收货」只取不放；
    // 一叠算一台，levels 是叠几层（只管出蓝图、画图，不乘产量）
    const st = u.store;
    const key = st?.byproduct ? BYPRODUCT + u.itemId : u.itemId;
    const r = st ? { inputs: st.kind === 'out' ? [{ id: key }] : [], outputs: st.kind === 'in' ? [{ id: u.itemId, count: 1 }] : [], time: 1 } : recipeOf(u.recipeId);
    // 研究站一叠 levels 台，规划里把一叠当一台：每「台」的产量乘层数
    const levels = f.kind === 'lab' || st ? u.levels ?? 1 : 1;
    // 喷了增产剂的配方：增产多出产物、加速整体快（见 calculator.js）
    const outMul = u.spray?.outMul ?? 1;
    const speedMul = u.spray?.speedMul ?? 1;
    const rateOf = st ? () => st.rate / u.count : (o) => (o.count * outMul * 60 * f.speed * speedMul * levels) / r.time; // 个/分钟
    const perFactory = rateOf(r.outputs.find((o) => o.id === u.itemId) ?? r.outputs[0]);
    // 产物：主产物 + 副产物（副产物在生产图里的编号是 BYPRODUCT + 真实编号，单独一条带）
    // 和主产物一起供产线的（u.shared，同一道配方被几种物品同时选中，calculator.js）也是正经产物
    const outputs = r.outputs.map((o) => ({ itemId: o.id === u.itemId || u.shared?.includes(o.id) ? o.id : BYPRODUCT + o.id, perFactory: rateOf(o) }));
    const sideItem = sideItemOf(f, r, u, calc.flows);
    const pitch = sideItem == null ? f.pitch : f.pitch + 1; // 夹带的组每台右边多一列（中心隔 6）
    return {
      id: u.id,
      letter: GROUP_LETTERS[i] ?? `G${i}`,
      itemId: u.itemId,
      item: u.item,
      recipeId: u.recipeId,
      inputs: r.inputs.map((x) => u.inputKeys?.[x.id] ?? x.id), // inputKeys：原料分给这组单用的那组仓（编号见 gamedata.js 的 STORE_COPY）
      factoryId: f.id,
      factory: f.name,
      kind: f.kind,
      pitch,
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
      ...(f.latitude ? { latitude: f.latitude } : null), // 化工厂、量子化工厂、精炼厂按哪套间距排：high 加宽、equator 赤道压缩
      levels,
      levelZ: f.levelZ ?? 0,
      // 一侧可用的分拣器列（中心 −1/0/+1）折算成和间距可比的数；对撞机每侧只有 2 列有槽位，就按 2 算；夹带的研究站多出来那列不放分拣器，按 3
      colCap: slotCols(f) < 3 || st || sideItem != null ? slotCols(f) : Math.min(f.pitch, 4),
      ...(f.slots && !Object.keys(f.slots.top ?? {}).length ? { noTop: true } : null), // 上侧没有口（精炼厂）：只挂下面那条通道
      ...(sideItem != null ? { sideItem } : null), // 产物从左右两侧出、走两台中间的夹带（见 sideItemOf）
      count: u.count,
      width: u.count * pitch + f.trailing,
      perFactory,
      outputs,
      crafts: st ? null : (60 * f.speed * speedMul * levels) / r.time, // 每台（一叠）每分钟跑几次配方：页面上工厂小窗算原料用量
      outputRate: u.outputRate,
      ...(st ? { store: { ...st, key } } : null),
    };
  });
  const byId = new Map(groups.map((g) => [g.id, g]));

  const items = new Map();
  let li = 0;
  const flowOf = (itemId, by) => {
    const key = by ? BYPRODUCT + itemId : itemId;
    if (!items.has(key)) {
      items.set(key, { itemId: key, real: realItem(itemId), byproduct: !!by, name: itemOf(realItem(itemId)).name + (by ? '（副产）' : ''), letter: ITEM_LETTERS[li++] ?? '?', producer: null, consumers: [], rate: 0 });
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
