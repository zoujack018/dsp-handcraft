// 给页面的精简绘图模型（不带 Map 和循环引用）。从 worker.js 拆出来单独一个文件：
// 除了最终结果，实时预览的快照（搜索中的布局，还没接物流站、供电）也用它转成同一种模型，页面同一套 drawingSvg 来画。
import { ITEMS, slotPoint, THERMAL_BANK } from '../../src/gamedata.js';
import { chainTiles } from '../../src/emit/blueprint.js';
import { bankSorters } from '../../src/plan/burn.js';

const realOf = (id) => (id >= 100000 ? id - 100000 : id);
/** route() 的布局 → 页面画图用的精简模型（rows、segments、legs、sorters…） */
export function renderModel(graph, L) {
  const rows = L.rows.map((row, r) => ({
    cy: L.rowCy[r],
    groups: row.map((bid) => {
      const p = L.pos.get(bid);
      const g = p.g;
      return { id: bid, letter: g.letter, item: g.item, factory: g.factory, kind: g.kind, count: p.n, levels: g.levels ?? 1, centers: p.centers, w: g.collider?.[0], h: g.collider?.[1], below: g.bodyBelow, above: g.bodyAbove };
    }),
  }));
  const items = Object.fromEntries([...graph.items.values()].map((f) => [f.itemId, { name: f.name, letter: f.letter, rate: f.rate }]));
  for (const pl of L.proLines || []) items[pl.itemId] = { name: ITEMS.get(pl.itemId).name, letter: 'p', rate: (items[pl.itemId]?.rate ?? 0) + (pl.rate ?? 0) };
  const segments = L.segments.map((s) => ({ id: s.id, itemId: s.itemId, a: s.a, b: s.b, y: s.y, dir: s.dir, split: s.split, rate: s.rate }));
  const legs = L.legs.map((l) => ({ itemId: l.itemId, kind: l.kind, level: l.level, cells: l.cells, road: l.road }));
  const sorters = L.sorterList.map((s) => {
    const cy = L.rowCy[L.pos.get(s.bid).row];
    const seg = L.segments[s.segId];
    const g = L.pos.get(s.bid).g;
    const pt = slotPoint(g, s.side, s.col - s.cx); // 研究站、对撞机的分拣器对齐槽位（x 带小数）
    return { x: s.cx + pt.dx, y0: cy + pt.dy, y1: seg.y, io: s.io, itemId: s.itemId, factoryItem: g.item };
  });
  const power = L.power ? { name: L.power.name, size: L.power.size, cover: L.power.cover, nodes: L.power.nodes } : null;
  const stations = (L.stations || []).map((st) => ({ x: st.x, y: st.y }));
  // 搜索中还没接站：打分时估的站位（holes.js，7×7 空地的中心），实时预览画成虚线框；真正接站在搜索结束后，位置可能不同
  const stationSites = L.stations?.length ? [] : (L.holes?.sites || []).map((st) => ({ x: st.x, y: st.y }));
  const stubs = L.legs.filter((l) => l.stub).map((l) => ({ itemId: l.itemId, cells: l.stub }));
  // 使用与蓝图导出完全相同的有向逐格路径，包含站口接线的真实高度。
  const routes = L.chains.flatMap((ch) => {
    const tiles = chainTiles(L, ch);
    const burned = ch.parts.some((q) => q.leg != null && L.legs[q.leg].burn != null); // 送去火力发电厂烧掉的副产物：带尾是死胡同，不画出口
    return [tiles.main, ...tiles.extra].map((cells, i) => ({ itemId: ch.itemId, cells, inPort: i === 0 && tiles.inPort && !tiles.inStation, outPort: i === 0 && tiles.outPort && !tiles.outStation && !burned })).filter((r) => r.cells.length);
  });
  // 增产剂带（可能几条：从物流站空口或边缘入口出来，横穿各台喷涂机背后那格）
  for (const pl of L.proLines || []) routes.push({ itemId: pl.itemId, cells: pl.cells, inPort: !pl.station, outPort: false });
  // 翘曲器带（站与站之间）
  if (L.warperLinks?.length) {
    items[1210] = { name: ITEMS.get(1210).name, letter: 'w', rate: 0 };
    for (const w of L.warperLinks) routes.push({ itemId: 1210, cells: w.cells, inPort: false, outPort: false });
  }
  // 喷涂机、自动集装机画成压在带子上的小符号（drawing.js 的 devices）
  const devices = [...(L.coaters || []).map((c) => ({ x: c.x, y: c.y, kind: 'coater' })), ...(L.pilers || []).map((p) => ({ x: p.x, y: p.y, kind: 'piler' }))];
  // 就地烧副产物的火力发电厂（plan/burn.js）：各台的占地框（碰撞体的估计）和它们的分拣器
  const burners = (L.burners || []).map((b) => {
    const chain = L.chains.find((ch) => ch.parts.some((q) => q.leg != null && L.legs[q.leg].burn != null && realOf(L.legs[q.leg].itemId) === b.itemId));
    const itemId = chain?.itemId ?? b.itemId;
    for (const s of bankSorters(b)) sorters.push({ x: s.p0[0], y0: s.p1[1], y1: s.p0[1], io: 'in', itemId, factoryItem: '火力发电厂' });
    return { itemId: b.itemId, plants: b.plants, box: THERMAL_BANK.box };
  });
  return { width: L.width, height: L.height, rotated: !!L.rotated, origin: L.origin ?? { x: 0, y: 0 }, rows, items, segments, legs, sorters, power, stations, stationSites, stubs, routes, devices, burners, streets: L.streets || [], trunk: L.trunk ?? null };
}
