// 箱子供货（用户 2026/10/18 定，v2.3）：不接物流站时，原料从储物仓 / 储液罐出、成品进储物仓 / 储液罐，整张图不用接带子。
//   supply（左栏「供货」）：'box-s' 小型储物仓、'box-l' 大型储物仓，'dist-s'、'dist-l' 同样的仓、最上面那个顶上放物流配送器
//   （原料那边「向其他配送器需求」、成品那边「供应」，照用户的蓝图不和机甲交换）。液体（gamedata.js 的 FLUIDS）一律用储液罐，
//   带子直接接罐口，不放配送器。
// 每个原料入口、成品出口接一组：一截横着的进料带，仓排在带子上方、隔 1 行放分拣器（仓口在仓身里，分拣器长 1）；储液罐在带子的远头。
// 几个仓：先按流量 ÷ 分拣器速度（左栏的分拣器、长 1）喂得过来；再看 60 分钟的量（用户：储物仓要装得下整条线跑 60 分钟，成品也算），
// 叠层不超过 maxLayers（左栏「研究站最多叠几层」：推断储物仓、储液罐的叠层也是「垂直建造」管），叠满还装不下就加仓。
// 组摆在产线外框外面、出入口原来那一侧，一组一组竖着排（上下隔 GAP_Y 行、和产线隔 GAP_X 列，放供电设施）；组口用寻路接到那条带的
// 段头 / 段尾（照接物流站、就地烧副产物的做法），原来通到边缘的那截作废。在烧副产物之后、落地、增产剂、供电之前做。
// 间距（gamedata.js 的 STORE_BODY，体积测试第八张）：小型仓隔 3（实测能放），大型仓隔 6（隔 5 没测，先保守）。
import { FLUIDS, ITEMS, realItem, stackSize, STORE_BODY, BOX_SLOT, TANK_PORT } from '../gamedata.js';
import { obstacles, pathfind, dirIndex, cropToContent } from './stations.js';
import { translateLayout } from './coordinates.js';
import { SORTER_SPEED } from './sorters.js';
import { contentBox } from './burn.js';
import { chainTiles } from '../emit/blueprint.js';

export const SMALL_BOX = 2101;
export const BIG_BOX = 2102;
export const TANK = 2106;
/** 一个储液罐装多少（推断：BWIKI 写的储液罐容量 10000） */
export const TANK_CAP = 10000;
/** 左栏「供货」的几种：仓的种类、放不放配送器（edge 是原来的从边缘送入） */
export const SUPPLY = {
  'box-s': { box: SMALL_BOX, dist: false },
  'box-l': { box: BIG_BOX, dist: false },
  'dist-s': { box: SMALL_BOX, dist: true },
  'dist-l': { box: BIG_BOX, dist: true },
};
const PITCH = { [SMALL_BOX]: 3, [BIG_BOX]: 6 }; // 沿进料带每个仓占几列
const PER_BOX = { [SMALL_BOX]: 1, [BIG_BOX]: 3 }; // 一个仓朝带子那边能接几根分拣器
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
  const need = rate * 60;
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
    const n = size.type === SMALL_BOX ? 1 : Math.min(3, Math.max(1, Math.ceil(left / (size.count - j))));
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
    const slot = size.type === SMALL_BOX ? 7 : SOUTH_SLOT[r];
    const [dx, dy] = BOX_SLOT[size.type][slot];
    const boxPt = [boxes[box][0] + dx, yB + dy];
    const beltPt = [ax(rx), yF];
    return { box, slot, p0: kind === 'in' ? boxPt : beltPt.slice(), p1: kind === 'in' ? beltPt.slice() : boxPt, belt: beltPt }; // 各存一份：平移时逐个挪
  });
  const tank = size.type === TANK ? { x: ax(shape.tank), y: yF, slot: side < 0 ? 1 : 3 } : null;
  if (tank) tank.port = [tank.x + TANK_PORT[tank.slot][0], yF];
  const xs = [ax(shape.rect[0]), ax(shape.rect[2])];
  const rect = [Math.min(...xs), yF + shape.rect[1], Math.max(...xs), yF + shape.rect[3]];
  const store = { kind, itemId: realItem(itemId), rate, type: size.type, dist: dist && size.type !== TANK, count: size.count, layers: size.layers, minutes: size.minutes, side, gate: [gx, yF], boxes, sorters, tank, rect };
  return { store, feed };
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
  const ports = L.ports.filter((p) => !p.burn && p.station == null && (p.kind === 'in' || p.kind === 'out'));
  if (!ports.length) return L;
  const [cx0, cy0, cx1, cy1] = contentBox(L);
  const sprayed = (p) => p.kind === 'in' && sprayItems && (sprayItems === true || sprayItems.includes(realItem(p.itemId)));
  const plans = ports.map((p) => {
    const size = storeSize(p.itemId, p.rate ?? 0, { box: spec.box, sorter, maxLayers });
    return { p, side: p.x <= (cx0 + cx1) / 2 ? -1 : 1, size, shape: shapeOf(size, sprayed(p) ? SPRAY_TAIL : 0) };
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
  for (const s of L.stores) if (s.minutes < 60 - 1e-6) L.storeNotes.push(`${name(s.itemId)}的${s.type === TANK ? '储液罐' : '储物仓'}叠到 ${s.layers} 层也只够 ${Math.floor(s.minutes)} 分钟`);
  cropToContent(L);
  if (maxHeight && L.height > maxHeight) L.storeNotes.push(`接上储物仓之后长 ${L.height} 格，超过上限 ${maxHeight} 格`);
  return L;
}

/**
 * 箱子供货又喷增产剂时，增产剂带（plan/addons.js 的 L.proLines）从边缘出来的那几条源头也接一组储物仓（用户 2026/10/18：整张图不用接带子）。
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
