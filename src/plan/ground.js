// 高架只保留在需要跨越的地方。沿既有走线降低高度，不新增绕路来抬高占用率。
import { chainTiles } from '../emit/blueprint.js';
import { sprayGuards } from './layout/elevation.js';
import { RAMP_MAX_DZ, OVERPASS_Z, OVERPASS_ZMAX } from '../gamedata.js';
import { DEFAULTS } from './route.js';

const key = (x, y, z = 0) => `${x},${y},${z}`;
/** 半路落地时，每多造 1 节带至少要换来这么多格落到地面 */
export const GROUND_PER_BELT = 4;

/**
 * 变层税（routeOptions.groundTax，默认关，细档开）：落地时一段高架变层越少越好，最好只在两头各变一次，不在层之间来回窜。
 * 没开时照旧（每格越低越便宜、没有变层次数的代价，一段 0→L→0 常被压成 0→2→5→1→0 这样的台阶，或半路落地再升起）。
 * 开了以后每段沿原来的平面路径按下面的代价挑高度剖面（越小越好）：
 *   水平走一格  1 + taxAir·[z > 0] + taxHeight·max(0, z − 这一格最低能走的层)；最低能走的层：桥段在熔炉、制造台头顶是 OVERPASS_Z，别处 1。
 *               线性超高税（routeOptions.heightTax，搜索打分用，layout/score.js）也开着时，空中每格另加
 *               heightTopWeight·max(0, z − heightTopFrom + 1)（和打分里同一个第 5 层起的附加项，免得落地把带子往第 5 层上推）
 *   一次变层    同一格里一整叠单调的升或降（z → z′，中间每层都要空着、只在直行的格子里）：
 *               (1 + taxNode)·|z′ − z| + (两头都在空中 ? taxMid : taxGround)，这段第 k 次变层（k ≥ 3）再加 taxRepeat·(k − 2)。
 *               两头从地面升起、落回地面也算；同一格里不连着变两次（一叠就是一次）
 * 带子数已经在代价里（每格、每节各 1），不再用 GROUND_PER_BELT；按同一套代价，比原来那条路严格便宜才换
 */
export const GROUND_TAX = { taxGround: 2, taxMid: 16, taxNode: 1, taxRepeat: 24, taxAir: 0.3, taxHeight: 0.4 };
/** 一段最多记到第几次变层（再往后不考虑：第 k 次另加 taxRepeat·(k − 2)，十几次早就不划算） */
const TAX_CHANGES = 12;

/**
 * routeOptions（或同样平铺的选项）→ 高架落地的选项：groundTax 没开时 null（照旧落地）。考卷的 ro.taxNode=1 会解析成 true，参数一律按数取。
 * heightTax 也开着时多带 heightTax、heightTopFrom、heightTopWeight（没写的取 route.js 的 DEFAULTS）；没开时没有这几项
 */
export function groundOptions(ro) {
  if (!ro?.groundTax) return null;
  const o = { groundTax: true };
  for (const [k, v] of Object.entries(GROUND_TAX)) o[k] = ro[k] == null ? v : Number(ro[k]);
  if (ro.heightTax) {
    o.heightTax = true;
    for (const k of ['heightTopFrom', 'heightTopWeight']) o[k] = ro[k] == null ? DEFAULTS[k] : Number(ro[k]);
  }
  return o;
}

/** 变层税：水平走进第 z 层的一格（need：这一格最低能走的层）；超高税开着时空中每格再加第 heightTopFrom 层起的附加项 */
export const taxStep = (z, need, tax) => {
  if (!(z > 0)) return 1;
  const c = 1 + tax.taxAir + tax.taxHeight * Math.max(0, z - need);
  return tax.heightTax ? c + tax.heightTopWeight * Math.max(0, z - tax.heightTopFrom + 1) : c;
};
/** 变层税：同一格里从 z 升降到 nz，这是这段第 k 次变层 */
export const taxChange = (z, nz, k, tax) => (1 + tax.taxNode) * Math.abs(nz - z) + (Math.min(z, nz) > 0 ? tax.taxMid : tax.taxGround) + (k >= 3 ? tax.taxRepeat * (k - 2) : 0);

/**
 * 变层税下一段高架的高度剖面：沿 n 格平面路径的动态规划，状态是（第几格、第几层、已经变了几次层）。
 * free(i, z)：第 i 格第 z 层能不能放带子；straight[i]：第 i 格能不能升降（直行）；need[i]：第 i 格最低能走的层（高度税从这里算）；
 * 层取 0..max，从第 0 格第 z0 层出发、到第 n−1 格第 z1 层。
 * 返回 { cost, steps }，steps 是依次经过的 [i, z]（含起点、终点和升降那一叠的每一节）；走不通时 null
 */
export function taxProfile(n, max, z0, z1, free, straight, need, tax) {
  const K = TAX_CHANGES + 1;
  const W = (max + 1) * K;
  const arrive = new Float64Array(n * W).fill(Infinity); // 水平走进第 i 格（还没在这格变层）
  const leave = new Float64Array(n * W).fill(Infinity); // 在第 i 格变完层（或没变），要往下一格走
  const from = new Int16Array(n * W); // leave 状态是从这一格的哪一层变过来的（等于自己就是没变层）
  const ok = new Uint8Array(n * (max + 1)); // free 先问一遍记下来（下面每个变层次数都要问）
  for (let i = 0; i < n; i++) for (let z = 0; z <= max; z++) ok[i * (max + 1) + z] = free(i, z) ? 1 : 0;
  const open = (i, z) => ok[i * (max + 1) + z] === 1;
  arrive[z0 * K] = 0;
  for (let i = 0; i < n; i++) {
    const b = i * W;
    for (let s = b; s < b + W; s++) {
      leave[s] = arrive[s];
      from[s] = Math.floor((s - b) / K);
    }
    // 一叠升降：从 z 一节节走到 nz，中间每层都要空着；没变层的状态优先（严格更便宜才换）
    if (straight[i]) for (let z = 0; z <= max; z++) for (let k = 0; k + 1 < K; k++) {
      const c0 = arrive[b + z * K + k];
      if (c0 === Infinity) continue;
      for (const d of [1, -1]) for (let nz = z + d; nz >= 0 && nz <= max && open(i, nz); nz += d) {
        const c = c0 + taxChange(z, nz, k + 1, tax);
        const s = b + nz * K + k + 1;
        if (c < leave[s]) {
          leave[s] = c;
          from[s] = z;
        }
      }
    }
    if (i + 1 === n) break;
    for (let z = 0; z <= max; z++) {
      if (!open(i + 1, z)) continue;
      const h = taxStep(z, need[i + 1], tax);
      for (let k = 0; k < K; k++) {
        const c = leave[b + z * K + k];
        if (c !== Infinity) arrive[b + W + z * K + k] = c + h;
      }
    }
  }
  const e = (n - 1) * W + z1 * K;
  let cost = Infinity;
  let k = -1;
  for (let j = 0; j < K; j++) if (leave[e + j] < cost) { cost = leave[e + j]; k = j; }
  if (k < 0) return null;
  // 倒着找回来：每格先记变完层的那一层，变过层的再把那一叠一节节记到变层前的那一层
  const steps = [];
  let z = z1;
  for (let i = n - 1; i >= 0; i--) {
    steps.push([i, z]);
    const fz = from[i * W + z * K + k];
    if (fz === z) continue;
    const d = Math.sign(fz - z);
    for (let w = z + d; ; w += d) {
      steps.push([i, w]);
      if (w === fz) break;
    }
    z = fz;
    k--;
  }
  steps.reverse();
  return { cost, steps };
}

/**
 * 一串格子 [x, y, z]（头尾是段尾的 before、段首的 after）按变层税的代价，和 taxProfile 同样的顺序逐项累加
 * （同一条路两边算出来一字不差）。needAt(x, y)：这一格最低能走的层。同一格里一段单调的升或降算一次变层
 */
export function taxCost(cells, needAt, tax) {
  let cost = 0;
  let k = 0;
  let run = 0; // 正在叠的升降：1 升、−1 降、0 没有
  let base = 0; // 这一叠从哪一层起
  for (let j = 1; j < cells.length; j++) {
    const a = cells[j - 1];
    const b = cells[j];
    if (a[0] === b[0] && a[1] === b[1]) {
      const d = Math.sign(b[2] - a[2]);
      if (!d) continue;
      if (run && d !== run) {
        cost += taxChange(base, a[2], ++k, tax);
        run = 0;
      }
      if (!run) {
        run = d;
        base = a[2];
      }
      continue;
    }
    if (run) {
      cost += taxChange(base, a[2], ++k, tax);
      run = 0;
    }
    if (a[2] !== b[2]) cost += taxChange(a[2], b[2], ++k, tax); // 斜坡（现在不生成）：按一次变层算
    cost += taxStep(b[2], needAt(b[0], b[1]), tax);
  }
  if (run) cost += taxChange(base, cells[cells.length - 1][2], ++k, tax);
  return cost;
}

/**
 * opts：groundOptions 的结果，或同样平铺的 routeOptions（{ groundTax, taxGround, … }）；不传或 groundTax 没开时照旧落地。
 * 只读写布局本身，外面拿一份布局 structuredClone 直接调也行
 */
export function groundRoutes(L, opts = null) {
  const tax = groundOptions(opts);
  const occupied = new Set();
  const solid = new Set();
  for (const p of L.pos.values()) {
    const hw = (p.g.bodyWidth - 1) / 2;
    for (const cx of p.centers) for (let x = cx - hw; x <= cx + hw; x++) for (let y = L.rowCy[p.row] - p.g.bodyBelow; y <= L.rowCy[p.row] + p.g.bodyAbove; y++) solid.add(key(x, y));
  }
  for (const st of L.stations || []) for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) solid.add(key(st.x + dx, st.y + dy));
  // 桥（routeOptions.bridges）：熔炉、制造台的块（整段 x0..x1，含制造台之间的窄缝，和 layout/positions.js 选列时一样）本体那几行的格子。
  // 桥段（leg.bridge）从这里过的格子只能留在原来那一层（第 4 层以上），窄缝里也不落地（放不下带子）；别处照常落地，
  // 半路落地的，到工厂头顶前要再升回原来那一层。没有桥段时不建
  let over = null;
  if (L.legs.some((l) => l.bridge)) {
    over = new Set();
    for (const p of L.pos.values()) {
      if (p.g.kind !== 'smelter' && p.g.kind !== 'assembler') continue;
      const cy = L.rowCy[p.row];
      for (let x = p.x0; x <= p.x1; x++) for (let y = cy - p.g.bodyBelow; y <= cy + p.g.bodyAbove; y++) over.add(key(x, y));
    }
  }
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
    const bridgeZ = over && l.bridge ? l.level : 0; // 桥段从工厂头顶过的那几格只能在这一层（变层税开着时放宽成第 OVERPASS_Z~OVERPASS_ZMAX 层）
    const free = (i, z) => {
      const [x, y] = path[i];
      if ((i === 0 && z === before[2]) || (i === path.length - 1 && z === after[2])) return true;
      if (bridgeZ > 0 && over.has(key(x, y))) return (tax ? z >= OVERPASS_Z && z <= OVERPASS_ZMAX : z === bridgeZ) && !occupied.has(key(x, y, z));
      return !occupied.has(key(x, y, z)) && !solid.has(key(x, y));
    };
    if (tax) {
      // 变层税：按同一套代价算原来那条路（0→L→0），动态规划的结果严格更便宜才换
      const needAt = (x, y) => (bridgeZ > 0 && over.has(key(x, y)) ? OVERPASS_Z : 1);
      const r = taxProfile(path.length, max, before[2], after[2], free, straight, path.map((p) => needAt(p[0], p[1])), tax);
      if (r && r.cost < taxCost([before, ...l.cells, after], needAt, tax)) {
        const cells = r.steps.slice(1, -1).map(([i, z]) => [path[i][0], path[i][1], z]);
        saved += l.cells.filter((p) => p[2]).length - cells.filter((p) => p[2]).length;
        l.cells = cells;
        l.level = Math.max(0, ...cells.map((p) => p[2]));
      }
      for (const p of l.cells) occupied.add(key(...p));
      continue;
    }
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
