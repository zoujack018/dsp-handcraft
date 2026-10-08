// 物流站接入层：在生产区边缘的空位放站，不为所有生产行预留一整条站列。
// 四面各三个口；接线只使用地面、水平高架和逐层原地升降。
import { chainTiles } from '../emit/blueprint.js';
import { translateLayout } from './coordinates.js';
import { sprayGuards } from './layout/elevation.js';
import { STATION_CLEAR, STATION_GAP, STATION_HALF, realItem } from '../gamedata.js';
import { WARPER, STATION_SLOTS, keepFreeSlot, stationItemCap } from './layout/shared.js';

export const STATION_PORTS = [
  { slot: 0, dx: 1, dy: 2, nx: 0, ny: 1 },
  { slot: 1, dx: 0, dy: 2, nx: 0, ny: 1 },
  { slot: 2, dx: -1, dy: 2, nx: 0, ny: 1 },
  { slot: 3, dx: -2, dy: 1, nx: -1, ny: 0 },
  { slot: 4, dx: -2, dy: 0, nx: -1, ny: 0 },
  { slot: 5, dx: -2, dy: -1, nx: -1, ny: 0 },
  { slot: 6, dx: -1, dy: -2, nx: 0, ny: -1 },
  { slot: 7, dx: 0, dy: -2, nx: 0, ny: -1 },
  { slot: 8, dx: 1, dy: -2, nx: 0, ny: -1 },
  { slot: 9, dx: 2, dy: -1, nx: 1, ny: 0 },
  { slot: 10, dx: 2, dy: 0, nx: 1, ny: 0 },
  { slot: 11, dx: 2, dy: 1, nx: 1, ny: 0 },
];

const key = (x, y) => `${x},${y}`;
const cell = (x, y, z) => `${x},${y},${z}`;

export function obstacles(L) {
  const solid = new Set(); // 工厂/物流站，所有高度都禁止穿越
  const ground = new Set(); // 分拣器只挡地面
  const belts = new Set();
  const projection = new Set();
  for (const p of L.pos.values()) {
    const hw = (p.g.bodyWidth - 1) / 2;
    const cy = L.rowCy[p.row];
    for (const cx of p.centers) for (let x = cx - hw; x <= cx + hw; x++) for (let y = cy - p.g.bodyBelow; y <= cy + p.g.bodyAbove; y++) solid.add(key(x, y));
  }
  for (const ch of L.chains) {
    const t = chainTiles(L, ch);
    for (const [x, y, z] of [...t.main, ...t.extra.flat()]) {
      belts.add(cell(x, y, z));
      projection.add(key(x, y));
    }
  }
  // 翘曲器带（linkWarpers）：站与站之间的带子
  for (const w of L.warperLinks || []) for (const [x, y, z] of w.cells) {
    belts.add(cell(x, y, z));
    projection.add(key(x, y));
  }
  // 就地烧副产物的火力发电厂（plan/burn.js）：整块地都不让别的东西进
  for (const b of L.burners || []) for (let x = b.rect[0]; x <= b.rect[2]; x++) for (let y = b.rect[1]; y <= b.rect[3]; y++) solid.add(key(x, y));
  for (const s of L.sorterList) {
    const p = L.pos.get(s.bid);
    const y0 = L.rowCy[p.row] + (s.side === 'top' ? p.g.edgeAbove : -p.g.edgeBelow);
    const y1 = L.segments[s.segId].y;
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) ground.add(key(s.col, y));
  }
  // 喷涂机空当的保护区（喷增产剂时才有）：候选格头顶两层、取料格邻格第 1 层不许别的带子经过，
  // 接站的线、翘曲器带都绕开（addAddons 自己会把这些格再放开，增产剂带就是要横穿这里；real 是放开前真有带子的格）
  const real = new Set(belts);
  const g = sprayGuards(L.segments, L.legs);
  for (const [x, y] of g.guard2) for (const z of [1, 2]) belts.add(cell(x, y, z));
  for (const [x, y] of g.guard1) belts.add(cell(x, y, 1));
  for (const [x, y, z] of g.guardZ) belts.add(cell(x, y, z)); // 高架上的喷涂窗口：头顶两层、取料格两侧一层
  // 物流站也别贴着喷涂机的空当（站身 ±3 格内不放喷涂机、增产剂带也进不去）
  const gapNear = new Set([...g.guard2, ...g.guard1, ...g.guardZ].map(([x, y]) => key(x, y)));
  return { solid, ground, belts, real, projection, sprayGuard: g, gapNear };
}

// 在有界网格上找一条接线。地面优先，升降昂贵，每拐一次弯多付 TURN 格的代价（走线成直路，不在空地里蛇行）；
// 保证每一步几何合法：水平走一步高度不变，升降都是原地竖直的一节。
// 升降只在直行的格子里做：竖直走过之后，下一步水平方向必须和进这一格时相同（endDir 是终点之后链继续走的方向），
// 不一边转弯一边升降，也不在升降的那一格掉头（游戏里会拧成莫比乌斯环那样）。
const TURN = 2;
export const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
export const dirIndex = (dx, dy) => DIRS.findIndex(([a, b]) => a === dx && b === dy);

// 寻路的工作区：到各状态的代价和前驱按状态编号挨着存在一个定长数组里（DP[2i]、DP[2i + 1]），没到过的代价是 +∞；
// 每次寻路把到过的状态记下来（touch），下次寻路前只把这些放回 +∞，不用整块清空。
// 堆是三列并行数组，比较规则和以前的对象堆一模一样（f 相等时的先后也一样），所以找出来的路一格不差。
let cap = 0;
let dpA = new Float64Array(0);
let touchA = new Int32Array(1024);
let nTouch = 0;
let hi = new Int32Array(1024);
let hfg = new Float64Array(2 * 1024); // 第 k 项的 f、g 挨着放：hfg[2k] = f，hfg[2k + 1] = g
function ensure(n) {
  if (n <= cap) return;
  cap = Math.max(n, cap * 2);
  dpA = new Float64Array(2 * cap).fill(Infinity);
  nTouch = 0;
}

/**
 * 预判（不出路）：A* 会不会把步数预算耗完、或者找到的路代价不小于 cut。
 * 代价按 1/25 格计全是整数：水平一步 25 + 3z（拐弯再 + 50），竖直一步 100；启发值 25 × 水平曼哈顿距离 + 100z。
 * 启发值是一致的，按 f 从小到大一层层出（桶队列，不用堆），每个状态第一次出来时代价就是最短的。
 *   - 出到第 F 层时，F 以下各层已经出过的（不算终点那一格的）状态有 B 个以上：终点的最短 f 不小于 F，A* 出终点之前
 *     要把 f 比它小的状态全出一遍（一致的启发值，每个这样的状态都至少出一次堆），预算 B 步不够，A* 一定返回 null。
 *     浮点误差远小于 1/25 格，不影响这个判断。
 *   - 出到第 F 层时，F 对应的代价（减去终点高度 × 4）已经不小于 cut + 1e-6：找到的路代价都不小于 cut，返回 CUT（见 CUT）。
 *   - 队列空了：走不到，A* 也一定返回 null。
 *   - 先出到合法的终点：说不准，返回 0，照常跑 A*。
 * 走法、挡不挡路、终点那一格不往外走、竖直落进终点要和 endDir 同向，都和 A* 一模一样。
 */
const RING = 512; // 一步 f 最多涨 200（往上一层），环形桶数要比它大
let pD = new Int32Array(0);
let pT = new Int32Array(1024);
let qS = new Int32Array(4096);
let qG = new Int32Array(4096);
let qN = new Int32Array(4096);
const qHead = new Int32Array(RING);
const PINF = 0x7fffffff;
function probe(start, startDir, ec, ex, ey, ez, lastDir, W, H, maxLevel, G, ig, av, blockedAt, cut, B) {
  if (pD.length < cap) pD = new Int32Array(cap).fill(PINF);
  const D = pD;
  const plane = W * H;
  const solid = G ? G.solid : null;
  const ground = G ? G.ground : null;
  const belts = G ? G.belts : null;
  let T = pT;
  let nt = 0;
  let S = qS;
  let QG = qG;
  let QN = qN;
  qHead.fill(-1);
  const from = ((start[2] * plane + start[1] * W + start[0]) * 5 + startDir) * 2;
  let F = 25 * (Math.abs(start[0] - ex) + Math.abs(start[1] - ey)) + 100 * start[2];
  D[from] = 0;
  T[nt++] = from;
  S[0] = from;
  QG[0] = 0;
  QN[0] = -1;
  qHead[F % RING] = 0;
  let ne = 1;
  let live = 1;
  let below = 0; // f 比当前层小的、出过的状态
  let at = 0; // 当前层出过的状态
  let verdict = 1; // 队列空了：走不到
  const cutF = cut === Infinity ? Infinity : 25 * (cut + 1e-6) + 100 * ez; // f 到这层，代价就不小于 cut + 1e-6
  if (F >= cutF) verdict = 2;
  else
    while (live) {
      const e = qHead[F % RING];
      if (e < 0) {
        F++;
        below += at;
        at = 0;
        if (below >= B) {
          verdict = 1;
          break;
        }
        if (F >= cutF) {
          verdict = 2;
          break;
        }
        continue;
      }
      qHead[F % RING] = QN[e];
      live--;
      const qi = S[e];
      const g = QG[e];
      if (g !== D[qi]) continue;
      const lifted = qi & 1;
      const jj = qi >> 1;
      const d = jj % 5;
      const c = (jj - d) / 5;
      if (c === ec) {
        if (lifted && d < 4 && lastDir >= 0 && d !== lastDir) continue;
        verdict = 0;
        break;
      }
      at++;
      const z = Math.floor(c / plane);
      const c2 = c - z * plane;
      const y = Math.floor(c2 / W);
      const x = c2 - y * W;
      const step = 25 + 3 * z;
      for (let m = 0; m < 6; m++) {
        let nx = x;
        let ny = y;
        let nz = z;
        let nd = d;
        let nl = 0;
        let nc2 = c2;
        let cost;
        if (m < 4) {
          if (d < 4 && (m ^ 1) === d) continue;
          if (lifted && d < 4 && m !== d) continue;
          if (m === 0) {
            if (++nx >= W) continue;
            nc2++;
          } else if (m === 1) {
            if (--nx < 0) continue;
            nc2--;
          } else if (m === 2) {
            if (++ny >= H) continue;
            nc2 += W;
          } else {
            if (--ny < 0) continue;
            nc2 -= W;
          }
          nd = m;
          cost = d < 4 && d !== m ? step + 50 : step;
        } else {
          if (m === 4) {
            if (++nz > maxLevel) continue;
          } else if (--nz < 0) continue;
          nl = 1;
          cost = 100;
        }
        const nc = nz * plane + nc2;
        if (nc !== ec) {
          if (G !== null) {
            if (solid[nc2] || (belts[nc] && !(ig !== null && ig.has(nc))) || (!nz && ground[nc2]) || (av !== null && av.has(nc))) continue;
          } else if (blockedAt(nx, ny, nz)) continue;
        }
        const i = (nc * 5 + nd) * 2 + nl;
        const ng = g + cost;
        const old = D[i];
        if (ng >= old) continue;
        if (old === PINF) {
          if (nt === T.length) {
            const b2 = new Int32Array(T.length * 2);
            b2.set(T);
            pT = T = b2;
          }
          T[nt++] = i;
        }
        D[i] = ng;
        if (ne === S.length) {
          const grow = (a) => {
            const b2 = new Int32Array(a.length * 2);
            b2.set(a);
            return b2;
          };
          qS = S = grow(S);
          qG = QG = grow(QG);
          qN = QN = grow(QN);
        }
        const b = (ng + 25 * (Math.abs(nx - ex) + Math.abs(ny - ey)) + 100 * nz) % RING;
        S[ne] = i;
        QG[ne] = ng;
        QN[ne] = qHead[b];
        qHead[b] = ne;
        ne++;
        live++;
      }
    }
  for (let k = 0; k < nt; k++) D[T[k]] = PINF;
  return verdict;
}
/** 哪些终点（连同走进去的方向、网格大小）A* 已经耗完过预算：再找它们时先预判（只影响快慢，不影响结果） */
const spent = new Set();
const spentKey = (end, endDir, W, H, maxLevel) => `${end[0]},${end[1]},${end[2]},${endDir},${W},${H},${maxLevel}`;

const POCKET = 64;

/**
 * 障碍集合的格子版：attachStations 每个候选站位一份，和 trial 的 solid / belts 集合同步增删。
 * 寻路判格子时直接查数组，不再每格拼字符串查集合。集合里不在网格内或不是整数的坐标寻路本来就问不到，不进数组。
 */
export function obstacleGrid(O, W, H, maxLevel) {
  const plane = W * H;
  const G = { W, H, maxLevel, solid: new Uint8Array(plane), ground: new Uint8Array(plane), belts: new Uint8Array(plane * (maxLevel + 1)) };
  for (const k of O.solid) gridSet(G, G.solid, k, 1);
  for (const k of O.ground) gridSet(G, G.ground, k, 1);
  for (const k of O.belts) gridSet(G, G.belts, k, 1);
  return G;
}
/** 坐标字符串（"x,y" 或 "x,y,z"）在网格里的下标，不在网格内返回 −1 */
function gridIndex(G, k) {
  // 常见的 "x,y" / "x,y,z"：按逗号切开直接转数（和下面的通用写法结果一样）
  const a = k.indexOf(',');
  const b = a < 0 ? -1 : k.indexOf(',', a + 1);
  if (a >= 0 && (b < 0 || k.indexOf(',', b + 1) < 0)) {
    const x = Number(k.slice(0, a));
    const y = Number(b < 0 ? k.slice(a + 1) : k.slice(a + 1, b));
    const z = b < 0 ? 0 : Number(k.slice(b + 1));
    if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z) || x < 0 || y < 0 || z < 0 || x >= G.W || y >= G.H || z > G.maxLevel) return -1;
    return (z * G.H + y) * G.W + x;
  }
  const v = k.split(',').map(Number);
  const [x, y, z = 0] = v;
  if (!v.every(Number.isInteger) || x < 0 || y < 0 || z < 0 || x >= G.W || y >= G.H || z > G.maxLevel) return -1;
  return (z * G.H + y) * G.W + x;
}
function gridSet(G, A, k, b) {
  const i = gridIndex(G, k);
  if (i >= 0) A[i] = b;
}
/** 坐标字符串集合 → 网格下标集合（空的返回 null） */
function gridIndices(G, set) {
  if (!set?.size) return null;
  const out = new Set();
  for (const k of set) {
    const i = gridIndex(G, k);
    if (i >= 0) out.add(i);
  }
  return out;
}

/**
 * 找路到「代价够低才有用」的地方就停：调用方给出 cut（只有代价 < cut 的路才有用）时，堆顶的 f 一到 cut 以上就返回 CUT，不再往下找。
 * 启发值（水平曼哈顿距离 + 高度 × 4）是一致的：每走一步 f 不减，所以出堆的 f 不减；终点出堆时 f = 代价 + 终点高度 × 4。
 * 堆顶的 f 到了 cut + 终点高度 × 4 + 1e-6，以后再找到的路代价都不小于 cut（浮点舍入远小于 1e-6）。
 * 所以返回 CUT 时，不设 cut 照原样找下去的结果只有两种：找不到（null），或者找到一条代价不小于 cut 的路。
 * 没有返回 CUT 时，结果和不设 cut 逐字一样（出堆次序、步数预算都一样，只是多判断了一次堆顶）。
 */
export const CUT = Object.freeze({ cut: true });

/**
 * 从某格朝 d 走（4：还没走过）到相对位置 (dx, dy) 至少要拐几次弯：正前方 0 次，前方或两侧 1 次，身后 2 次，正后方 3 次
 * （不许原地掉头，竖直升降不改朝向）。每拐一次多付 TURN，所以路的代价不比「曼哈顿距离 + 拐弯次数 × TURN」少
 */
function minTurns(d, dx, dy) {
  if (!dx && !dy) return 0;
  if (d === 4) return dx && dy ? 1 : 0;
  if (!(d >= 0 && d < 4)) return 0;
  const hx = DIRS[d][0];
  const hy = DIRS[d][1];
  const along = dx * hx + dy * hy;
  const side = hx ? dy : dx;
  if (along > 0) return side ? 1 : 0;
  if (along === 0) return 1;
  return side ? 2 : 3;
}

/**
 * A* 每次最多出堆多少次（还受格数 × 层数 × 5 封顶）：接物流站时 24 万，别的（增产剂带、烧副产物的接线）照旧 6 万。
 * 云上 2026/10/08（智川云，E3，238 份引力矩阵 / 小产线的站格）：6 万 → 24 万，挑出来可行的从 76% 到 85%，同一批候选配对 21 份只有新的接上、0 份反过来，
 * 预算耗尽的次数每份 27 → 2；再加到 100 万只多 2 个百分点。attachStations 进出时切换（同步执行，不会串到别的活）
 */
const PATH_BUDGET = 60000;
const ATTACH_BUDGET = 240000;
let budgetCap = PATH_BUDGET;

function pathfind0(start, end, O, W, H, maxLevel, startDir = 4, ignore = null, endDir = 4, avoid = null, cut = Infinity, pre = false) {
  // 代价的下限（水平曼哈顿距离 + 至少要拐的弯 × TURN + 高度差 × 4）已经不小于 cut：找到的路也用不上，直接返回 CUT（见上）
  if (cut !== Infinity) {
    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    if (Math.abs(dx) + Math.abs(dy) + TURN * minTurns(startDir, dx, dy) + 4 * Math.abs(end[2] - start[2]) >= cut + 1e-6) return CUT;
  }
  const plane = W * H;
  // 状态：格子 × 上一步水平方向（4 = 还没走过）× 刚竖直走过没有，编号 ((格子 × 5) + 方向) × 2 + 刚升降过
  const encode = (x, y, z, d, lifted = 0) => ((z * plane + y * W + x) * 5 + d) * 2 + lifted;
  ensure(plane * (maxLevel + 1) * 10);
  // 上一次寻路到过的状态，代价放回 +∞
  const DP = dpA;
  {
    const T = touchA;
    for (let k = 0; k < nTouch; k++) DP[2 * T[k]] = Infinity;
    nTouch = 0;
  }
  const G = O.grid && O.grid.W === W && O.grid.H === H && O.grid.maxLevel === maxLevel ? O.grid : null;
  const ig = G ? gridIndices(G, ignore) : null;
  const av = G ? gridIndices(G, avoid) : null;
  let blockedAt;
  if (G) {
    const { solid, ground, belts } = G;
    blockedAt = (x, y, z) => {
      const c2 = y * W + x;
      if (solid[c2]) return true;
      const c = z * plane + c2;
      if (belts[c] && !(ig !== null && ig.has(c))) return true;
      if (!z && ground[c2]) return true;
      return av !== null && av.has(c);
    };
  } else {
    // 格子挡不挡路：第一次问到时才查障碍集合，记下来（0 没查过、1 能走、2 挡住）
    const block = new Uint8Array(plane * (maxLevel + 1));
    blockedAt = (x, y, z) => {
      const c = z * plane + y * W + x;
      let b = block[c];
      if (!b) {
        const k2 = key(x, y);
        const k3 = cell(x, y, z);
        b = O.solid.has(k2) || (O.belts.has(k3) && !ignore?.has(k3)) || (!z && O.ground.has(k2)) || avoid?.has(k3) ? 2 : 1;
        block[c] = b;
      }
      return b === 2;
    };
  }
  const [ex, ey, ez] = end;
  // 起点或终点被围在一小块里（实测走不到的都是 1~2 格的小块）：先各做一次最多 POCKET 格的广度搜索，
  // 那一小块走完了还没碰到另一头，就一定走不到，直接返回（A* 的走法只比它更受限，结果一样，只是不再白耗 6 万步）
  const enclosed = (sx, sy, sz, tx, ty, tz) => {
    const seen = new Set([sz * plane + sy * W + sx]);
    const st = [sx, sy, sz];
    while (st.length) {
      const cz = st.pop();
      const cy = st.pop();
      const cx = st.pop();
      for (let k = 0; k < 6; k++) {
        const nx = cx + (k === 0 ? 1 : k === 1 ? -1 : 0);
        const ny = cy + (k === 2 ? 1 : k === 3 ? -1 : 0);
        const nz = cz + (k === 4 ? 1 : k === 5 ? -1 : 0);
        if (nx < 0 || ny < 0 || nx >= W || ny >= H || nz < 0 || nz > maxLevel) continue;
        if (nx === tx && ny === ty && nz === tz) return false;
        const c = nz * plane + ny * W + nx;
        if (seen.has(c) || blockedAt(nx, ny, nz)) continue;
        if (seen.size >= POCKET) return false;
        seen.add(c);
        st.push(nx, ny, nz);
      }
    }
    return true;
  };
  if (enclosed(ex, ey, ez, start[0], start[1], start[2]) || enclosed(start[0], start[1], start[2], ex, ey, ez)) return null;
  // 终点的进路：最后一步要么从同一层的相邻格水平走进终点，要么从这一列竖直落进来。竖直落进来时状态里的方向是最后一次水平走的方向，
  // 下面的终点判断要它等于 endDir（0~3 时），也就是先在这一列的某一层 z 从 endDir 反方向的那一格水平走进来，再一路竖直到终点。
  // 这些格子全都走不进去（挡住或出界），终点就一定到不了，A* 只会把 6 万步的预算耗完再返回 null，这里直接返回（结果一样）。
  // 实测接站时走不到的几乎都是这种：终点左右是别的带子、上一层的来路是工厂。起点不查挡不挡，算能走；起点就在这一列上时不判断
  {
    const [sx, sy, sz] = start;
    const open = (x, y, z) => x >= 0 && y >= 0 && x < W && y < H && z >= 0 && z <= maxLevel && ((x === sx && y === sy && z === sz) || !blockedAt(x, y, z));
    let reach = sx === ex && sy === ey;
    for (let m = 0; !reach && m < 4; m++) reach = open(ex - DIRS[m][0], ey - DIRS[m][1], ez);
    const ed = endDir >= 0 && endDir < 4 ? endDir : -1;
    for (const dz of [1, -1]) {
      for (let z = ez + dz; !reach && open(ex, ey, z); z += dz) reach = ed < 0 || open(ex - DIRS[ed][0], ey - DIRS[ed][1], z);
    }
    if (!reach) return null;
  }
  let budget = Math.min(budgetCap, plane * (maxLevel + 1) * 5);
  // 终点的格子编号；终点不在网格里时永远走不到（原来按坐标比，出界的格子不会和网格里的混为一格），记成 −1
  const ec = Number.isInteger(ex) && Number.isInteger(ey) && Number.isInteger(ez) && ex >= 0 && ey >= 0 && ez >= 0 && ex < W && ey < H && ez <= maxLevel ? ez * plane + ey * W + ex : -1;
  const lastDir = endDir >= 0 && endDir < 4 ? endDir : -1; // 竖直落进终点时要求的方向（-1：不要求）
  // 这个终点之前耗完过预算（接站时同一个口换个站口、换个站位再找，多半还是找不到），或者调用方估计多半用不上（pre）：
  // 先用桶队列预判，判得出就不跑 A*（预判只省时间，判不出照常跑，结果一样）。
  // 预判只在起点、终点都是网格里的整数格时做：桶号按坐标算，坐标不是整数时桶号也不是整数，队列会空转不停
  const sk = spentKey(end, endDir, W, H, maxLevel);
  const [sx0, sy0, sz0] = start;
  const startIn = Number.isInteger(sx0) && Number.isInteger(sy0) && Number.isInteger(sz0) && sx0 >= 0 && sy0 >= 0 && sz0 >= 0 && sx0 < W && sy0 < H && sz0 <= maxLevel;
  if (ec >= 0 && startIn && startDir >= 0 && startDir <= 4 && ((pre && cut !== Infinity) || spent.has(sk))) {
    const v = probe(start, startDir, ec, ex, ey, ez, lastDir, W, H, maxLevel, G, ig, av, blockedAt, cut, budget);
    if (v === 1) return null;
    if (v === 2) return CUT;
  }
  // 主循环把堆的进出、走一步都写在一个函数里，工作区数组放进局部变量（不再经过闭包和模块变量），
  // 每一步的判断、代价的浮点运算次序、进堆出堆的比较都和原来逐字一样，所以出堆的次序、找出来的路一格不差。
  // 到某状态的代价和前驱挨着放在 DP 里（DP[2i]、DP[2i + 1]），没到过的代价是 +∞；第一次到时记进 touch，下次寻路前放回 +∞。
  // 有障碍网格时，挡不挡路直接查网格（和 blockedAt 一样的判断），不经过闭包
  let T = touchA;
  let nt = 0;
  let HI = hi;
  let FG = hfg;
  let hcap = HI.length;
  let n = 0; // 堆里有几个
  // 堆里和前驱里存的是按位拼的编号：平面格 c2 << (zb + 4) | z << 4 | 方向 << 1 | 刚升降（出堆时移位就拆开，不用除 5、除 plane）；
  // DP 的下标照旧是 ((格子 × 5) + 方向) × 2 + 刚升降。编号是 32 位整数，平面格数 < 2^24 都放得下（DP 早在这之前就放不下了）
  let zb = 0;
  while (1 << zb <= maxLevel) zb++;
  const zs = zb + 4;
  const zm = (1 << zb) - 1;
  const from = encode(start[0], start[1], start[2], startDir);
  const fromH = (((start[1] * W + start[0]) << zb) | start[2]) << 4 | (startDir << 1);
  DP[2 * from] = 0;
  DP[2 * from + 1] = -1;
  T[nt++] = from;
  HI[0] = fromH;
  FG[0] = Math.abs(start[0] - ex) + Math.abs(start[1] - ey) + start[2] * 4;
  FG[1] = 0;
  n = 1;
  FG[2] = Infinity; // 哨兵：堆尾后面那一格的 f 总是 +∞，下沉时不用再判断右孩子出没出界
  const stop = cut + ez * 4 + 1e-6; // 堆顶的 f 到这里就停（见 CUT）；cut 是 +∞ 时永远不停
  const solid = G ? G.solid : null;
  const ground = G ? G.ground : null;
  const belts = G ? G.belts : null;
  let result = null;
  while (n && budget-- > 0) {
    if (FG[0] >= stop) {
      result = CUT;
      break;
    }
    // 出堆：取堆顶，最后一个往下沉
    const qh = HI[0];
    const qg = FG[1];
    n--;
    if (n) {
      const li = HI[n];
      const lf = FG[2 * n];
      const lg = FG[2 * n + 1];
      FG[2 * n] = Infinity; // 哨兵：堆尾后面那一格的 f 是 +∞
      let k = 0;
      while (k * 2 + 1 < n) {
        let j = k * 2 + 1;
        j += (FG[2 * j + 2] < FG[2 * j]) | 0; // 右孩子严格更小才挑右边（和原来的比较一样）；右孩子出界时那一格是哨兵 +∞，挑不上
        const fj = FG[2 * j];
        if (fj >= lf) break;
        HI[k] = HI[j];
        FG[2 * k] = fj;
        FG[2 * k + 1] = FG[2 * j + 1];
        k = j;
      }
      HI[k] = li;
      FG[2 * k] = lf;
      FG[2 * k + 1] = lg;
    }
    const lifted = qh & 1;
    const d = (qh >> 1) & 7;
    const z = (qh >> 4) & zm;
    const c2 = qh >> zs; // 这一格在平面上的编号
    const c = z * plane + c2;
    const qi = (c * 5 + d) * 2 + lifted;
    if (qg !== DP[2 * qi]) continue; // 过期的（之后又找到了更近的走法）
    const y = Math.floor(c2 / W);
    const x = c2 - y * W;
    if (c === ec) {
      // 竖直落进终点、但落下的方向和链接下去的方向不同（会在终点那一格拧着掉头）：这条路不算，也不从终点再往外走
      if (lifted && d < 4 && lastDir >= 0 && d !== lastDir) continue;
      const path = [];
      for (let h = qh; h !== -1; ) {
        const pz = (h >> 4) & zm;
        const pc2 = h >> zs;
        const py = Math.floor(pc2 / W);
        path.push([pc2 - py * W, py, pz]);
        h = DP[2 * ((((pz * plane + pc2) * 5 + ((h >> 1) & 7)) * 2) + (h & 1)) + 1];
      }
      result = { cells: path.reverse(), cost: qg };
      break;
    }
    // 走一步：先四个水平方向（0~3：+x、−x、+y、−y），再往上、往下（4、5）
    const step = 1 + z * 0.12; // 水平走一步的代价（拐弯再加 TURN），和原来的式子同样先算这一项
    for (let m = 0; m < 6; m++) {
      let nx = x;
      let ny = y;
      let nz = z;
      let nd = d;
      let nl = 0;
      let nc2 = c2;
      let cost;
      if (m < 4) {
        if (d < 4 && (m ^ 1) === d) continue; // 不掉头（DIRS 里 0、1 和 2、3 两两相反）
        if (lifted && d < 4 && m !== d) continue; // 升降的那一格不拐弯
        if (m === 0) {
          if (++nx >= W) continue;
          nc2++;
        } else if (m === 1) {
          if (--nx < 0) continue;
          nc2--;
        } else if (m === 2) {
          if (++ny >= H) continue;
          nc2 += W;
        } else {
          if (--ny < 0) continue;
          nc2 -= W;
        }
        nd = m;
        cost = d < 4 && d !== m ? step + TURN : step + 0;
      } else {
        if (m === 4) {
          if (++nz > maxLevel) continue;
        } else if (--nz < 0) continue;
        nl = 1;
        cost = 4;
      }
      const nc = nz * plane + nc2;
      if (nc !== ec) {
        if (G !== null) {
          if (solid[nc2] || (belts[nc] && !(ig !== null && ig.has(nc))) || (!nz && ground[nc2]) || (av !== null && av.has(nc))) continue;
        } else if (blockedAt(nx, ny, nz)) continue;
      }
      const i = (nc * 5 + nd) * 2 + nl;
      const g = qg + cost;
      const old = DP[2 * i];
      if (g >= old) continue;
      if (old === Infinity) {
        if (nt === T.length) {
          const b2 = new Int32Array(T.length * 2);
          b2.set(T);
          touchA = T = b2;
        }
        T[nt++] = i;
      }
      DP[2 * i] = g;
      DP[2 * i + 1] = qh;
      const f = g + (Math.abs(nx - ex) + Math.abs(ny - ey) + nz * 4);
      // 进堆：放到末尾往上浮
      if (n + 1 === hcap) {
        const grow = (a, A) => {
          const b2 = new A(a.length * 2);
          b2.set(a);
          return b2;
        };
        hi = HI = grow(HI, Int32Array);
        hfg = FG = grow(FG, Float64Array);
        hcap = HI.length;
      }
      let k = n++;
      while (k) {
        const p = (k - 1) >> 1;
        const fp = FG[2 * p];
        if (fp <= f) break;
        HI[k] = HI[p];
        FG[2 * k] = fp;
        FG[2 * k + 1] = FG[2 * p + 1];
        k = p;
      }
      HI[k] = ((nc2 << zb) | nz) << 4 | (nd << 1) | nl;
      FG[2 * k] = f;
      FG[2 * k + 1] = g;
      FG[2 * n] = Infinity; // 哨兵
    }
  }
  nTouch = nt;
  if (result === null && n) {
    // 预算耗完了：记下这个终点
    if (spent.size >= 4096) spent.clear();
    spent.add(sk);
  }
  return result;
}

/** 接到原来的出入口格时，过了这一格链往哪走（按寻路方向）：原料顺着原来那段高架走，成品逆着它走 */
function portDir(p, leg) {
  const cells = p.kind === 'in' ? leg.cells : leg.cells.slice().reverse();
  const next = cells.find(([x, y]) => x !== p.x || y !== p.y);
  return next ? dirIndex(Math.sign(next[0] - p.x), Math.sign(next[1] - p.y)) : 4;
}

/**
 * 状态里带着方向，同一格可能以不同方向走两次（升降后必须直走时，落地的那一格有时会绕一圈再回来）。
 * 路径自己压到自己时，把重复的格子当障碍再找，最多几次。
 * cut：只要代价 < cut 的路（见 CUT）。返回 CUT 时，不设 cut 的结果是 null 或者一条代价不小于 cut 的路：
 * 再找时多了障碍，能走的只少不多，最短路只长不短，所以哪一次返回 CUT 都一样。
 * pre：调用方估计这次多半找不到有用的路（返回 CUT），先用桶队列预判（见 probe），只影响快慢。
 */
export function pathfind(start, end, O, W, H, maxLevel, startDir = 4, ignore = null, endDir = 4, cut = Infinity, pre = false) {
  const avoid = new Set();
  for (let k = 0; k < 4; k++) {
    const r = pathfind0(start, end, O, W, H, maxLevel, startDir, ignore, endDir, avoid, cut, pre);
    if (!r || r === CUT) return r;
    const seen = new Set();
    const dup = r.cells.map((c) => cell(...c)).filter((c) => (seen.has(c) ? true : (seen.add(c), false)));
    if (!dup.length) return r;
    for (const c of dup) avoid.add(c);
  }
  return null;
}

/**
 * 站位 s 上接口 p 的接线得分的下限（不管用哪个站口、找到哪条路）：站口那 2 节 + 从站口外那格到终点的曼哈顿距离
 * + 至少要拐的弯 × TURN（见 minTurns）；退回原来出入口格时再加上让不出来的那段（ownLen）。和下面接线时的得分式子一一对应：
 * 得分 = 路的代价 + 2（+ ownLen），路的代价不比曼哈顿距离 + 拐弯少
 */
function routeFloor(s, target, p, ownLen) {
  let lb = Infinity;
  for (const q of STATION_PORTS) {
    const sx = s.x + q.dx + q.nx * 2;
    const sy = s.y + q.dy + q.ny * 2;
    const dir = dirIndex(q.nx, q.ny);
    const tx = target[0] - sx;
    const ty = target[1] - sy;
    let v = Math.abs(tx) + Math.abs(ty) + TURN * minTurns(dir, tx, ty);
    if (target[0] !== p.x || target[1] !== p.y) {
      const fx = p.x - sx;
      const fy = p.y - sy;
      v = Math.min(v, Math.abs(fx) + Math.abs(fy) + TURN * minTurns(dir, fx, fy) + ownLen);
    }
    lb = Math.min(lb, v + 2);
  }
  return lb;
}

/** 坐标字符串集合里的整数格（"x,y"）追加进坐标表 out = [x0, y0, x1, y1, …]；不是整数的格子按整数格查永远查不到，不进表 */
function intCells(set, out) {
  for (const k of set) {
    const v = k.split(',');
    if (v.length !== 2) continue;
    const x = Number(v[0]);
    const y = Number(v[1]);
    if (Number.isInteger(x) && Number.isInteger(y)) out.push(x, y);
  }
  return out;
}

/**
 * 站位 (x, y) 能不能放站（3 ≤ x ≤ W − 4，3 ≤ y ≤ H − 4）。原来逐个站位查 7×7 格在不在 solid、ground、projection、gapNear 里，
 * 再逐台工厂比碰撞体；这里一次算好整张图：cells 是这几个集合里的整数格坐标表，7×7 窗口里挡住的格数用二维前缀和数；
 * 工厂碰撞体碰得到的站心，在每台工厂附近逐格按原来的式子标出来。结果和逐个查一模一样。
 * 连续碰撞体：整数格空着不意味着站可以紧贴制造台的半格边界。站身按半宽 3.4 算：
 * 制造台本体紧贴站身（中心隔 5）实测能放（体积测试 D6），制造台碰撞体又确实大于 3 格（C3、C4），3.5 + 1.6 > 5 是误报。
 * 站身外那 1 格碰撞圈只挡卫星配电站（D4~D10），工厂本体可以贴着站身。
 * 碰撞体中心有偏移的（化工厂往上 0.5、对撞机往左 0.3）按偏移后的中心算
 */
function stationFits(L, cells, W, H) {
  const W1 = W + 1;
  const mark = new Uint8Array(W * H);
  for (let k = 0; k < cells.length; k += 2) {
    const x = cells[k];
    const y = cells[k + 1];
    if (x >= 0 && y >= 0 && x < W && y < H) mark[y * W + x] = 1;
  }
  const S = new Int32Array(W1 * (H + 1)); // S[(y + 1)(W + 1) + x + 1]：[0, x] × [0, y] 里挡住的格数
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) {
      row += mark[y * W + x];
      S[(y + 1) * W1 + x + 1] = S[y * W1 + x + 1] + row;
    }
  }
  const clash = new Uint8Array(W * H);
  for (const p of L.pos.values()) for (const cx of p.centers) {
    const [sx, sy] = p.g.colliderShift ?? [0, 0];
    const ax = STATION_HALF + p.g.collider[0] / 2;
    const ay = STATION_HALF + p.g.collider[1] / 2;
    const fx = cx + sx;
    const fy = L.rowCy[p.row] + sy;
    for (let x = Math.max(0, Math.floor(fx - ax)); x <= Math.min(W - 1, Math.ceil(fx + ax)); x++) {
      if (!(Math.abs(cx + sx - x) < ax)) continue;
      for (let y = Math.max(0, Math.floor(fy - ay)); y <= Math.min(H - 1, Math.ceil(fy + ay)); y++) if (Math.abs(L.rowCy[p.row] + sy - y) < ay) clash[y * W + x] = 1;
    }
  }
  return (x, y) => {
    const x0 = x - 3;
    const y0 = y - 3;
    const x1 = x + 4;
    const y1 = y + 4;
    return S[y1 * W1 + x1] - S[y0 * W1 + x1] - S[y1 * W1 + x0] + S[y0 * W1 + x0] === 0 && !clash[y * W + x];
  };
}

function stationGroups(L, slots = null) {
  const cap = stationItemCap(slots); // 每座最多 5 种；增产剂、翘曲器的空格整张留够（keepFreeSlot）
  // 按真实物品分：副产物送出去的带和产线自己要用的同种物品共用一个存储格；送出的多就设为供应，否则设为需求
  const byItem = new Map();
  for (const p of L.ports) {
    if (p.burn) continue; // 就地烧掉的副产物不进站（plan/burn.js）
    const k = realItem(p.itemId);
    if (!byItem.has(k)) byItem.set(k, []);
    byItem.get(k).push(p);
  }
  const items = [...byItem.entries()].flatMap(([itemId, ports]) => {
    const net = ports.reduce((a, p) => a + (p.kind === 'out' ? 1 : -1) * (p.rate ?? 0), 0);
    const role = net >= 0 && ports.some((p) => p.kind === 'out') ? 'supply' : 'demand';
    const out = [];
    for (let i = 0; i < ports.length; i += 12) out.push({ itemId, role, ports: ports.slice(i, i + 12) });
    return out;
  }).sort((a, b) => {
    const axis = L.width >= L.height ? 'x' : 'y';
    const mean = (it) => it.ports.reduce((n, p) => n + p[axis], 0) / it.ports.length;
    return mean(a) - mean(b) || b.ports.length - a.ports.length;
  });
  const groups = [];
  for (const it of items) {
    let g = groups.find((g) => g.length < cap && g.reduce((n, q) => n + q.ports.length, 0) + it.ports.length <= 12 && !g.some((q) => q.itemId === it.itemId));
    if (!g) groups.push(g = []);
    g.push(it);
  }
  keepFreeSlot(groups, slots); // 喷增产剂时至少留一个空格给增产剂
  return groups.sort((a, b) => b.reduce((n, q) => n + q.ports.length, 0) - a.reduce((n, q) => n + q.ports.length, 0));
}

/** 返回新布局，接不上时返回 null；绝不把没有接站的入口当成功。接线的 A* 用接站的预算（ATTACH_BUDGET） */
export function attachStations(source, opts = {}) {
  budgetCap = ATTACH_BUDGET;
  try {
    return attachStations0(source, opts);
  } finally {
    budgetCap = PATH_BUDGET;
  }
}
function attachStations0(source, { stack = 1, maxWidth = null, maxHeight = null, maxLevel = 6, siteLimit = 10, diagnostics = null, reserve = [], reserveItem = null, slots = null } = {}) {
  // 要诊断信息时每个站位都接到底（哪个口接不上都记下来）；不要时，注定比已有最好站位贵的站位中途就放弃（见下）
  const prune = !diagnostics;
  const L = structuredClone(source);
  translateLayout(L, 1, 1);
  L.width += 2;
  L.height += 2;
  L.area = L.width * L.height;
  const O = obstacles(L);
  // 预留的格子（比如先按紧凑布局选好的电力塔位置）：站和接线都不占
  for (const [x, y] of reserve) O.solid.add(key(x + 1, y + 1));
  // 挡站身的整数格（solid、ground、projection、gapNear）：之后每放一座站，站身和接线的格子也接着记进来（和那几个集合同步）
  const fitCells = [];
  for (const set of [O.solid, O.ground, O.projection, O.gapNear]) if (set) intCells(set, fitCells);
  L.stations = [];
  const groups = stationGroups(L, slots);
  for (const group of groups) {
    const ports = group.flatMap((it) => it.ports);
    // 搜索范围：布局四周各多 1 格（最后会裁掉没用到的），再往外留几格给站；限宽 / 限长时站本身不许把外框撑过上限
    const W = maxWidth ? Math.max(L.width, Math.min(maxWidth + 2, L.width + 10)) : L.width + 10;
    const H = maxHeight ? Math.max(L.height, Math.min(maxHeight + 2, L.height + 10)) : L.height + 10;
    const fits = stationFits(L, fitCells, W, H);
    const sites = [];
    for (let x = 3; x + 3 < W; x++) for (let y = 3; y + 3 < H; y++) {
      if (maxWidth && Math.max(L.width - 2, x + 3) - Math.min(1, x - 3) + 1 > maxWidth) continue;
      if (maxHeight && Math.max(L.height - 2, y + 3) - Math.min(1, y - 3) + 1 > maxHeight) continue;
      if (!fits(x, y)) continue;
      // 预留的是卫星配电站时，它的格子不进站身外那 1 格碰撞圈（电力感应塔可以贴着站身）
      if (reserveItem === 2212 && reserve.some(([rx, ry]) => Math.abs(rx + 1 - x) <= STATION_CLEAR && Math.abs(ry + 1 - y) <= STATION_CLEAR)) continue;
      if (L.stations.some((st) => Math.hypot(st.x - x, st.y - y) < STATION_GAP)) continue; // 游戏要求两站隔开
      const area = Math.max(L.width, x + 4) * Math.max(L.height, y + 4);
      const distance = ports.reduce((n, p) => n + Math.abs(p.x - x) + Math.abs(p.y - y), 0);
      sites.push({ x, y, score: (area - L.area) * 2 + distance });
    }
    sites.sort((a, b) => a.score - b.score);
    // 邻近坐标的失败通常同源；保留分散的候选站位。
    const candidates = [];
    for (const s of sites) {
      if (candidates.every((p) => Math.abs(p.x - s.x) + Math.abs(p.y - s.y) >= 3)) candidates.push(s);
      if (candidates.length >= siteLimit) break;
    }
    let best = null;
    const base = candidates.length ? obstacleGrid(O, W, H, maxLevel) : null;
    // 每个站位直接在 base 上加站身、加接线（寻路只看 trial.grid），接完这个站位再原样改回去（undo 记着改前的值），
    // 不再每个站位复制一份网格和障碍集合。选上的站位对带子集合的增删记在 ops 里，这一组定下来以后照着改 O
    const trial = { ...O, grid: base };
    const undo = []; // 数组, 下标, 改前的值, …
    const put = (A, i, b) => {
      undo.push(A, i, A[i]);
      A[i] = b;
    };
    for (const s of candidates) {
      // 这个站位得分的下限：站本身已经把外框撑到这么大（接线只会撑得更大），接线代价每条都不是负的。
      // 下限加上已接的代价不比最好站位的得分低，这个站位就不可能被选上（要严格更低才换），后面的口不用再接；
      // 浮点加法对非负数是单调的，所以按同样的式子算出来的下限不会比真算出来的得分高，选出来的站位逐字一样
      const floor = (Math.max(L.width, s.x + 4) * Math.max(L.height, s.y + 4) - L.area) * 2;
      if (prune && best && floor >= best.score) continue;
      const order = ports.slice().sort((a, b) => (Math.abs(a.x - s.x) + Math.abs(a.y - s.y)) - (Math.abs(b.x - s.x) + Math.abs(b.y - s.y)));
      // 还没接的口的得分下限之和（rest[k]：第 k 个口及以后的）。已接的代价 + 还没接的下限 + floor 不比最好站位的得分低，
      // 这个站位就注定选不上（最后的得分只会更高），和接完再跳过是一回事；多加 1e-6 盖住浮点舍入
      const rest = new Float64Array(order.length + 1);
      if (prune && best) {
        for (let k = order.length - 1; k >= 0; k--) {
          const p = order[k];
          const leg = L.legs[p.leg];
          const seg = L.segments[p.kind === 'in' ? leg.to : leg.from];
          rest[k] = rest[k + 1] + routeFloor(s, [p.kind === 'in' ? seg.entryX : seg.exitX, seg.y], p, leg.cells.length + (leg.direct ? 0 : 1));
        }
        if (floor + rest[0] >= best.score + 1e-6) continue;
      }
      // 站身 7×7（站位离网格边至少 3 格，都在网格里）
      for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) put(base.solid, (s.y + dy) * W + s.x + dx, 1);
      const ops = []; // 这个站位对带子集合的增删：是不是删, 格子, …
      const freeSlots = new Set(STATION_PORTS.map((p) => p.slot));
      const routes = [];
      let cost = 0;
      for (let pk = 0; pk < order.length; pk++) {
        const p = order[pk];
        if (prune && best && floor + cost >= best.score) break; // 注定选不上：少接几个口，下面按没接全跳过
        if (prune && best && floor + cost + rest[pk] >= best.score + 1e-6) break; // 加上还没接的下限也注定选不上（见 rest）
        // 这个口的接线代价不比 need 低，接上之后（再加上后面几个口的下限）就是上面那种注定选不上的（最后一个口也一样：真得分不比下限加已接的代价低），
        // 这个站位直接放弃，和接完再跳过是一回事。多加 1e-6：浮点舍入远小于它，判成注定选不上的一定是真选不上
        const need = prune && best ? best.score - floor - cost - rest[pk + 1] + 1e-6 : Infinity;
        // chosen 只记代价低于 need 的接法：原来的 chosen 最后低于 need 时，就是这些里第一个最小的那个，和这里一样；
        // 不低于 need 时站位注定选不上，这里 chosen 是空的，同样放弃
        let chosen = null;
        // 只试离目标最近的 4 个空闲站口：更远的口几乎不会更好，A* 失败时却要把预算耗完
        const slots = STATION_PORTS.filter((q) => freeSlots.has(q.slot)).sort((a, b) =>
          Math.abs(s.x + a.dx + a.nx * 2 - p.x) + Math.abs(s.y + a.dy + a.ny * 2 - p.y) - Math.abs(s.x + b.dx + b.nx * 2 - p.x) - Math.abs(s.y + b.dy + b.ny * 2 - p.y)).slice(0, 4);
        // 直接接到段的端头（不经过边缘的出入口和原来那段高架），原来那段高架和出入口格让出来
        const leg = L.legs[p.leg];
        const seg = L.segments[p.kind === 'in' ? leg.to : leg.from];
        const target = [p.kind === 'in' ? seg.entryX : seg.exitX, seg.y, 0];
        // 终点之后链往哪走（按寻路的方向说）：原料从段首顺着段流下去；成品是从站往段尾反着找，过了段尾就是逆着段回去
        const targetDir = p.kind === 'in' ? dirIndex(seg.dir, 0) : dirIndex(-seg.dout, 0);
        const own = [...leg.cells.map((c) => cell(...c)), ...(leg.direct ? [] : [cell(leg.edge, leg.py, 0)])];
        const ignore = new Set(own);
        for (const q of slots) {
          const stub = [0, 1, 2].map((d) => [s.x + q.dx + q.nx * d, s.y + q.dy + q.ny * d, 0]);
          // 站口那 3 格（地面）：出界，或者有带子（自己那段让出来的除外）就不行。网格和带子集合逐格一致，直接查网格
          if (stub.some(([x, y, z]) => x < 0 || y < 0 || x >= W || y >= H || (base.belts[(z * H + y) * W + x] && !ignore.has(cell(x, y, z))))) continue;
          const start = stub[2];
          if (base.solid[start[1] * W + start[0]] || base.ground[start[1] * W + start[0]]) continue;
          const dir = DIRS.findIndex(([dx, dy]) => dx === q.nx && dy === q.ny);
          // 这个口的接法要有用：得分低于 lim（换掉已选的，或者让站位不至于注定选不上），或者是一条地面直路（下面就不再试别的口）。
          // 寻路只找代价够低的路（pathfind 的 cut）：得分不低于 lim、又不是直路（代价比曼哈顿距离多出 0.01 以上）的路找到了也用不上，
          // 找不到时直接退回原来出入口的那次寻路也一样：所以两次寻路都返回 CUT 时这个口跳过，和原来逐字一样
          const lim = chosen ? chosen.cost : need;
          const back = target[0] !== p.x || target[1] !== p.y; // 直接接不上时还能退回原来的出入口格
          const cutD = Math.max(lim - 2, Math.abs(start[0] - target[0]) + Math.abs(start[1] - target[1]) + 0.02);
          const cutB = Math.max(lim - 2 - own.length, Math.abs(start[0] - p.x) + Math.abs(start[1] - p.y) + 0.02);
          // 已经选了一个口时，后面的口多半比不过它（实测六七成返回 CUT）：寻路先用桶队列预判（pre）
          const pre = !!chosen;
          // 喷涂机骑在这截高架上的（leg.spray，layout/belts.js 的 legIn）不直接接段头：那截高架要留着，只接原来的出入口
          let path = leg.spray ? null : pathfind(start, target, trial, W, H, maxLevel, dir, ignore, targetDir, cutD, pre);
          let direct = !!path;
          if (path === CUT) {
            // 直接接的路没找完：原来要么找到一条用不上的路（不再退回），要么找不到（退回原来的出入口）。
            // 退回的那次也用不上，这个口就跳过；退回的那次有用时，直接接的那次照原样找完，才知道原来走的是哪一支
            if (!back) continue;
            const alt = pathfind(start, [p.x, p.y, 0], trial, W, H, maxLevel, dir, null, portDir(p, leg), cutB, pre);
            if (!alt || alt === CUT) continue;
            path = pathfind(start, target, trial, W, H, maxLevel, dir, ignore, targetDir);
            direct = !!path;
            if (!path) path = alt;
          } else if (!path && back) {
            path = pathfind(start, [p.x, p.y, 0], trial, W, H, maxLevel, dir, null, portDir(p, leg), cutB, pre);
            if (path === CUT) continue;
          }
          if (!path) continue;
          const cells = [...stub.slice(0, 2), ...path.cells.slice(0, -1)];
          const score = path.cost + 2 + (direct ? 0 : own.length);
          if (score < lim) chosen = { port: p, slot: q.slot, cells, cost: score, direct, target, own };
          // 已找到地面最短路，无需再尝试朝向更远的口。
          const goal = direct ? target : [p.x, p.y];
          if (path.cost <= Math.abs(start[0] - goal[0]) + Math.abs(start[1] - goal[1]) + 0.01) break;
        }
        if (!chosen) { diagnostics?.push({ station: L.stations.length, site: [s.x, s.y], port: [p.x, p.y], itemId: p.itemId, connected: routes.length }); break; }
        freeSlots.delete(chosen.slot);
        if (chosen.direct) for (const k of chosen.own) {
          ops.push(true, k);
          const i = gridIndex(base, k);
          if (i >= 0) put(base.belts, i, 0);
        }
        // 接线的格子：站口那 2 节和寻路出来的格子，都是网格里的整数格
        for (const [x, y, z] of chosen.cells) {
          ops.push(false, cell(x, y, z));
          put(base.belts, (z * H + y) * W + x, 1);
        }
        routes.push(chosen);
        cost += chosen.cost;
      }
      // 网格改回接这个站位之前
      for (let u = undo.length - 3; u >= 0; u -= 3) undo[u][undo[u + 1]] = undo[u + 2];
      undo.length = 0;
      if (routes.length !== ports.length) continue;
      let width = Math.max(L.width, s.x + 4), height = Math.max(L.height, s.y + 4);
      for (const r of routes) for (const [x, y] of r.cells) { width = Math.max(width, x + 1); height = Math.max(height, y + 1); }
      const score = (width * height - L.area) * 2 + cost;
      if (!best || score < best.score) best = { ...s, routes, width, height, score, ops };
    }
    if (!best) return null;
    const k = L.stations.length;
    L.stations.push({ x: best.x, y: best.y, stack, items: [...group.map(({ itemId, role }) => ({ itemId, role })), ], ports: [] });
    for (const r of best.routes) {
      const p = r.port;
      const leg = L.legs[p.leg];
      leg.stub = r.cells;
      leg.station = { k, slot: r.slot };
      // chainTiles 对成品的 stub 会自行反转；两种方向均保存从站到产线的路径。
      const outPort = L.ports.find((q) => q.leg === p.leg);
      outPort.station = k;
      outPort.slot = r.slot;
      if (r.direct) {
        // 站的接线直接接到段的端头：原来的出入口格和高架段作废
        leg.cells = [];
        leg.shadow = [];
        leg.level = 0;
        leg.direct = true;
        [leg.edge, leg.py] = r.target;
        [outPort.x, outPort.y] = r.target;
        outPort.direct = true;
      }
      L.stations[k].ports.push({ slot: r.slot, leg: p.leg, itemId: p.itemId, dir: p.kind === 'in' ? 'out' : 'in' });
      for (const [x, y] of r.cells) {
        O.projection.add(key(x, y));
        fitCells.push(x, y);
      }
    }
    // 障碍集合加上这座站的站身、照选上的站位的增删改带子（和原来接这个站位时在集合副本上做的一样，顺序也一样）
    for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) {
      O.solid.add(key(best.x + dx, best.y + dy));
      fitCells.push(best.x + dx, best.y + dy);
    }
    for (let u = 0; u < best.ops.length; u += 2) {
      if (best.ops[u]) O.belts.delete(best.ops[u + 1]);
      else O.belts.add(best.ops[u + 1]);
    }
    L.width = best.width;
    L.height = best.height;
    L.area = L.width * L.height;
  }
  L.stationMode = 'edge';
  cropToContent(L);
  return L;
}

/**
 * 裁到实际占用的格子（接线时四周留的边、没用到的去掉），重数带子：搜索边界用于绕线，只有最终确实占用的格子才进入蓝图边界。
 * 算工厂、物流站、各条线路，还有翘曲器带（linkWarpers）。
 */
export function cropToContent(L) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const include = (x, y) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
  for (const p of L.pos.values()) {
    const hw = (p.g.bodyWidth - 1) / 2;
    for (const cx of p.centers) { include(cx - hw, L.rowCy[p.row] - p.g.bodyBelow); include(cx + hw, L.rowCy[p.row] + p.g.bodyAbove); }
  }
  for (const st of L.stations || []) { include(st.x - 3, st.y - 3); include(st.x + 3, st.y + 3); }
  for (const ch of L.chains) {
    const t = chainTiles(L, ch);
    for (const [x, y] of [...t.main, ...t.extra.flat()]) include(x, y);
  }
  for (const w of L.warperLinks || []) for (const [x, y] of w.cells) include(x, y);
  for (const b of L.burners || []) { include(b.rect[0], b.rect[1]); include(b.rect[2], b.rect[3]); } // 火力发电厂那一块（plan/burn.js）
  translateLayout(L, -x0, -y0);
  L.width = x1 - x0 + 1;
  L.height = y1 - y0 + 1;
  L.area = L.width * L.height;
  L.belts = 0;
  L.airBelts = 0;
  L.longestBelt = 0;
  for (const ch of L.chains) {
    const t = chainTiles(L, ch);
    const paths = [t.main, ...t.extra];
    for (const path of paths) {
      L.belts += path.length;
      L.airBelts += path.filter((p) => p[2] > 0).length;
      if (path.length > L.longestBelt) { L.longestBelt = path.length; L.longestBeltItem = ch.itemId; }
    }
  }
  for (const w of L.warperLinks || []) {
    L.belts += w.cells.length;
    L.airBelts += w.cells.filter((c) => c[2] > 0).length;
  }
  return L;
}

/**
 * 翘曲器带（用户 2026/10/07：翘曲器整张蓝图一格就够，别的站用传送带接）：挑一座有空格的站存空间翘曲器（星际需求），
 * 从它的空口各拉一条带到别的每座站的空口。传送带送进星际物流站的翘曲器自动进站里专门的翘曲器仓，收的那座站不占物品格。
 * 接不上的那座站有空格就自己存一格翘曲器，都不行就写进 L.warperNotes（那座站的运输船不用翘曲器，照样能跑，只是慢）。
 * 在接站、高架落地之后，增产剂和供电之前做：带子算进障碍（obstacles），后面的增产剂带、供电设施都让开。直接改 L。
 */
export function linkWarpers(L, { maxLevel = 6 } = {}) {
  L.warperLinks = [];
  L.warperNotes = [];
  const sts = L.stations || [];
  if (!sts.length) return L;
  const free = (st) => STATION_SLOTS - st.items.length;
  // 存翘曲器的站：空格最多的；一样多时离别的站总距离最近的（带子短）
  const dist = (a) => sts.reduce((n, b) => n + Math.abs(a.x - b.x) + Math.abs(a.y - b.y), 0);
  const homes = sts.map((st, k) => ({ st, k })).filter(({ st }) => free(st) > 0).sort((a, b) => free(b.st) - free(a.st) || dist(a.st) - dist(b.st));
  if (!homes.length) {
    L.warperNotes.push('物流站都满了，放不下翘曲器格');
    return L;
  }
  const { st: home, k: hk } = homes[0];
  home.items.push({ itemId: WARPER, role: 'warper' });
  if (sts.length === 1) return L;
  // 四周留几格给接线绕（最后裁掉没用到的）
  const PAD = 4;
  translateLayout(L, PAD, PAD);
  L.width += 2 * PAD;
  L.height += 2 * PAD;
  const W = L.width, H = L.height;
  const O = obstacles(L);
  for (const st of sts) for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) O.solid.add(key(st.x + dx, st.y + dy));
  O.grid = obstacleGrid(O, W, H, maxLevel);
  const stubOf = (st, q) => [0, 1, 2].map((d) => [st.x + q.dx + q.nx * d, st.y + q.dy + q.ny * d, 0]);
  const okStub = (stub) => stub.every(([x, y, z]) => x >= 0 && y >= 0 && x < W && y < H && !O.belts.has(cell(x, y, z)) && !O.ground.has(key(x, y)));
  // 站的空口，按离对面那座站由近到远（只试最近的 4 个，同接站）
  const nearPorts = (from, to) => {
    const used = new Set(from.ports.map((p) => p.slot));
    return STATION_PORTS.filter((q) => !used.has(q.slot)).sort((a, b) => Math.abs(from.x + a.dx * 2 - to.x) + Math.abs(from.y + a.dy * 2 - to.y) - (Math.abs(from.x + b.dx * 2 - to.x) + Math.abs(from.y + b.dy * 2 - to.y))).slice(0, 4);
  };
  const order = sts.map((st, k) => ({ st, k })).filter(({ k }) => k !== hk).sort((a, b) => Math.abs(a.st.x - home.x) + Math.abs(a.st.y - home.y) - (Math.abs(b.st.x - home.x) + Math.abs(b.st.y - home.y)));
  for (const { st, k } of order) {
    let best = null;
    for (const qa of nearPorts(home, st)) for (const qb of nearPorts(st, home)) {
      const sa = stubOf(home, qa);
      const sb = stubOf(st, qb);
      if (!okStub(sa) || !okStub(sb)) continue;
      const da = DIRS.findIndex(([dx, dy]) => dx === qa.nx && dy === qa.ny); // 出站朝外
      const db = DIRS.findIndex(([dx, dy]) => dx === -qb.nx && dy === -qb.ny); // 进站朝里
      // 已经有一条了：只要更短的（cut；返回 CUT 时原来找到的也不比它短，换不上）
      const path = pathfind(sa[2], sb[2], O, W, H, maxLevel, da, null, db, best ? best.cost : Infinity);
      if (path && path !== CUT && (!best || path.cost < best.cost)) best = { qa, qb, cost: path.cost, cells: [sa[0], sa[1], ...path.cells, sb[1], sb[0]] };
    }
    if (!best) {
      if (free(st) > 0) {
        st.items.push({ itemId: WARPER, role: 'warper' });
        L.warperNotes.push(`物流站 ${k + 1} 接不上翘曲器带，自己存一格翘曲器`);
      } else L.warperNotes.push(`物流站 ${k + 1} 接不上翘曲器带、也没有空格：它的运输船不用翘曲器（照样能跑，远路慢）`);
      continue;
    }
    for (const [x, y, z] of best.cells) {
      O.belts.add(cell(x, y, z));
      gridSet(O.grid, O.grid.belts, cell(x, y, z), 1);
    }
    home.ports.push({ slot: best.qa.slot, itemId: WARPER, dir: 'out', warper: true });
    st.ports.push({ slot: best.qb.slot, itemId: WARPER, dir: 'in', warper: true });
    L.warperLinks.push({ from: { k: hk, slot: best.qa.slot }, to: { k, slot: best.qb.slot }, cells: best.cells });
  }
  return cropToContent(L);
}
