// 出蓝图后的独立检查：只看解码后的蓝图记录本身，不看规划器的任何中间数据。
// 这是在进游戏之前能做到的最接近实测的检查。
import { fromStr } from '../codec/parser.js';
import { RECIPES, ITEMS, factory, RAMP_MAX_DZ, STATION_GAP, STATION_CLEAR, STATION_HALF, powerCells, powerGap, slotPoint, substationPad, THERMAL_PLANT, THERMAL_BANK, FUEL_MJ, BOX_SLOT, TANK_PORT, STORE_BODY, DISTRIBUTOR_LIFT } from '../gamedata.js';
import { POWER, powerReach } from '../plan/power.js';

const isBelt = (id) => id >= 2001 && id <= 2003;
const isSorter = (id) => id >= 2011 && id <= 2014;
const PILER = 2040; // 自动集装机：带子 → 1 号口，0 号口 → 带子，进出两节挤在同一格里（各偏 0.2 格）
const COATER = 2313; // 喷涂机：骑在第 z 层的带子上，背后那格上方第 z + 1 层有增产剂带横穿；同一格可以上下叠（z 差 2），不能悬空（用户 2026/10/08 实测）
const SPRAYS = new Set([1141, 1142, 1143]);
// 物理碰撞体（格）：熔炉约 2.4×2.4、制造台约 3.2×3.2、研究站约 4.5×4.5（由游戏数据中的占地面积开方得到），
// 化工厂 6.8×4（中心往上 0.5）、对撞机 9×5（中心往左 0.3），见 gamedata.js 的 FACTORY_GEOMETRY（2026/10/05 两张体积测试图）。
// 槽位 -> 分拣器在工厂一端的落点相对中心的偏移，化工厂下侧落点带 0.284 的小数，研究站、对撞机的槽位不在整格上（x ±0.8、y ±1.83 这类）。
const BODY = {};
const isLab = (id) => id === 2901 || id === 2902;
for (const id of [2302, 2315, 2319, 2303, 2304, 2305, 2318, 2309, 2317, 2901, 2902, 2310]) {
  const f = factory(id);
  const slot = {};
  for (const side of ['bottom', 'top'])
    for (const [off, no] of Object.entries(f.slots[side])) {
      const pt = slotPoint(f, side, Number(off));
      slot[no] = [pt.dx, pt.dy];
    }
  Object.assign(slot, f.slotPos ?? {}); // 研究站、对撞机：规划器不用的槽位也认（玩家手搓的蓝图里会用）
  BODY[id] = { w: f.collider[0], h: f.collider[1], shift: f.colliderShift ?? [0, 0], slot, kind: f.kind };
}
// 火力发电厂（就地烧副产物，plan/burn.js）：槽位照用户 2026/10/07 的蓝图（朝东时量的，这里换回朝北的建筑自己坐标），
// 碰撞体 6.5 × 3.5（gamedata.js 的 THERMAL_BANK.box，2026/10/08 验证合集 R 组实测）。不进 factories（不查配方），燃料来源另查（第 5c 节）
{
  const T = THERMAL_BANK;
  const local = ([wx, wy]) => [-wy, wx]; // 朝东（yaw 90）时的偏移 → 建筑自己坐标
  BODY[THERMAL_PLANT] = { w: T.box.h, h: T.box.w, shift: local([T.box.dx, T.box.dy]), slot: Object.fromEntries(Object.entries(T.slot).map(([k, v]) => [k, local(v)])), kind: 'thermal' };
}
// 储物仓、储液罐、物流配送器的口位、碰撞体、叠层高度在 gamedata.js（STORE_BODY 等，来由见那里）
const SMALL_BOX = 2101;
const BIG_BOX = 2102;
const TANK = 2106;
const DISTRIBUTOR = 2107;
const isBox = (id) => id === SMALL_BOX || id === BIG_BOX;
const isStore = (id) => isBox(id) || id === TANK;
// 大型仓长边两头的口（0、2、6、8）体积测试第八张 H1 验证过，不再提醒；小型仓南边两头、东西两边的角口是照用户 10/19 那张图（北边 0 1 2、东北角 3）对称推断的
const BOX_SLOT_GUESS = { [BIG_BOX]: new Set(), [SMALL_BOX]: new Set([5, 6, 8, 9, 11]) };
// 物流站：7×7 的地归站；站口那节带子在中心 ±2 处（左 3/4/5 号口上中下，右 11/10/9 号口上中下，antian 已验证）
const isStation = (id) => id === 2103 || id === 2104;
const STATION_SLOT = { 3: [-2, 1], 4: [-2, 0], 5: [-2, -1], 9: [2, -1], 10: [2, 0], 11: [2, 1], 0: [1, 2], 1: [0, 2], 2: [-1, 2], 6: [-1, -2], 7: [0, -2], 8: [1, -2] };
// 上下两侧（0/1/2、6/7/8 号）的口位是按逆时针编号推断的，还没在游戏里验证
const UNVERIFIED_SLOT = new Set([0, 1, 2, 6, 7, 8]);
// 建筑转了方向（整张竖排的蓝图是横排转 90° 来的）：槽位偏移跟着朝向转，碰撞体宽高对调。
// 朝向 yaw 0 北、90 东（顺时针），建筑自己坐标里的 (dx, dy) 转 90° 后是 (dy, −dx)
const yawOf = (b) => ((Math.round(b.yaw?.[0] ?? 0) % 360) + 360) % 360;
const turn = (b, [dx, dy]) => {
  const y = yawOf(b);
  return y === 90 ? [dy, -dx] : y === 180 ? [-dx, -dy] : y === 270 ? [-dy, dx] : [dx, dy];
};
const dims = (f) => (yawOf(f) % 180 ? { w: BODY[f.itemId].h, h: BODY[f.itemId].w } : { w: BODY[f.itemId].w, h: BODY[f.itemId].h });
/** 工厂碰撞体的中心和宽高（碰撞体中心的偏移跟着朝向转） */
const box = (f, P) => {
  const [sx, sy] = turn(f, BODY[f.itemId].shift);
  return { x: P(f).x + sx, y: P(f).y + sy, ...dims(f) };
};
// 碰撞体正好贴着算贴着：中心带小数偏移（对撞机往左 0.3）时，相减会差一点点（128.7 − 119.7 = 8.999999999999986），
// 比较时留 EPS，不然 x 大的地方两台挨着的对撞机会被误判成碰撞（2026/10/07 放大的考卷上量到）
const EPS = 1e-6;
const inside = (f, x, y, P) => {
  const b = box(f, P);
  return Math.abs(b.x - x) < b.w / 2 - EPS && Math.abs(b.y - y) < b.h / 2 - EPS;
};
const name = (id) => ITEMS.get(id)?.name ?? String(id);

export function checkBlueprint(str) {
  const bp = fromStr(str.trim());
  const B = bp.buildings;
  const errors = [];
  const warnings = [];
  const err = (m) => errors.length < 200 && errors.push(m);
  // 坐标取整：垂直升降处较低的几节带子会错开 0.0016 的倍数（antian 的写法），按所在格子算
  const P = (b) => {
    const o = b.localOffset[0];
    return { x: Math.round(o.x), y: Math.round(o.y), z: Math.round(o.z) };
  };
  const factories = B.filter((b) => BODY[b.itemId] && BODY[b.itemId].kind !== 'thermal');
  const thermals = B.filter((b) => b.itemId === THERMAL_PLANT);
  const solids = [...factories, ...thermals]; // 查碰撞时火力发电厂和工厂一样算
  const stations = B.filter((b) => isStation(b.itemId));
  const belts = B.filter((b) => isBelt(b.itemId));
  const sorters = B.filter((b) => isSorter(b.itemId));
  const pilers = B.filter((b) => b.itemId === PILER);
  const coaters = B.filter((b) => b.itemId === COATER);
  const stores = B.filter((b) => isStore(b.itemId));
  const distributors = B.filter((b) => b.itemId === DISTRIBUTOR);
  // 和储液罐相连的带子（接在罐口的那节，和进罐前、出罐后的一节）：游戏把这几节放在口上，坐标带小数
  const tankLinked = new Set();
  for (const b of belts) {
    if (B[b.outputObjIdx]?.itemId === TANK) {
      tankLinked.add(b.index);
      for (const u of belts) if (u.outputObjIdx === b.index) tankLinked.add(u.index);
    } else if (B[b.inputObjIdx]?.itemId === TANK) {
      tankLinked.add(b.index);
      if (isBelt(B[b.outputObjIdx]?.itemId)) tankLinked.add(b.outputObjIdx);
    }
  }
  // 和集装机相连的带子（进出那两节）
  const pileLinked = (b) => (b.outputObjIdx >= 0 && B[b.outputObjIdx]?.itemId === PILER) || (b.inputObjIdx >= 0 && B[b.inputObjIdx]?.itemId === PILER);
  // 叠在别的研究站上面的研究站：原料从下面那台传上来、产物传下去，不接分拣器
  const stacked = (f) => isLab(f.itemId) && f.inputObjIdx >= 0 && isLab(B[f.inputObjIdx]?.itemId);

  // 1. 索引与链接
  B.forEach((b, i) => {
    if (b.index !== i) err(`建筑 ${i} 的 index 为 ${b.index}`);
    for (const k of ['outputObjIdx', 'inputObjIdx']) if (b[k] < -1 || b[k] >= B.length) err(`建筑 ${i} 的 ${k}=${b[k]} 越界`);
  });

  // 2. 工厂之间不碰撞（同一叠研究站上下重合是正常的，按高度分开算）
  const LAB_H = 3;
  for (let i = 0; i < solids.length; i++) {
    for (let j = i + 1; j < solids.length; j++) {
      const a = solids[i];
      const c = solids[j];
      const A = box(a, P);
      const C = box(c, P);
      if (isLab(a.itemId) && isLab(c.itemId) && Math.abs(P(a).z - P(c).z) >= LAB_H) continue;
      if (Math.abs(A.x - C.x) < (A.w + C.w) / 2 - EPS && Math.abs(A.y - C.y) < (A.h + C.h) / 2 - EPS) err(`工厂 ${a.index} 与 ${c.index} 碰撞`);
    }
  }
  // 2a. 研究站的叠法：上面一台正好在下面一台头顶（同一格、高 3），配方相同；悬空的研究站游戏里放不上去
  for (const f of factories) {
    if (!isLab(f.itemId)) continue;
    if (stacked(f)) {
      const d = B[f.inputObjIdx];
      if (P(d).x !== P(f).x || P(d).y !== P(f).y || P(f).z - P(d).z !== LAB_H) err(`研究站 ${f.index} 没有正好叠在研究站 ${d.index} 头顶`);
      if (d.recipeId !== f.recipeId) err(`研究站 ${f.index} 和下面的 ${d.index} 配方不同`);
    } else if (P(f).z !== 0) err(`研究站 ${f.index} 悬空（z=${P(f).z}），下面没有研究站`);
  }
  // 3. 传送带：格子不重复、连接相邻、不压在工厂上
  const tile = new Map();
  for (const b of belts) {
    const k = `${P(b).x},${P(b).y},${P(b).z}`;
    const o = tile.get(k);
    // 集装机那一格：进集装机的一节和从它出来的一节共用一格，不算重叠
    const pair = o && ((o.outputObjIdx >= 0 && o.outputObjIdx === b.inputObjIdx && B[o.outputObjIdx]?.itemId === PILER) || (b.outputObjIdx >= 0 && b.outputObjIdx === o.inputObjIdx && B[b.outputObjIdx]?.itemId === PILER));
    if (o && !pair) err(`传送带重叠于 ${k}`);
    tile.set(k, b);
    if (b.outputObjIdx >= 0 && B[b.outputObjIdx]?.itemId === PILER) {
      const n = B[b.outputObjIdx];
      if (Math.hypot(n.localOffset[0].x - b.localOffset[0].x, n.localOffset[0].y - b.localOffset[0].y) > 0.25) err(`传送带 ${b.index} 接集装机 ${n.index} 但不在它那一格`);
      if (b.outputToSlot !== 1) err(`传送带 ${b.index} 应该接集装机的 1 号口`);
    } else if (b.outputObjIdx >= 0) {
      const n = B[b.outputObjIdx];
      // 相邻：水平走一格（高度变化不超过 RAMP_MAX_DZ 层，现在是 0：不用斜坡），或同一格里上下差 1 层（原地竖直升降）
      const flat = Math.abs(P(n).x - P(b).x) + Math.abs(P(n).y - P(b).y);
      if (isStation(n.itemId) || n.itemId === TANK) {
        // 进物流站、储液罐：口的位置在 3b、3c 里查
      } else if (!isBelt(n.itemId)) err(`传送带 ${b.index} 输出到非传送带`);
      else if (!(flat === 1 || (flat === 0 && Math.abs(P(n).z - P(b).z) === 1))) err(`传送带 ${b.index}→${n.index} 不相邻`);
      else if (flat === 1 && Math.abs(P(n).z - P(b).z) > RAMP_MAX_DZ) err(`传送带 ${b.index}→${n.index} 斜着升降 ${Math.abs(P(n).z - P(b).z)} 层（官方垂直传送带是同一格里竖直叠放）`);
      else if (flat === 0) {
        // 官方垂直传送带的错开：一叠里按流向越来越靠近格子中心，不往回走（往回走的那种在游戏里画出来是折返的）
        const dist = (q) => Math.abs(q.localOffset[0].x - P(q).x) + Math.abs(q.localOffset[0].y - P(q).y);
        if (dist(n) > dist(b) + 1e-4) err(`传送带 ${b.index}→${n.index} 竖直升降时往回错开（不是官方垂直传送带的写法）`);
      }
    }
    if (P(b).z < 0) err(`传送带 ${b.index} 在地面以下`);
    const off = Math.abs(b.localOffset[0].x - P(b).x) + Math.abs(b.localOffset[0].y - P(b).y);
    if (off > (pileLinked(b) || tankLinked.has(b.index) ? 0.21 : 0.02)) err(`传送带 ${b.index} 偏离格子 ${off.toFixed(4)}`);
    for (const f of solids) {
      if (inside(f, P(b).x, P(b).y, P)) err(`传送带 ${b.index} 压在工厂 ${f.index} 上`);
    }
  }

  // 3a. 升降不转弯：同一格里竖直叠放的那一叠，进来和出去的水平方向应该相同（官方垂直传送带直上直下），
  // 一边转弯一边升降、或在升降那一格掉头，游戏里会拧成麻花。能用，但难看，记为提醒。
  {
    const pred = new Map();
    for (const b of belts) if (b.outputObjIdx >= 0 && isBelt(B[b.outputObjIdx].itemId)) pred.set(b.outputObjIdx, b);
    const same = (a, q) => P(a).x === P(q).x && P(a).y === P(q).y;
    const next = (b) => (b.outputObjIdx >= 0 && isBelt(B[b.outputObjIdx].itemId) ? B[b.outputObjIdx] : null);
    let twisted = 0;
    for (const b of belts) {
      const n = next(b);
      const p = pred.get(b.index);
      if (!n || !same(b, n) || (p && same(p, b))) continue; // 只从一叠的最下（最先）那节看起
      let top = n;
      while (next(top) && same(next(top), top)) top = next(top);
      const after = next(top);
      if (!p || !after) continue;
      const din = [P(b).x - P(p).x, P(b).y - P(p).y];
      const dout = [P(after).x - P(top).x, P(after).y - P(top).y];
      if (din[0] !== dout[0] || din[1] !== dout[1]) twisted++;
    }
    if (twisted) warnings.push(`有 ${twisted} 处一边转弯一边升降（升降那一格进出方向不同），游戏里能用，但带子会拧着，不好看`);
  }

  // 翘曲器带（plan/stations.js 的 linkWarpers）：进站口不对应存储格也行——顺着带子往上游找，源头是别的星际站存翘曲器那格的出站口
  // （传送带送进星际物流站的翘曲器自动进站里专门的翘曲器仓，不占物品格）
  const warperFeed = (b) => {
    let cur = b;
    for (let n = 0; n < 10000; n++) {
      const up = belts.find((u) => u.outputObjIdx === cur.index);
      if (!up) break;
      cur = up;
    }
    const src = B[cur.inputObjIdx];
    if (!src || src.itemId !== 2104 || B[b.outputObjIdx]?.itemId !== 2104) return false;
    const sl = src.parameters?.slots?.[cur.inputFromSlot];
    return sl?.dir === 1 && src.parameters.storage?.[sl.storageIdx - 1]?.itemId === 1210;
  };
  // 3b. 物流站：不和工厂、别的站碰撞；高架带不从站上方过；地面带只能是站口那几节（中心 ±2 的站口格和外圈 ±3）
  // 站身按半宽 3.4 判（制造台本体紧贴站身实测能放，体积测试 D6）；站身外那 1 格碰撞圈只挡卫星配电站（第 6 节），工厂可以贴着站身（D6~D8、D10）
  for (const st of stations) {
    const c = P(st);
    for (const f of solids) {
      const F = box(f, P);
      if (Math.abs(F.x - c.x) < STATION_HALF + F.w / 2 - EPS && Math.abs(F.y - c.y) < STATION_HALF + F.h / 2 - EPS) err(`工厂 ${f.index} 与物流站 ${st.index} 碰撞`);
    }
    for (const o of stations) {
      if (o.index <= st.index) continue;
      const d = Math.hypot(P(o).x - c.x, P(o).y - c.y);
      if (Math.abs(P(o).x - c.x) < 7 && Math.abs(P(o).y - c.y) < 7) err(`物流站 ${st.index} 与 ${o.index} 碰撞`);
      else if (d < STATION_GAP - 1e-9) err(`物流站 ${st.index} 与 ${o.index} 相距 ${d.toFixed(2)} 格，游戏里两站中心至少要隔 ${STATION_GAP} 格（约 29 m）`);
    }
    for (const b of belts) {
      const dx = Math.abs(P(b).x - c.x);
      const dy = Math.abs(P(b).y - c.y);
      if (dx > 3 || dy > 3) continue;
      if (P(b).z > 0) err(`传送带 ${b.index} 从物流站 ${st.index} 上方经过`);
      else if (dx <= 2 && dy <= 2 && !(dx === 2 && dy <= 1) && !(dy === 2 && dx <= 1)) err(`传送带 ${b.index} 压在物流站 ${st.index} 上`);
    }
    // 连到站口的带子：位置与槽位一致，槽位的进出方向与站的设置一致
    const prm = st.parameters || {};
    for (const b of belts) {
      for (const [idx, slot, dir] of [[b.inputObjIdx, b.inputFromSlot, 1], [b.outputObjIdx, b.outputToSlot, 2]]) {
        if (idx !== st.index) continue;
        const off = STATION_SLOT[slot] && turn(st, STATION_SLOT[slot]);
        if (UNVERIFIED_SLOT.has(slot) && !warnings.includes('用到了物流站上下两侧的站口（0/1/2、6/7/8 号），口位是推断的，请在游戏里确认')) warnings.push('用到了物流站上下两侧的站口（0/1/2、6/7/8 号），口位是推断的，请在游戏里确认');
        if (!off) err(`传送带 ${b.index} 接在物流站 ${st.index} 的 ${slot} 号口（位置未知）`);
        else if (P(b).x !== c.x + off[0] || P(b).y !== c.y + off[1]) err(`传送带 ${b.index} 接在物流站 ${st.index} 的 ${slot} 号口，但位置不在口上`);
        const sl = prm.slots?.[slot];
        if (!sl || sl.dir !== dir) err(`物流站 ${st.index} 的 ${slot} 号口方向设置应为 ${dir === 1 ? '出站' : '进站'}`);
        else if (!prm.storage?.[sl.storageIdx - 1]?.itemId && !(dir === 2 && warperFeed(b))) err(`物流站 ${st.index} 的 ${slot} 号口没有对应的存储物品`);
      }
    }
  }

  // 3c. 储物仓、储液罐、物流配送器（常量和来由见文件开头）：一叠里上面那个正好在下面那个头顶，悬空的放不上去；
  // 占地不压工厂、物流站、别的仓和带子（接在储液罐口上的那节带子除外）；配送器在一叠最上面那个仓的顶上、filterId 是它管的物品；
  // 储液罐口上的带子位置和口对得上
  {
    const below = (b) => (b.inputObjIdx >= 0 ? B[b.inputObjIdx] : null);
    const sbox = (b) => ({ x: P(b).x, y: P(b).y, ...(yawOf(b) % 180 ? { w: STORE_BODY[b.itemId].h, h: STORE_BODY[b.itemId].w } : { w: STORE_BODY[b.itemId].w, h: STORE_BODY[b.itemId].h }) });
    const hit = (A, C) => Math.abs(A.x - C.x) < (A.w + C.w) / 2 - EPS && Math.abs(A.y - C.y) < (A.h + C.h) / 2 - EPS;
    const z = (b) => b.localOffset[0].z;
    for (const b of stores) {
      const d = below(b);
      if (d && d.itemId === b.itemId) {
        if (P(d).x !== P(b).x || P(d).y !== P(b).y || Math.abs(z(b) - z(d) - STORE_BODY[b.itemId].lift) > 0.05) err(`${name(b.itemId)} ${b.index} 没有正好叠在 ${d.index} 头顶`);
      } else if (d) err(`${name(b.itemId)} ${b.index} 叠在 ${name(d.itemId)} 上`);
      else if (z(b) > 0.05) err(`${name(b.itemId)} ${b.index} 悬空（z=${z(b).toFixed(2)}），下面没有同样的仓`);
      if (d) continue; // 叠在上面的占地和最下面那个一样，只查最下面那个
      const A = sbox(b);
      for (const f of solids) if (hit(A, box(f, P))) err(`${name(b.itemId)} ${b.index} 与工厂 ${f.index} 碰撞`);
      for (const st of stations) if (Math.abs(A.x - P(st).x) < STATION_HALF + A.w / 2 - EPS && Math.abs(A.y - P(st).y) < STATION_HALF + A.h / 2 - EPS) err(`${name(b.itemId)} ${b.index} 与物流站 ${st.index} 碰撞`);
      for (const o of stores) if (o.index > b.index && !below(o) && hit(A, sbox(o))) err(`${name(b.itemId)} ${b.index} 与 ${name(o.itemId)} ${o.index} 碰撞`);
      for (const bt of belts) if (!tankLinked.has(bt.index) && P(bt).z < 3 && Math.abs(P(bt).x - A.x) < A.w / 2 - EPS && Math.abs(P(bt).y - A.y) < A.h / 2 - EPS) err(`传送带 ${bt.index} 压在${name(b.itemId)} ${b.index} 上`);
    }
    for (const d of distributors) {
      const o = below(d);
      if (!o || !isBox(o.itemId)) err(`物流配送器 ${d.index} 下面不是储物仓`);
      else if (stores.some((u) => u.inputObjIdx === o.index && isBox(u.itemId))) err(`物流配送器 ${d.index} 不在那一叠最上面的储物仓顶上`);
      else if (P(o).x !== P(d).x || P(o).y !== P(d).y || Math.abs(z(d) - z(o) - DISTRIBUTOR_LIFT[o.itemId]) > 0.05) err(`物流配送器 ${d.index} 没有正好放在储物仓 ${o.index} 顶上`);
      if (!d.filterId) warnings.push(`物流配送器 ${d.index} 没设管哪种物品`);
    }
    for (const b of belts) {
      for (const [idx, slot] of [[b.outputObjIdx, b.outputToSlot], [b.inputObjIdx, b.inputFromSlot]]) {
        const t = idx >= 0 ? B[idx] : null;
        if (!t || t.itemId !== TANK) continue;
        if (below(t)) err(`传送带 ${b.index} 接在叠在上面的储液罐 ${t.index} 上（只接最下面那个）`);
        const off = TANK_PORT[slot] && turn(t, TANK_PORT[slot]);
        if (!off) err(`传送带 ${b.index} 接在储液罐 ${t.index} 的 ${slot} 号口（位置未知）`);
        else if (Math.abs(t.localOffset[0].x + off[0] - b.localOffset[0].x) > 0.05 || Math.abs(t.localOffset[0].y + off[1] - b.localOffset[0].y) > 0.05) err(`传送带 ${b.index} 接在储液罐 ${t.index} 的 ${slot} 号口，但位置不在口上`);
      }
    }
  }

  // 4. 分拣器几何：直线、长度 1~3、端点落在所连对象上、槽位与位置一致
  const spans = new Map(); // x -> [{lo, hi, idx}]
  for (const s of sorters) {
    const [p0, p1] = s.localOffset;
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const len = Math.floor(Math.abs(dx) + Math.abs(dy) + 1e-6); // 化工厂下侧落点带 0.284 的小数，长度按整格算
    if (Math.abs(dx) > 0.01 && Math.abs(dy) > 0.01) err(`分拣器 ${s.index} 不是直线`); // 游戏自己存的坐标有千分之几的误差
    if (len < 1 || len > 3 || s.parameters?.length !== len) err(`分拣器 ${s.index} 长度 ${len} 与参数 ${s.parameters?.length} 不符或超出 1~3`);
    const ends = [
      [s.inputObjIdx, s.inputFromSlot, p0, '起点'],
      [s.outputObjIdx, s.outputToSlot, p1, '终点'],
    ];
    for (const [idx, slot, p, which] of ends) {
      const o = B[idx];
      if (!o) {
        err(`分拣器 ${s.index} ${which}没有连接对象`);
        continue;
      }
      if (isBelt(o.itemId)) {
        // 研究站、对撞机的分拣器对齐槽位，带子那头离带子那格的中心最多差 0.4 格（参考蓝图里就是这样接的）
        if (Math.abs(P(o).x - p.x) > 0.45 || Math.abs(P(o).y - p.y) > 0.45) err(`分拣器 ${s.index} ${which}不在所连传送带上`);
        if (P(o).z !== 0) err(`分拣器 ${s.index} ${which}接在高架带上（分拣器只能接地面带）`);
      } else if (isBox(o.itemId)) {
        const off = BOX_SLOT[o.itemId][slot] && turn(o, BOX_SLOT[o.itemId][slot]);
        if (!off) err(`分拣器 ${s.index} ${which}接在储物仓 ${o.index} 的 ${slot} 号口（位置未知）`);
        else if (Math.abs(P(o).x + off[0] - p.x) > 0.02 || Math.abs(P(o).y + off[1] - p.y) > 0.02) err(`分拣器 ${s.index} ${which}槽位 ${slot} 与储物仓 ${o.index} 的位置不符`);
        if (P(o).z !== 0) err(`分拣器 ${s.index} ${which}接在叠在上面的储物仓 ${o.index} 上（只接最下面那个）`);
        const guess = '用到了小型储物仓南边两头或东西两边角上的口（5、6、8、9、11 号），口位是照北边推断的，请在游戏里确认';
        if (BOX_SLOT_GUESS[o.itemId].has(slot) && !warnings.includes(guess)) warnings.push(guess);
      } else if (BODY[o.itemId]) {
        const off = BODY[o.itemId].slot[slot] && turn(o, BODY[o.itemId].slot[slot]);
        if (!off) err(`分拣器 ${s.index} ${which}槽位 ${slot} 未知`);
        // 火力发电厂放宽到 0.05：用户的蓝图里同一列往下 0、4 号口的横向偏移从 0.860 渐变到 0.902（槽位的实际位置以米计，
        // 离赤道越远格子越窄，折成格数就越大），规划器按最上面一台的值出
        else if (Math.abs(P(o).x + off[0] - p.x) > (o.itemId === THERMAL_PLANT ? 0.05 : 0.01) || Math.abs(P(o).y + off[1] - p.y) > (o.itemId === THERMAL_PLANT ? 0.05 : 0.01)) err(`分拣器 ${s.index} ${which}槽位 ${slot} 与位置不符`);
      } else err(`分拣器 ${s.index} ${which}连到了不支持的建筑`);
    }
    // 按所接那格带子的列（横着的分拣器按行）分组：对齐槽位的分拣器（坐标带小数）和同一列整格上的分拣器算同一列
    const vertical = Math.abs(dx) <= 0.01;
    const [a, b] = vertical ? [p0.y, p1.y] : [p0.x, p1.x];
    const across = vertical ? p0.x : p0.y;
    const key = `${vertical ? 'x' : 'y'}=${Math.round(across)}`;
    if (!spans.has(key)) spans.set(key, []);
    spans.get(key).push({ lo: Math.min(a, b), hi: Math.max(a, b), x: across, idx: s.index });
  }
  // 同一列上的两根竖直分拣器：占的格子有重叠（接到同一格带子或交叉）就会碰撞。
  // 玩家实测（2026/10/03）：各接各的带子、哪怕端点上下紧挨或中间隔着带子都没问题。
  // 同一格带子上并排、x 错开 0.8 格的两根（对撞机 1/2 号、6/7 号槽都落在同一格）不碰撞，参考蓝图里就这么接。
  for (const [x, list] of spans) {
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        if (Math.abs(a.x - b.x) < 0.5 && a.lo <= b.hi && b.lo <= a.hi) err(`分拣器 ${a.idx} 与 ${b.idx} 在 ${x} 接到同一格或交叉，会碰撞`);
      }
  }

  // 5. 物料语义：沿传送带链传播物品，检查每台工厂的每种原料都有带子供应、产物都有出路
  const carried = new Map(belts.map((b) => [b.index, new Set()]));
  const fromPiler = new Map(); // 集装机 → 它送出的那节带子
  for (const b of belts) if (b.inputObjIdx >= 0 && B[b.inputObjIdx]?.itemId === PILER) fromPiler.set(b.inputObjIdx, b);
  const seed = (b, item) => {
    let cur = b;
    const seen = new Set();
    while (cur && !seen.has(cur.index)) {
      seen.add(cur.index);
      if (cur.itemId === PILER) {
        cur = fromPiler.get(cur.index) ?? null; // 集装机只叠层，物品不变
        continue;
      }
      if (!isBelt(cur.itemId)) break;
      carried.get(cur.index).add(item);
      cur = cur.outputObjIdx >= 0 ? B[cur.outputObjIdx] : null;
    }
  };
  // 物流站出站口：带上是那个口对应存储格里的物品
  for (const b of belts) {
    const st = B[b.inputObjIdx];
    if (!st || !isStation(st.itemId)) continue;
    const sl = st.parameters?.slots?.[b.inputFromSlot];
    const item = sl && st.parameters.storage?.[sl.storageIdx - 1]?.itemId;
    if (item) seed(b, item);
  }
  for (const b of belts) if (b.parameters?.iconId && b.inputObjIdx === -1) {
    const isHead = !belts.some((x) => x.outputObjIdx === b.index);
    if (isHead) seed(b, b.parameters.iconId);
  }
  // 储液罐出来的带：罐里装什么蓝图里不记，按那节带子的图标
  for (const b of belts) if (b.parameters?.iconId && B[b.inputObjIdx]?.itemId === TANK) seed(b, b.parameters.iconId);
  // 储物仓经分拣器放上带的料：一叠里设了过滤的物品，或者顶上配送器管的物品（只有一种时才算）
  const boxItem = (b) => {
    const items = new Set();
    for (let cur = b, n = 0; cur && n < 64; n++) {
      for (const it of cur.parameters?.filters ?? []) if (it) items.add(it);
      const up = B.find((u) => u.inputObjIdx === cur.index && (u.itemId === cur.itemId || u.itemId === DISTRIBUTOR));
      if (up?.itemId === DISTRIBUTOR) {
        if (up.filterId) items.add(up.filterId);
        break;
      }
      cur = up ?? null;
    }
    return items.size === 1 ? [...items][0] : null;
  };
  for (const s of sorters) {
    const src = B[s.inputObjIdx];
    const dst = B[s.outputObjIdx];
    if (src && isBox(src.itemId) && dst && isBelt(dst.itemId)) {
      const it = s.filterId || boxItem(src);
      if (it) seed(dst, it);
      else if (!warnings.includes('有储物仓往带上放料，但没设过滤或配送器，不知道放的是什么')) warnings.push('有储物仓往带上放料，但没设过滤或配送器，不知道放的是什么');
    }
    if (src && BODY[src.itemId] && dst && isBelt(dst.itemId)) {
      const r = RECIPES.get(src.recipeId);
      // 带过滤的出料分拣器只拿那一种（有副产物的工厂两根出料各拿各的）
      if (s.filterId) seed(dst, s.filterId);
      else for (const o of r?.outputs ?? []) seed(dst, o.id); // 没配方的工厂后面会单独报
    }
  }
  for (const set of carried.values()) if (set.size > 1) {
    warnings.push(`有传送带同时承载 ${[...set].map(name).join('、')}（应为单品带）`);
    break;
  }
  for (const f of factories) {
    const r = RECIPES.get(f.recipeId);
    if (!r) {
      err(`工厂 ${f.index} 没有配方`);
      continue;
    }
    if (stacked(f)) continue; // 叠在上面的研究站靠下面那台供料
    const fed = new Set();
    let outputs = 0;
    const taken = new Set(); // 出料分拣器拿走的物品（0 = 不过滤，什么都拿）
    for (const s of sorters) {
      if (s.outputObjIdx === f.index && isBelt(B[s.inputObjIdx]?.itemId)) for (const it of carried.get(s.inputObjIdx)) fed.add(it);
      if (s.inputObjIdx === f.index) {
        outputs++;
        taken.add(s.filterId || 0);
      }
    }
    for (const inp of r.inputs) if (!fed.has(inp.id)) err(`工厂 ${f.index}（${r.name}）缺原料「${name(inp.id)}」`);
    if (!outputs) err(`工厂 ${f.index}（${r.name}）没有出料分拣器`);
    // 有副产物的配方：每种产物都要有分拣器拿走，否则那种产物堆满后工厂停机
    else if (!taken.has(0)) for (const o of r.outputs) if (!taken.has(o.id)) err(`工厂 ${f.index}（${r.name}）的产物「${name(o.id)}」没有出料分拣器，堆满后会停机`);
  }

  // 5a. 集装机：前后各接一节带子；喷涂机：骑在第 z 层的带子上（地面或高架），背后那格上方第 z + 1 层有增产剂带横穿；
  //     同一格可以上下叠（每台 z 差 2，上一台骑在下一台身上），叠着但脚下没带子的那台什么也喷不到；悬空不行（用户 2026/10/08 的蓝图）
  for (const p of pilers) {
    if (!belts.some((b) => b.outputObjIdx === p.index)) err(`自动集装机 ${p.index} 没有进料带`);
    if (!fromPiler.has(p.index)) err(`自动集装机 ${p.index} 没有出料带`);
  }
  for (const c of coaters) {
    const cz = Math.round(P(c).z);
    const under = belts.find((b) => P(b).x === P(c).x && P(b).y === P(c).y && Math.round(P(b).z) === cz);
    const onCoater = !under && coaters.some((o) => o !== c && P(o).x === P(c).x && P(o).y === P(c).y && Math.round(P(o).z) === cz - 2);
    if (!under && !onCoater) err(`喷涂机 ${c.index} 悬空：第 ${cz} 层脚下既没有传送带，也没有叠在另一台喷涂机上`);
    if (!under && onCoater) {
      warnings.push(`喷涂机 ${c.index} 叠在别的喷涂机上、脚下没有带子，什么也喷不到`);
      continue;
    }
    const yaw = Math.round(c.yaw[0] / 90) * 90 % 360;
    // 喷涂机顺着带子朝下游（用户的分馏阵列就是这样）；倒过来的话机身伸向上游，接物流站时会撞到站（用户 2026/10/07）
    if (under && ((Math.round((under.yaw?.[0] ?? 0) / 90) * 90 % 360) + 360) % 360 !== (yaw + 360) % 360) err(`喷涂机 ${c.index} 的朝向和脚下传送带的流向不一致（应顺着带子朝下游）`);
    const [dx, dy] = { 0: [0, -1], 90: [-1, 0], 180: [0, 1], 270: [1, 0] }[(yaw + 360) % 360];
    // 压着的 3 格不转弯、不升降，再往外各一格也顺着同一方向进出：转弯、坡道、竖直升降最近只能在第 2 格（用户 2026/10/07 两张实测蓝图）。
    // 顺着带子的连接往上游、下游各走两格；带子从压着的第一格开头（没有来路）不算错
    if (under) {
      const up = (b) => belts.find((u) => u.outputObjIdx === b.index);
      const down = (b) => (isBelt(B[b.outputObjIdx]?.itemId) ? B[b.outputObjIdx] : null);
      const step = (a, b) => P(b).x - P(a).x === -dx && P(b).y - P(a).y === -dy && Math.round(P(a).z) === cz && Math.round(P(b).z) === cz;
      const a1 = up(under), a2 = a1 && up(a1), b1 = down(under), b2 = b1 && down(b1);
      if (!(a1 && b1 && step(a1, under) && step(under, b1) && (!a2 || step(a2, a1)) && (!b2 || step(b1, b2)))) {
        err(`喷涂机 ${c.index} 压着的 3 格带子要直、在同一层，前后再各一格也要顺着同一方向（转弯、升降最近在第 2 格）`);
      }
    }
    const feed = belts.find((b) => P(b).x === P(c).x + dx && P(b).y === P(c).y + dy && b.localOffset[0].z > cz + 0.5 && b.localOffset[0].z < cz + 1.5);
    if (!feed) err(`喷涂机 ${c.index} 背后那格上方（第 ${cz + 1} 层）没有增产剂带`);
    else if (![...carried.get(feed.index)].some((it) => SPRAYS.has(it))) warnings.includes('喷涂机取料的那条带上不是增产剂') || warnings.push('喷涂机取料的那条带上不是增产剂');
  }

  // 5b. 喷涂覆盖（蓝图里有喷涂机才查）：每根从带子往工厂取料的分拣器，沿带子往上游走到这条带的来源
  // （带头、物流站出站口，或最后一个往带上放料的出料分拣器）之前经过了喷涂机，取的料才算喷过——
  // 工厂产出的东西不带增产（游戏规则），放料口在喷涂机下游、或来源到取料口之间没有喷涂机，料就没喷到。
  // 一台工厂的原料要么全喷过、要么全没喷：只喷一部分时按最低一级算没有效果，喷过的增产剂白耗（游戏规则）。
  // （用户 2026/10/18 起只喷最终产物的直接原料，上游工厂的原料本来就不喷；以前每级都喷时要求每根取料都喷过）
  let feedSorters = 0;
  let unsprayed = 0;
  let mixed = 0;
  let sprayedFactories = 0;
  {
    const coaterAt = new Set(coaters.map((c) => `${P(c).x},${P(c).y},${Math.round(P(c).z)}`)); // 喷涂机骑着的格（分层）
    const prevOf = new Map(); // 带 index -> 上游的带（可能几条汇进来；过集装机接着算）
    for (const b of belts) {
      const n = b.outputObjIdx >= 0 ? B[b.outputObjIdx] : null;
      const to = n && n.itemId === PILER ? fromPiler.get(n.index) : n && isBelt(n.itemId) ? n : null;
      if (!to) continue;
      if (!prevOf.has(to.index)) prevOf.set(to.index, []);
      prevOf.get(to.index).push(b);
    }
    const dumpsOn = new Set(); // 有出料分拣器往上放料的带（工厂刚放上来的料没喷过）
    for (const s of sorters) if (BODY[B[s.inputObjIdx]?.itemId] && isBelt(B[s.outputObjIdx]?.itemId)) dumpsOn.add(s.outputObjIdx);
    const memo = new Map(); // 带 index -> 流出这一节的料是否全喷过
    const fedBy = new Map(); // 工厂 index -> [取的料喷过的分拣器数, 没喷过的分拣器数]
    const sprayedFrom = (idx) => {
      if (memo.has(idx)) return memo.get(idx);
      memo.set(idx, true); // 环上先按喷过算（纯环没有来源，不会有料）
      const b = B[idx];
      let ok;
      if (coaterAt.has(`${P(b).x},${P(b).y},${Math.round(P(b).z)}`)) ok = true; // 这一节骑着喷涂机：过了它的料都喷过
      else if (dumpsOn.has(idx)) ok = false;
      else if (b.inputObjIdx >= 0 && isStation(B[b.inputObjIdx]?.itemId)) ok = false; // 从物流站出来的料没喷
      else {
        const ups = prevOf.get(idx);
        ok = ups ? ups.every((u) => sprayedFrom(u.index)) : false; // 带头（边缘入口）进来的料也没喷
      }
      memo.set(idx, ok);
      return ok;
    };
    for (const s of sorters) {
      const src = B[s.inputObjIdx];
      const dst = B[s.outputObjIdx];
      if (!src || !isBelt(src.itemId) || !dst || !BODY[dst.itemId] || dst.itemId === THERMAL_PLANT) continue; // 烧掉的燃料不用喷
      feedSorters++;
      if (!coaters.length) continue;
      const ok = sprayedFrom(src.index);
      if (!ok) unsprayed++;
      const t = fedBy.get(dst.index) ?? [0, 0];
      t[ok ? 0 : 1]++;
      fedBy.set(dst.index, t);
    }
    for (const [fi, [yes, no]] of fedBy) {
      if (yes && no) {
        mixed++;
        err(`工厂 ${fi} 的原料只喷了一部分（${yes} 根取料分拣器的料过了喷涂机、${no} 根没过）：按最低一级算没有效果，喷过的增产剂白耗`);
      } else if (yes) sprayedFactories++;
    }
    if (coaters.length && !sprayedFactories) warnings.push('蓝图里有喷涂机，但没有一台工厂的原料全喷过（增产剂不起作用）');
  }

  // 5c. 火力发电厂的燃料：每台要么有分拣器从带燃料的带子上取，要么从一台有燃料的发电厂接过来（一列往下一台传一台）
  if (thermals.length) {
    const fuelled = new Set();
    for (let changed = true; changed;) {
      changed = false;
      for (const s of sorters) {
        const dst = B[s.outputObjIdx];
        const src = B[s.inputObjIdx];
        if (!dst || dst.itemId !== THERMAL_PLANT || fuelled.has(dst.index) || !src) continue;
        const ok = isBelt(src.itemId) ? [...carried.get(src.index)].some((it) => FUEL_MJ[it]) : src.itemId === THERMAL_PLANT && fuelled.has(src.index);
        if (ok) {
          fuelled.add(dst.index);
          changed = true;
        }
      }
    }
    for (const f of thermals) if (!fuelled.has(f.index)) err(`火力发电厂 ${f.index} 没有燃料来源`);
  }

  // 6. 供电（蓝图里有电力设施时才查）：设施不压工厂、带子、分拣器；卫星配电站不进物流站身外那一圈；每台工厂、每根分拣器都在覆盖范围内；设施彼此连通
  const SPEC = new Map(Object.entries(POWER).map(([type, s]) => [s.itemId, { ...s, ...powerReach(type) }]));
  const nodes = B.filter((b) => SPEC.has(b.itemId));
  if (nodes.length) {
    const taken = new Set();
    for (const b of belts) taken.add(`${P(b).x},${P(b).y}`);
    for (const s of sorters) {
      const [p0, p1] = s.localOffset;
      for (let y = Math.round(Math.min(p0.y, p1.y)); y <= Math.round(Math.max(p0.y, p1.y)); y++) for (let x = Math.round(Math.min(p0.x, p1.x)); x <= Math.round(Math.max(p0.x, p1.x)); x++) taken.add(`${x},${y}`);
    }
    // 卫星配电站 3×3，电力感应塔 1 格
    for (const d of [...pilers, ...coaters]) taken.add(`${P(d).x},${P(d).y}`);
    for (const n of nodes) {
      const s = SPEC.get(n.itemId);
      for (const [x, y] of powerCells(n.itemId, P(n).x, P(n).y)) {
        const what = `${s.name} ${n.index}`;
        if (taken.has(`${x},${y}`)) err(`${what}压在 (${x},${y}) 的传送带、分拣器或喷涂机/集装机上`);
        for (const st of stations) if (Math.abs(P(st).x - x) <= 3 && Math.abs(P(st).y - y) <= 3) err(`${what}压在物流站 ${st.index} 上`);
        // 站身外 1 格碰撞圈（按 9×9）只挡卫星配电站，电力感应塔可以贴着站身（体积测试 D2 D3 变红、D4 能放）
        else if (n.itemId === 2212 && Math.abs(P(st).x - x) <= STATION_CLEAR && Math.abs(P(st).y - y) <= STATION_CLEAR) err(`${what}离物流站 ${st.index} 太近（站身外还有 1 格碰撞圈）`);
        for (const f of solids) if (inside(f, x, y, P)) err(`${what}与工厂 ${f.index} 碰撞`);
        for (const b of stores) {
          if (b.inputObjIdx >= 0) continue;
          const w = yawOf(b) % 180 ? STORE_BODY[b.itemId].h : STORE_BODY[b.itemId].w;
          const h = yawOf(b) % 180 ? STORE_BODY[b.itemId].w : STORE_BODY[b.itemId].h;
          if (Math.abs(P(b).x - x) < w / 2 - EPS && Math.abs(P(b).y - y) < h / 2 - EPS) err(`${what}压在${name(b.itemId)} ${b.index} 上`);
        }
      }
      // 卫星配电站 3×3 和化工厂、叠层研究站、对撞机的碰撞体之间要再隔开一点（gamedata.js 的 substationPad，第六张体积测试 + 2026/10/08 验证合集：
      // 化工厂左 0.5、下沿 0.5，叠层研究站四周 1，对撞机左 1.5、下 1.5、右 0.5、上 0.5）。间隔按工厂自己的朝向，转了方向的蓝图跟着转
      if (n.itemId === 2212) for (const f of factories) {
        if (P(f).z > 0) continue; // 叠起来的研究站只看最底下那台
        const stacked = isLab(f.itemId) && factories.some((u) => u !== f && isLab(u.itemId) && P(u).x === P(f).x && P(u).y === P(f).y && P(u).z > 0);
        const m = substationPad({ kind: BODY[f.itemId].kind, levels: stacked ? 2 : 1 }).margin;
        if (!m) continue;
        const b = box(f, P);
        // 工厂自己坐标里的四个方向（左右下上）转到蓝图里，各取对应的间隔
        const ext = { x0: 0, x1: 0, y0: 0, y1: 0 };
        for (const [d, v] of [[[-1, 0], m.left], [[1, 0], m.right], [[0, -1], m.below], [[0, 1], m.above]]) {
          const [wx, wy] = turn(f, d);
          ext[wx < 0 ? 'x0' : wx > 0 ? 'x1' : wy < 0 ? 'y0' : 'y1'] = v;
        }
        const sx = P(n).x, sy = P(n).y;
        if (sx - 1.5 < b.x + b.w / 2 + ext.x1 - EPS && b.x - b.w / 2 - ext.x0 < sx + 1.5 - EPS && sy - 1.5 < b.y + b.h / 2 + ext.y1 - EPS && b.y - b.h / 2 - ext.y0 < sy + 1.5 - EPS) {
          err(`卫星配电站 ${n.index} 离工厂 ${f.index} 太近（实测：化工厂左边和下沿、叠层研究站四周不能紧贴，对撞机左边和下面要隔 2 格、右边和上面隔 1 格）`);
        }
      }
    }
    // 供电设施之间的最小间距（2026/10/05 实测：配电站之间 6、配电站和塔 2√2、塔之间紧挨着不行）
    for (let i = 0; i < nodes.length; i++)
      for (let j = i + 1; j < nodes.length; j++) {
        const [a, b] = [nodes[i], nodes[j]];
        const g = powerGap(a.itemId, b.itemId);
        if ((P(a).x - P(b).x) ** 2 + (P(a).y - P(b).y) ** 2 < g * g - 1e-9) err(`${SPEC.get(a.itemId).name} ${a.index} 和 ${SPEC.get(b.itemId).name} ${b.index} 离得太近（中心至少隔 ${+g.toFixed(2)} 格）`);
      }
    const covered = (pt) => nodes.some((n) => (P(n).x - pt.x) ** 2 + (P(n).y - pt.y) ** 2 <= SPEC.get(n.itemId).cover ** 2);
    for (const f of factories) if (!covered(P(f))) err(`工厂 ${f.index} 不在供电范围内`);
    for (const f of thermals) if (!covered(P(f))) err(`火力发电厂 ${f.index} 不在供电范围内（不并网）`);
    for (const st of stations) if (!covered(P(st))) err(`物流站 ${st.index} 不在供电范围内`);
    for (const d of [...pilers, ...coaters]) if (!covered(P(d))) err(`${d.itemId === PILER ? '自动集装机' : '喷涂机'} ${d.index} 不在供电范围内`);
    for (const d of distributors) if (!covered(P(d))) err(`物流配送器 ${d.index} 不在供电范围内`); // 推断：给配送运输机充电要电（参数里有最大充能功率）
    for (const s of sorters) {
      const [p0, p1] = s.localOffset;
      if (!covered({ x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 })) err(`分拣器 ${s.index} 不在供电范围内`);
    }
    const seen = new Set([0]);
    const st = [0];
    while (st.length) {
      const a = nodes[st.pop()];
      nodes.forEach((b, j) => {
        const l = Math.max(SPEC.get(a.itemId).link, SPEC.get(b.itemId).link);
        if (!seen.has(j) && (P(a).x - P(b).x) ** 2 + (P(a).y - P(b).y) ** 2 <= l * l) {
          seen.add(j);
          st.push(j);
        }
      });
    }
    if (seen.size < nodes.length) warnings.push('电力设施没有连成一张网');
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    stats: { width: bp.dragBoxSize.x, height: bp.dragBoxSize.y, buildings: B.length, factories: factories.length, belts: belts.length, sorters: sorters.length, power: nodes.length, stations: stations.length, pilers: pilers.length, coaters: coaters.length, feedSorters, unsprayed: coaters.length ? unsprayed : null, mixed: coaters.length ? mixed : null, sprayedFactories: coaters.length ? sprayedFactories : null },
  };
}
