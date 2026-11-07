// 无带流接物流站：原料、产物那几条带（DSQ 排的都只有几节）整条挪到站口上，从站口那节起往外一字排开（原料从站出来往外流、产物往里流进站），
// 机器那头的分拣器照旧隔空连着这几节；中间产物的带子一条一列、底边对齐，放在第一、二座站中间（只有一座站时放在它右边）。
// 一座站最多 5 种物品，同一种进出不放同一座（game-rules 第 37 条）；先用站左右两侧的 6 个口（实测验证过），不够才用上面 3 个（口位推断），
// 上面挂最短的几条，免得竖着伸太长；站排成一行，站心隔够 SPAN。
// 每座站（连它的带子）、中间产物带各是一块，页面上能各自拖（perimeter.js 的 partsFit）。
// 翘曲器（左栏「翘曲器格：整张一格」）：一座站留一格存翘曲器（星际需求），别的站从它那里接一条翘曲器带（linkWarpers，位置定下来以后再接）
// 喷了增产剂：喷涂机跟着它骑的链挪，增产剂当一种原料分站口，位置定下来以后从站口在 1 层拉一条带走过每台喷涂机（linkSpray）
import buildingsData from '../../data/Buildings.json' with { type: 'json' };
import { STATION_PORTS, pathfind, DIRS, dirIndex } from '../plan/stations.js';
import { STATION_GAP, STATION_M, stationWorstM, factory } from '../gamedata.js';
import { WARPER } from '../plan/layout/shared.js';

const BELTS = new Set([2001, 2002, 2003]);
const SORTERS = new Set([2011, 2012, 2013, 2014]);
const MACHINES = new Set([2302, 2315, 2319, 2303, 2304, 2305, 2318, 2309, 2317, 2308, 2310, 2901, 2902]);
const BELT_MODEL = { 2001: 35, 2002: 36, 2003: 37 };
const COATER = 2313;
const PROLIFERATORS = new Set([1141, 1142, 1143]);
const FWD = { 0: [0, 1], 90: [1, 0], 180: [0, -1], 270: [-1, 0] }; // 朝向 → 往前一格
const MAXL = 2; // 接带子最高到第几层
const yawOf = (b) => ((Math.round(b.yaw?.[0] ?? 0) % 360) + 360) % 360;
const LIFT_SHIFT = 0.0016;
// 站口那头先接几节空带子（不挂分拣器）：站立着的时候，拆了带子原地再贴，落在站身碰撞体里的带子放不下（站口那节和往外一节），
// 留着站和这几节不拆，挂分拣器的带子都在站身外面
const PORT_BUFFER = 4;
export const STATION = 2104;
const MAX_ITEMS = 5;
// 站心至少隔几格：贴到哪条纬度带、东西隔还是南北隔都够 29 m（蓝图多高、带子区转到哪边都不知道，按最坏的算，同独立检查）
export let SPAN = Math.ceil(STATION_GAP);
while (stationWorstM(SPAN, 0, 1).m < STATION_M || stationWorstM(0, SPAN, 1).m < STATION_M) SPAN++;
const SLOTS = [4, 10, 3, 9, 5, 11, 1, 0, 2]; // 西、东两侧先中间再上下，再用上面一排
const SIDE = 6; // 左右两侧的口数
const HEADING = { '1,0': 90, '-1,0': 270, '0,1': 0, '0,-1': 180 }; // 往东、西、北、南流
const TEMPLATE = Object.values(buildingsData.buildings).find((b) => b.itemId === STATION);

/** 带子区里的带子按链分：带头贴了标签的是原料（in），带尾贴了标签的是产物（out），别的是中间产物（mid）；有并线时返回 null */
function chainsOf(B, zone) {
  const isBelt = (b) => !!b && BELTS.has(b.itemId);
  const fed = new Map();
  for (const b of zone) if (isBelt(B[b.outputObjIdx])) {
    if (fed.has(b.outputObjIdx)) return null;
    fed.set(b.outputObjIdx, b);
  }
  const chains = [];
  for (const b of zone) {
    if (fed.has(b.index)) continue;
    const nodes = [];
    for (let n = b; isBelt(n) && nodes.length <= zone.length; n = B[n.outputObjIdx]) nodes.push(n);
    const [head, tail] = [nodes[0], nodes[nodes.length - 1]];
    const kind = head.parameters?.iconId ? 'in' : tail.parameters?.iconId ? 'out' : 'mid';
    chains.push({ nodes, kind, itemId: kind === 'in' ? head.parameters.iconId : kind === 'out' ? tail.parameters.iconId : 0 });
  }
  return chains.reduce((n, c) => n + c.nodes.length, 0) === zone.length ? chains : null;
}

/** 原料、产物按物品分站：照 DSQ 的顺序装，一座满了（5 种、9 个口）或者同一种已经反着进出了就另开一座；超过 6 条的，最短的几条排到最后（挂上面的口） */
function groupsOf(chains) {
  const groups = [];
  for (const c of chains) {
    const kinds = (g) => new Set(g.map((q) => `${q.itemId}${q.kind}`));
    let g = groups.find((g) => g.length < SLOTS.length && kinds(g).has(`${c.itemId}${c.kind}`));
    g ||= groups.find((g) => g.length < SLOTS.length && kinds(g).size < MAX_ITEMS && !g.some((q) => q.itemId === c.itemId));
    if (!g) groups.push((g = []));
    g.push(c);
  }
  return groups.map((g) => {
    if (g.length <= SIDE) return g;
    const top = new Set([...g].sort((a, b) => a.nodes.length - b.nodes.length).slice(0, g.length - SIDE));
    return [...g.filter((c) => !top.has(c)), ...g.filter((c) => top.has(c))];
  });
}

/**
 * 带子区（zone：DSQ 排的带子、喷涂机）接到物流站：带子挪到新位置（同一批对象，编号、上下游照旧），站接在 B 后面。opt.pile：站往带上出货叠几层；
 * opt.warper：要不要留一格翘曲器（留在有空格的第一座站；都满了就把最后一种挪出去单开一座）；opt.buffer：站口先接几节空带子（默认 PORT_BUFFER）。
 * 喷了增产剂的：喷涂机跟着它骑的那条链挪（还骑在同一节上，朝向顺着带子）；离站太近会撞站身的，在站口那头补几节带子把它推出去。
 * DSQ 的增产剂带和那条空的增产剂原料链（一根分拣器都不挂）不要了（dropped），增产剂当一种原料分站口，位置都定下来以后从那个口拉（linkSpray）。
 * 返回 { added 新加的站和带子, stations: [{ items: [{ itemId, kind }], warper 存不存翘曲器 }], parts: [{ kind: 'station' | 'mid', members 这一块的建筑 }],
 * box 新的外框（底边是站身的下沿）, spray 增产剂从哪儿拉 { station, slot, itemId, coaters }（没喷是 null） }；
 * 接不了时返回 { skip: 'spray' }（喷涂机骑在增产剂带上、没有增产剂带）、{ skip: 'other' }（带子区里有带子、喷涂机以外的东西）或 null（有并线），都什么也不改
 */
export function attachStations(B, zone, opt = {}) {
  if (zone.some((b) => !BELTS.has(b.itemId) && b.itemId !== COATER)) return { skip: 'other' };
  const belts = zone.filter((b) => BELTS.has(b.itemId));
  const coaters = zone.filter((b) => b.itemId === COATER);
  const all = chainsOf(B, belts);
  if (!all) return null;
  // 增产剂带：带头贴着增产剂、走到高处的，和空的增产剂原料链
  const hooked = new Set();
  for (const s of B) if (SORTERS.has(s.itemId)) for (const k of [s.inputObjIdx, s.outputObjIdx]) hooked.add(k);
  const isFeed = (c) => c.kind === 'in' && PROLIFERATORS.has(c.itemId) && (c.nodes.some((n) => n.localOffset[0].z > 0.01) || c.nodes.every((n) => !hooked.has(n.index)));
  const feeds = all.filter(isFeed);
  const chains = all.filter((c) => !isFeed(c));
  // 每台喷涂机骑在哪条链的第几节
  const nodeAt = new Map();
  for (const c of chains) c.nodes.forEach((n, j) => n.localOffset[0].z < 0.01 && nodeAt.set(`${Math.round(n.localOffset[0].x)},${Math.round(n.localOffset[0].y)}`, [c, j]));
  for (const t of coaters) {
    const hit = nodeAt.get(`${Math.round(t.localOffset[0].x)},${Math.round(t.localOffset[0].y)}`);
    if (!hit) return { skip: 'spray' };
    (hit[0].coaters ??= []).push({ b: t, j: hit[1] });
  }
  if (coaters.length && !feeds.length) return { skip: 'spray' };
  const added = [];
  // 喷涂机压着的 3 节要在站身外面（离站口 2 节起，game-rules 第 24 条）；站口那头另外先接 PORT_BUFFER 节空带子（opt.buffer 可改）。
  // 原料链补在头上、产物链补在尾上
  const tpl = chains.find((c) => c.nodes.length)?.nodes[0] ?? belts[0];
  const buffer = Math.max(0, Math.round(opt.buffer ?? PORT_BUFFER));
  for (const c of chains) {
    if (c.kind === 'mid' || (!c.coaters && !buffer)) continue;
    const n = c.nodes.length;
    const near = !c.coaters ? Infinity : c.kind === 'in' ? Math.min(...c.coaters.map((t) => t.j)) - 1 : n - 2 - Math.max(...c.coaters.map((t) => t.j));
    const more = Array.from({ length: Math.max(0, 2 - near, buffer) }, () => {
      const b = structuredClone(tpl);
      Object.assign(b, { index: B.length, inputObjIdx: -1, outputObjIdx: -1, inputFromSlot: 0, outputToSlot: 0, parameters: null });
      B.push(b);
      added.push(b);
      return b;
    });
    if (!more.length) continue;
    // 原料头一节、产物最后一节的标签跟着挪到新的接站那一节
    const [oldEnd, newEnd] = c.kind === 'in' ? [c.nodes[0], more[0]] : [c.nodes[n - 1], more[more.length - 1]];
    if (oldEnd?.parameters?.iconId) [newEnd.parameters, oldEnd.parameters] = [oldEnd.parameters, null];
    const line = c.kind === 'in' ? [...more, ...c.nodes] : [...c.nodes, ...more];
    line.forEach((b, i) => i + 1 < line.length && Object.assign(b, { outputObjIdx: line[i + 1].index, outputToSlot: 1 }));
    if (c.kind === 'in') for (const t of c.coaters ?? []) t.j += more.length;
    c.nodes = line;
  }
  // 增产剂当一条原料链分站口（排在最前，进挨着中间产物带的第一座站）：这时还不铺
  if (coaters.length) chains.unshift({ nodes: [], kind: 'in', itemId: feeds[0].itemId, feed: true });
  for (const c of feeds) for (const b of c.nodes) b.dropped = true;
  const mids = chains.filter((c) => c.kind === 'mid');
  const groups = groupsOf(chains.filter((c) => c.kind !== 'mid'));
  if (!groups.length) return null;
  const kinds = (g) => new Set(g.map((c) => `${c.itemId}${c.kind}`)).size;
  if (opt.warper && groups.every((g) => kinds(g) >= MAX_ITEMS)) {
    const last = groups[groups.length - 1];
    const k = `${last[last.length - 1].itemId}${last[last.length - 1].kind}`;
    groups.push(last.filter((c) => `${c.itemId}${c.kind}` === k));
    groups[groups.length - 2] = last.filter((c) => `${c.itemId}${c.kind}` !== k);
  }
  const warperAt = opt.warper ? groups.findIndex((g) => kinds(g) < MAX_ITEMS) : -1;
  const place = (b, x, y, yaw) => {
    b.localOffset = [{ x, y, z: 0 }, { x, y, z: 0 }];
    b.yaw = [yaw, yaw];
  };
  // 每座站的口：第 i 条带挂 SLOTS[i]；一面伸出去最长几节
  const port = (i) => STATION_PORTS.find((p) => p.slot === SLOTS[i]);
  const reach = (g, nx, ny) => Math.max(0, ...g.filter((_, i) => port(i).nx === nx && port(i).ny === ny).map((c) => c.nodes.length));
  const half = (g, west) => Math.max(3, 1 + reach(g, west ? -1 : 1, 0)); // 站心往左 / 右占到第几格（站身或那一侧的带子）
  // 站心 y 让站身、南边的带子都不低于 0（中间产物那一排从 0 起）；第一座站左边的带子从 x = 1 起，后面每座站离前一座（和中间产物）至少空一格、站心隔够 SPAN
  const cy = Math.max(3, 1 + Math.max(...groups.map((g) => reach(g, 0, -1))));
  const combX = (cx) => cx + half(groups[0], false) + 2; // 中间产物那一排从哪一列起
  const xs = [];
  for (let k = 0; k < groups.length; k++) {
    if (!k) xs.push(1 + half(groups[0], true));
    else {
      const after = k === 1 && mids.length ? combX(xs[0]) + mids.length - 1 : xs[k - 1] + half(groups[k - 1], false);
      xs.push(Math.max(xs[k - 1] + SPAN, after + 2 + half(groups[k], true)));
    }
  }
  const stations = [];
  const parts = [];
  let spray = null;
  const riders = (c) => (c.coaters ?? []).map((t) => t.b);
  // 喷涂机骑回它那一节上，朝向同那节带子
  const ride = (c) => {
    for (const t of c.coaters ?? []) {
      const n = c.nodes[t.j];
      place(t.b, n.localOffset[0].x, n.localOffset[0].y, n.yaw[0]);
    }
  };
  groups.forEach((g, k) => {
    const cx = xs[k];
    const st = structuredClone(TEMPLATE);
    delete st.itemName;
    delete st.attributes;
    st.index = B.length;
    B.push(st);
    added.push(st);
    st.localOffset = [{ x: cx, y: cy, z: 0 }, { x: cx, y: cy, z: 0 }];
    st.yaw = [0, 0];
    const prm = st.parameters;
    const items = [...new Map(g.map((c) => [`${c.itemId}${c.kind}`, { itemId: c.itemId, kind: c.kind }])).values()];
    prm.storage = prm.storage.map((_, i) => {
      const it = items[i];
      const role = it?.kind === 'in' ? 2 : 1; // 原料需求、产物供应（本地、星际都是）
      if (!it && k === warperAt && i === items.length) return { itemId: WARPER, localRole: 0, remoteRole: 2, max: 1000, lockAmount: 0 }; // 翘曲器：本地仓储、星际需求（同 emit/blueprint.js）
      return it ? { itemId: it.itemId, localRole: role, remoteRole: role, max: 5000, lockAmount: 0 } : { itemId: 0, localRole: 0, remoteRole: 0, max: 0, lockAmount: 0 };
    });
    prm.slots = prm.slots.map(() => ({ dir: 0, storageIdx: 0 }));
    prm.pilerCount = Math.min(4, Math.max(1, Math.round(opt.pile ?? 1)));
    g.forEach((c, i) => {
      const q = port(i);
      const n = c.nodes.length;
      if (c.feed) {
        spray = { station: st, slot: q.slot, itemId: c.itemId, coaters };
        prm.slots[q.slot] = { dir: 1, storageIdx: items.findIndex((it) => it.itemId === c.itemId && it.kind === 'in') + 1 };
        return;
      }
      // 原料：头一节在站口、往外流；产物：最后一节在站口、往里流进站
      const f = c.kind === 'in' ? 1 : -1;
      c.nodes.forEach((b, j) => {
        const d = c.kind === 'in' ? j : n - 1 - j;
        place(b, cx + q.dx + q.nx * d, cy + q.dy + q.ny * d, HEADING[`${q.nx * f},${q.ny * f}`]);
      });
      prm.slots[q.slot] = { dir: c.kind === 'in' ? 1 : 2, storageIdx: items.findIndex((it) => it.itemId === c.itemId && it.kind === c.kind) + 1 };
      if (c.kind === 'in') Object.assign(c.nodes[0], { inputObjIdx: st.index, inputFromSlot: q.slot });
      else Object.assign(c.nodes[n - 1], { outputObjIdx: st.index, outputToSlot: q.slot });
      ride(c);
    });
    stations.push({ x: cx, items, warper: k === warperAt });
    parts.push({ kind: 'station', members: [st, ...g.flatMap((c) => [...c.nodes, ...riders(c)])] });
  });
  // 中间产物：一条一列，从 y = 0 往上流
  mids.forEach((c, i) => {
    c.nodes.forEach((b, j) => place(b, combX(xs[0]) + i, j, 0));
    ride(c);
  });
  if (mids.length) parts.push({ kind: 'mid', members: mids.flatMap((c) => [...c.nodes, ...riders(c)]) });
  const box = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
  for (const b of [...zone, ...added]) {
    if (b.dropped) continue;
    const p = b.localOffset[0];
    const h = b.itemId === STATION ? 3.5 : 0.5;
    box.x0 = Math.min(box.x0, p.x - h);
    box.x1 = Math.max(box.x1, p.x + h);
    box.y0 = Math.min(box.y0, p.y - h);
    box.y1 = Math.max(box.y1, p.y + h);
  }
  return { added, stations: stations.map((s) => ({ items: s.items, warper: s.warper })), parts, box, spray };
}

/**
 * 翘曲器带（位置都定下来以后接）：存翘曲器那座站的空口出、进别的站的空口（进星际站的翘曲器自动进它的翘曲器仓，不占物品格），
 * 用生成器接站的寻路，工厂、站身挡所有高度，带子挡它那一层。整条走 L2（站口那节在 1 层接，game-rules 第 87 条），
 * 底下还能过地面的带子；跨别的翘曲器带时上 L3，这样接不上才走地面。还接不上的站自己还有空格就也存一格。
 * B：整张建筑表（编号就是下标），新带子接在后面；opt.belt：带子型号 1~3。返回 { linked 接了几条, own 自己存的几座, missed 都没有的几座 }
 */
export function linkWarpers(B, opt = {}) {
  const stations = B.filter((b) => b.itemId === STATION);
  const hasWarper = (st) => st.parameters.storage.some((x) => x.itemId === WARPER);
  const home = stations.find(hasWarper);
  const out = { linked: 0, own: 0, missed: 0 };
  if (!home) return out;
  const g = gridOf(B);
  const { O, gx, gy, W, H } = g;
  const high = { ...O, ground: { has: () => true } };
  const used = (st) => new Set(st.parameters.slots.map((sl, i) => (sl.dir ? i : -1)).filter((i) => i >= 0));
  const stub = (st, q, d, z = 1) => [Math.round(st.localOffset[0].x) + q.dx + q.nx * d - gx, Math.round(st.localOffset[0].y) + q.dy + q.ny * d - gy, z];
  const beltId = { 1: 2001, 2: 2002, 3: 2003 }[opt.belt] ?? 2003;
  const warperIdx = home.parameters.storage.findIndex((x) => x.itemId === WARPER) + 1;
  for (const st of stations) {
    if (st === home) continue;
    // 两边的空口里挑离得近的几对试
    const pairs = [];
    for (const qa of STATION_PORTS) if (!used(home).has(qa.slot)) for (const qb of STATION_PORTS) if (!used(st).has(qb.slot)) {
      const [ax, ay] = stub(home, qa, 2);
      const [bx, by] = stub(st, qb, 2);
      pairs.push({ qa, qb, d: Math.abs(ax - bx) + Math.abs(ay - by) });
    }
    pairs.sort((a, b) => a.d - b.d);
    // 站口那节在 z 层接，grid 里走 tops 这几种最高层
    const link = (z, grid, tops) => {
      for (const { qa, qb } of pairs.slice(0, 6)) {
        const sa = [0, 1, 2].map((d) => stub(home, qa, d, z));
        const sb = [0, 1, 2].map((d) => stub(st, qb, d, z));
        if ([...sa, ...sb].some(([x, y, l]) => O.belts.has(`${x},${y},${l}`)) || O.solid.has(`${sa[2][0]},${sa[2][1]}`) || O.solid.has(`${sb[2][0]},${sb[2][1]}`)) continue;
        for (const top of tops) {
          const r = pathfind(sa[2], sb[2], grid, W, H, top, dirIndex(qa.nx, qa.ny), null, dirIndex(-qb.nx, -qb.ny));
          if (r && !r.cut) return { qa, qb, tiles: [sa[0], sa[1], ...r.cells, sb[1], sb[0]] };
        }
      }
      return null;
    };
    // 地面整个不走：先只走 1 层，跨别的翘曲器带走不通再许 2 层；都接不上再照地面也能走的接
    const got = link(1, high, [1, MAXL]) ?? link(0, O, [MAXL]);
    if (!got) {
      // 接不上：自己还有空格就也存一格
      const free = st.parameters.storage.findIndex((x) => !x.itemId);
      if (free >= 0) {
        st.parameters.storage[free] = { itemId: WARPER, localRole: 0, remoteRole: 2, max: 1000, lockAmount: 0 };
        out.own++;
      } else out.missed++;
      continue;
    }
    const bs = lay(B, g, got.tiles, beltId);
    Object.assign(bs[0], { inputObjIdx: home.index, inputFromSlot: got.qa.slot });
    Object.assign(bs[bs.length - 1], { outputObjIdx: st.index, outputToSlot: got.qb.slot });
    home.parameters.slots[got.qa.slot] = { dir: 1, storageIdx: warperIdx };
    st.parameters.slots[got.qb.slot] = { dir: 2, storageIdx: 0 };
    out.linked++;
  }
  return out;
}

/**
 * 增产剂带（各块位置都定下来以后接，翘曲器带之前）：从供增产剂那座站的口在 1 层出，依次走过每台喷涂机背后那格的正上方
 * （game-rules 第 24、43 条：横穿或伸到那儿断掉都行），到最后一台那儿断掉。寻路同翘曲器带：地面整个不走，先只走 1 层，走不通再许 2 层；
 * 每次去离得最近的那台，顺路经过的也算；那座站分给增产剂的口和别的空口都试，用整条最短的（上下两侧的口不到万不得已不用）。
 * spray：attachStations 返回的 { station, slot, itemId, coaters }；opt.belt：带子型号 1~3。
 * 都接上了返回 true；有一台够不着返回 false，什么也不加
 */
export function linkSpray(B, spray, opt = {}) {
  const g = gridOf(B);
  const st = spray.station;
  const slots = st.parameters.slots;
  // 分给增产剂的口和别的空口都试，挑整条最短的；上下两侧的口位是推断的（game-rules 第 77 条），按多走 6 节算
  let best = null;
  for (const q of STATION_PORTS) {
    if (q.slot !== spray.slot && slots[q.slot].dir) continue;
    const tiles = sprayRoute(g, st, q, spray.coaters);
    const cost = tiles && tiles.length + (q.nx ? 0 : 6);
    if (tiles && (!best || cost < best.cost)) best = { q, tiles, cost };
  }
  if (!best) return false;
  if (best.q.slot !== spray.slot) [slots[best.q.slot], slots[spray.slot]] = [slots[spray.slot], { dir: 0, storageIdx: 0 }];
  const bs = lay(B, g, best.tiles, { 1: 2001, 2: 2002, 3: 2003 }[opt.belt] ?? 2003);
  Object.assign(bs[0], { inputObjIdx: st.index, inputFromSlot: best.q.slot, parameters: { iconId: spray.itemId } });
  return true;
}

/** 增产剂带从站 st 的口 q 出、走过每台喷涂机背后那格的格子（网格坐标），走不通返回 null；不改网格 */
function sprayRoute(g, st, q, coaters) {
  const { O, gx, gy, W, H } = g;
  const tiles = [0, 1, 2].map((d) => [Math.round(st.localOffset[0].x) + q.dx + q.nx * d - gx, Math.round(st.localOffset[0].y) + q.dy + q.ny * d - gy, 1]);
  if (tiles.some(([x, y, l]) => O.belts.has(`${x},${y},${l}`)) || O.solid.has(`${tiles[2][0]},${tiles[2][1]}`)) return null;
  const mine = new Set(tiles.map((t) => t.join()));
  const grid = { ...O, ground: { has: () => true }, belts: { has: (k) => O.belts.has(k) || mine.has(k) } };
  let left = coaters.map((c) => {
    const [fx, fy] = FWD[yawOf(c)];
    return [Math.round(c.localOffset[0].x) - fx - gx, Math.round(c.localOffset[0].y) - fy - gy, 1];
  });
  let dir = dirIndex(q.nx, q.ny);
  while ((left = left.filter((t) => !mine.has(t.join()))).length) {
    const at = tiles[tiles.length - 1];
    left.sort((a, b) => Math.abs(a[0] - at[0]) + Math.abs(a[1] - at[1]) - Math.abs(b[0] - at[0]) - Math.abs(b[1] - at[1]));
    let cells = null;
    for (const t of left) {
      for (const top of [1, MAXL]) {
        const r = pathfind(at, t, grid, W, H, top, dir, null, 4);
        if (r && !r.cut) {
          cells = r.cells.slice(1);
          break;
        }
      }
      if (cells) break;
    }
    if (!cells) return null;
    for (const c of cells) {
      tiles.push(c);
      mine.add(c.join());
    }
    const [a, b] = tiles.slice(-2);
    if (a[0] !== b[0] || a[1] !== b[1]) dir = dirIndex(Math.sign(b[0] - a[0]), Math.sign(b[1] - a[1]));
  }
  return tiles;
}

/**
 * 接带子用的网格：整张外框四周留 12 格，坐标挪成非负整数。工厂、站身、喷涂机身（它那格和前头那格；背后那格上方是增产剂带）挡所有高度，
 * 分拣器挡地面，带子挡它那一层；不要了的带子（dropped）不算
 */
function gridOf(B) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of B) {
    if (b.itemId === 2201 || b.dropped) continue; // DSQ 原来的塔（这时还在 DSQ 的位置上，后面换掉）
    const p = b.localOffset[0];
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  const gx = Math.floor(x0) - 12;
  const gy = Math.floor(y0) - 12;
  const W = Math.ceil(x1) + 12 - gx + 1;
  const H = Math.ceil(y1) + 12 - gy + 1;
  const O = { solid: new Set(), ground: new Set(), belts: new Set() };
  const cell2 = (x, y) => `${x - gx},${y - gy}`;
  for (const b of B) {
    if (b.dropped) continue;
    const p = b.localOffset[0];
    if (MACHINES.has(b.itemId) && p.z < 0.01) {
      const f = factory(b.itemId);
      const yaw = yawOf(b);
      const [w, h] = yaw % 180 ? [f.collider[1], f.collider[0]] : f.collider;
      for (let x = Math.floor(p.x - w / 2 - 1); x <= Math.ceil(p.x + w / 2 + 1); x++) for (let y = Math.floor(p.y - h / 2 - 1); y <= Math.ceil(p.y + h / 2 + 1); y++) if (Math.abs(x - p.x) < w / 2 + 0.5 && Math.abs(y - p.y) < h / 2 + 0.5) O.solid.add(cell2(x, y));
    } else if (b.itemId === STATION) {
      for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) O.solid.add(cell2(Math.round(p.x) + dx, Math.round(p.y) + dy));
    } else if (SORTERS.has(b.itemId)) {
      const [a, c] = b.localOffset;
      for (let y = Math.round(Math.min(a.y, c.y)); y <= Math.round(Math.max(a.y, c.y)); y++) for (let x = Math.round(Math.min(a.x, c.x)); x <= Math.round(Math.max(a.x, c.x)); x++) O.ground.add(cell2(x, y));
    } else if (BELTS.has(b.itemId)) O.belts.add(`${cell2(Math.round(p.x), Math.round(p.y))},${Math.round(p.z)}`);
    else if (b.itemId === COATER) {
      const [fx, fy] = FWD[yawOf(b)];
      for (const k of [0, 1]) O.solid.add(cell2(Math.round(p.x) + fx * k, Math.round(p.y) + fy * k));
    }
  }
  return { O, gx, gy, W, H };
}

/** 照格子铺一条带（tiles：网格坐标 [x, y, 层]，顺着流向）：新带子接在 B 后面，一节连下一节，朝向照走向，原地升降那一叠错开；格子记进网格。返回这几节 */
function lay(B, g, tiles, beltId) {
  const { O, gx, gy } = g;
  const tpl = B.find((b) => BELTS.has(b.itemId) && !b.dropped);
  for (const [x, y, l] of tiles) O.belts.add(`${x},${y},${l}`);
  const bs = tiles.map(([x, y, l]) => {
    const b = structuredClone(tpl);
    Object.assign(b, { index: B.length, itemId: beltId, modelIndex: BELT_MODEL[beltId], localOffset: [{ x: x + gx, y: y + gy, z: l }, { x: x + gx, y: y + gy, z: l }], inputObjIdx: -1, outputObjIdx: -1, inputFromSlot: 0, outputToSlot: 0, parameters: null });
    B.push(b);
    return b;
  });
  const t = tiles;
  bs.forEach((b, i) => {
    if (i + 1 < bs.length) Object.assign(b, { outputObjIdx: bs[i + 1].index, outputToSlot: 1 });
    // 朝向：往后找第一格换了位置的方向，到头就照前面的
    let d = -1;
    for (let j = i + 1; j < t.length && d < 0; j++) if (t[j][0] !== t[i][0] || t[j][1] !== t[i][1]) d = dirIndex(Math.sign(t[j][0] - t[j - 1][0]), Math.sign(t[j][1] - t[j - 1][1]));
    for (let j = i - 1; j >= 0 && d < 0; j--) if (t[j][0] !== t[i][0] || t[j][1] !== t[i][1]) d = dirIndex(Math.sign(t[i][0] - t[j][0]), Math.sign(t[i][1] - t[j][1]));
    const yaw = [90, 270, 0, 180][d < 0 ? 0 : d];
    b.yaw = [yaw, yaw];
  });
  // 原地升降（同一格的一叠）：照官方垂直传送带，一叠里按流向往来路方向错开，还剩几节到出口就错几个 LIFT_SHIFT（同 emit/blueprint.js）
  for (let i = 0; i < t.length; ) {
    let j = i;
    while (j + 1 < t.length && t[j + 1][0] === t[i][0] && t[j + 1][1] === t[i][1]) j++;
    if (j > i) {
      const unit = (a, b) => [Math.sign(b[0] - a[0]), Math.sign(b[1] - a[1])];
      const u = i > 0 ? unit(t[i], t[i - 1]) : j + 1 < t.length ? unit(t[j + 1], t[j]) : [0, 0];
      for (let m = i; m < j; m++) {
        const q = bs[m].localOffset[0];
        q.x = Math.round((q.x + u[0] * (j - m) * LIFT_SHIFT) * 1e4) / 1e4;
        q.y = Math.round((q.y + u[1] * (j - m) * LIFT_SHIFT) * 1e4) / 1e4;
        bs[m].localOffset[1] = { ...q };
      }
    }
    i = j + 1;
  }
  return bs;
}
