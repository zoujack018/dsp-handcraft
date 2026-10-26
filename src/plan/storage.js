// 箱子供货（用户 2026/10/18 定，v2.3）：不接物流站时，原料从储物仓 / 储液罐出、成品进储物仓 / 储液罐，整张图不用接带子。
//   supply（左栏「供货」）：'box-s' 小型储物仓、'box-l' 大型储物仓，'dist-s'、'dist-l' 同样的仓、最上面那个顶上放物流配送器
//   （原料那边「向其他配送器需求」、成品那边「供应」，照用户的蓝图不和机甲交换）。液体（gamedata.js 的 FLUIDS）一律用储液罐，
//   带子直接接罐口，不放配送器。
//   左侧一列仓组（用户 2026/10/26）：'side-s'、'side-l'、'sdist-s'、'sdist-l' 同样的仓和配送器，但不排进行里（storeUnits 不动），原料（矿除外）、
//   成品、副产物每个出入口都是外面一组、一律摆在左边一列（addStores）；走线时出入口都在左边（route.js 的 leftPorts），矿也从左边缘送进来。
// 固体原料、成品的仓当工厂排进生产行里（storeUnits，用户 2026/10/19），原料按用料的工厂组各配一组，挨着它们摆；增产剂仓摆在蓝图里面的空地上
// （storeSites，增产剂那一步挑位置）。下面说的「外面一组」是剩下的：液体的储液罐、一组工厂要的比一条带多的原料、放不进里面的增产剂仓。
// 矿（ORES）不放进仓，照旧从边缘送进来（用户 2026/10/24：矿物不再放进箱子，小型仓、大型仓都一样）。
// 外面每个原料入口、成品出口接一组：一截横着的进料带，仓排在带子上方、隔 1 行放分拣器（仓口在仓身里，分拣器长 1）；储液罐在带子的远头。
// 几个仓：先按流量 ÷ 分拣器速度（左栏的分拣器、长 1）喂得过来；再看 STORE_MINUTES 分钟的量（用户：储物仓要装得下整条线跑这么久，成品也算；2026/10/19 从 60 砍到 30），
// 叠层不超过 maxLayers（左栏「研究站最多叠几层」：推断储物仓、储液罐的叠层也是「垂直建造」管），叠满还装不下就加仓。
// 组摆在产线外框外面、出入口原来那一侧，一组一组竖着排（上下隔 GAP_Y 行、和产线隔 GAP_X 列，放供电设施）；组口用寻路接到那条带的
// 段头 / 段尾（照接物流站、就地烧副产物的做法），原来通到边缘的那截作废。在烧副产物之后、落地、增产剂、供电之前做。
// 间距（gamedata.js 的 STORE_BODY，体积测试第八张）：小型仓隔 3（实测能放），大型仓隔 6（隔 5 没测，先保守）。
import { FLUIDS, ITEMS, BYPRODUCT, STORE_COPY, BELT_SPEED, RAW_ITEM_IDS, realItem, stackSize, STORE_BODY, BOX_SLOT, TANK_PORT } from '../gamedata.js';
import { obstacles, pathfind, dirIndex, cropToContent } from './stations.js';
import { translateLayout } from './coordinates.js';
import { SORTER_SPEED } from './sorters.js';
import { contentBox, burnable } from './burn.js';
import { chainTiles } from '../emit/blueprint.js';
import { portRays } from './layout/shared.js';

export const SMALL_BOX = 2101;
export const BIG_BOX = 2102;
export const TANK = 2106;
/** 矿：原矿（物品 Type 1）里的固体，木材、植物燃料（手采的）除外。箱子供货时照旧从边缘送进来，不放进仓（用户 2026/10/24） */
export const ORES = new Set([...RAW_ITEM_IDS].filter((id) => !FLUIDS.has(id) && id !== 1030 && id !== 1031));
/** 一组仓、罐要装得下整条线跑几分钟（用户 2026/10/18 定 60，10/19 砍到 30） */
export const STORE_MINUTES = 30;
/** 一个储液罐装多少（推断：BWIKI 写的储液罐容量 10000） */
export const TANK_CAP = 10000;
/** 左栏「供货」的几种：仓的种类、放不放配送器（edge 是原来的从边缘送入） */
export const SUPPLY = {
  'box-s': { box: SMALL_BOX, dist: false },
  'box-l': { box: BIG_BOX, dist: false },
  'dist-s': { box: SMALL_BOX, dist: true },
  'dist-l': { box: BIG_BOX, dist: true },
  // 左侧一列仓组（column，见文件开头）
  'side-s': { box: SMALL_BOX, dist: false, column: true },
  'side-l': { box: BIG_BOX, dist: false, column: true },
  'sdist-s': { box: SMALL_BOX, dist: true, column: true },
  'sdist-l': { box: BIG_BOX, dist: true, column: true },
};
/** 是不是左侧一列仓组（SUPPLY 里标 column 的几种）：走线时出入口都在左边（route.js 的 leftPorts） */
export function isColumnSupply(supply) {
  return !!SUPPLY[supply]?.column;
}
const PITCH = { [SMALL_BOX]: 3, [BIG_BOX]: 6 }; // 沿进料带每个仓占几列
const PER_BOX = { [SMALL_BOX]: 3, [BIG_BOX]: 3 }; // 一个仓朝带子那边能接几根分拣器（每边三个口，用户 2026/10/19 的蓝图）
const GAP_X = 2; // 组和产线之间空几列（放供电设施、接线）
const GAP_Y = 1; // 上下两组之间空几行
const SPRAY_TAIL = 5; // 要喷的原料：最后一个放料口和组口之间多留几格直带，喷涂机骑在这里（plan/addons.js 的 coaterFits 要 5 格直带）
/** 仓的南边（朝带子那边）几个口：相对仓中心的列 → 口号（照制造台下侧：+1 → 6、0 → 7、−1 → 8） */
const SOUTH_SLOT = { 1: 6, 0: 7, [-1]: 8 };

/**
 * 一组要几个仓、叠几层：itemId 物品（生产图里的编号，副产物带 BYPRODUCT），rate 每分钟。
 * 返回 { type, count 几个（一叠算一个）, layers 每叠几层, sorters 几根分拣器, minutes 装满能撑多少分钟 }
 */
export function storeSize(itemId, rate, { box = SMALL_BOX, sorter = 2013, maxLayers = 15 } = {}) {
  const item = realItem(itemId);
  const need = rate * STORE_MINUTES;
  const top = Math.max(1, Math.floor(maxLayers));
  if (FLUIDS.has(item)) {
    const layers = Math.max(1, Math.min(top, Math.ceil(need / TANK_CAP - 1e-9)));
    return { type: TANK, count: 1, layers, sorters: 0, minutes: (layers * TANK_CAP) / Math.max(rate, 1e-9) };
  }
  const layerCap = STORE_BODY[box].cap * stackSize(item);
  const speed = SORTER_SPEED[sorter]?.[1] ?? 360;
  let count = Math.ceil(Math.max(1, Math.ceil(rate / speed - 1e-9)) / PER_BOX[box]);
  let layers = Math.ceil(need / (count * layerCap) - 1e-9);
  if (layers > top) {
    count = Math.ceil(need / (top * layerCap) - 1e-9);
    layers = Math.ceil(need / (count * layerCap) - 1e-9);
  }
  layers = Math.max(1, layers);
  // 每个仓至少一根分拣器（不然里面的东西出不来），流量要的根数在各仓之间均分
  const sorters = Math.max(count, Math.ceil(rate / speed - 1e-9));
  return { type: box, count, layers, sorters, minutes: (count * layers * layerCap) / Math.max(rate, 1e-9) };
}

/** 分拣器速度至少比要送的多这么多（同 plan/route.js 的 headroom），不够分拣器就排不上 */
const HEADROOM = 1.15;
/**
 * 工厂超过这么多台的线，仓照旧摆在外面（addStores），不排进行里。2026/10/19 量的（标准档考卷 × 3 个种子）：80 台以内的
 * 电磁涡轮 90、位面过滤器 15 / 45、粒子宽带 60、粒子容器 60 排进行里面积 −11%~+3%、利用率 +1~+16 个百分点；
 * 奇异物质 30（81 台）+4%~+6%、引力矩阵 30（102 台）+35%~+40%。原料仓按用料的工厂分开、仓数按长 1 的分拣器算以后再量（同样 3 个种子）：
 * 奇异物质 30 持平 / +5%，引力矩阵 30（107 台）+16%~+17%、小型仓 3 个种子有 1 个不可行（铁矿仓的带子没落在紧贴的轨上），照旧不排
 */
export const STORE_ROW_MAX = 80;
/** 仓数按多长的分拣器算喂得过来：按长 1（带子在紧贴的那条轨上）。原料仓按用料的工厂分开以后带子短、挨着用料的工厂（2026/10/19：按长 2 算时每叠只叠 1~2 层） */
const STACK_SORTER_LEN = 1;
/**
 * 排进生产行里的一组储物仓（storeUnits）：几叠、每叠几层。先按分拣器喂得过来：小型仓每侧一个口、大型仓三个，按左栏分拣器
 * 长 STACK_SORTER_LEN 的速度、留 HEADROOM 的余量（只算一侧，带子在哪一侧都行）；再装得下 STORE_MINUTES 分钟（叠层不超过 maxLayers，叠满不够再加一叠）。
 * 返回 { count 几叠, layers 每叠几层, minutes 装满能撑多少分钟 }
 */
export function storeStacks(itemId, rate, { box = SMALL_BOX, sorter = 2013, maxLayers = 15 } = {}) {
  const layerCap = STORE_BODY[box].cap * stackSize(realItem(itemId));
  const perStack = ((SORTER_SPEED[sorter]?.[STACK_SORTER_LEN] ?? 180) / HEADROOM) * PER_BOX[box];
  const need = rate * STORE_MINUTES;
  const top = Math.max(1, Math.floor(maxLayers));
  const count = Math.max(1, Math.ceil(rate / perStack - 1e-9), Math.ceil(need / (top * layerCap) - 1e-9));
  const layers = Math.max(1, Math.ceil(need / (count * layerCap) - 1e-9));
  return { count, layers, minutes: (count * layers * layerCap) / Math.max(rate, 1e-9) };
}

/**
 * 箱子供货时把储物仓当工厂排进生产行里（用户 2026/10/19：小型仓和熔炉一样大，紧挨着摆，不用另外摆在产线外面）：
 * 每种原料按用料的工厂组各加一组「储物仓供货」（液体是一叠储液罐，罐口直接出带子），原来从 RAW 来的流改成从各自那组来；
 * 流向出口的成品、副产物（液体、要就地烧掉的除外）各加一组「储物仓收货」。液体成品、副产物照旧从边缘出去，收尾时接储液罐（addStores）。
 * 一组工厂要的比一条带运得多的原料也照旧从边缘进、在外面接仓组（2026/10/19 量的：粒子容器 180 的铁矿 3600/分只走一条带就超运力、不可行）。
 * 工厂超过 STORE_ROW_MAX 台的线整条照旧摆在外面。在 calculate() 里做（网页、命令行、考卷、帮手线程拿同一份 calc 建图）；返回新的 calc，
 * calc.storeUnits 记下用的哪种仓。belt：传送带等级（1~3），按它的运力判断装不装得下
 */
export function storeUnits(calc, { supply, sorter = 2013, maxLayers = 15, burn = false, belt = 3 } = {}) {
  const spec = SUPPLY[supply];
  // 左侧一列仓组（column）不排进行里：原料（矿除外）、成品照旧从边缘进出，收尾时在左边接仓组（addStores）
  if (!spec || spec.column || calc.storeUnits) return calc;
  if (calc.units.reduce((n, u) => n + u.count * (u.levels ?? 1), 0) > STORE_ROW_MAX) return calc;
  const name = (id) => ITEMS.get(realItem(id))?.name ?? String(id);
  const units = [...calc.units];
  const flows = calc.flows.map((f) => ({ ...f }));
  const top = Math.max(1, Math.floor(maxLayers));
  const add = (kind, itemId, rate, byproduct) => {
    const tank = FLUIDS.has(realItem(itemId));
    // 储液罐（液体原料）：一叠只有朝通道的那一个口、罐口那截带子只能接一条带，所以一组只放一叠，叠到装得下 30 分钟
    const size = tank ? { count: 1, layers: Math.max(1, Math.ceil((rate * STORE_MINUTES) / TANK_CAP - 1e-9)) } : storeStacks(itemId, rate, { box: spec.box, sorter, maxLayers });
    const minutes = tank ? (size.layers * TANK_CAP) / Math.max(rate, 1e-9) : size.minutes;
    const type = tank ? TANK : spec.box;
    const u = { id: `s${units.length}`, itemId, item: name(itemId), recipeId: 0, recipe: kind === 'in' ? (tank ? '储液罐供货' : '储物仓供货') : '储物仓收货', factoryId: type, factory: name(type), exact: size.count, count: size.count, levels: size.layers, outputRate: kind === 'in' ? rate : 0, spray: null, store: { kind, dist: spec.dist && !tank, rate, byproduct, minutes, ...(tank ? { tank: true } : null) } };
    units.push(u);
    return u;
  };
  const raw = [];
  const beltCap = (BELT_SPEED[belt] ?? 30) * 60;
  for (const r of calc.raw) {
    if (ORES.has(r.itemId)) {
      raw.push(r); // 矿照旧从边缘进
      continue;
    }
    // 每组用料的工厂各配一组仓（用户 2026/10/19：仓可以摆在任何地方，挨着用料的工厂）：第二组起换个编号（STORE_COPY），各走各的带。
    // 一组工厂要的比一条带运得多（储液罐还有叠满 maxLayers 层也装不下 30 分钟）时这份照旧从边缘进（从边缘进能拆成几个入口走几条带），原来的编号留给它
    const fluid = FLUIDS.has(r.itemId);
    const mine = flows.filter((f) => f.from === 'RAW' && !f.byproduct && f.itemId === r.itemId);
    // 一组罐最多送多少：一条带，叠满 maxLayers 层装得下 30 分钟
    const tankMax = Math.min(beltCap, (top * TANK_CAP) / STORE_MINUTES);
    const edge = mine.filter((f) => f.rate > beltCap + 1e-9 || (fluid && f.rate > tankMax + 1e-9));
    // 储液罐 5×5 占地大（2026/10/19 量的：按用料的工厂拆开时位面过滤器 15 有 7 组罐，面积 +30%）：一种液体尽量只放一组，
    // 一组送不过来再分（大的先装）；储物仓照旧每组工厂各一组
    const bins = [];
    const rest = mine.filter((q) => !edge.includes(q));
    for (const f of fluid ? rest.sort((a, b) => b.rate - a.rate) : rest) {
      const bin = fluid ? bins.find((b) => b.rate + f.rate <= tankMax + 1e-9) : null;
      if (bin) {
        bin.rate += f.rate;
        bin.flows.push(f);
      } else bins.push({ rate: f.rate, flows: [f] });
    }
    let k = edge.length ? 1 : 0;
    for (const bin of bins) {
      const key = STORE_COPY * k++ + r.itemId;
      const id = add('in', key, bin.rate, false).id;
      for (const f of bin.flows) {
        f.from = id;
        if (key === r.itemId) continue;
        f.itemId = key;
        const i = units.findIndex((u) => u.id === f.to);
        units[i] = { ...units[i], inputKeys: { ...units[i].inputKeys, [r.itemId]: key } };
      }
    }
    if (edge.length) raw.push({ ...r, rate: edge.reduce((a, f) => a + f.rate, 0) });
  }
  // 出口：同一种（副产物另算一种）合成一组；就地烧掉的副产物照旧送到边缘（plan/burn.js）
  const burned = (f) => f.byproduct && burn && burnable(BYPRODUCT + f.itemId) && (burn === true || burn.includes(f.itemId));
  const outs = new Map();
  for (const f of flows) {
    if (f.to !== 'OUT' || FLUIDS.has(f.itemId) || burned(f)) continue;
    const k = `${f.itemId}:${!!f.byproduct}`;
    if (!outs.has(k)) outs.set(k, { itemId: f.itemId, byproduct: !!f.byproduct, rate: 0, list: [] });
    outs.get(k).rate += f.rate;
    outs.get(k).list.push(f);
  }
  for (const o of outs.values()) {
    const u = add('out', o.itemId, o.rate, o.byproduct);
    for (const f of o.list) f.to = u.id;
  }
  return { ...calc, units, flows, raw, storeUnits: { supply, box: spec.box, dist: spec.dist } };
}

/**
 * 一组的形状，左边那侧的写法：组口在 (0, 0)，进料带是 x = −len … −1 那一行，仓在带子上方（中心 y = 2），储液罐在带子的西头。
 * 右边那侧整个左右翻过来。返回 { len, boxes: [仓中心的 x], cols: [{ x, box, rel }]（分拣器那一列、哪个仓、离仓中心几列）,
 * tank: 罐中心的 x 或 null, rect: [x0, y0, x1, y1] }
 */
function shapeOf(size, tail) {
  if (size.type === TANK) {
    const len = 2 + tail;
    return { len, boxes: [], cols: [], tank: -len - 1, rect: [-len - 3, -2, -1, 2] };
  }
  const pitch = PITCH[size.type];
  const len = size.type === SMALL_BOX ? pitch * size.count + tail : pitch * size.count - 1 + tail;
  const boxes = [];
  const cols = [];
  let left = size.sorters;
  for (let j = 0; j < size.count; j++) {
    const x = size.type === SMALL_BOX ? -len + 1 + pitch * j : -len + 2 + pitch * j;
    boxes.push(x);
    // 这个仓接几根：剩下的根数按剩下的仓均分（至少 1 根）
    const n = Math.min(3, Math.max(1, Math.ceil(left / (size.count - j))));
    left -= n;
    for (const rel of [0, 1, -1].slice(0, n)) cols.push({ x: x + rel, box: j, rel });
  }
  return { len, boxes, cols, tank: null, rect: [-len, 0, -1, 3] };
}

/**
 * 一组落到实处：组口在 (gx, yF)，side −1 摆在左边、1 摆在右边。返回 { store（还没记 leg）, feed（从组的远头到组口前一格） }
 */
function makeStore({ kind, itemId, rate, size, shape, dist, side, gx, yF }) {
  const ax = (rx) => gx + side * -rx; // 左边那侧的相对 x → 这一侧的绝对 x（左边 gx + rx，右边 gx − rx）
  const feed = [];
  for (let rx = -shape.len; rx <= -1; rx++) feed.push([ax(rx), yF, 0]);
  const yB = yF + 2;
  const boxes = shape.boxes.map((rx) => [ax(rx), yB]);
  const sorters = shape.cols.map(({ x: rx, box, rel }) => {
    const r = side * -rel; // 这一侧离仓中心几列（右边那侧翻过来）
    const slot = SOUTH_SLOT[r];
    const [dx, dy] = BOX_SLOT[size.type][slot];
    const boxPt = [boxes[box][0] + dx, yB + dy];
    const beltPt = [boxPt[0], yF]; // 分拣器整根对齐口的 x（小型仓两头的口在 ±0.797），接 ax(rx) 那格带子
    const cellPt = [ax(rx), yF];
    return { box, slot, p0: kind === 'in' ? boxPt : beltPt.slice(), p1: kind === 'in' ? beltPt.slice() : boxPt, belt: cellPt }; // 各存一份：平移时逐个挪
  });
  const tank = size.type === TANK ? { x: ax(shape.tank), y: yF, slot: side < 0 ? 1 : 3 } : null;
  if (tank) tank.port = [tank.x + TANK_PORT[tank.slot][0], yF];
  const xs = [ax(shape.rect[0]), ax(shape.rect[2])];
  const rect = [Math.min(...xs), yF + shape.rect[1], Math.max(...xs), yF + shape.rect[3]];
  const store = { kind, itemId: realItem(itemId), rate, type: size.type, dist: dist && size.type !== TANK, count: size.count, layers: size.layers, minutes: size.minutes, side, gate: [gx, yF], boxes, sorters, tank, rect };
  return { store, feed };
}

/**
 * 增产剂仓摆在蓝图里面的空地上（用户 2026/10/19：仓可以摆在任何地方，包括蓝图中间）：能放一组的位置，按组口离 (cx, cy) 近排，
 * 最多 limit 个。free(x, y)：这一格能不能占（没有工厂、分拣器、任何一层的带子）。返回 [{ store（还没记 leg）, feed, d }]
 */
export function storeSites({ itemId, rate, supply, sorter = 2013, maxLayers = 15, W, H, free, cx, cy, limit = 8 }) {
  const spec = SUPPLY[supply];
  if (!spec) return [];
  const size = storeSize(itemId, rate, { box: spec.box, sorter, maxLayers });
  const shape = shapeOf(size, 0);
  const out = [];
  for (const side of [-1, 1]) for (let yF = 0; yF < H; yF++) for (let gx = 0; gx < W; gx++) {
    if (!free(gx, yF)) continue;
    const { store, feed } = makeStore({ kind: 'in', itemId, rate, size, shape, dist: spec.dist, side, gx, yF });
    const r = store.rect;
    if (r[0] < 0 || r[1] < 0 || r[2] >= W || r[3] >= H) continue;
    let ok = true;
    for (let x = r[0]; x <= r[2] && ok; x++) for (let y = r[1]; y <= r[3] && ok; y++) ok = free(x, y);
    if (ok) out.push({ store, feed, d: Math.abs(gx - cx) + Math.abs(yF - cy) });
  }
  return out.sort((a, b) => a.d - b.d).slice(0, limit);
}

/**
 * 给布局的原料入口、成品出口接上储物仓 / 储液罐（改写 L）：
 *   L.stores [{ kind 'in'|'out', itemId, rate, type, dist, count, layers, minutes, side −1 左 / 1 右, gate, boxes: [[x,y]],
 *              sorters: [{ box, slot, p0, p1, belt: [x,y] }], tank: { x, y, slot } | null, rect, leg }]
 *   接上的那条腿：stub 是从组的远头到段头 / 段尾前一格的整条带（chainTiles 对成品会反过来），原来通到边缘的那截作废。
 *   接不上（寻路失败、超出宽长上限）的照旧从边缘进出，L.storeNotes 写明。
 * sprayItems：要喷增产剂的物品（全喷时 true），这几种原料的进料带多留几格给喷涂机。
 */
export function addStores(L, { supply, sorter = 2013, maxLayers = 15, maxWidth = null, maxHeight = null, maxLevel = 6, sprayItems = null } = {}) {
  const spec = SUPPLY[supply];
  L.stores = [];
  L.storeNotes = [];
  if (!spec) return L;
  const name = (id) => ITEMS.get(realItem(id))?.name ?? String(id);
  const ports = L.ports.filter((p) => !p.burn && p.station == null && (p.kind === 'out' || (p.kind === 'in' && !ORES.has(realItem(p.itemId)))));
  if (!ports.length) return L;
  const [cx0, cy0, cx1, cy1] = contentBox(L);
  const sprayed = (p) => p.kind === 'in' && sprayItems && (sprayItems === true || sprayItems.includes(realItem(p.itemId)));
  const plans = ports.map((p) => {
    const size = storeSize(p.itemId, p.rate ?? 0, { box: spec.box, sorter, maxLayers });
    // 左侧一列仓组（column）：一律摆在左边
    return { p, side: spec.column || p.x <= (cx0 + cx1) / 2 ? -1 : 1, size, shape: shapeOf(size, sprayed(p) ? SPRAY_TAIL : 0) };
  });
  // 先把地方留够：左右各留最长那组 + 空当，上下各留一侧所有组的高度（用不着的最后裁掉）
  const mX = { [-1]: 0, 1: 0 };
  const hY = { [-1]: 0, 1: 0 };
  for (const q of plans) {
    mX[q.side] = Math.max(mX[q.side], GAP_X + q.shape.rect[2] - q.shape.rect[0] + 1);
    hY[q.side] += q.shape.rect[3] - q.shape.rect[1] + 1 + GAP_Y;
  }
  const mY = Math.max(hY[-1], hY[1]);
  translateLayout(L, mX[-1] + 2 - cx0, mY + 2 - cy0);
  const X0 = mX[-1] + 2, X1 = X0 + cx1 - cx0; // 产线外框平移后的左右
  const TW = X1 + mX[1] + 3, TH = cy1 - cy0 + 1 + 2 * mY + 4;
  const used = { [-1]: [], 1: [] }; // 每一侧已经占了的行区间 [下, 上]（含上下的空当）
  const free = (side, y0, y1) => y0 >= 0 && y1 < TH && used[side].every(([a, b]) => y1 < a || y0 > b);
  plans.sort((a, b) => a.side - b.side || a.p.y - b.p.y);
  // 每个出入口段头外面那一格（接线最后一步的上一格，地面）：还没轮到的口先留着，先接的组找路时不许从地面走（可以从高架上过）。
  // 以前不留：先接的组（多是储液罐那组）的接线正好走过另一个原料段头前面那一格，那组怎么找路都进不去，照旧从边缘送入；
  // 2026/10/19 量的：考卷 6 条线 × 小型仓 / 大型仓配送器，快速搜 120 张有 10 张这样，网页快档 60 张有 1 张，留了之后都接上
  for (const q of plans) {
    const seg = L.segments[q.p.kind === 'in' ? L.legs[q.p.leg].to : L.legs[q.p.leg].from];
    q.door = q.p.kind === 'in' ? `${seg.entryX - seg.dir},${seg.y}` : `${seg.exitX + seg.dout},${seg.y}`;
  }
  for (const q of plans) {
    const { p, side, size, shape } = q;
    q.tried = true;
    const leg = L.legs[p.leg];
    const seg = L.segments[p.kind === 'in' ? leg.to : leg.from];
    const target = p.kind === 'in' ? [seg.entryX, seg.y, 0] : [seg.exitX, seg.y, 0];
    const endDir = p.kind === 'in' ? dirIndex(seg.dir, 0) : dirIndex(-seg.dout, 0);
    const gx = side < 0 ? X0 - GAP_X : X1 + GAP_X;
    const ax = (rx) => gx + side * -rx; // 左边那侧的相对 x → 这一侧的绝对 x（左边 gx + rx，右边 gx − rx）
    const own = new Set([...leg.cells.map((c) => c.join(',')), ...(leg.direct ? [] : [`${leg.edge},${leg.py},0`])]);
    let done = false;
    const O = obstacles(L); // 这一组试各个位置时共用（试过的那块地试完拿掉）
    for (const r of plans) if (!r.tried) O.ground.add(r.door); // 还没轮到的口段头前那一格
    // 不接仓、照旧从边缘进出的口（矿等）往外那一行的地面留空（layout/shared.js 的 portRays）：仓组不压上去，接线只能从头顶过
    for (const [x, y] of portRays(L, (q) => plans.some((r) => r.p === q))) O.ground.add(`${x},${y}`);
    let tries = 0;
    // 进料带那一行：尽量和原来的出入口同一行，不行就往上、往下挪；真去找路的位置最多试 12 个
    for (let d = 0; d <= 2 * TH && !done && tries < 12; d++) {
      const yF = p.y + (d % 2 ? (d + 1) / 2 : -d / 2);
      const y0 = yF + shape.rect[1], y1 = yF + shape.rect[3];
      if (!free(side, y0 - GAP_Y, y1 + GAP_Y)) continue;
      const xs = [ax(shape.rect[0]), ax(shape.rect[2])];
      const rect = [Math.min(...xs), y0, Math.max(...xs), y1];
      if (maxWidth && Math.max(X1, rect[2]) - Math.min(X0, rect[0]) + 1 > maxWidth) break;
      let clash = O.solid.has(`${gx},${yF}`) || O.ground.has(`${gx},${yF}`);
      for (let x = rect[0]; x <= rect[2] && !clash; x++) for (let y = rect[1]; y <= rect[3]; y++) if (O.solid.has(`${x},${y}`) || O.ground.has(`${x},${y}`) || O.projection.has(`${x},${y}`)) clash = true;
      if (clash) continue;
      tries++;
      const added = [];
      for (let x = rect[0]; x <= rect[2]; x++) for (let y = rect[1]; y <= rect[3]; y++) if (!O.solid.has(`${x},${y}`)) { O.solid.add(`${x},${y}`); added.push(`${x},${y}`); }
      const path = pathfind([gx, yF, 0], target, O, TW, TH, maxLevel, dirIndex(-side, 0), own, endDir);
      for (const k of added) O.solid.delete(k);
      if (!path) continue;
      const { store, feed } = makeStore({ kind: p.kind, itemId: p.itemId, rate: p.rate ?? 0, size, shape, dist: spec.dist, side, gx, yF });
      leg.stub = [...feed, ...path.cells.slice(0, -1)].map((c) => c.slice());
      leg.cells = [];
      leg.shadow = [];
      leg.level = 0;
      leg.direct = true;
      [leg.edge, leg.py] = target;
      [p.x, p.y] = target;
      p.direct = true;
      leg.store = p.store = L.stores.length;
      L.stores.push({ ...store, leg: leg.id });
      used[side].push([y0 - GAP_Y, y1 + GAP_Y]);
      done = true;
    }
    if (!done) L.storeNotes.push(`${name(p.itemId)}的${p.kind === 'in' ? '原料' : '成品'}没接上${size.type === TANK ? '储液罐' : '储物仓'}（${maxWidth ? '宽度上限内放不下，或' : ''}接不上），照旧从边缘${p.kind === 'in' ? '送入' : '送出'}`);
  }
  for (const s of L.stores) if (s.minutes < STORE_MINUTES - 1e-6) L.storeNotes.push(`${name(s.itemId)}的${s.type === TANK ? '储液罐' : '储物仓'}叠到 ${s.layers} 层也只够 ${Math.floor(s.minutes)} 分钟`);
  cropToContent(L);
  if (maxHeight && L.height > maxHeight) L.storeNotes.push(`接上储物仓之后长 ${L.height} 格，超过上限 ${maxHeight} 格`);
  return L;
}

/**
 * 箱子供货又喷增产剂时，增产剂带（plan/addons.js 的 L.proLines）从边缘出来的那几条源头也接一组储物仓（用户 2026/10/18：整张图不用接带子）。
 * 增产剂那一步先在蓝图里面的空地上找仓位（storeSites），放不下才从边缘出来、走到这里。
 * 增产剂带从产线的外沿出发，组就摆在源头外面那一侧、同一行（往外伸，不用找路；那一行外面被挡住时上下挪几行、找路接上）。
 * 在增产剂之后、供电之前做；只挪坐标、加地，不裁边（裁边会按产线的带子重数带数，把增产剂带漏掉）。
 */
export function addProStores(L, { supply, sorter = 2013, maxLayers = 15, maxLevel = 6 } = {}) {
  const spec = SUPPLY[supply];
  if (!spec) return L;
  L.stores ||= [];
  L.storeNotes ||= [];
  for (const pl of L.proLines || []) {
    if (!pl.edge || pl.store != null || !pl.cells.length) continue;
    const port = L.ports.find((q) => q.spray && q.store == null && q.x === pl.edge[0] && q.y === pl.edge[1]);
    const start = pl.cells[0];
    const side = start[0] <= (L.width - 1) / 2 ? -1 : 1;
    const size = storeSize(pl.itemId, pl.rate ?? 0, { box: spec.box, sorter, maxLayers });
    const shape = shapeOf(size, 0);
    // 挪出地方：组的长度 + 上下各 4 行
    const room = shape.rect[2] - shape.rect[0] + 3;
    translateLayout(L, side < 0 ? room : 0, 4);
    L.width += room;
    L.height += 8;
    const s0 = pl.cells[0];
    const next = pl.cells.find((c) => c[0] !== s0[0] || c[1] !== s0[1]);
    const endDir = next ? dirIndex(Math.sign(next[0] - s0[0]), Math.sign(next[1] - s0[1])) : 4;
    const O = obstacles(L);
    for (const q of L.proLines) for (const [x, y, z] of q.cells) {
      O.belts.add(`${x},${y},${z}`);
      O.projection.add(`${x},${y}`);
    }
    for (const c of L.coaters || []) for (const z of [(c.z ?? 0) + 1, (c.z ?? 0) + 2]) O.belts.add(`${c.x},${c.y},${z}`);
    for (const [x, y] of portRays(L, (q) => q === port)) O.ground.add(`${x},${y}`); // 别的从边缘进出的口往外那一行留空
    const gx = s0[0] + side;
    let done = null;
    for (let d = 0; d <= 8 && !done; d++) {
      const yF = s0[1] + (d % 2 ? (d + 1) / 2 : -d / 2);
      const { store, feed } = makeStore({ kind: 'in', itemId: pl.itemId, rate: pl.rate ?? 0, size, shape, dist: spec.dist, side, gx, yF });
      const r = store.rect;
      if (r[1] < 0 || r[3] >= L.height || r[0] < 0 || r[2] >= L.width) continue;
      let clash = O.solid.has(`${gx},${yF}`) || O.ground.has(`${gx},${yF}`) || O.projection.has(`${gx},${yF}`);
      for (let x = r[0]; x <= r[2] && !clash; x++) for (let y = r[1]; y <= r[3]; y++) if (O.solid.has(`${x},${y}`) || O.ground.has(`${x},${y}`) || O.projection.has(`${x},${y}`)) clash = true;
      if (clash) continue;
      const added = [];
      for (let x = r[0]; x <= r[2]; x++) for (let y = r[1]; y <= r[3]; y++) if (!O.solid.has(`${x},${y}`)) { O.solid.add(`${x},${y}`); added.push(`${x},${y}`); }
      const path = pathfind([gx, yF, 0], [s0[0], s0[1], 0], O, L.width, L.height, maxLevel, dirIndex(-side, 0), new Set([s0.join(',')]), endDir);
      for (const k of added) O.solid.delete(k);
      if (path) done = { store, cells: [...feed, ...path.cells.slice(0, -1)] };
    }
    if (!done) {
      L.storeNotes.push('增产剂带的源头没接上储物仓，照旧从边缘送入');
      continue;
    }
    pl.cells = [...done.cells.map((c) => c.slice()), ...pl.cells];
    pl.edge = null;
    pl.store = L.stores.length;
    if (port) {
      port.store = pl.store;
      [port.x, port.y] = done.cells[0];
    }
    L.belts += done.cells.length;
    L.airBelts += done.cells.filter((c) => c[2] > 0).length;
    L.stores.push({ ...done.store, leg: null, pro: true });
  }
  // 挪出来的地方没用完：裁掉四周空着的行列（只挪坐标、改宽长，带数不重算）
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const inc = (x, y) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
  for (const p of L.pos.values()) {
    const hw = (p.g.bodyWidth - 1) / 2;
    for (const c of p.centers) { inc(c - hw, L.rowCy[p.row] - p.g.bodyBelow); inc(c + hw, L.rowCy[p.row] + p.g.bodyAbove); }
  }
  for (const ch of L.chains) for (const [x, y] of [...chainTiles(L, ch).main, ...chainTiles(L, ch).extra.flat()]) inc(x, y);
  for (const p of L.ports) inc(p.x, p.y);
  for (const b of [...(L.burners || []), ...(L.stores || [])]) { inc(b.rect[0], b.rect[1]); inc(b.rect[2], b.rect[3]); }
  for (const q of L.proLines || []) for (const [x, y] of q.cells) inc(x, y);
  for (const d of [...(L.coaters || []), ...(L.pilers || [])]) inc(d.x, d.y);
  translateLayout(L, -x0, -y0);
  L.width = x1 - x0 + 1;
  L.height = y1 - y0 + 1;
  L.area = L.width * L.height;
  return L;
}
