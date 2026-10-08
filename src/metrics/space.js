// 空间利用率：三种口径，各回答一个问题。
//   space    空间利用率：地面上被任何建筑（工厂本体、地面传送带、分拣器、电力设施，配电站按 5×5 去四角）占用的格子 ÷ 总面积。有没有浪费地。
//   factory  工厂占地率：工厂本体的格子 ÷ 总面积（熔炉、制造台按 3×3，化工厂按 8×4）。
//   rows     行利用率：工厂行被工厂占满的比例（route 里的 fill）。行排得紧不紧。
import { chainTiles } from '../emit/blueprint.js';
import { powerCells, THERMAL_BANK } from '../gamedata.js';

export function spaceStats(L) {
  const ground = new Set();
  const K = (x, y) => `${x},${y}`;
  let factoryCells = 0;
  for (const p of L.pos.values()) {
    const cy = L.rowCy[p.row];
    const w = Math.min(p.g.bodyWidth, p.g.pitch);
    factoryCells += p.n * w * p.g.bodyHeight;
    const hw = (p.g.bodyWidth - 1) / 2;
    for (const cx of p.centers) for (let x = cx - hw; x <= cx + hw; x++) for (let y = cy - p.g.bodyBelow; y <= cy + p.g.bodyAbove; y++) ground.add(K(x, y));
  }
  for (const ch of L.chains) {
    const t = chainTiles(L, ch);
    for (const [x, y, z] of [...t.main, ...t.extra.flat()]) if (z === 0) ground.add(K(x, y));
  }
  for (const s of L.sorterList) {
    const p = L.pos.get(s.bid);
    const seg = L.segments[s.segId];
    const edge = s.side === 'bottom' ? L.rowCy[p.row] - p.g.edgeBelow : L.rowCy[p.row] + p.g.edgeAbove;
    for (let y = Math.min(edge, seg.y); y <= Math.max(edge, seg.y); y++) ground.add(K(s.col, y));
  }
  for (const w of L.warperLinks || []) for (const [x, y, z] of w.cells) if (z === 0) ground.add(K(x, y)); // 翘曲器带
  for (const pl of L.proLines || []) for (const [x, y, z] of pl.cells) if (z === 0) ground.add(K(x, y)); // 增产剂带（多半在第 1 层，落地的几节算占用）
  for (const st of L.stations || []) for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) ground.add(K(st.x + dx, st.y + dy));
  // 就地烧副产物的火力发电厂（plan/burn.js）：每台按碰撞体的估计（gamedata.js 的 THERMAL_BANK.box）占格子，和它们中间的分拣器
  for (const b of L.burners || []) {
    const { dx, dy, w, h } = THERMAL_BANK.box;
    for (const [x, y] of b.plants) {
      for (let gx = Math.round(x + dx - w / 2 + 0.5); gx <= Math.round(x + dx + w / 2 - 0.5); gx++) for (let gy = Math.round(y + dy - h / 2 + 0.5); gy <= Math.round(y + dy + h / 2 - 0.5); gy++) ground.add(K(gx, gy));
      factoryCells += w * h;
    }
  }
  // 卫星配电站连外面那一圈（5×5 去四角）都算占用：那一圈里放不了别的
  if (L.power) for (const n of L.power.nodes) for (const [x, y] of powerCells(L.power.itemId, n.x, n.y)) ground.add(K(x, y));
  const area = L.width * L.height;
  return { space: ground.size / area, factory: factoryCells / area, rows: L.fill, usedCells: ground.size, factoryCells, area };
}

/** 出出来的蓝图的宽和长：竖排的布局（layout.rotated）出蓝图时整张转了 90°，宽长对调 */
export const blueprintSize = (L) => (L.rotated ? { width: L.height, height: L.width } : { width: L.width, height: L.height });

/** 蓝图的标题和描述：游戏里蓝图列表能看到标题，点开能看到描述 */
export function blueprintText(L, name) {
  const s = L.space ?? spaceStats(L);
  const pct = (v) => `${Math.round(v * 100)}%`;
  const power = L.power ? `；${L.power.name} ${L.power.nodes.length} 座` : '';
  // 化工厂按赤道压缩的间距排的写一句：只在赤道附近放得下，贴之前看得出来
  const tight = [...L.pos.values()].find((p) => p.g.latitude === 'equator');
  const lat = tight ? `；${tight.g.factory}赤道压缩间距，只在赤道附近能放` : '';
  return {
    title: `${name} 利用率${pct(s.space)}`,
    desc: `${blueprintSize(L).width}×${blueprintSize(L).height}=${L.area} 格${L.rotated ? '（竖排）' : ''}；${spaceLine(L)}；传送带 ${L.belts}，分拣器 ${L.sorters}，工厂 ${L.factories}${power}${lat}。dsp-handcraft 生成`,
  };
}

/** 一行文字，写进蓝图描述和摘要 */
export function spaceLine(L) {
  const s = L.space ?? spaceStats(L);
  const pct = (v) => `${Math.round(v * 100)}%`;
  return `空间利用率 ${pct(s.space)}（工厂占地 ${pct(s.factory)}，行利用率 ${pct(s.rows)}）`;
}
