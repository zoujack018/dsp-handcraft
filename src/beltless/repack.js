// 无带流蓝图重新摆放：DSQ 的生成器（dsq.js）照原样出整张（分拣器、带子区、隔空连接都照它），这里把「机器连同贴着它的分拣器」
// 当一整块重新紧排，带子区（传送带、喷涂机）整块挪到外面，电力感应塔重新放。
// 贴蓝图时分拣器只和分拣器互撞，压在别的建筑上不算（游戏的 BuildTool_BlueprintPaste，game-rules 第 35 条），所以块与块之间只要
// 工厂碰撞框不重叠、分拣器不在同一列占同一格就行。分拣器、供电设施的判法照独立检查（src/emit/check.js）；
// 工厂的框取独立检查的框和游戏的建造盒里大的（GAME_FOOT）。
// 排法：同一种机器排成一行（中心对齐、靠左），一行排满或换了机器就另起一行，每行往下贴到不撞为止
import { factory, powerApart, powerCells, substationPad, STATION_CLEAR, STATION_EW } from '../gamedata.js';
import { POWER, powerReach } from '../plan/power.js';
import { SIDES, turn as quarter, placeZone, offsetRange, partsFit } from './perimeter.js';
import { attachStations, linkWarpers, linkSpray, STATION, SPAN } from './station.js';

const SORTERS = new Set([2011, 2012, 2013, 2014]);
const BELTS = new Set([2001, 2002, 2003]);
const COATER = 2313;
const TOWER = 2201;
const MACHINES = new Set([2302, 2315, 2319, 2303, 2304, 2305, 2318, 2309, 2317, 2308, 2310, 2901, 2902]);
const EPS = 1e-6;

const yawOf = (b) => ((Math.round(b.yaw?.[0] ?? 0) % 360) + 360) % 360;
const turn = (yaw, [dx, dy]) => (yaw === 90 ? [dy, -dx] : yaw === 180 ? [-dx, -dy] : yaw === 270 ? [-dy, dx] : [dx, dy]);

/**
 * 游戏的建造盒比独立检查的框大出来的（朝北时相对建筑位置，格；out/colliders，game-rules 第 35 条）：
 * 原油精炼厂北边到 +2.63（检查的框到 +2.4，横着放时北边朝东，挨着的制造台按检查不撞、游戏里撞），化工厂东边到 +3.42
 */
const GAME_FOOT = {
  2308: { x0: -1.39, x1: 1.41, y0: -3.11, y1: 2.63 },
  2309: { x0: -3.19, x1: 3.43, y0: -1.28, y1: 2.23 },
  2317: { x0: -3.19, x1: 3.43, y0: -1.28, y1: 2.23 },
};
const HIGH_LAT = new Set([2309, 2317, 2308]); // 高纬度间距展开时东西向两边各多让 1 格的（化工厂、量子化工厂、原油精炼厂，gamedata.js 的 GEOMETRY_HIGH_LATITUDE）
/** 工厂的框：独立检查的框（check.js 的 box）和游戏的建造盒取大的；wide：高纬度间距展开（HIGH_LAT 东西向两边各宽 1 格）。中心、宽高 */
function bodyOf(b, wide = false) {
  const f = factory(b.itemId);
  const yaw = yawOf(b);
  const [sx, sy] = turn(yaw, f.colliderShift ?? [0, 0]);
  const [w, h] = yaw % 180 ? [f.collider[1], f.collider[0]] : f.collider;
  const p = b.localOffset[0];
  let [x0, x1, y0, y1] = [p.x + sx - w / 2, p.x + sx + w / 2, p.y + sy - h / 2, p.y + sy + h / 2];
  const g = GAME_FOOT[b.itemId];
  if (g) {
    const [a, c] = [turn(yaw, [g.x0, g.y0]), turn(yaw, [g.x1, g.y1])];
    x0 = Math.min(x0, p.x + Math.min(a[0], c[0]));
    x1 = Math.max(x1, p.x + Math.max(a[0], c[0]));
    y0 = Math.min(y0, p.y + Math.min(a[1], c[1]));
    y1 = Math.max(y1, p.y + Math.max(a[1], c[1]));
  }
  if (wide && HIGH_LAT.has(b.itemId)) [x0, x1] = [x0 - 1, x1 + 1];
  return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 };
}
/** 整张的外框（按占地：工厂的框，物流站 7×7，喷涂机 3×1，卫星配电站 3×3，带子、分拣器、电力感应塔每个端点那一格） */
function footprint(B, wide = false) {
  const r = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
  const grow = (x, y, hw, hh) => {
    r.x0 = Math.min(r.x0, x - hw);
    r.x1 = Math.max(r.x1, x + hw);
    r.y0 = Math.min(r.y0, y - hh);
    r.y1 = Math.max(r.y1, y + hh);
  };
  for (const b of B) {
    const p = b.localOffset[0];
    if (MACHINES.has(b.itemId)) {
      const f = bodyOf(b, wide);
      grow(f.x, f.y, f.w / 2, f.h / 2);
    } else if (b.itemId === STATION) grow(p.x, p.y, 3.5, 3.5);
    else if (b.itemId === COATER) grow(p.x, p.y, yawOf(b) % 180 ? 1.5 : 0.5, yawOf(b) % 180 ? 0.5 : 1.5);
    else if (b.itemId === POWER.substation.itemId) grow(p.x, p.y, 1.5, 1.5);
    else for (const q of b.localOffset) grow(q.x, q.y, 0.5, 0.5);
  }
  return r;
}
/** 分拣器占的一段（同独立检查：竖着的按所在列、横着的按所在行分组，同组里横向差不到 0.5、又有重叠就算撞） */
function spanOf(s) {
  const [p0, p1] = s.localOffset;
  const v = Math.abs(p1.x - p0.x) <= 0.01;
  return v ? { v, across: p0.x, lo: Math.min(p0.y, p1.y), hi: Math.max(p0.y, p1.y) } : { v, across: p0.y, lo: Math.min(p0.x, p1.x), hi: Math.max(p0.x, p1.x) };
}
const spanKey = (s, tx, ty) => `${s.v ? 'x' : 'y'}${Math.round(s.across + (s.v ? tx : ty))}`;
const overlap = (a, b) => Math.abs(a.x - b.x) < (a.w + b.w) / 2 - EPS && Math.abs(a.y - b.y) < (a.h + b.h) / 2 - EPS;

/** 一块（机器、叠在上面的研究站、贴着它的分拣器）的外框，相对蓝图原点 */
function frameOf(u) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const b of u.bodies) {
    x0 = Math.min(x0, b.x - b.w / 2);
    x1 = Math.max(x1, b.x + b.w / 2);
    y0 = Math.min(y0, b.y - b.h / 2);
    y1 = Math.max(y1, b.y + b.h / 2);
  }
  for (const s of u.spans) {
    const [ax0, ax1, ay0, ay1] = s.v ? [s.across - 0.25, s.across + 0.25, s.lo - 0.5, s.hi + 0.5] : [s.lo - 0.5, s.hi + 0.5, s.across - 0.25, s.across + 0.25];
    x0 = Math.min(x0, ax0);
    x1 = Math.max(x1, ax1);
    y0 = Math.min(y0, ay0);
    y1 = Math.max(y1, ay1);
  }
  return { x0, x1, y0, y1 };
}

/** 已放好的块：工厂框（按 4 格见方的桶找邻居）、分拣器占的段；overBody 为假时分拣器当一条细框，不许压别的机器。配电站的空位（solid）分拣器一直不许压 */
function occupancy(overBody) {
  const S = 4;
  const buckets = new Map();
  const spans = new Map();
  const stubs = [];
  let solid = false;
  const bucketKeys = (r) => {
    const out = [];
    for (let i = Math.floor((r.x - r.w / 2) / S); i <= Math.floor((r.x + r.w / 2) / S); i++) for (let j = Math.floor((r.y - r.h / 2) / S); j <= Math.floor((r.y + r.h / 2) / S); j++) out.push(`${i},${j}`);
    return out;
  };
  const stubOf = (s, tx, ty) => (s.v ? { x: s.across + tx, y: (s.lo + s.hi) / 2 + ty, w: 0.42, h: s.hi - s.lo } : { x: (s.lo + s.hi) / 2 + tx, y: s.across + ty, w: s.hi - s.lo, h: 0.42 });
  const fits = (u, tx, ty) => {
    for (const b of u.bodies) {
      const r = { x: b.x + tx, y: b.y + ty, w: b.w, h: b.h };
      for (const k of bucketKeys(r)) for (const o of buckets.get(k) ?? []) if (overlap(r, o)) return false;
      if (!overBody || b.solid) for (const o of stubs) if (overlap(r, o)) return false;
    }
    if (!overBody || solid)
      for (const s of u.spans) {
        const r = stubOf(s, tx, ty);
        for (const k of bucketKeys(r)) for (const o of buckets.get(k) ?? []) if ((!overBody || o.solid) && overlap(r, o)) return false;
      }
    for (const s of u.spans) {
      const across = s.across + (s.v ? tx : ty);
      const lo = s.lo + (s.v ? ty : tx);
      const hi = s.hi + (s.v ? ty : tx);
      for (const o of spans.get(spanKey(s, tx, ty)) ?? []) if (Math.abs(across - o.across) < 0.5 && lo <= o.hi && o.lo <= hi) return false;
    }
    return true;
  };
  const put = (u, tx, ty) => {
    for (const s of u.spans) stubs.push(stubOf(s, tx, ty));
    for (const b of u.bodies) {
      const r = { x: b.x + tx, y: b.y + ty, w: b.w, h: b.h, solid: b.solid };
      solid ||= !!b.solid;
      for (const k of bucketKeys(r)) (buckets.get(k) ?? buckets.set(k, []).get(k)).push(r);
    }
    for (const s of u.spans) {
      const k = spanKey(s, tx, ty);
      (spans.get(k) ?? spans.set(k, []).get(k)).push({ across: s.across + (s.v ? tx : ty), lo: s.lo + (s.v ? ty : tx), hi: s.hi + (s.v ? ty : tx) });
    }
  };
  return { fits, put };
}

/**
 * 一排一排：units 照给的顺序从左往右贴紧排成一行，底边对齐（机器位置是整格，底边差不到半格），排到宽度 W 另起一行。
 * 一行排好后整行往下贴：在上一行之上找最低的、整行都不撞的位置。返回每块的平移和占到的高度。
 * street：{ every, gap } 时行和行之间留供电道放卫星配电站（整宽空出 gap 格高，分拣器也不进）：一行的顶离最近的供电线
 * （底边、上一条道的中线）超过 every 格，就把这一行整行抬到已排好的最高处上面 gap 格。
 * holes：{ every, half, pads } 时在行里留供电的空位：空位当一台只有身子的块（中心到边 half 格，pads 时四面再让出两边那两台该让
 * 卫星配电站的 pad 格；同一种机器挨着排，上下几行多半也是这种），别的机器、分拣器都不进；
 * 每开一行估它落在哪（已排好的最高处往上半行），到了下一条空位线（隔 every 格一条，第一条在 every / 2）就是排空位的一行，
 * 行里隔 every 格放一个，一排一排错开半个 every；holes.before（块的编号）时不按网格，排到这几块时在它前面放一个，
 * 再有 holes.swap 时空位顶掉那一块的位置、那一块挪到最后排
 */
function packShelves(units, W, overBody, street = null, holes = null) {
  const all = occupancy(overBody);
  const at = new Map();
  let top = 0;
  let line = -Infinity; // 上一行的底边
  let floor = -Infinity; // 最近一条供电道的上沿：之后的行整行在它上面
  let power = 0; // 最近一条供电线
  // 一行整行往下贴到哪（在上一行之上、整行都不撞的最低处）
  const dropOf = (row) => {
    const lo = Math.min(...row.map(({ u, ty }) => u.frame.y0 + ty));
    let by = Math.max(line + 1, 0, Math.ceil(floor - lo - EPS));
    while (!row.every(({ u, tx, ty }) => all.fits(u, tx, ty + by))) by++;
    return by;
  };
  const close = (row) => {
    const lo = Math.min(...row.map(({ u, ty }) => u.frame.y0 + ty));
    let by = dropOf(row);
    if (street && at.size && Math.max(...row.map(({ u, ty }) => u.frame.y1 + ty)) + by > power + street.every + EPS) {
      floor = top + street.gap;
      power = top + street.gap / 2;
      by = Math.max(by, Math.ceil(floor - lo - EPS));
    }
    for (const { u, tx, ty } of row) {
      all.put(u, tx, ty + by);
      at.set(u, [tx, ty + by]);
      top = Math.max(top, u.frame.y1 + ty + by);
      right = Math.max(right, u.frame.x1 + tx);
    }
    line = by;
  };
  let row = [];
  let here = occupancy(overBody); // 这一行自己（底边放在 y = 0）
  const place = (u) => {
    const ty = Math.round(-u.base);
    let tx = Math.ceil(-u.frame.x0 - EPS);
    if (row.length) tx = Math.max(tx, row[row.length - 1].tx + Math.floor(row[row.length - 1].u.frame.x0 - u.frame.x0));
    while (!here.fits(u, tx, ty)) tx++;
    return { tx, ty };
  };
  const hole = (pad) => {
    const h = holes.half + pad;
    return { members: [], bodies: [{ x: 0, y: 0, w: 2 * h, h: 2 * h, solid: true }], spans: [], frame: { x0: -h, x1: h, y0: -h, y1: h }, base: -h };
  };
  let line2 = holes?.every ? holes.every / 2 : Infinity; // 下一条空位线
  let odd = false;
  let holeX = Infinity; // 这一行下一个空位在哪
  const startRow = (u) => {
    holeX = Infinity;
    if (!holes?.every || top + (u.frame.y1 - u.frame.y0) / 2 < line2 - EPS) return;
    holeX = holes.every * (odd ? 1 : 0.5);
    odd = !odd;
    line2 += holes.every;
  };
  const add = (u, p) => {
    here.put(u, p.tx, p.ty);
    row.push({ u, ...p });
  };
  // 换位顶掉的块（holes.swap）先放着，哪一行排满前右头还空得下就塞进去，最后还剩的接着往后排
  const spare = [];
  // （塞了会让这一行整行抬高的不塞：别种机器的分拣器常和上下行的撞）
  // 也不塞出已经排好的那几行的右沿（W 只是上限，各行常排不满，塞出去整张就宽了）
  let right = 0;
  const fillSpare = () => {
    const edge = Math.min(W, Math.max(right, ...row.map(({ u, tx }) => u.frame.x1 + tx)));
    for (let k = 0; k < spare.length; k++) {
      const p = place(spare[k]);
      if (spare[k].frame.x1 + p.tx > edge + EPS || (row.length && dropOf([...row, { u: spare[k], ...p }]) > dropOf(row))) continue;
      add(spare[k], p);
      spare.splice(k--, 1);
    }
  };
  const newRow = (u) => {
    if (holes?.fill) fillSpare();
    close(row);
    row = [];
    here = occupancy(overBody);
    startRow(u);
  };
  if (units.length) startRow(units[0]);
  const queue = units.slice();
  const holed = new Set();
  for (let i = 0; i < queue.length || spare.length; i++) {
    if (i === queue.length) queue.push(spare.shift());
    const u = queue[i];
    let p = place(u);
    // 定点的空位（holes.before：块的编号）：排这一块之前先放一个（这一行放不下就放到下一行头上）；
    // holes.swap 时空位顶掉这一块的位置，这一块先放着（后面的块不跟着往后挤）：holes.fill 时塞进哪一行右头的空余，不然排到最后
    if (holes?.before?.has(u.key) && !holed.has(u.key)) {
      holed.add(u.key);
      const h = hole(holes.pads ? Math.max(u.pad, row[row.length - 1]?.u.pad ?? 0) : 0);
      let q = place(h);
      if (h.frame.x1 + q.tx > W + EPS && row.length) {
        newRow(u);
        q = place(h);
      }
      if (h.frame.x1 + q.tx > W + EPS) return null;
      add(h, q);
      if (holes.swap) {
        spare.push(u);
        continue;
      }
      p = place(u);
    }
    // 到了空位的地方：先放一个空位（这一行放不下了就不放）
    while (holes?.every && p.tx + u.frame.x0 >= holeX - holes.half - EPS) {
      const h = hole(holes.pads ? Math.max(u.pad, row[row.length - 1]?.u.pad ?? 0) : 0);
      const q = place(h);
      if (h.frame.x1 + q.tx > W + EPS) {
        holeX = Infinity;
        break;
      }
      add(h, q);
      holeX += holes.every;
      p = place(u);
    }
    if (u.frame.x1 + p.tx > W + EPS) {
      if (!row.length) return null; // 这个宽度连这一块都放不下
      newRow(u);
      p = place(u);
      if (u.frame.x1 + p.tx > W + EPS) return null;
    }
    add(u, p);
  }
  if (row.length) close(row);
  return { at, top };
}

/**
 * 重新摆放 DSQ 出的建筑表（不改它的对象）：返回新的建筑表（index、上下游重新编号；DSQ 的电力感应塔换成重新放的）。
 * opt.aspect：外框想要的长宽比（宽 ÷ 高，默认 16/9，只拿来在几种宽度里挑）；opt.sorterOverBody：分拣器能不能伸进别的机器的碰撞框（默认能）；
 * opt.zoneAt：带子区放在机器那一圈的哪儿 { side, offset }（perimeter.js；默认照挑中的那条边、从起点放）；
 * opt.station：接物流站 { pile 出货叠几层 }（station.js：原料、产物带挪到站口上；接不了时照不接的出，zone.stationSkip 写为什么）；
 * opt.partShift：接了站时各块（站、中间产物带）在默认位置上再挪多少格 [[dx, dy], …]（页面上拖的；放不下时整个不挪，zone.shiftRejected 为真）；
 * opt.power：'substation' 放卫星配电站，别的放电力感应塔（行里留空位 HOLES、行间留供电道 STREETS 都试，挑外框小的）；opt.wide：化工厂、精炼厂高纬度间距展开；
 * opt.limits：{ maxWidth, maxHeight, maxAspect } 左栏的宽、长、长宽比上限（挑宽度时先挑守得住的，守不住照最好的出，zone.limitMiss 为真）。
 * 返回 { buildings, towers 塔数, uncovered 没够着的（工厂、分拣器、喷涂机、站）, missed 框里够不着的 [x, y, 块的编号], fixed 挑中的 { order 顺序, W 宽度 },
 *   zone: { side, offset, zone 带子区（连站）原来的外框, machines 机器的外框, box 放好的外框, stations,
 *   parts: [{ kind, members 建筑编号, box, center 站心, shift }]（接了站时）, span 站心至少隔几格 } }
 */
export function repack(buildings, opt = {}) {
  if (opt.street !== undefined) return repackOnce(buildings, opt);
  // 先试行里留空位（从稀往密），再试供电道
  const type = opt.power === 'substation' ? 'substation' : 'tesla';
  const tries = [...HOLES[type].map((holes) => ({ holes })), ...STREETS[type].map((street) => ({ street }))];
  // 留不留、怎么留只看默认位置（带子区、各块都没拖）：拖过以后复制时机器不跟着变
  const plain = !opt.zoneAt && !opt.partShift;
  const probe = (t) => repackOnce(buildings, { ...opt, zoneAt: undefined, partShift: undefined, street: null, holes: null, ...t });
  let out = probe({});
  const plainOut = out;
  let pick = {};
  // 机器不多的每种都试（默认位置全够得着也试：放在外面的供电会撑大外框），挑都够得着里分（同挑宽度：外框按占地的面积，偏离长宽比加罚；
  // 有宽长上限时先挑守得住的）最小的；多的（每试一种都得整张重排）挑头一个都够得着的
  const all = buildings.filter((b) => MACHINES.has(b.itemId)).length <= 600;
  const aspect = opt.aspect ?? 16 / 9;
  const cost = (r) => {
    const f = footprint(r.buildings, !!opt.wide);
    const [w, h] = [f.x1 - f.x0, f.y1 - f.y0];
    return (r.zone?.limitMiss ? 1e12 : 0) + w * h * (1 + 0.4 * Math.abs(Math.log(w / h / aspect)));
  };
  let fewest = out.uncovered;
  const consider = (t, r) => {
    if (r && (r.uncovered < fewest || (!r.uncovered && !fewest && cost(r) < cost(out) - EPS))) [fewest, pick, out] = [r.uncovered, t, r];
  };
  // 带子区折了，上面那块空地就没了（原来供电常放那儿）：机器不多的也试不折的，放好供电再比
  if (all) consider({ fold: false }, probe({ fold: false }));
  // 照默认那张的顺序，宽度在它的往上 k 格里挑（只重排这几种，比整张换排法便宜得多）
  const around = (k, from = out) => ({ order: from.fixed.order, W: Array.from({ length: k + 1 }, (_, i) => from.fixed.W + i) });
  // 定点留空位（机器不多的）：默认那张框里够不着的机器、分拣器扎堆的地方，挑一块在它前面留空位，再排再看，还有够不着的再补，最多几轮
  if (all && out.missed.length) {
    const { half, pads } = HOLES[type][0];
    const reach = powerReach(type).cover - AIM_SLACK[type];
    const fixed = around(AIM_WIDEN[type]);
    const before = new Set();
    let r = out;
    for (let k = 0; k < AIM_ROUNDS && r?.missed.length; k++) {
      const add = aimHoles(r.missed, reach, before);
      if (!add.length) break;
      for (const key of add) before.add(key);
      const t = { holes: { half, pads, before: new Set(before) }, fixed };
      r = probe(t);
      consider(t, r);
    }
  }
  // 卫星配电站换位留空位（机器不多的）：在够不着的那片附近挑自己和四周都不用给配电站让的块（熔炉、制造台、单层研究站这类），
  // 空位顶掉它的位置、它挪到最后排（别的行不跟着挤，挤掉的进最后一行的空余）；同样照默认那张的顺序、宽度往上几格里排，最多补几轮
  if (all && type === 'substation' && plainOut.missed.length) {
    const { half, pads } = HOLES[type][0];
    const reach = powerReach(type).cover - AIM_SLACK[type];
    const fixed = around(AIM_WIDEN[type], plainOut);
    // 挤掉的塞不塞进别的行右头的空余（fill），两种各自从头补到底
    for (const fill of [false, true]) {
      const before = new Set();
      let r = plainOut;
      for (let k = 0; k < AIM_ROUNDS && r?.missed.length; k++) {
        const add = swapSites(r, reach, before);
        if (!add.length) break;
        for (const key of add) before.add(key);
        const t = { holes: { half, pads, before: new Set(before), swap: true, fill }, fixed };
        r = probe(t);
        consider(t, r);
      }
    }
  }
  // 机器多的电力感应塔：空位要一档档往密里试（稀的够不着），整张换排法一档就要好几秒，先照默认那张的顺序、宽度往上几格里排，
  // 各档都够不着再整张搜（卫星配电站头一两档就够得着，照旧整张搜）
  const quick = all || type !== 'tesla' ? [] : HOLES[type].map((holes) => ({ holes, fixed: around(QUICK_WIDEN) }));
  if (fewest || all)
    for (const t of [...quick, ...tries]) {
      if (!fewest && !all) break;
      consider(t, probe(t));
    }
  return plain ? out : repackOnce(buildings, { ...opt, street: null, holes: null, ...pick });
}
/** 定点补空位：空位离要够着的点让出的格数（插空位会把后面的机器往右挤，空位也不正好落在要的地方）；宽度在原来的往上几格里挑；最多补几轮 */
const AIM_SLACK = { substation: 4, tesla: 2 };
const AIM_WIDEN = { substation: 6, tesla: 2 };
const AIM_ROUNDS = 4;
/** 机器多的电力感应塔按网格留空位先快排：宽度在默认那张的往上几格里挑 */
const QUICK_WIDEN = 6;
/**
 * 定点留空位放在哪几块前面：够不着的点（[x, y, 块的编号]）里挑一个当中心，reach 以内够不着的点最多的，划掉再挑，直到都划掉；
 * 每个中心取离它最近的、还没留过空位的那块
 */
function aimHoles(points, reach, used) {
  const left = points.slice();
  const out = [];
  const near = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 <= reach * reach;
  while (left.length) {
    let best = null;
    for (const p of left) {
      let n = 0;
      for (const q of left) if (near(p, q)) n++;
      if (!best || n > best.n) best = { p, n };
    }
    const c = best.p;
    let key = null;
    let d = Infinity;
    for (const q of points) {
      const e = (q[0] - c[0]) ** 2 + (q[1] - c[1]) ** 2;
      if (q[2] != null && !used.has(q[2]) && !out.includes(q[2]) && e < d) [key, d] = [q[2], e];
    }
    if (key != null) out.push(key);
    for (let i = left.length - 1; i >= 0; i--) if (near(c, left[i])) left.splice(i, 1);
  }
  return out;
}
/**
 * 带子区折不折、怎么折（不接站时）：只有地面上的带子（有喷涂机、高处的带子时不折），DSQ 原样一条链一列、各列挨着、从同一行往上排。
 * 比平均长 1.5 倍以上的链折成几列蛇形（上去、拐一格、下来），每列最高 H 节（不折的那些里最长那条，至少平均长、2 节），列数最少；
 * 别的整条不动，只往左挤。原料链的带头（贴了标签的口）留在最上一行，产物链最后一列往上走、带尾在最上一行；口都在朝外那头，同 DSQ。
 * 返回 { chains（照列从左到右）, x0 第一列, y0 底行, top 最长那条的节数, options: [[H, 宽, 高]…]（头一个是不折，第二个是折） }，折不了返回 null
 */
function foldPlan(zone) {
  if (zone.some((b) => !BELTS.has(b.itemId) || b.localOffset[0].z > 0.01)) return null;
  const at = new Map(zone.map((b) => [b.index, b]));
  const fed = new Set(zone.map((b) => b.outputObjIdx).filter((i) => at.has(i)));
  const chains = [];
  for (const b of zone) {
    if (fed.has(b.index)) continue;
    const nodes = [];
    for (let n = b; n && nodes.length <= zone.length; n = at.get(n.outputObjIdx)) nodes.push(n);
    chains.push({ nodes, kind: nodes[0].parameters?.iconId ? 'in' : nodes[nodes.length - 1].parameters?.iconId ? 'out' : 'mid' });
  }
  if (!chains.length || chains.reduce((a, c) => a + c.nodes.length, 0) !== zone.length) return null;
  const y0 = Math.min(...zone.map((b) => b.localOffset[0].y));
  const xOf = (c) => c.nodes[0].localOffset[0].x;
  for (const c of chains) {
    const ys = c.nodes.map((n) => n.localOffset[0].y).sort((a, b) => a - b);
    if (c.nodes.some((n) => Math.abs(n.localOffset[0].x - xOf(c)) > EPS) || ys.some((y, i) => Math.abs(y - y0 - i) > EPS)) return null;
  }
  chains.sort((a, b) => xOf(a) - xOf(b));
  if (chains.some((c, i) => i && Math.abs(xOf(c) - xOf(chains[i - 1]) - 1) > EPS)) return null;
  // 只折比平均长 1.5 倍以上的，折成和不折的那些里最长的一样高（至少平均长、2 节），列数最少
  const lens = chains.map((c) => c.nodes.length);
  const top = Math.max(...lens);
  const avg = lens.reduce((a, n) => a + n, 0) / lens.length;
  const H = Math.max(2, Math.ceil(avg), ...lens.filter((n) => n <= 1.5 * avg));
  const options = [[top, chains.length, top]];
  if (H < top) options.push([H, lens.reduce((a, n) => a + (n <= H ? 1 : Math.ceil(n / H)), 0), H]);
  return { chains, x0: xOf(chains[0]), y0, top, options };
}
/** 照 foldPlan 折成每列最高 H 节：位置、朝向（每节朝着下一节，最后一节顺着它那一列）改在原来的对象上 */
function layFold(f, H) {
  const HEADING = { '0,1': 0, '1,0': 90, '0,-1': 180, '-1,0': 270 };
  let x = f.x0;
  for (const c of f.chains) {
    const n = c.nodes.length;
    if (n <= H) {
      for (const b of c.nodes) for (const p of new Set(b.localOffset)) p.x = x;
      x += 1;
      continue;
    }
    const m = Math.ceil(n / H);
    // 原料：第一列满、从顶上往下流（带头在最上一行），不满的在最后；产物：不满的那列放最前，最后一列满、往上走（带尾在最上一行）；
    // 中间产物同原料的分法、第一列往上
    const out = c.kind === 'out';
    const first = out ? n - (m - 1) * H : H; // 第一列几节
    const d0 = c.kind === 'in' || (out && m % 2 === 0) ? -1 : 1;
    const pos = c.nodes.map((_, k) => {
      const col = k < first ? 0 : 1 + Math.floor((k - first) / H);
      const j = k < first ? k : (k - first) % H;
      const len = col ? H : first;
      const d = col % 2 ? -d0 : d0;
      // 不满的第一列（产物）贴着它拐弯的那头：往上的占顶上几格、往下的占底下几格
      const lo = col === 0 && len < H && d > 0 ? H - len : 0;
      return [x + col, d > 0 ? f.y0 + lo + j : f.y0 + len - 1 - j, d];
    });
    c.nodes.forEach((b, k) => {
      const [px, py, d] = pos[k];
      const next = pos[k + 1];
      const yaw = next ? HEADING[`${next[0] - px},${next[1] - py}`] : d > 0 ? 0 : 180;
      for (const p of new Set(b.localOffset)) [p.x, p.y] = [px, py];
      b.yaw = [yaw, yaw];
    });
    x += m;
  }
}
/**
 * 换位留空位顶掉哪几块：够不着的点里挑一个当中心（reach 以内够不着的点最多的），reach 以内挑离它最近的、自己和四周 3 格内的块都不用
 * 给卫星配电站让的那块（精炼厂、化工厂、对撞机、叠层研究站要让 1~1.5 格，空位要 6×6，比这几种一行高，整行都会撑开），
 * 划掉它够得着的点（和中心附近的）再挑。r：上一张的 missed、spots（每块排好的外框、要让几格）
 */
function swapSites(r, reach, used) {
  const near = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 <= reach * reach;
  const mid = (s) => [(s.x0 + s.x1) / 2, (s.y0 + s.y1) / 2];
  const free = r.spots.filter((s) => !s.pad && !used.has(s.key) && !r.spots.some((o) => o.pad > 0 && o.x0 < s.x1 + 3 && o.x1 > s.x0 - 3 && o.y0 < s.y1 + 3 && o.y1 > s.y0 - 3));
  const left = r.missed.slice();
  const out = [];
  while (left.length) {
    let best = null;
    for (const p of left) {
      let n = 0;
      for (const q of left) if (near(p, q)) n++;
      if (!best || n > best.n) best = { p, n };
    }
    const c = best.p;
    let site = null;
    for (const s of free) if (!out.includes(s.key) && near(mid(s), c) && (!site || (mid(s)[0] - c[0]) ** 2 + (mid(s)[1] - c[1]) ** 2 < (mid(site)[0] - c[0]) ** 2 + (mid(site)[1] - c[1]) ** 2)) site = s;
    if (site) out.push(site.key);
    for (let i = left.length - 1; i >= 0; i--) if (near(c, left[i]) || (site && near(mid(site), left[i]))) left.splice(i, 1);
  }
  return out;
}
/**
 * 空位从稀往密试（every：上下、左右隔几格一个；错开排时最远的点离空位约 0.56 个 every）：卫星配电站覆盖 20.7 格，空位 3×3 再加让的；
 * 电力感应塔覆盖 8 格，塔 0.48 格见方、离工厂的框要 0.25 格，空位半格见方就够（贴着的两台中心隔开塔要的距离，分拣器也进不来）
 */
const HOLES = {
  substation: [30, 26, 22, 18].map((every) => ({ every, half: 1.5, pads: true })),
  tesla: [16, 14, 12, 10].map((every) => ({ every, half: 0.25, pads: false })),
};
/** 供电道从宽松往紧试（every 隔几行一条，gap 多高）：卫星配电站覆盖 20.7 格，道两边各十几行都够得着；电力感应塔覆盖 8 格，道窄、隔得密 */
const STREETS = {
  substation: [{ every: 34, gap: 4 }, { every: 34, gap: 6 }, { every: 26, gap: 4 }, { every: 26, gap: 6 }, { every: 18, gap: 4 }, { every: 18, gap: 6 }],
  tesla: [{ every: 12, gap: 2 }, { every: 12, gap: 3 }, { every: 8, gap: 2 }, { every: 8, gap: 3 }, { every: 5, gap: 2 }],
};

function repackOnce(buildings, opt) {
  const B = buildings.map((b) => structuredClone(b));
  const isMachine = (b) => !!b && MACHINES.has(b.itemId);
  // 叠着的研究站跟最下面那台；分拣器两头都接工厂的（无带流里没有，保险起见）两块并成一块
  const root = new Map();
  const find = (i) => (root.get(i) === i ? i : (root.set(i, find(root.get(i))), root.get(i)));
  for (const b of B) if (isMachine(b)) root.set(b.index, b.index);
  for (const b of B) if (isMachine(b) && b.localOffset[0].z > 0.01 && isMachine(B[b.inputObjIdx])) root.set(find(b.index), find(b.inputObjIdx));
  for (const b of B) if (SORTERS.has(b.itemId) && isMachine(B[b.inputObjIdx]) && isMachine(B[b.outputObjIdx])) root.set(find(b.inputObjIdx), find(b.outputObjIdx));
  const units = new Map();
  const zone = [];
  for (const b of B) {
    if (b.itemId === TOWER) continue;
    let r = isMachine(b) ? find(b.index) : null;
    if (SORTERS.has(b.itemId)) r = isMachine(B[b.inputObjIdx]) ? find(b.inputObjIdx) : isMachine(B[b.outputObjIdx]) ? find(b.outputObjIdx) : null;
    if (r == null) {
      zone.push(b);
      continue;
    }
    const u = units.get(r) ?? units.set(r, { key: r, members: [], bodies: [], spans: [], kind: `${B[r].itemId}:${yawOf(B[r])}` }).get(r);
    u.members.push(b);
    if (isMachine(b) && b.localOffset[0].z <= 0.01) u.bodies.push(bodyOf(b, !!opt.wide));
    if (SORTERS.has(b.itemId)) u.spans.push(spanOf(b));
  }
  const list = [...units.values()];
  for (const u of list) {
    u.frame = frameOf(u);
    u.base = Math.min(...u.bodies.map((b) => b.y - b.h / 2));
  }
  // 卫星配电站离这一块要让多少（substationPad 四边里最大的）：行里留空位时空位两边照它让
  for (const u of list) {
    const b = u.members.find((x) => isMachine(x) && x.localOffset[0].z <= 0.01);
    const stacked = u.members.some((x) => isMachine(x) && x.localOffset[0].z > 0.01);
    u.pad = Math.max(0, ...Object.values(substationPad({ kind: KIND[b.itemId], levels: stacked ? 2 : 1 }).margin ?? {}));
  }
  // 同一种机器挨着排；种与种的先后试三种：照 DSQ 的顺序（按生产链）、高的在前、矮的在前
  const first = (u) => u.members[0].index;
  const tall = (u) => u.frame.y1 - u.frame.y0;
  const kindAt = new Map();
  for (const u of list.slice().sort((a, b) => first(a) - first(b))) if (!kindAt.has(u.kind)) kindAt.set(u.kind, kindAt.size);
  const kindTall = new Map();
  for (const u of list) kindTall.set(u.kind, Math.max(kindTall.get(u.kind) ?? 0, tall(u)));
  const byKinds = (rank) => list.slice().sort((a, b) => rank(a.kind) - rank(b.kind) || kindAt.get(a.kind) - kindAt.get(b.kind) || first(a) - first(b));
  const orders = [byKinds((k) => kindAt.get(k)), byKinds((k) => -kindTall.get(k)), byKinds((k) => kindTall.get(k))];

  // 带子区（传送带、喷涂机）整块的外框
  let zx0 = Infinity, zx1 = -Infinity, zy0 = Infinity, zy1 = -Infinity;
  for (const b of zone) {
    const p = b.localOffset[0];
    const [hw, hh] = b.itemId === COATER ? (yawOf(b) % 180 ? [1.5, 0.5] : [0.5, 1.5]) : [0.5, 0.5];
    zx0 = Math.min(zx0, p.x - hw);
    zx1 = Math.max(zx1, p.x + hw);
    zy0 = Math.min(zy0, p.y - hh);
    zy1 = Math.max(zy1, p.y + hh);
  }
  const hasZone = zone.length > 0;
  // 接物流站：带子重新排在站周围（station.js），站并进带子区整块放
  const tried = hasZone && opt.station ? attachStations(B, zone, opt.station) : null;
  const attached = tried?.added ? tried : null;
  const block = attached ? attached.box : { x0: zx0, x1: zx1, y0: zy0, y1: zy1 };
  if (attached) zone.push(...attached.added);
  const zw = hasZone ? block.x1 - block.x0 : 0;
  const zh = hasZone ? block.y1 - block.y0 : 0;
  // 不接站时带子区里长的链折成几列（foldPlan）：折多高和宽度一起挑；opt.fold === false 不折
  const folds = !attached && hasZone && opt.fold !== false ? foldPlan(zone) : null;

  // 试几种宽度，挑整张（连带子区）外框面积小、又接近 aspect 的（偏离 aspect 一倍按面积多 28% 算）
  const aspect = opt.aspect ?? 16 / 9;
  const total = list.reduce((a, u) => a + (u.frame.x1 - u.frame.x0) * (u.frame.y1 - u.frame.y0), 0);
  const widest = Math.max(...list.map((u) => u.frame.x1 - u.frame.x0));
  const base = Math.sqrt(total * aspect);
  const lim = opt.limits ?? {};
  const limited = !!(lim.maxWidth || lim.maxHeight || lim.maxAspect);
  // w、h 是估的（机器那几行加带子区），出图时塔、分拣器还会多出一点：宽、长各留一格
  const fits = (w, h) => (!lim.maxWidth || w <= lim.maxWidth - 1 + EPS) && (!lim.maxHeight || h <= lim.maxHeight - 1 + EPS) && (!lim.maxAspect || Math.max(w / h, h / w) <= lim.maxAspect + EPS);
  // opt.fixed：{ order, W: [宽度…] } 照给的顺序、只在这几种宽度里挑（定点留空位、机器多的按网格快排时照默认那张的排法）
  let best = null;
  const widths = new Set();
  for (let k = limited ? 0.3 : 0.5; k <= (limited ? 4 : 2); k += 0.05) widths.add(Math.max(Math.ceil(widest), Math.round(base * k)));
  orders.forEach((order, oi) => {
    if (opt.fixed && oi !== opt.fixed.order) return;
    for (const W of opt.fixed ? opt.fixed.W : widths) {
      const r = packShelves(order, W, opt.sorterOverBody ?? true, opt.street ?? null, opt.holes ?? null);
      if (!r) continue;
      // 带子区默认放上面，底边贴着机器、隔一格（别的边是画布上拖过去的）；折不折按分数挑，一样好时不折
      for (const side of opt.sides ?? ['top'])
        for (const [H, dw, dh] of folds?.options ?? [[null, zw, zh]]) {
          const w = side === 'right' ? W + (hasZone ? 1 + dh : 0) : Math.max(W, dw);
          const h = side === 'right' ? Math.max(r.top, dw) : r.top + (hasZone ? 1 + dh : 0);
          const score = w * h * (1 + 0.4 * Math.abs(Math.log(w / h / aspect)));
          const fit = fits(w, h);
          if (!best || (fit && !best.fit) || (fit === best.fit && score < best.score - 1e-9)) best = { score, W, r, side, w, h, fit, oi, H };
        }
    }
  });
  if (!best) return null;
  const { r, side, W } = best;
  if (folds && best.H < folds.top) {
    layFold(folds, best.H);
    [zx0, zx1, zy0, zy1] = [Infinity, -Infinity, Infinity, -Infinity];
    for (const b of zone) {
      const p = b.localOffset[0];
      [zx0, zx1, zy0, zy1] = [Math.min(zx0, p.x - 0.5), Math.max(zx1, p.x + 0.5), Math.min(zy0, p.y - 0.5), Math.max(zy1, p.y + 0.5)];
    }
    Object.assign(block, { x0: zx0, x1: zx1, y0: zy0, y1: zy1 });
  }

  // 挪位置：每块按它的平移；带子区整块先顺时针转 k 个 90°（朝向跟着转）再平移。DSQ 给带子、塔写的两个端点是同一个对象，只挪一次
  const moved = (b, k, tx, ty) => {
    for (const p of new Set(b.localOffset)) {
      const [x, y] = quarter(k, [p.x, p.y]);
      p.x = x + tx;
      p.y = y + ty;
    }
    if (k) b.yaw = b.yaw.map((a) => (((a + 90 * k) % 360) + 360) % 360);
  };
  const m = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity }; // 机器（连贴着的分拣器）的外框
  for (const u of list) {
    const [tx, ty] = r.at.get(u);
    for (const b of u.members) moved(b, 0, tx, ty);
    m.x0 = Math.min(m.x0, u.frame.x0 + tx);
    m.x1 = Math.max(m.x1, u.frame.x1 + tx);
    m.y0 = Math.min(m.y0, u.frame.y0 + ty);
    m.y1 = Math.max(m.y1, u.frame.y1 + ty);
  }
  // 带子区围着机器那一圈放（perimeter.js），沿边挪的格数超出范围的收回来。带子区的口（带头带尾有标签的那节）在原来的上头、往外接：
  // 带子区、两边各一格和口外那一条不放电力塔；贴着机器那一格放得，带子区靠里几排的喷涂机要从那儿供电。接了站的没有敞着的口，不用让
  let keepOut = () => false;
  let zoneAt = null;
  if (hasZone) {
    const want = SIDES.includes(opt.zoneAt?.side) ? opt.zoneAt : { side, offset: 0 };
    const [lo, hi] = offsetRange(block, m, want.side);
    const offset = Math.min(hi, Math.max(lo, Math.round(Number(want.offset) || 0)));
    const p = placeZone(block, m, want.side, offset);
    for (const b of zone) moved(b, p.k, p.tx, p.ty);
    if (attached) {
      // 各块照拖的挪：先算挪过以后的外框、站心，放得下（partsFit）才挪
      const boxOf = (members, [dx, dy]) => {
        const r = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
        for (const b of members) {
          const q = b.localOffset[0];
          const h = b.itemId === STATION ? 3.5 : 0.5;
          r.x0 = Math.min(r.x0, q.x + dx - h);
          r.x1 = Math.max(r.x1, q.x + dx + h);
          r.y0 = Math.min(r.y0, q.y + dy - h);
          r.y1 = Math.max(r.y1, q.y + dy + h);
        }
        return r;
      };
      const want = attached.parts.map((_, i) => (opt.partShift?.[i] ?? [0, 0]).map((v) => Math.round(Number(v) || 0)));
      const at = (part, d) => ({ box: boxOf(part.members, d), center: part.kind === 'station' ? [part.members[0].localOffset[0].x + d[0], part.members[0].localOffset[0].y + d[1]] : null });
      const fits = (ds) => {
        const ps = attached.parts.map((part, i) => at(part, ds[i]));
        return partsFit(ps.map((q) => q.box), ps.map((q) => q.center), m, SPAN);
      };
      const moved0 = want.some(([dx, dy]) => dx || dy);
      const ok = !moved0 || fits(want);
      const ds = ok ? want : want.map(() => [0, 0]);
      attached.parts.forEach((part, i) => {
        const [dx, dy] = ds[i];
        if (dx || dy) for (const b of part.members) moved(b, 0, dx, dy);
        part.shift = ds[i];
      });
      attached.shiftRejected = (moved0 && !ok) || !!opt.rejected;
      // 位置都定下来了：先拉增产剂带，再接翘曲器带。增产剂带走不到每台喷涂机：拖过的照默认位置出，默认位置也不行就不接站
      if (attached.spray && !linkSpray(B, attached.spray, { belt: opt.station.belt }))
        return ds.some(([dx, dy]) => dx || dy) ? repackOnce(buildings, { ...opt, partShift: undefined, rejected: true }) : repackOnce(buildings, { ...opt, station: null, skipped: 'spray' });
      if (opt.station.warper) attached.warper = linkWarpers(B, { belt: opt.station.belt });
    } else
      keepOut = (x, y) => {
        const [lx, ly] = quarter(-p.k, [x - p.tx, y - p.ty]);
        return lx >= zx0 - 1 && lx <= zx1 + 1 && ly >= zy0;
      };
    zoneAt = { side: want.side, offset, zone: block, machines: m, box: p.box, stations: attached?.stations ?? null, stationSkip: opt.skipped ?? (opt.station && !attached ? (tried?.skip ?? 'other') : null), span: SPAN, shiftRejected: !!attached?.shiftRejected, warper: attached?.warper ?? null, limitMiss: limited && !best.fit };
  }

  // 新的建筑表：DSQ 的电力感应塔不要了，重新编号
  const kept = B.filter((b) => b.itemId !== TOWER && !b.dropped);
  const towerTemplate = B.find((b) => b.itemId === TOWER);
  const newIndex = new Map(kept.map((b, i) => [b.index, i]));
  for (const b of kept) {
    b.index = newIndex.get(b.index);
    if (b.inputObjIdx >= 0) b.inputObjIdx = newIndex.get(b.inputObjIdx) ?? -1;
    if (b.outputObjIdx >= 0) b.outputObjIdx = newIndex.get(b.outputObjIdx) ?? -1;
  }
  const type = opt.power === 'substation' ? 'substation' : 'tesla';
  const keyOf = new Map(list.flatMap((u) => u.members.map((b) => [b, u.key])));
  const { at: towers, uncovered, missed } = placeTowers(kept, keepOut, type, !!opt.wide, keyOf);
  const template = towerTemplate ?? { areaIndex: 0, yaw: [0, 0], itemId: TOWER, modelIndex: 44, outputObjIdx: -1, inputObjIdx: -1, outputToSlot: 0, inputFromSlot: 0, outputFromSlot: 0, inputToSlot: 0, outputOffset: 0, inputOffset: 0, recipeId: 0, filterId: 0, parameters: null }; // 参数写 null（同 DSQ 的建筑模板；{} 编蓝图码时会被当成数组）
  for (const [x, y] of towers) {
    const t = structuredClone(template);
    t.index = kept.length;
    t.localOffset = [{ x, y, z: 0 }, { x, y, z: 0 }];
    t.inputObjIdx = -1;
    t.outputObjIdx = -1;
    // 卫星配电站：电力感应塔的模板换物品和模型编号（同 emit/blueprint.js）
    if (type === 'substation') Object.assign(t, { itemId: POWER.substation.itemId, modelIndex: POWER.substation.model, parameters: null });
    kept.push(t);
  }
  // 各块（接了站时）：重新编号以后的建筑、外框、站心，给页面拖
  if (attached)
    zoneAt.parts = attached.parts.map((part) => {
      const r = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
      for (const b of part.members) {
        const q = b.localOffset[0];
        const h = b.itemId === STATION ? 3.5 : 0.5;
        r.x0 = Math.min(r.x0, q.x - h);
        r.x1 = Math.max(r.x1, q.x + h);
        r.y0 = Math.min(r.y0, q.y - h);
        r.y1 = Math.max(r.y1, q.y + h);
      }
      const c = part.kind === 'station' ? [part.members[0].localOffset[0].x, part.members[0].localOffset[0].y] : null;
      return { kind: part.kind, members: part.members.map((b) => b.index), box: r, center: c, shift: part.shift };
    });
  const spots = list.map((u) => {
    const [tx, ty] = r.at.get(u);
    return { key: u.key, x0: u.frame.x0 + tx, x1: u.frame.x1 + tx, y0: u.frame.y0 + ty, y1: u.frame.y1 + ty, pad: u.pad };
  });
  return { buildings: kept, towers: towers.length, uncovered, missed, spots, fixed: { order: best.oi, W }, zone: zoneAt };
}

const KIND = { 2302: 'smelter', 2315: 'smelter', 2319: 'smelter', 2303: 'assembler', 2304: 'assembler', 2305: 'assembler', 2318: 'assembler', 2309: 'chemical', 2317: 'chemical', 2308: 'refinery', 2310: 'collider', 2901: 'lab', 2902: 'lab' };
/**
 * 供电（type：tesla 电力感应塔 / substation 卫星配电站，POWER）：覆盖每台工厂（中心）、每根分拣器（取料那头，game-rules 第 33 条）、每台喷涂机、
 * 每座物流站。电力感应塔（0.48 格见方）不碰工厂的框、站身；卫星配电站 3×3，离工厂照 substationPad 再让开，格子不进物流站身外那圈（9×9）
 * 和站心东西两边窄了会撞的那截（同规划器、独立检查的 STATION_CLEAR、STATION_EW，game-rules 第 17、19、39 条）。都不压带子、分拣器经过的格子、喷涂机，不进 keepOut，彼此照 powerApart 隔开。
 * 贪心：先只在整张（供电以外）的外框里挑，每次挑能新覆盖最多的格子；框里够不着的才往外放（挑外框撑得最少的）；最后连不成一张网的补中继。
 * keyOf：建筑 → 块的编号（missed 里记，定点留空位用）
 */
function placeTowers(B, keepOut, type = 'tesla', wide = false, keyOf = new Map()) {
  const id = POWER[type].itemId;
  const { cover, link } = powerReach(type);
  const bodies = B.filter((b) => MACHINES.has(b.itemId) && b.localOffset[0].z <= 0.01).map((b) => bodyOf(b, wide));
  const stations = B.filter((b) => b.itemId === STATION).map((b) => b.localOffset[0]);
  for (const c of stations) bodies.push({ x: c.x, y: c.y, w: 7, h: 7 });
  // 卫星配电站离工厂还要再让开的（工厂自己朝向的左右下上，转到蓝图里）
  const padded = [];
  if (id === 2212)
    for (const b of B) {
      if (!MACHINES.has(b.itemId) || b.localOffset[0].z > 0.01) continue;
      const p = b.localOffset[0];
      const stacked = KIND[b.itemId] === 'lab' && B.some((u) => u !== b && MACHINES.has(u.itemId) && u.localOffset[0].z > 0.01 && Math.abs(u.localOffset[0].x - p.x) < 0.01 && Math.abs(u.localOffset[0].y - p.y) < 0.01);
      const m = substationPad({ kind: KIND[b.itemId], levels: stacked ? 2 : 1 }).margin ?? { left: 0, right: 0, below: 0, above: 0 };
      const f = bodyOf(b, wide);
      const r = { x0: f.x - f.w / 2, x1: f.x + f.w / 2, y0: f.y - f.h / 2, y1: f.y + f.h / 2 };
      for (const [d, v] of [[[-1, 0], m.left], [[1, 0], m.right], [[0, -1], m.below], [[0, 1], m.above]]) {
        const [wx, wy] = turn(yawOf(b), d);
        if (wx < 0) r.x0 -= v;
        else if (wx > 0) r.x1 += v;
        else if (wy < 0) r.y0 -= v;
        else r.y1 += v;
      }
      padded.push(r);
    }
  const taken = new Set();
  for (const b of B) {
    if (BELTS.has(b.itemId) || b.itemId === COATER) taken.add(`${Math.round(b.localOffset[0].x)},${Math.round(b.localOffset[0].y)}`);
    if (SORTERS.has(b.itemId)) {
      const [p0, p1] = b.localOffset;
      for (let y = Math.round(Math.min(p0.y, p1.y)); y <= Math.round(Math.max(p0.y, p1.y)); y++) for (let x = Math.round(Math.min(p0.x, p1.x)); x <= Math.round(Math.max(p0.x, p1.x)); x++) taken.add(`${x},${y}`);
    }
  }
  const targets = [];
  const owner = [];
  for (const b of B) {
    if (MACHINES.has(b.itemId) || b.itemId === COATER || b.itemId === STATION || SORTERS.has(b.itemId)) {
      targets.push(b.localOffset[0]);
      owner.push(keyOf.get(b) ?? null);
    }
  }
  // 候选位置：要供电的点和工厂、站的框再往外 pad 格（只按中心算时，最上面一排化工厂框上面空着的那行进不了候选）
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of targets) {
    x0 = Math.min(x0, p.x);
    x1 = Math.max(x1, p.x);
    y0 = Math.min(y0, p.y);
    y1 = Math.max(y1, p.y);
  }
  for (const b of bodies) {
    x0 = Math.min(x0, b.x - b.w / 2);
    x1 = Math.max(x1, b.x + b.w / 2);
    y0 = Math.min(y0, b.y - b.h / 2);
    y1 = Math.max(y1, b.y + b.h / 2);
  }
  const free = (x, y) => {
    if (keepOut(x, y) || powerCells(id, x, y).some(([cx, cy]) => taken.has(`${cx},${cy}`))) return false;
    if (id !== 2212) return !bodies.some((b) => Math.abs(b.x - x) < b.w / 2 + 0.25 - EPS && Math.abs(b.y - y) < b.h / 2 + 0.25 - EPS);
    const near = (dx, dy) => (dx <= STATION_CLEAR + 1 && dy <= STATION_CLEAR + 1) || (dx <= STATION_EW.x + 1 && dy <= STATION_EW.y + 1);
    if (stations.some((c) => near(Math.abs(c.x - x), Math.abs(c.y - y)))) return false;
    return !padded.some((r) => x - 1.5 < r.x1 - EPS && r.x0 < x + 1.5 - EPS && y - 1.5 < r.y1 - EPS && r.y0 < y + 1.5 - EPS);
  };
  const cands = [];
  const pad = id === 2212 ? 3 : 1;
  for (let x = Math.floor(x0) - pad; x <= Math.ceil(x1) + pad; x++) for (let y = Math.floor(y0) - pad; y <= Math.ceil(y1) + pad; y++) if (free(x, y)) cands.push([x, y]);
  const chosen = [];
  const ok = ([x, y]) => chosen.every(([a, b]) => powerApart(id, id, a - x, b - y));
  // 整张（供电以外）的外框：整个落在框里的供电不撑大外框，先只在框里挑；框里的都够不着了才往外放，挑撑大的面积 ÷ 新覆盖的最少的
  const half = id === 2212 ? 1.5 : 0.5;
  const box = footprint(B, wide);
  const inBox = ([x, y]) => x - half >= box.x0 - EPS && x + half <= box.x1 + EPS && y - half >= box.y0 - EPS && y + half <= box.y1 + EPS;
  const growOf = (r, [x, y]) => (Math.max(r.x1, x + half) - Math.min(r.x0, x - half)) * (Math.max(r.y1, y + half) - Math.min(r.y0, y - half)) - (r.x1 - r.x0) * (r.y1 - r.y0);
  // 贪心：每次挑新覆盖最多的（一样多挑 cands 里排前的）。要供电的点按 cover 见方分桶，每个候选只数周围几桶；
  // 覆盖数只减不增，候选按上一次数的放进堆里，取出来重数一遍还排在最前才算挑中（和挨个数一遍挑出来的一样）
  const S = Math.ceil(cover);
  const buckets = new Map();
  targets.forEach((p, i) => {
    const k = `${Math.floor(p.x / S)},${Math.floor(p.y / S)}`;
    (buckets.get(k) ?? buckets.set(k, []).get(k)).push(i);
  });
  const alive = new Uint8Array(targets.length).fill(1);
  let left = targets.length;
  const withinOf = (al, [x, y], fn) => {
    for (let i = Math.floor((x - cover) / S); i <= Math.floor((x + cover) / S); i++)
      for (let j = Math.floor((y - cover) / S); j <= Math.floor((y + cover) / S); j++)
        for (const t of buckets.get(`${i},${j}`) ?? []) if (al[t] && (targets[t].x - x) ** 2 + (targets[t].y - y) ** 2 <= cover * cover) fn(t);
  };
  const within = (c, fn) => withinOf(alive, c, fn);
  const gain = (c) => {
    let n = 0;
    within(c, () => n++);
    return n;
  };
  const heap = new Heap((a, b) => b.n - a.n || a.i - b.i);
  cands.forEach((c, i) => {
    const n = gain(c);
    if (n) heap.push({ n, i });
  });
  const take = (c) => {
    chosen.push(c);
    within(c, (t) => {
      alive[t] = 0;
      left--;
    });
    expand(box, c);
  };
  const expand = (r, [x, y]) => Object.assign(r, { x0: Math.min(r.x0, x - half), x1: Math.max(r.x1, x + half), y0: Math.min(r.y0, y - half), y1: Math.max(r.y1, y + half) });
  const later = []; // 框外的候选
  while (left && heap.size) {
    const top = heap.pop();
    const c = cands[top.i];
    if (!ok(c)) continue; // 离挑中的太近：以后也放不了
    if (!inBox(c)) {
      later.push(top.i);
      continue;
    }
    top.n = gain(c);
    if (!top.n) continue;
    if (heap.size && heap.before(heap.peek(), top)) {
      heap.push(top);
      continue;
    }
    take(c);
  }
  const missed = targets.flatMap((p, t) => (alive[t] ? [[p.x, p.y, owner[t]]] : [])); // 框里够不着的（定点留空位照它们留）
  // 框里的都够不着了：往外放，几种放法挑外框最小的（都够不着全部时挑剩得少的）：只往一边撑（下、上、左、右），撑得最浅的那一档；
  // 或者一座一座挑「撑大的面积 ÷ 新覆盖的」最少的（撑大以后进了框的不算撑大）
  if (left) {
    const sim = (pool, ratio) => {
      const al = alive.slice();
      const bx = { ...box };
      const picks = [];
      let lf = left;
      const count = (c) => {
        let n = 0;
        withinOf(al, c, () => n++);
        return n;
      };
      while (lf) {
        let best = null;
        for (const i of pool) {
          const c = cands[i];
          if (!ok(c) || !picks.every(([a, b]) => powerApart(id, id, a - c[0], b - c[1]))) continue;
          const n = count(c);
          if (!n) continue;
          const key = ratio ? growOf(bx, c) / n : -n;
          if (!best || key < best.key - EPS || (key <= best.key + EPS && (n > best.n || (n === best.n && i < best.i)))) best = { key, n, i };
        }
        if (!best) break;
        const c = cands[best.i];
        picks.push(c);
        withinOf(al, c, (t) => {
          al[t] = 0;
          lf--;
        });
        expand(bx, c);
      }
      return { picks, left: lf, area: (bx.x1 - bx.x0) * (bx.y1 - bx.y0) };
    };
    const options = [sim(later, true)];
    // 只往一边撑：每个够不着的都有框外的候选够得着才试
    const reach = new Uint8Array(targets.length);
    for (const i of later) withinOf(alive, cands[i], (t) => (reach[t] = 1));
    if (targets.every((_, t) => !alive[t] || reach[t]))
      for (const side of ['bottom', 'top', 'left', 'right']) {
        const depth = (c) => ({ bottom: box.y0 - (c[1] - half), top: c[1] + half - box.y1, left: box.x0 - (c[0] - half), right: c[0] + half - box.x1 })[side];
        const along = side === 'bottom' || side === 'top' ? (c) => c[0] - half >= box.x0 - EPS && c[0] + half <= box.x1 + EPS : (c) => c[1] - half >= box.y0 - EPS && c[1] + half <= box.y1 + EPS;
        const pool = later.filter((i) => along(cands[i]) && depth(cands[i]) > EPS);
        for (const d of [...new Set(pool.map((i) => Math.round(depth(cands[i]) * 2) / 2))].sort((a, b) => a - b)) {
          const r = sim(pool.filter((i) => depth(cands[i]) <= d + EPS), false);
          if (!r.left) {
            options.push(r);
            break;
          }
        }
      }
    const best = options.reduce((a, b) => (b.left < a.left || (b.left === a.left && b.area < a.area - EPS) ? b : a));
    for (const c of best.picks) take(c);
  }
  // 连成一张网：两群之间离得超过连接距离的，在最近的两座之间补中继（框里有就放框里）
  for (let guard = 0; guard < 50; guard++) {
    const seen = new Set([0]);
    for (const st = [0]; st.length; ) {
      const a = chosen[st.pop()];
      chosen.forEach((b, j) => {
        if (!seen.has(j) && (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 <= link * link) {
          seen.add(j);
          st.push(j);
        }
      });
    }
    if (seen.size >= chosen.length) break;
    let bestPair = null;
    for (const i of seen) for (let j = 0; j < chosen.length; j++) {
      if (seen.has(j)) continue;
      const d = (chosen[i][0] - chosen[j][0]) ** 2 + (chosen[i][1] - chosen[j][1]) ** 2;
      if (!bestPair || d < bestPair.d) bestPair = { i, j, d };
    }
    const [a, b] = [chosen[bestPair.i], chosen[bestPair.j]];
    const near = (p) => (p[0] - (a[0] + b[0]) / 2) ** 2 + (p[1] - (a[1] + b[1]) / 2) ** 2;
    const both = (p) => (p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2 <= link * link && (p[0] - b[0]) ** 2 + (p[1] - b[1]) ** 2 <= link * link;
    const mid = cands.filter((p) => ok(p) && inBox(p) && both(p)).sort((p, q) => near(p) - near(q))[0] ?? cands.filter(ok).sort((p, q) => near(p) - near(q))[0];
    if (!mid) break;
    chosen.push(mid);
    expand(box, mid);
  }
  return { at: chosen, uncovered: left, missed };
}

/** 二叉堆：before(a, b) 为负时 a 排在前头 */
class Heap {
  constructor(cmp) {
    this.cmp = cmp;
    this.a = [];
  }
  get size() {
    return this.a.length;
  }
  before(x, y) {
    return this.cmp(x, y) < 0;
  }
  peek() {
    return this.a[0];
  }
  push(v) {
    const a = this.a;
    a.push(v);
    for (let i = a.length - 1; i > 0; ) {
      const p = (i - 1) >> 1;
      if (!this.before(a[i], a[p])) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      for (let i = 0; ; ) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && this.before(a[l], a[m])) m = l;
        if (r < a.length && this.before(a[r], a[m])) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}
