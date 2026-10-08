// 高架只保留在需要跨越的地方。沿既有走线降低高度，不新增绕路来抬高占用率。
import { chainTiles } from '../emit/blueprint.js';
import { sprayGuards } from './layout/elevation.js';
import { RAMP_MAX_DZ } from '../gamedata.js';

const key = (x, y, z = 0) => `${x},${y},${z}`;
/** 半路落地时，每多造 1 节带至少要换来这么多格落到地面 */
export const GROUND_PER_BELT = 4;

export function groundRoutes(L) {
  const occupied = new Set();
  const solid = new Set();
  for (const p of L.pos.values()) {
    const hw = (p.g.bodyWidth - 1) / 2;
    for (const cx of p.centers) for (let x = cx - hw; x <= cx + hw; x++) for (let y = L.rowCy[p.row] - p.g.bodyBelow; y <= L.rowCy[p.row] + p.g.bodyAbove; y++) solid.add(key(x, y));
  }
  for (const st of L.stations || []) for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) solid.add(key(st.x + dx, st.y + dy));
  for (const s of L.sorterList) {
    const p = L.pos.get(s.bid);
    const edge = L.rowCy[p.row] + (s.side === 'top' ? p.g.edgeAbove : -p.g.edgeBelow);
    const belt = L.segments[s.segId].y;
    for (let y = Math.min(edge, belt) + 1; y < Math.max(edge, belt); y++) occupied.add(key(s.col, y));
  }
  for (const ch of L.chains) {
    const t = chainTiles(L, ch);
    for (const p of [...t.main, ...t.extra.flat()]) occupied.add(key(...p));
  }
  // 喷涂机空当的保护区（喷增产剂时才有）：落地的带子也不许压到候选格头顶两层、取料格邻格第 1 层
  const g = sprayGuards(L.segments, L.legs);
  for (const [x, y] of g.guard2) for (const z of [1, 2]) occupied.add(key(x, y, z));
  for (const [x, y] of g.guard1) occupied.add(key(x, y, 1));
  for (const [x, y, z] of g.guardZ) occupied.add(key(x, y, z));
  let saved = 0;
  for (const l of L.legs) {
    if (!l.cells.length) continue;
    if (l.spray) continue; // 喷涂机骑在这截高架上（layout/belts.js 的 legOut）：窗口那几格要在同一层直走，这段不落地
    const ch = L.chains.find((c) => c.parts.some((p) => p.leg === l.id));
    if (!ch) continue;
    const main = chainTiles(L, ch).main;
    const first = main.findIndex((p) => p.every((v, i) => v === l.cells[0][i]));
    const before = main[first - 1], after = main[first + l.cells.length];
    if (!before || !after) continue;
    const path = [before, ...l.cells, after].filter((p, i, a) => !i || p[0] !== a[i - 1][0] || p[1] !== a[i - 1][1]);
    // 端点为相同平面格的情况保留原接线。
    if (path.length < 2 || path.at(-1)[0] !== after[0] || path.at(-1)[1] !== after[1]) continue;
    // 只在直行的格子里升降（进来和出去的水平方向相同），不一边转弯一边升降：
    // 官方垂直传送带是直上直下的，转弯处升降在游戏里会拧成麻花。两端的进出方向看链上再往外一格。
    const dirOf = (a, b) => (a && b ? `${Math.sign(b[0] - a[0])},${Math.sign(b[1] - a[1])}` : null);
    const outside = (from, step) => {
      for (let j = from; j >= 0 && j < main.length; j += step) {
        const q = main[j];
        const ref = step < 0 ? before : after;
        if (q[0] !== ref[0] || q[1] !== ref[1]) return q;
      }
      return null;
    };
    const pre = outside(first - 2, -1);
    const post = outside(first + l.cells.length + 1, 1);
    const straight = path.map((p, i) => {
      const a = dirOf(i ? path[i - 1] : pre, p);
      const b = dirOf(p, i + 1 < path.length ? path[i + 1] : post);
      return !a || !b || a === b;
    });
    for (const p of l.cells) occupied.delete(key(...p));
    const max = Math.max(...l.cells.map((p) => p[2]), before[2], after[2]);
    const levels = max + 1;
    const n = path.length * levels;
    const dist = new Float64Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    const free = (i, z) => {
      const [x, y] = path[i];
      if ((i === 0 && z === before[2]) || (i === path.length - 1 && z === after[2])) return true;
      return !occupied.has(key(x, y, z)) && !solid.has(key(x, y));
    };
    const start = before[2], end = (path.length - 1) * levels + after[2];
    dist[start] = 0;
    // 所有水平移动向前，每一列只需上下各一次松弛。
    for (let i = 0; i < path.length; i++) {
      const relax = (a, b, cost) => { if (dist[a] + cost < dist[b]) { dist[b] = dist[a] + cost; prev[b] = a; } };
      if (straight[i]) for (const direction of [1, -1]) for (let k = 0; k < max; k++) {
        const z = direction > 0 ? k : max - k;
        const nz = z + direction;
        if (free(i, nz)) relax(i * levels + z, i * levels + nz, 1.1 + nz * 0.3);
      }
      if (i + 1 === path.length) continue;
      // 水平走一格时高度最多变 RAMP_MAX_DZ 层（现在是 0：不走斜坡，升降都在同一格里竖直叠放）
      for (let z = 0; z <= max; z++) for (let nz = Math.max(0, z - RAMP_MAX_DZ); nz <= Math.min(max, z + RAMP_MAX_DZ); nz++) {
        if (free(i + 1, nz)) relax(i * levels + z, (i + 1) * levels + nz, 1 + nz * 0.3);
      }
    }
    if (Number.isFinite(dist[end])) {
      const out = [];
      for (let j = end; j >= 0; j = prev[j]) {
        const i = Math.floor(j / levels), z = j % levels;
        out.push([path[i][0], path[i][1], z]);
      }
      out.reverse();
      // 同样长度优先减少高架。升降都在同一格里竖直叠放，半路落地再升起要多 2 节竖直带：
      // 只在每多 1 节带能换来至少 GROUND_PER_BELT 格落地时才这样做（上面的松弛代价已经让很短的落地不划算）。
      const cells = out.slice(1, -1);
      const extra = cells.length - l.cells.length;
      const gain = cells.filter((p) => !p[2]).length - l.cells.filter((p) => !p[2]).length;
      if (extra <= 0 || gain >= GROUND_PER_BELT * extra) {
        saved += l.cells.filter((p) => p[2]).length - cells.filter((p) => p[2]).length;
        l.cells = cells;
        l.level = Math.max(0, ...cells.map((p) => p[2]));
      }
    }
    for (const p of l.cells) occupied.add(key(...p));
  }
  L.groundedBelts = saved;
  L.belts = 0;
  L.airBelts = 0;
  for (const ch of L.chains) {
    const t = chainTiles(L, ch);
    for (const p of [t.main, ...t.extra]) { L.belts += p.length; L.airBelts += p.filter((q) => q[2]).length; }
  }
  return L;
}
